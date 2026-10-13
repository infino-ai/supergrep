// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The account's data through the MCP server, end to end on an in-memory
// transport against a scripted platform: one server, started for a
// repository with no CX_TABLE (the plugin's shape), reaches every database
// of the account by the `database` argument - sql, search, find, ask and
// join_keys over a table of a named database, `tables` for what the account
// holds, and `hydrate` for getting data in from a bucket or from files on
// this machine. Nothing is asked of the platform at startup for any of it,
// a database's tables and a table's shape are read once and kept, every
// request goes to the named database's path, and no local index is built by
// a call that named a database.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, scriptPlatform, start, stop, type Platform, type Sent, type Started } from "./mcp-harness.js";

// The environment the server reads at module load and at startup, set
// before either module is imported (every import of the client's own code
// below is dynamic for that reason).
delete process.env.CX_TABLE;
delete process.env.CX_SIBLING_TABLES;
process.env.CX_NO_EMBED = "1";
delete process.env.CX_AUTO_INDEX;
delete process.env.CX_NO_RECEIPT;
delete process.env.CX_INDEX_DIR;

const { API_KEY_ENV, MANIFEST_NAME, configureHosted, hostedSettingsFromFlags } = await import("../src/core/config.js");

/** The platform the server is started against, and the database its
 * `--db` named: the repository's own. */
const PLATFORM = "http://127.0.0.1:9";
const REPO_DB = "cxbench";
/** A data database of the account, and its tables: a bank's accounts and
 * transactions, as a hydrate loaded them - no full-text column on either,
 * a vector on neither. */
const DATA_DB = "lab";
const ACCOUNTS = "accounts";
const TRANS = "trans";
/** A third table with a text column the platform indexed and embedded, for
 * the search and find doors. */
const NOTES = "notes";

const ACCOUNTS_COLUMNS = [
  { name: "account_id", nullable: true, type: "i64" },
  { name: "district_id", nullable: true, type: "i64" },
  { name: "frequency", nullable: true, type: "utf8" },
];
const TRANS_COLUMNS = [
  { name: "trans_id", nullable: true, type: "i64" },
  { name: "account_id", nullable: true, type: "i64" },
  { name: "amount", nullable: true, type: "f64" },
];
const NOTES_COLUMNS = [
  { name: "note_id", nullable: true, type: "utf8" },
  { name: "title", nullable: true, type: "utf8" },
  { name: "body", nullable: true, type: "large_utf8" },
  { dim: 384, name: "emb", nullable: false, type: "vector" },
];
const NOTES_LOAD = {
  state: "succeeded",
  request: { table: NOTES, source: { kind: "prefix", prefix: "_source/notes/" } },
  schema: { fts: [{ column: "body", analyzer: "standard" }], embed: { column: "emb", source: ["body"] } },
};
const NOTE = { note_id: "n1", title: "Quarterly close", body: "The ledger closed on the third day.", score: 0.4 };

/** The platform's loop answering over the data database. */
const ASKED = {
  facts: [{ table: TRANS, row: { account_id: 42, total: 1200.5 } }],
  statement: `SELECT account_id, SUM(amount) AS total FROM ${TRANS} GROUP BY account_id ORDER BY total DESC LIMIT 1`,
  coverage: { rows_total: 1, rows_returned: 1, truncated: false },
  terminate: "answered",
  turns: 1,
  retries: 0,
  model_tokens: 500,
};

/** The writes a call that named a database may never make: the table
 * routes are read, and only hydrate and the account plane write. */
const FORBIDDEN_OPS = ["drop_table", "create_table", "append", "delete", "update"];

/** Where upload sessions point: the storage host, not the platform's. */
const STORAGE = "https://storage.test";

/** The account with two databases and their tables, every read answering
 * and no card anywhere. The `hydrate` route answers by method and path:
 * a status read, an upload opening, a submit, a cancel. */
