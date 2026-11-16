// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// A build's platform copy, loaded from this machine's disk: the chunks this
// machine cut (the same rows its local index holds) written out as one NDJSON
// file, uploaded into the database's storage over the platform's upload
// sessions (the `hydrate` tool's own path, uploads.ts), and appended to the
// table this client created by a platform load job, which this waits for. A
// load job embeds a whole build's chunks across the platform's hosts at once:
// measured on the platform, 9,281 chunks in 124 s, where appending them 512
// rows a request took 8 min 34 s. A sync's few changed files are appended
// instead (an append answers in under a second; a load job takes about 30 s
// before it starts). The load keeps the columns and indexes the table was
// created with, and may cut a long chunk into passages, each a row with the
// chunk's path and lines.

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
  /** `append` adds the rows to the table the caller created, which keeps the
   * columns and indexes it was created with; `new` loads a table that is not
   * there. */
  ifExists: "append" | "new";
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
    ...(opts.ifExists === "append" ? { if_exists: "append" } : {}),
  });
  const job = String(answer.job ?? opts.table);
  const record = await waitForLoad(hosted, opts.table, prefix, opts);
  return { job, prefix, record };
}

/** Wait until the load of `table` from the upload at `prefix` has ended: its
 * record when its rows landed, a throw when it failed, stopped, or outlasted
 * the wait.
 *
 * A table keeps one load record, and a job's name is the table's own
 * (`hydrate/<account>/<database>/<table>`), the same for every load of it, so
 * the name cannot tell this load's record from the one an earlier load of the
 * table left. The upload's prefix can: each upload has its own, and a record
 * names its request's source. A record of another source is an earlier load's,
 * and is read again until this one's replaces it. A record that names no
 * source prefix is taken as this load's. */
export async function waitForLoad(
  hosted: Pick<HostedDb, "hydrateJob">,
  table: string,
  prefix: string,
  opts: Pick<LoadOptions, "pollMs" | "waitMs" | "sleep"> = {},
): Promise<RowRecord> {
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const waitMs = opts.waitMs ?? DEFAULT_WAIT_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = Date.now() + waitMs;
  for (;;) {
    const record = await hosted.hydrateJob(table);
    if (!loadsFrom(record, prefix)) {
      if (Date.now() >= deadline) throw new Error(`the platform never showed the load of ${table} from ${prefix} within ${Math.round(waitMs / 1000)} s`);
      await sleep(pollMs);
      continue;
    }
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

/** Whether `record` is of a load from the upload at `prefix`: its request's
 * source prefix ends with it, trailing slashes aside (the platform may
 * store the prefix resolved under the database's root), or it names none. */
function loadsFrom(record: RowRecord | null | undefined, prefix: string): boolean {
  const request = record?.request as RowRecord | undefined;
  const source = request?.source as RowRecord | undefined;
  const from = source?.prefix;
  const bare = (p: string) => p.replace(/\/+$/, "");
  return typeof from !== "string" || bare(from).endsWith(bare(prefix));
}
