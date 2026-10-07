// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// A hosted table with no full-text column and no vector, end to end through
// the MCP server on an in-memory transport against a scripted platform: the
// Berka financial tables (2026-10-01), eight tables of numbers and short
// codes hydrated with no full-text index, served with two of their siblings.
// The engine refuses a token match or a BM25 search over a column with no
// index, so the server offers no find and no search over such a table, and no
// tool text names a search function it cannot run; sql, ask and join_keys
// keep working, and the answer is told to cite no row by an id - the table
// has no link column to cite one by.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, scriptPlatform, start, stop, type Started } from "./mcp-harness.js";

/** The table the server is started for, and two of its siblings. */
const TRANS_TABLE = "berka_trans";
const ACCOUNT_TABLE = "berka_account";
const LOAN_TABLE = "berka_loan";

// The environment the server reads at module load (TABLE is a constant of
// config.ts) and at startup, set before either module is imported - which is
// why every import of the client's own code below is dynamic.
process.env.CX_TABLE = TRANS_TABLE;
process.env.CX_REMOTE_SEARCH = "1";
process.env.CX_NO_EMBED = "1";
process.env.CX_SIBLING_TABLES = `${ACCOUNT_TABLE},${LOAN_TABLE}`;
delete process.env.CX_AUTO_INDEX;
delete process.env.CX_NO_RECEIPT;
delete process.env.CX_INDEX_DIR;

const { API_KEY_ENV, MANIFEST_NAME, configureHosted, hostedSettingsFromFlags } = await import("../src/core/config.js");

/** The three tables' schemas as `POST /v1/schema` would describe them, from
 * the hydrate dry run's columns: every text column Utf8, no embedding. */
const SCHEMAS: Record<string, unknown[]> = {
  [TRANS_TABLE]: [
    { name: "trans_id", type: "i64" },
    { name: "account_id", type: "i64" },
    { name: "date", type: "i64" },
    { name: "type", type: "utf8" },
    { name: "operation", type: "utf8" },
    { name: "amount", type: "f64" },
    { name: "balance", type: "f64" },
    { name: "k_symbol", type: "utf8" },
    { name: "bank", type: "utf8" },
    { name: "account", type: "i64" },
  ],
  [ACCOUNT_TABLE]: [
    { name: "account_id", type: "i64" },
    { name: "district_id", type: "i64" },
    { name: "frequency", type: "utf8" },
    { name: "date", type: "i64" },
  ],
  [LOAN_TABLE]: [
    { name: "loan_id", type: "i64" },
    { name: "account_id", type: "i64" },
    { name: "date", type: "i64" },
    { name: "amount", type: "i64" },
    { name: "duration", type: "i64" },
    { name: "payments", type: "f64" },
    { name: "status", type: "utf8" },
  ],
};

/** The platform's loop answering one question over the table: the first
 * fact of the statement it ran, which matched three rows - the platform
 * returns the caller's k and says what it cut. */
const ASKED_STATEMENT = `SELECT trans_id, account_id, amount FROM ${TRANS_TABLE} ORDER BY amount DESC LIMIT 10`;
const ASKED_ROWS = [
  { trans_id: 695247, account_id: 2378, amount: 700 },
  { trans_id: 695248, account_id: 2378, amount: 650 },
  { trans_id: 695249, account_id: 11, amount: 600 },
];
const ASKED = {
  facts: [{ table: TRANS_TABLE, row: ASKED_ROWS[0] }],
  statement: ASKED_STATEMENT,
  coverage: { rows_total: ASKED_ROWS.length, rows_returned: 1, truncated: true },
  terminate: "answered",
  turns: 1,
  retries: 0,
  model_tokens: 320,
};

/** The writes this file exists to catch: none of them may ever be sent. */
const FORBIDDEN_OPS = ["drop_table", "create_table", "append", "delete", "update"];

/** The functions a table with no full-text column cannot run, and the
 * meaning-only one it has no vector for. */
const UNRUNNABLE = ["hybrid_search", "bm25_search", "token_match", "exact_match", "vector_search"];

