// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The platform copy of an index, loaded from this machine's disk: the chunks
// this machine cut (the same rows its local index holds) written out as one
// NDJSON file, uploaded into the database's storage over the platform's
// upload sessions (the `hydrate` tool's own path, uploads.ts), and loaded by
// a platform load job, which this waits for. The platform chooses what the
// table indexes and embeds at the table's first load; every later load
// appends and keeps those choices. The caller deletes a changed file's old
// rows before it loads the new ones, and only while no load is writing the
// table.

import { createReadStream, createWriteStream, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { basename } from "node:path";
import { Readable } from "node:stream";
import { once } from "node:events";
import type { HostedDb, RowRecord } from "./hosted.js";

/** The source format of the rows file. */
const ROWS_FORMAT = "ndjson";
/** The source kind of files uploaded into the database's own storage. */
const PREFIX_SOURCE = "prefix";
/** A job's states while it may still write the table. */
export const LIVE_LOAD_STATES: ReadonlySet<string> = new Set(["admitting", "pending", "running", "cancelling"]);
/** The states of a load whose rows are in the table. */
const LANDED_STATES: ReadonlySet<string> = new Set(["succeeded", "synced"]);
/** How often a running load is asked how it stands. */
const DEFAULT_POLL_MS = 2_000;
/** How long a load may take before the wait gives up on it. The job goes on
 * on the platform; the caller treats the rows as not applied. */
const DEFAULT_WAIT_MS = 30 * 60_000;

/** One table row from one spilled chunk: the columns the local index holds. */
export interface TextRow {
  path: string;
  start_line: number;
  end_line: number;
  lang: string;
  symbol: string;
  content: string;
}

/** Write the spill's chunks (one JSON chunk per line) at `spillPath` to
 * `rowsPath` as table rows, one per line, through `toRow`. Returns how many
 * rows were written. */
export async function writeRows(spillPath: string, rowsPath: string, toRow: (chunk: never) => TextRow): Promise<number> {
  const out = createWriteStream(rowsPath, { mode: 0o600 });
  let n = 0;
  try {
    const lines = createInterface({ input: createReadStream(spillPath), crlfDelay: Infinity });
    for await (const line of lines) {
      if (line === "") continue;
      if (!out.write(JSON.stringify(toRow(JSON.parse(line) as never)) + "\n")) await once(out, "drain");
      n++;
    }
  } finally {
    out.end();
    await once(out, "finish");
  }
  return n;
}

export interface LoadOptions {
  /** The table the rows load into. */
  table: string;
  /** The NDJSON rows file to upload. */
  rowsPath: string;
  /** What the load does with a table of that name: `append` adds the rows
   * (the table keeps the roles it was built with); `replace` starts the
   * table over from them, its roles chosen again (a build). */
  ifExists: "append" | "replace";
  pollMs?: number;
  waitMs?: number;
  /** Sleeps between polls; a test's own clock. */
  sleep?: (ms: number) => Promise<void>;
}

export interface LoadResult {
  /** The job's name, as the platform gave it. */
  job: string;
  /** The upload's prefix in the database's storage. */
  prefix: string;
  /** The record of the job as it ended. */
  record: RowRecord;
}

/** Upload `rowsPath` and load it into `table` by a platform load job, and wait for
 * the job to end. Throws when the upload, the submission or the load fails,
 * or the load does not end within the wait. */
export async function loadRows(hosted: HostedDb, opts: LoadOptions): Promise<LoadResult> {
  const size = statSync(opts.rowsPath).size;
  const name = basename(opts.rowsPath);
  // A client of the platform's API opens its uploads for the API's own origin,
  // as the `hydrate` tool does (mcp/server.ts).
  const accepted = await hosted.openUploads(new URL(hosted.target.baseUrl).origin, [{ name, size }]);
  const sessions = accepted.files as Array<{ name: string; url: string }> | undefined;
  const prefix = accepted.prefix;
  if (!Array.isArray(sessions) || sessions.length !== 1 || typeof prefix !== "string") {
    throw new Error(`the platform opened ${Array.isArray(sessions) ? sessions.length : 0} upload sessions for 1 file`);
  }
  await hosted.upload(sessions[0].url, Readable.toWeb(createReadStream(opts.rowsPath)) as ReadableStream<Uint8Array>, size);
  const answer = await hosted.hydrateSubmit({
    table: opts.table,
    source: { kind: PREFIX_SOURCE, prefix },
    format: ROWS_FORMAT,
    if_exists: opts.ifExists,
  });
  const job = String(answer.job ?? opts.table);
  const record = await waitForLoad(hosted, opts.table, opts);
  return { job, prefix, record };
}

/** Wait until `table`'s load job has ended: its record when its rows
 * landed, a throw when it failed, stopped, or outlasted the wait. */
export async function waitForLoad(
  hosted: Pick<HostedDb, "hydrateJob">,
  table: string,
  opts: Pick<LoadOptions, "pollMs" | "waitMs" | "sleep"> = {},
): Promise<RowRecord> {
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const waitMs = opts.waitMs ?? DEFAULT_WAIT_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = Date.now() + waitMs;
  for (;;) {
    const record = await hosted.hydrateJob(table);
    const state = typeof record?.state === "string" ? record.state : "";
    if (LANDED_STATES.has(state)) return record;
    if (!LIVE_LOAD_STATES.has(state)) {
      const why = typeof record?.error === "string" && record.error !== "" ? `: ${record.error}` : "";
      throw new Error(`the platform load of ${table} ended ${state || "with no state"}${why}`);
    }
    if (Date.now() >= deadline) throw new Error(`the platform load of ${table} was still ${state} after ${Math.round(waitMs / 1000)} s`);
    await sleep(pollMs);
  }
}
