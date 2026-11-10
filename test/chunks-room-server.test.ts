// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// A hosted table of PASSAGES this process did not build, end to end through
// the MCP server on an in-memory transport against a scripted platform: the
// data rooms of a document benchmark, one hosted table a room, named by
// CX_TABLE a question at a time (2026-10-11). Its columns are the chunks
// table's, so its shape says chunks - and the chunks mode runs find, read
// and a plain sql on the LOCAL index under the table's name, which holds the
// one table this process built and no other. On every room task every such
// call failed "table not found", and search asked the hosted index for the
// local vector column's name (`embedding`, where the table has `emb`); the
// loop's ask was the one door that reached the rooms.
//
// So: with CX_REMOTE_SEARCH on and CX_TABLE naming a chunks-shaped table the
// local index does not hold, the server runs the rows tools over the table
// on the platform, driven by its own shape - search by its `emb`, find and
// sql through query_sql, read registered for its path column - and nothing
// touches the local index.

import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NO_GRAPH, call, scriptPlatform, start, stop, type Started } from "./mcp-harness.js";

/** The room's table: chunks-shaped, loaded by something else, never built here. */
const ROOM_TABLE = "contracts_banking_isda_master_pack_first_draft_scenario_02";

// The environment the server reads at module load (TABLE is a constant of
// config.ts) and at startup, set before either module is imported - which is
// why every import of the client's own code below is dynamic.
process.env.CX_TABLE = ROOM_TABLE;
process.env.CX_REMOTE_SEARCH = "1";
process.env.CX_NO_EMBED = "1";
process.env.CX_AUTO_INDEX = "0";
delete process.env.CX_NO_RECEIPT;
delete process.env.CX_INDEX_DIR;

const { API_KEY_ENV, MANIFEST_NAME, configureHosted, hostedSettingsFromFlags } = await import("../src/core/config.js");

/** The width the rooms' `emb` is embedded at. */
const ROOM_DIM = 768;

/** A room table's columns as `POST /v1/schema` returns them on the fleet
 * (cxbench, 2026-10-12): the chunks table's place columns and content, the
 * room's own, and the vector the platform embeds. */
const ROOM_SCHEMA = [
  { name: "area", nullable: true, type: "large_utf8" },
  { name: "content", nullable: true, type: "large_utf8" },
  { name: "path", nullable: true, type: "large_utf8" },
  { name: "task", nullable: true, type: "large_utf8" },
  { name: "title", nullable: true, type: "large_utf8" },
  { name: "chunk", nullable: false, type: "i32" },
  { name: "start_line", nullable: true, type: "i32" },
  { name: "end_line", nullable: true, type: "i32" },
  { name: "symbol", nullable: true, type: "large_utf8" },
  { name: "kind", nullable: true, type: "large_utf8" },
  { name: "scope", nullable: true, type: "large_utf8" },
  { dim: ROOM_DIM, name: "emb", nullable: false, type: "vector" },
];

/** One passage as the platform returns it. */
const PASSAGE = {
  area: "contracts/banking",
  content: "Threshold Amount means 3% of Shareholders' Equity.",
  path: "contracts/banking/isda-master-pack-first-draft/scenario-02/term-sheet.docx.txt",
  task: "isda-master-pack-first-draft/scenario-02",
  title: "term-sheet.docx",
  chunk: 4,
  start_line: 40,
  end_line: 52,
  score: 0.021,
};

/** The writes this file exists to catch: none of them may ever be sent. */
const FORBIDDEN_OPS = ["drop_table", "create_table", "append", "delete", "update"];

/** The platform with the room's table there and describable: its schema, no
 * card yet, no load record (the rooms were not hydrated), and every read
 * answering. The database holds other chunks-shaped tables beside the room,
 * which the server describes as the tables a statement may join. */