/** The platform with the three tables there: the primary not yet carded, one
 * sibling carded with every column scalar (the optimizer's card for a table
 * with no index), one not; every read answers. */
const berka = () =>
  scriptPlatform({
    schema: (body) => {
      const fields = SCHEMAS[String(body?.table_name)];
      return fields ? [200, fields] : [404, { error: "no such table" }];
    },
    table_card: (query) =>
      query?.table === ACCOUNT_TABLE
        ? [200, { table: ACCOUNT_TABLE, rows: 4500, schema: (SCHEMAS[ACCOUNT_TABLE] as Array<{ name: string }>).map((c) => ({ name: c.name, index: "scalar" })) }]
        : [404, { error: `no lean card for table ${String(query?.table)}` }],
    // Loaded one row per record: the load cut nothing.
    hydrate: () => [200, { state: "succeeded", request: { table: TRANS_TABLE, source: { kind: "bucket", prefix: "berka/trans/" } } }],
    join_keys: () => [200, { joins: [{ predicate: `${TRANS_TABLE}.account_id = ${ACCOUNT_TABLE}.account_id` }], pairs: 1, counted: 0, model_tokens: 0 }],
    // The loop's statement, run again by the client for the rows the
    // platform cut; any other statement is the model's own.
    query_sql: (body) => [200, body?.query === ASKED_STATEMENT ? ASKED_ROWS : [{ account_id: 2378, n: 42 }]],
    validate: () => [200, { valid: true, check: "unchecked" }],
    sub_agent: () => [200, ASKED],
  });

beforeAll(() => {
  configureHosted(hostedSettingsFromFlags({ db: "http://127.0.0.1:9/cxbench" }, { [API_KEY_ENV]: "inf_test_key_do_not_log" }));
});

afterAll(() => {
  configureHosted(null);
  delete process.env.CX_SIBLING_TABLES;
});