function account(): Platform {
  const schemas: Record<string, unknown> = { [ACCOUNTS]: ACCOUNTS_COLUMNS, [TRANS]: TRANS_COLUMNS, [NOTES]: NOTES_COLUMNS };
  return scriptPlatform({
    databases: (body, request) =>
      request.method === "POST" ? (body?.name === DATA_DB ? [409, { error: "exists" }] : [201, { name: body?.name }]) : [200, { databases: [{ name: REPO_DB, state: "registered" }, { name: DATA_DB, state: "registered" }] }],
    list_tables: (_body, request) => (request.path.endsWith(`/${DATA_DB}`) ? [200, [ACCOUNTS, TRANS, NOTES]] : [200, ["chunks"]]),
    schema: (body) => (schemas[String(body?.table_name)] ? [200, schemas[String(body?.table_name)]] : [404, { error: `no such table ${String(body?.table_name)}` }]),
    table_card: (body) => [404, { error: `no lean card for table ${String(body?.table)}` }],
    vector_search: () => [200, [{ _id: 1, score: 0.2 }]],
    hybrid_search: () => [200, [NOTE]],
    query_sql: (body) => {
      const query = String(body?.query);
      if (query.includes("token_match")) return [200, [{ __cx_total: 1, ...NOTE }]];
      return [200, [{ account_id: 42, n: 7 }]];
    },
    validate: () => [200, { valid: true, check: "unchecked" }],
    join_keys: () => [200, { joins: [{ from_table: TRANS, to_table: ACCOUNTS, predicate: `${TRANS}.account_id = ${ACCOUNTS}.account_id` }] }],
    sub_agent: () => [200, ASKED],
    hydrate: (body, request) => {
      if (request.method === "GET") return body?.table === NOTES ? [200, NOTES_LOAD] : [200, { job: `${String(body?.table)}-1`, state: "running", progress: { rows: 10 } }];
      if (request.method === "DELETE") return body?.table === "ended" ? [200, null] : [202, { job: `${String(body?.table)}-1`, state: "cancelling" }];
      if (request.path.endsWith("/uploads")) {
        const files = body?.files as Array<{ name: string }>;
        return [200, { upload: "up1", prefix: "_source/up1/", files: files.map((f, i) => ({ name: f.name, url: `${STORAGE}/session/${i}` })) }];
      }
      if (body?.table === "refused") return [403, { error: "uploads are for accounts that bring their own data self-serve" }];
      if (body?.dry_run) return [200, { job: `${String(body?.table)}-1`, admissible: true }];
      return [202, { job: `${String(body?.table)}-1`, state: "pending" }];
    },
    "storage.test": () => [200, {}],
  });
}

function expectNothingBuilt(started: Started, since = 0): void {
  const ops = started.sent.slice(since).map((s) => s.op);
  for (const forbidden of FORBIDDEN_OPS) expect(ops, `the server sent ${forbidden}`).not.toContain(forbidden);
  expect(existsSync(join(started.root, ".infino", MANIFEST_NAME))).toBe(false);
}

/** The requests of one call that went to the named database's path. */
const toDatabase = (sent: Sent[], database: string) => sent.filter((s) => s.path.startsWith(`${s.op}/${database}`) || s.path === `${s.op}/${database}`);

beforeAll(() => {
  configureHosted(hostedSettingsFromFlags({ db: `${PLATFORM}/${REPO_DB}` }, { [API_KEY_ENV]: "inf_test_key_do_not_log" }));
});

afterAll(() => {
  configureHosted(null);
});