const platform = () =>
  scriptPlatform({
    list_tables: () => [200, ["chunks", "chunks_docs", ROOM_TABLE]],
    schema: () => [200, ROOM_SCHEMA],
    table_card: () => [404, { error: `no lean card for table ${ROOM_TABLE}` }],
    hydrate: () => [404, { error: `no load recorded for ${ROOM_TABLE}` }],
    vector_search: () => [200, [{ _id: 1, score: 0.26 }]],
    hybrid_search: () => [200, [PASSAGE]],
    bm25_search: () => [200, [PASSAGE]],
    query_sql: (body) => {
      const query = String(body?.query);
      if (query.includes("token_match")) return [200, [{ __cx_total: 1, ...PASSAGE }]];
      return [200, [{ n: 14 }]];
    },
    validate: () => [200, { valid: true, check: "unchecked" }],
    graph_expand: () => NO_GRAPH,
  });

beforeAll(() => {
  configureHosted(hostedSettingsFromFlags({ db: "http://127.0.0.1:9/cxbench" }, { [API_KEY_ENV]: "inf_test_key_do_not_log" }));
});

afterAll(() => {
  configureHosted(null);
});

describe("a chunks-shaped hosted table the local index does not hold", () => {
  let s: Started;
  beforeAll(async () => {
    s = await start(platform(), "cx-room-");
  });
  afterAll(async () => {
    await stop(s);
  });

  it("is probed at startup and registered as rows: the tool text names the table's own columns and the read tool is there for its path column", async () => {
    // The database's tables listed once, then the room's schema read first.
    expect(s.startup.slice(0, 2)).toEqual(["list_tables", "schema"]);
    expect(s.startup.filter((op) => op === "list_tables")).toHaveLength(1);
    const { tools } = await s.client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t.description ?? ""]));
    expect(byName.get("sql")).toContain(`hybrid_search('${ROOM_TABLE}','content','terms','emb', {{q:"..."}}, k)`);
    expect(byName.get("find")).toContain(`Every row of ${ROOM_TABLE}`);
    expect(byName.has("read")).toBe(true);
    // The room first, the database's other tables the platform listed beside it.
    expect(s.client.getInstructions()).toContain(`an index of the tables ${ROOM_TABLE}, chunks, chunks_docs, one database`);
  });

  it("search reads the hosted index by the table's own text and vector columns", async () => {
    const { ok, value, ops } = await call(s, "search", { query: "threshold amount", k: 3 });
    expect(ok, String(value)).toBe(true);
    expect(ops[0]).toBe("hybrid_search");
    const request = s.sent.find((x) => x.op === "hybrid_search")?.body;
    expect(request).toMatchObject({ table_name: ROOM_TABLE, text_field: "content", vector_field: "emb", text_query: "threshold amount", k: 3 });
    const result = value as { index: string; hits: Array<Record<string, unknown>> };
    expect(result.index).toBe("platform");
    expect(result.hits[0].path).toBe(PASSAGE.path);
  });

  it("find and a plain sql run on the platform, never on the local index", async () => {
    const found = await call(s, "find", { query: "threshold", limit: 5 });
    expect(found.ok, String(found.value)).toBe(true);
    expect(found.ops).toEqual(["query_sql"]);
    const statement = String(s.sent.find((x) => x.op === "query_sql" && String(x.body?.query).includes("token_match"))?.body?.query);
    expect(statement).toContain(`FROM token_match('${ROOM_TABLE}', 'content', 'threshold', 'and') LIMIT 5`);
    const counted = await call(s, "sql", { query: `SELECT COUNT(*) AS n FROM ${ROOM_TABLE}` });
    expect(counted.ok, String(counted.value)).toBe(true);
    expect(counted.ops[0]).toBe("query_sql");
    expect((counted.value as { rows: unknown[] }).rows).toEqual([{ n: 14 }]);
  });

  it("built nothing and wrote nothing: no local manifest, no write to the platform", () => {
    const ops = s.sent.map((x) => x.op);
    for (const forbidden of FORBIDDEN_OPS) expect(ops, `the server sent ${forbidden}`).not.toContain(forbidden);
    expect(existsSync(`${s.root}/.infino/${MANIFEST_NAME}`)).toBe(false);
  });
});