describe("a table with no full-text column, with siblings of the same kind", () => {
  let s: Started;
  beforeAll(async () => {
    s = await start(berka(), "cx-rows-notext-");
  });
  afterAll(async () => {
    await stop(s);
  });

  it("read the primary's shape and each sibling's once at startup", () => {
    // Each card asked at the enriched tier, the default; the primary and the
    // uncarded sibling then at the lean one they fall back to.
    expect(s.startup).toEqual(["schema", "table_card", "table_card", "hydrate", "schema", "table_card", "schema", "table_card", "table_card"]);
  });

  it("offers no find and no search, and keeps sql, ask and join_keys", async () => {
    const { tools } = await s.client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).not.toContain("find");
    expect(names).not.toContain("search");
    for (const name of ["sql", "ask", "join_keys"]) expect(names, name).toContain(name);
  });

  it("names no function the tables cannot run anywhere the model reads", async () => {
    const { tools } = await s.client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t.description ?? ""]));
    const instructions = s.client.getInstructions() ?? "";
    for (const [where, text] of [["instructions", instructions], ...byName.entries()]) {
      for (const name of UNRUNNABLE) expect(text, `${where} names ${name}`).not.toContain(name);
    }
    // The routing names sql and ask alone and says why.
    expect(instructions).not.toContain("- find -");
    expect(instructions).not.toContain("- search -");
    expect(instructions).toContain(`No column of ${TRANS_TABLE} is full-text indexed, so there is no find or search over it`);
    // The sql text is plain SQL over the columns, and the JOIN is over the
    // tables themselves, its keys still join_keys's to return.
    const sql = byName.get("sql") ?? "";
    expect(sql).toContain("Full-text indexed: none. ");
    expect(sql).toContain("the search functions do not apply to this table");
    expect(sql).toContain(`FROM ${ACCOUNT_TABLE} JOIN ${TRANS_TABLE} ON <the predicate join_keys returned>`);
    expect(sql).toContain("The keys are not written here: call join_keys with the tables first and paste its predicate into ON");
    expect(byName.get("join_keys")).toContain(`FROM ${TRANS_TABLE} JOIN other ON <predicate> reads as written`);
    expect(instructions).toContain("is an ask first: the loop sees every one of them");
    // No row is cited by an id: the tables have no link to cite one by.
    const cite = "Cite no row by an id: its trans_id or _id looks a row up and never goes in the answer as a reference";
    expect(instructions).toContain(cite);
    expect(byName.get("ask")).toContain(cite);
    expect(byName.get("ask")).not.toContain("use find");
  });

  it("refuses a call to search or find without reaching the platform", async () => {
    for (const name of ["search", "find"]) {
      const before = s.sent.length;
      const refused = await s.client
        .callTool({ name, arguments: { query: "PRIJEM" } })
        .then((result) => (result as { isError?: boolean }).isError === true, () => true);
      expect(refused, name).toBe(true);
      expect(s.sent.length, name).toBe(before);
    }
  });

  it("runs sql on the platform, a statement over one table asking no keys", async () => {
    const { ok, value, ops } = await call(s, "sql", {
      query: `SELECT account_id, COUNT(*) AS n FROM ${TRANS_TABLE} GROUP BY account_id ORDER BY n DESC LIMIT 5`,
      question: "which accounts have the most transactions?",
    });
    expect(ok, String(value)).toBe(true);
    expect(ops).toEqual(["query_sql", "validate"]);
    expect((value as { index: string; rows: unknown[] }).index).toBe("platform");
    expect((value as { rows: unknown[] }).rows).toEqual([{ account_id: 2378, n: 42 }]);
  });

  it("answers join_keys and runs a statement across the tables on the key it found", async () => {
    const keys = await call(s, "join_keys", { tables: [TRANS_TABLE, ACCOUNT_TABLE] });
    expect(keys.ok, String(keys.value)).toBe(true);
    expect(keys.ops).toEqual(["join_keys"]);
    const joined = await call(s, "sql", {
      query: `SELECT a.frequency, COUNT(*) AS n FROM ${TRANS_TABLE} t JOIN ${ACCOUNT_TABLE} a ON t.account_id = a.account_id GROUP BY a.frequency`,
    });
    expect(joined.ok, String(joined.value)).toBe(true);
    expect(joined.ops).toContain("query_sql");
  });

  it("asks the platform's loop with the row key as the projection, and reads the rows it cut with its statement", async () => {
    const { ok, value, ops } = await call(s, "ask", { question: "which transactions are the largest?" });
    expect(ok, String(value)).toBe(true);
    // The platform returned the first of three rows; the client ran the
    // statement again for the other two, so the model sees every row and
    // not a sample (the owner, 2026-10-04: "unacceptable to simply take the
    // top 10 results").
    expect(ops).toEqual(["sub_agent", "query_sql"]);
    const request = s.sent.find((x) => x.op === "sub_agent")?.body;
    expect(request?.projection).toEqual(["trans_id"]);
    expect(request?.tables).toEqual([ACCOUNT_TABLE, LOAN_TABLE]);
    // The last query_sql sent is this call's (the sql tests above sent their own).
    expect(s.sent.filter((x) => x.op === "query_sql").at(-1)?.body?.query).toBe(ASKED_STATEMENT);
    const result = value as { rows: Array<Record<string, unknown>>; hits: unknown[]; coverage: Record<string, unknown>; completed?: string; more?: string };
    expect(result.hits).toEqual([]);
    expect(result.rows).toEqual(ASKED_ROWS);
    expect(result.coverage).toMatchObject({ rowsTotal: 3, rowsReturned: 3, truncated: false });
    expect(result.completed).toContain("the platform returned the first 1 of 3 rows");
    expect(result).not.toHaveProperty("more");
  });

  it("never reached the platform with a drop, create or append, and wrote no manifest", () => {
    const ops = s.sent.map((x) => x.op);
    for (const forbidden of FORBIDDEN_OPS) expect(ops, `the server sent ${forbidden}`).not.toContain(forbidden);
    expect(existsSync(join(s.root, ".infino", MANIFEST_NAME))).toBe(false);
  });
});