describe("the account's data through the server started for a repository", () => {
  let s: Started;
  beforeAll(async () => {
    s = await start(account(), "cx-data-");
  });
  afterAll(async () => {
    await stop(s);
  });

  it("asks the platform nothing about the account's data at startup", () => {
    expect(s.startup).toEqual(["table_card", "table_card"]);
  });

  it("registers tables, hydrate, hydrate_status and hydrate_cancel, and database on every query tool", async () => {
    const { tools } = await s.client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const name of ["tables", "hydrate", "hydrate_status", "hydrate_cancel"]) expect(byName.has(name), name).toBe(true);
    for (const name of ["sql", "search", "find", "ask", "join_keys"]) {
      const schema = byName.get(name)?.inputSchema as { properties?: Record<string, unknown> };
      expect(Object.keys(schema.properties ?? {}), name).toContain("database");
    }
    expect(byName.get("tables")?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get("hydrate")?.annotations?.readOnlyHint).toBe(false);
    expect(byName.get("hydrate_cancel")?.annotations?.destructiveHint).toBe(true);
    const instructions = s.client.getInstructions() ?? "";
    expect(instructions).toContain("- tables - the databases of this Infino account");
    expect(instructions).toContain("- hydrate - load a dataset");
    for (const name of ["sql", "search", "find", "ask"]) expect(byName.get(name)?.description).toContain("With database (and table)");
  });

  it("tables lists the account's databases with their tables, a chunks table marking a repository's index", async () => {
    const { ok, value, ops } = await call(s, "tables", {});
    expect(ok, String(value)).toBe(true);
    expect(ops).toEqual(["databases", "list_tables", "list_tables"]);
    const listed = value as { databases: Array<{ name: string; kind: string; tables: string[] }> };
    expect(listed.databases).toEqual([
      { name: REPO_DB, state: "registered", kind: "code", tables: ["chunks"] },
      { name: DATA_DB, state: "registered", kind: "data", tables: [ACCOUNTS, TRANS, NOTES] },
    ]);
  });

  it("tables with a database answers from what it read, and with a table reads the shape once", async () => {
    const named = await call(s, "tables", { database: DATA_DB });
    expect(named.ok, String(named.value)).toBe(true);
    expect(named.ops).toEqual([]);
    expect(named.value).toEqual({ database: DATA_DB, tables: [ACCOUNTS, TRANS, NOTES] });

    const shaped = await call(s, "tables", { database: DATA_DB, table: NOTES });
    expect(shaped.ok, String(shaped.value)).toBe(true);
    // Schema, the two card tiers, the load's record, and the check that the
    // platform embeds a query for the vector column - all on the database's path.
    expect(shaped.ops).toEqual(["schema", "table_card", "table_card", "hydrate", "vector_search"]);
    for (const sent of s.sent.slice(-5)) expect(sent.path.startsWith(`${sent.op}/${DATA_DB}`), sent.path).toBe(true);
    const shape = shaped.value as Record<string, unknown>;
    // No card named the indexes: the long-text column stands in, and the
    // result says the list is inferred.
    expect(shape.text_columns).toEqual(["body"]);
    expect(shape.text_columns_inferred).toBe(true);
    expect(shape.primary_text).toBe("body");
    expect(shape.vector_column).toBe("emb");
    expect(shape.key_column).toBe("note_id");
    expect(shape.columns).toEqual([
      { name: "note_id", type: "utf8" },
      { name: "title", type: "utf8" },
      { name: "body", type: "large_utf8" },
      { name: "emb", type: "vector<384>" },
    ]);
    expect(String(shape.how)).toContain(`search and find with table "${NOTES}"`);

    const again = await call(s, "tables", { database: DATA_DB, table: NOTES });
    expect(again.ops).toEqual([]);
  });

  it("sql with a database runs on the platform against that database, judged against the table it names, and builds nothing", async () => {
    const before = s.sent.length;
    const { ok, value, ops } = await call(s, "sql", {
      database: DATA_DB,
      query: `SELECT account_id, COUNT(*) AS n FROM ${TRANS} GROUP BY account_id ORDER BY n DESC LIMIT 5`,
      question: "which account has the most transactions",
    });
    expect(ok, String(value)).toBe(true);
    // The trans table's shape (no card, no load record for it, no vector),
    // then the statement, then the verdict - every one on the data database.
    expect(ops).toEqual(["schema", "table_card", "table_card", "hydrate", "query_sql", "validate"]);
    expect(toDatabase(s.sent.slice(before), DATA_DB).length).toBe(ops.length);
    const result = value as { rows: unknown[]; index: string; database: string; validation?: { valid: boolean } };
    expect(result.index).toBe("platform");
    expect(result.database).toBe(DATA_DB);
    expect(result.rows).toEqual([{ account_id: 42, n: 7 }]);
    expect(result.validation?.valid).toBe(true);
    expect(s.sent.find((x) => x.op === "validate")?.body).toMatchObject({ table_name: TRANS, field_name: "" });
    expectNothingBuilt(s, before);
  });

  it("sql across two tables of the database is held to the platform's keys", async () => {
    const refused = await call(s, "sql", {
      database: DATA_DB,
      query: `SELECT a.frequency, COUNT(*) FROM ${TRANS} t JOIN ${ACCOUNTS} a ON t.trans_id = a.district_id GROUP BY a.frequency`,
    });
    expect(refused.ok).toBe(false);
    expect(String(refused.value)).toContain(`${TRANS}.account_id = ${ACCOUNTS}.account_id`);
    expect(refused.ops).toEqual(["join_keys"]);
    const run = await call(s, "sql", {
      database: DATA_DB,
      query: `SELECT a.frequency, COUNT(*) AS n FROM ${TRANS} t JOIN ${ACCOUNTS} a ON t.account_id = a.account_id GROUP BY a.frequency`,
    });
    expect(run.ok, String(run.value)).toBe(true);
    // The keys were kept from the refusal. The verdict is judged against
    // the first of the database's tables the statement names - accounts,
    // in the database's own order - whose shape is read here, once.
    expect(run.ops).toEqual(["schema", "table_card", "table_card", "hydrate", "query_sql", "validate"]);
    expect(s.sent.at(-1)?.body).toMatchObject({ table_name: ACCOUNTS });
  });

  it("search and find with a database and table run over that table's text column", async () => {
    const searched = await call(s, "search", { database: DATA_DB, table: NOTES, query: "ledger closed", k: 3 });
    expect(searched.ok, String(searched.value)).toBe(true);
    expect(searched.ops).toEqual(["hybrid_search"]);
    expect(s.sent.at(-1)?.body).toMatchObject({ table_name: NOTES, text_field: "body", vector_field: "emb", k: 3 });
    const hits = (searched.value as { hits: Array<Record<string, unknown>>; database: string }).hits;
    expect(hits[0].note_id).toBe("n1");
    expect((searched.value as { database: string }).database).toBe(DATA_DB);

    const found = await call(s, "find", { database: DATA_DB, table: NOTES, query: "ledger" });
    expect(found.ok, String(found.value)).toBe(true);
    expect(found.ops).toEqual(["query_sql"]);
    expect(String(s.sent.at(-1)?.body?.query)).toContain(`token_match('${NOTES}', 'body', 'ledger', 'and')`);
    expect((found.value as { total: number }).total).toBe(1);

    const noTable = await call(s, "search", { database: DATA_DB, query: "ledger" });
    expect(noTable.ok).toBe(false);
    expect(String(noTable.value)).toContain("name the table");
  });

  it("search over a table with no text column says so instead of calling the platform", async () => {
    const { ok, value, ops } = await call(s, "search", { database: DATA_DB, table: ACCOUNTS, query: "monthly" });
    expect(ok).toBe(false);
    expect(String(value)).toContain("is full-text indexed");
    // The shape was read when a statement named the table; no search ran.
    expect(ops).not.toContain("hybrid_search");
    expect(ops).not.toContain("bm25_search");
  });

  it("ask with a database runs the platform's loop over the whole database, or over the tables named", async () => {
    const whole = await call(s, "ask", { database: DATA_DB, question: "which account moved the most money" });
    expect(whole.ok, String(whole.value)).toBe(true);
    expect(whole.ops).toEqual(["sub_agent"]);
    const request = s.sent.at(-1)!;
    expect(request.path).toBe(`sub_agent/${DATA_DB}`);
    expect(request.body).not.toHaveProperty("table");
    expect(request.body).not.toHaveProperty("tables");
    // No projection: the chunks table's place columns name no column of a
    // data table, and the platform refuses such a projection (live, 2026-10-11).
    expect(request.body).not.toHaveProperty("projection");
    const result = whole.value as { rows: unknown[]; database: string; statement?: string };
    expect(result.database).toBe(DATA_DB);
    expect(result.rows).toEqual([{ account_id: 42, total: 1200.5 }]);

    const some = await call(s, "ask", { database: DATA_DB, question: "the same", tables: [TRANS, ACCOUNTS] });
    expect(some.ok, String(some.value)).toBe(true);
    expect(s.sent.at(-1)?.body).toMatchObject({ tables: [TRANS, ACCOUNTS] });
    expect(s.sent.at(-1)?.body).not.toHaveProperty("projection");

    const one = await call(s, "ask", { database: DATA_DB, question: "notes about the close", tables: [NOTES] });
    expect(one.ok, String(one.value)).toBe(true);
    // One table named: its shape (kept from before) places the facts.
    expect(one.ops).toEqual(["sub_agent"]);
    expect(s.sent.at(-1)?.body).toMatchObject({ table: NOTES, projection: ["note_id"] });
  });

  it("join_keys with a database asks that database", async () => {
    const { ok, value, ops } = await call(s, "join_keys", { database: DATA_DB, tables: [TRANS, ACCOUNTS] });
    expect(ok, String(value)).toBe(true);
    expect(ops).toEqual(["join_keys"]);
    expect(s.sent.at(-1)?.path).toBe(`join_keys/${DATA_DB}`);
  });

  it("hydrate from a bucket registers the database and submits the platform's own request; a dry run writes nothing", async () => {
    const dry = await call(s, "hydrate", { database: "fresh", table: "events", kind: "bucket", bucket: "acme-exports", prefix: "events/", fts: ["message"], dry_run: true });
    expect(dry.ok, String(dry.value)).toBe(true);
    // A dry run registers nothing: the account's databases are listed, the
    // request checked.
    expect(dry.ops).toEqual(["databases", "hydrate"]);
    expect(s.sent.at(-2)?.method).toBe("GET");
    expect(s.sent.at(-1)?.body).toEqual({ table: "events", source: { kind: "bucket", bucket: "acme-exports", prefix: "events/" }, format: "auto", fts: [{ column: "message" }], dry_run: true });
    expect(dry.value).toMatchObject({ dry_run: true, admissible: true, database: expect.stringContaining("not a database of this account yet") });

    const real = await call(s, "hydrate", { database: "fresh", table: "events", kind: "bucket", bucket: "acme-exports", prefix: "events/", embed: { column: "emb", source: ["message"] }, if_exists: "append", options: { csv: { delimiter: ";" } } });
    expect(real.ok, String(real.value)).toBe(true);
    expect(real.ops).toEqual(["databases", "hydrate"]);
    const register = s.sent.at(-2)!;
    expect(register.method).toBe("POST");
    expect(register.body).toEqual({ name: "fresh" });
    const submit = s.sent.at(-1)!;
    expect(submit.method).toBe("POST");
    expect(submit.path).toBe("hydrate/fresh");
    expect(submit.body).toEqual({
      csv: { delimiter: ";" },
      table: "events",
      source: { kind: "bucket", bucket: "acme-exports", prefix: "events/" },
      format: "auto",
      embed: { column: "emb", source: ["message"] },
      if_exists: "append",
    });
    expect(real.value).toMatchObject({ job: "events-1", state: "pending", database: "registered fresh on the account", follow: expect.stringContaining("hydrate_status") });
  });

  it("hydrate from files on this machine lists them, opens their upload sessions, puts every byte, and loads the prefix they landed in", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cx-hydrate-src-"));
    mkdirSync(join(dir, "2024"));
    writeFileSync(join(dir, "2024", "jan.csv"), "a,b\n1,2\n");
    writeFileSync(join(dir, "readme.txt"), "about");
    try {
      const before = s.sent.length;
      const { ok, value } = await call(s, "hydrate", { database: DATA_DB, table: "ledger", kind: "path", path: dir });
      expect(ok, String(value)).toBe(true);
      const sent = s.sent.slice(before);
      expect(sent.map((x) => `${x.method} ${x.op}`)).toEqual(["POST databases", "POST hydrate", "PUT storage.test", "PUT storage.test", "POST hydrate"]);
      const opened = sent[1];
      expect(opened.path).toBe(`hydrate/${DATA_DB}/uploads`);
      expect(opened.body).toEqual({ origin: PLATFORM, files: [{ name: "2024/jan.csv", size: 8 }, { name: "readme.txt", size: 5 }] });
      // Each file's bytes went to its own session, whole.
      expect(sent.slice(2, 4).map((x) => [x.path, x.body?.bytes]).sort()).toEqual([["/session/0", 8], ["/session/1", 5]]);
      expect(sent[4].body).toEqual({ table: "ledger", source: { kind: "prefix", prefix: "_source/up1/" }, format: "auto" });
      expect(value).toMatchObject({ uploaded: { files: 2, bytes: 13, prefix: "_source/up1/" }, job: "ledger-1", state: "pending" });
      // The tables of the database are read again after a load into it.
      const listed = await call(s, "tables", { database: DATA_DB });
      expect(listed.ops).toEqual(["list_tables"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("hydrate from files on a dry run counts them and uploads nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cx-hydrate-dry-"));
    writeFileSync(join(dir, "one.parquet"), "xxxx");
    try {
      const { ok, value, ops } = await call(s, "hydrate", { database: DATA_DB, kind: "path", path: dir, dry_run: true });
      expect(ok, String(value)).toBe(true);
      expect(ops).toEqual(["databases"]);
      expect(value).toMatchObject({ dry_run: true, files: 1, bytes: 4, would: expect.stringContaining("one table per folder") });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("hydrate from files that cannot be listed registers no database", async () => {
    const missing = join(tmpdir(), "cx-hydrate-missing", "nowhere");
    const { ok, value, ops } = await call(s, "hydrate", { database: "never-made", table: "t", kind: "path", path: missing });
    expect(ok).toBe(false);
    expect(String(value)).toContain("nowhere");
    expect(ops).toEqual([]);
  });

  it("hydrate passes the platform's refusal through, in its words", async () => {
    const { ok, value } = await call(s, "hydrate", { database: DATA_DB, table: "refused", kind: "prefix", prefix: "_source/x/" });
    expect(ok).toBe(false);
    expect(String(value)).toContain("uploads are for accounts that bring their own data self-serve");
  });

  it("a source missing what its kind needs is refused before any request", async () => {
    const { ok, value, ops } = await call(s, "hydrate", { database: DATA_DB, table: "t", kind: "ssh", path: "/data" });
    expect(ok).toBe(false);
    expect(String(value)).toContain("names the host and the path");
    expect(ops).toEqual([]);
  });

  it("hydrate_status reads the job's record and hydrate_cancel stops or clears it", async () => {
    const status = await call(s, "hydrate_status", { database: DATA_DB, table: "ledger" });
    expect(status.ok, String(status.value)).toBe(true);
    expect(status.ops).toEqual(["hydrate"]);
    expect(s.sent.at(-1)).toMatchObject({ method: "GET", path: `hydrate/${DATA_DB}`, body: { table: "ledger" } });
    expect(status.value).toMatchObject({ job: "ledger-1", state: "running" });

    const cancel = await call(s, "hydrate_cancel", { database: DATA_DB, table: "ledger" });
    expect(cancel.ok, String(cancel.value)).toBe(true);
    expect(s.sent.at(-1)).toMatchObject({ method: "DELETE", path: `hydrate/${DATA_DB}`, body: { table: "ledger" } });
    expect(cancel.value).toEqual({ database: DATA_DB, table: "ledger", cancelling: { job: "ledger-1", state: "cancelling" } });

    const clear = await call(s, "hydrate_cancel", { database: DATA_DB, table: "ended" });
    expect(clear.ok, String(clear.value)).toBe(true);
    expect(clear.value).toEqual({ database: DATA_DB, table: "ended", cleared: true });
  });

  it("never wrote a table, dropped one, appended to one, or built a local index", () => {
    expectNothingBuilt(s);
  });
});

describe("the tables a load makes, as the server keeps them", () => {
  /** The table a load is making, and one made by a load this server never
   * followed. */
  const EVENTS = "events";
  const LATE = "late";
  /** What the platform holds: the database's tables and the load's state,
   * changed by each test as the load moves. */
  let tables: string[] = [ACCOUNTS];
  let state = "running";
  let s: Started;
  beforeAll(async () => {
    s = await start(
      scriptPlatform({
        list_tables: () => [200, tables],
        schema: (body) => (tables.includes(String(body?.table_name)) ? [200, ACCOUNTS_COLUMNS] : [404, { error: `no such table ${String(body?.table_name)}` }]),
        table_card: (body) => [404, { error: `no lean card for table ${String(body?.table)}` }],
        query_sql: () => [200, [{ account_id: 42 }]],
        validate: () => [200, { valid: true, check: "unchecked" }],
        hydrate: (body) => [200, { job: `${String(body?.table)}-1`, state }],
      }),
      "cx-data-cache-",
    );
  });
  afterAll(async () => {
    await stop(s);
  });

  it("a status read that sees the load end shows the table it made; one that sees it running keeps what was read", async () => {
    const before = await call(s, "tables", { database: DATA_DB });
    expect(before.value).toEqual({ database: DATA_DB, tables: [ACCOUNTS] });

    tables = [ACCOUNTS, EVENTS];
    const running = await call(s, "hydrate_status", { database: DATA_DB, table: EVENTS });
    expect(running.value).toMatchObject({ state: "running" });
    const still = await call(s, "tables", { database: DATA_DB });
    expect(still.ops).toEqual([]);
    expect(still.value).toEqual({ database: DATA_DB, tables: [ACCOUNTS] });

    state = "succeeded";
    const ended = await call(s, "hydrate_status", { database: DATA_DB, table: EVENTS });
    expect(ended.value).toMatchObject({ state: "succeeded" });
    const after = await call(s, "tables", { database: DATA_DB });
    expect(after.ops).toEqual(["list_tables"]);
    expect(after.value).toEqual({ database: DATA_DB, tables: [ACCOUNTS, EVENTS] });
  });

  it("sql reads the tables once more before refusing one the kept list lacks", async () => {
    tables = [ACCOUNTS, EVENTS, LATE];
    const late = await call(s, "sql", { database: DATA_DB, table: LATE, query: `SELECT account_id FROM ${LATE}` });
    expect(late.ok, String(late.value)).toBe(true);
    expect(late.ops[0]).toBe("list_tables");

    const missing = await call(s, "sql", { database: DATA_DB, table: "nosuch", query: "SELECT 1 FROM nosuch" });
    expect(missing.ok).toBe(false);
    expect(missing.ops).toEqual(["list_tables"]);
    expect(String(missing.value)).toContain(`its tables are ${ACCOUNTS}, ${EVENTS}, ${LATE}`);
  });
});
