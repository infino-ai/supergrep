// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// CX_LOCAL_DB with CX_TABLE unset: the default table, `chunks`, is this
// client's code index, which a local database does not hold, so the doors
// read `memory` when the database holds it and else the first table it
// lists - never a server whose every call says it holds no table chunks.
// A file of its own because CX_TABLE is read when config.ts loads, and the
// other local-database file sets it.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, scriptPlatform, start, stop, type Started } from "./mcp-harness.js";

// The environment the server reads at module load and at startup, set before
// either module is imported - which is why every import of the client's own
// code below is dynamic.
delete process.env.CX_TABLE;
delete process.env.CX_REMOTE_SEARCH;
delete process.env.CX_NO_EMBED;
delete process.env.CX_AUTO_INDEX;
delete process.env.CX_NO_RECEIPT;
delete process.env.CX_INDEX_DIR;

const { configureHosted, LOCAL_DB_ENV } = await import("../src/core/config.js");
const { connect, IndexSpec } = await import("@infino-ai/infino");

/** A query embedder that is never asked: no table here has vectors. */
const noVectors = {
  embed: async (): Promise<number[][]> => {
    throw new Error("nothing here is searched by meaning");
  },
  dim: async () => 384,
  provider: "fake",
  model: "fake-unused",
};

/** A database in `dir` holding `tables`, each with one row whose content
 * names the table, full-text indexed. */
function writeDatabase(dir: string, tables: string[]): void {
  const db = connect(dir);
  for (const table of tables) {
    db.createTable(table, { row_id: "utf8", session_id: "utf8", content: "large_utf8" }, new IndexSpec().fts("content"));
    db.openTable(table).append([{ row_id: `${table}-1`, session_id: "s1", content: `a row of ${table} about otters` }]);
  }
}

/** A server over a fresh database holding `tables`, with CX_TABLE unset. */
function serving(tables: string[]): { started: () => Started } {
  const home = mkdtempSync(join(tmpdir(), "cx-localdb-default-"));
  const dir = join(home, "db");
  let s: Started;
  beforeAll(async () => {
    configureHosted(null);
    writeDatabase(dir, tables);
    process.env[LOCAL_DB_ENV] = dir;
    s = await start(scriptPlatform({}), "cx-localdb-default-root-", { localEmbedder: noVectors });
  });
  afterAll(async () => {
    await stop(s);
    delete process.env[LOCAL_DB_ENV];
    rmSync(home, { recursive: true, force: true });
  });
  return { started: () => s };
}

describe("a local database holding memory, with CX_TABLE unset", () => {
  const { started } = serving(["conversations", "memory", "skills"]);

  it("reads memory when a call names no table, and says so", async () => {
    const s = started();
    expect(s.client.getInstructions()).toContain("find, search and read each take the table they read, memory when none is named");
    const searched = await call(s, "search", { query: "otters" });
    expect(searched.ok, String(searched.value)).toBe(true);
    expect(searched.value).toMatchObject({ table: "memory", ranking: "keyword" });
    const found = await call(s, "find", { query: "otters" });
    expect(found.ok, String(found.value)).toBe(true);
    expect(found.value).toMatchObject({ table: "memory", total: 1 });
    // A table named still reads that table.
    const named = await call(s, "search", { query: "otters", table: "skills" });
    expect(named.value).toMatchObject({ table: "skills" });
  });
});

describe("a local database without memory, with CX_TABLE unset", () => {
  const { started } = serving(["traces", "skills"]);

  it("reads the first table the database lists", async () => {
    const s = started();
    const first = connect((process.env[LOCAL_DB_ENV] ?? "") as string).listTables()[0];
    expect(["traces", "skills"]).toContain(first);
    const searched = await call(s, "search", { query: "otters" });
    expect(searched.ok, String(searched.value)).toBe(true);
    expect(searched.value).toMatchObject({ table: first });
  });
});
