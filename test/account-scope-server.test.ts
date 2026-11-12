// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// How much of the account a server started for one table reaches
// (CX_ACCOUNT_DATA): its whole database in the `database` scope, and the
// table alone in the `table` scope. The database holds the server's table and
// a second one, `payroll`; in the `table` scope nothing the model can call
// reaches `payroll`, and a statement naming it is refused before the
// platform runs it.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, scriptPlatform, start, stop, type Platform, type Started } from "./mcp-harness.js";

/** The table the server is started for, and the other table beside it. */
const JOBS = "jobs";
const PAYROLL = "payroll";

// Read at module load (TABLE is a constant of config.ts) and at startup.
process.env.CX_TABLE = JOBS;
process.env.CX_NO_EMBED = "1";
delete process.env.CX_INDEX_DIR;
delete process.env.CX_ACCOUNT_DATA;
delete process.env.CX_API_TOOLS;

const { API_KEY_ENV, accountDataScope, configureHosted, hostedSettingsFromFlags } = await import("../src/core/config.js");

const SCHEMAS: Record<string, unknown> = {
  [JOBS]: [
    { name: "id", nullable: true, type: "utf8" },
    { name: "title", nullable: true, type: "large_utf8" },
  ],
  [PAYROLL]: [
    { name: "employee_id", nullable: true, type: "utf8" },
    { name: "salary", nullable: true, type: "f64" },
  ],
};

/** The database: both tables listed and described, no card, every read
 * answering. */
const platform = (): Platform =>
  scriptPlatform({
    list_tables: () => [200, [JOBS, PAYROLL]],
    schema: (body) => [200, SCHEMAS[String(body?.table_name)]],
    table_card: () => [404, { error: "no card" }],
    hydrate: () => [404, { error: "no load record" }],
    query_sql: () => [200, [{ n: 3 }]],
    validate: () => [200, { valid: true, check: "unchecked" }],
    join_keys: () => [200, { joins: [] }],
  });

/** The statements this file sends, and what each names. */
const OWN = `SELECT COUNT(*) AS n FROM ${JOBS}`;
const OTHERS = [
  `SELECT * FROM ${PAYROLL}`,
  `SELECT j.title FROM ${JOBS} j JOIN ${PAYROLL} p ON j.id = p.employee_id`,
  `SELECT * FROM bm25_search('${PAYROLL}', 'employee_id', 'x', 5)`,
  `WITH p AS (SELECT * FROM "${PAYROLL}") SELECT COUNT(*) FROM p`,
];

beforeAll(() => {
  configureHosted(hostedSettingsFromFlags({ db: "http://127.0.0.1:9/hr" }, { [API_KEY_ENV]: "inf_test_key_do_not_log" }));
});
afterAll(() => {
  configureHosted(null);
});

describe("CX_ACCOUNT_DATA's values", () => {
  it("reads account, database and table, and the switch's on and off words", () => {
    for (const value of [undefined, "", "account", "1", "true", "YES"]) {
      expect(accountDataScope({ CX_ACCOUNT_DATA: value }), String(value)).toBe("account");
    }
    for (const value of ["database", "0", "false", "no"]) expect(accountDataScope({ CX_ACCOUNT_DATA: value }), value).toBe("database");
    expect(accountDataScope({ CX_ACCOUNT_DATA: " Table " })).toBe("table");
  });

  it("refuses any other value rather than serve more than was meant", () => {
    expect(() => accountDataScope({ CX_ACCOUNT_DATA: "tables" })).toThrow(/not a scope: account, database or table/);
  });
});

describe("the database scope: every table of its own database", () => {
  let s: Started;
  beforeAll(async () => {
    s = await start(platform(), "cx-scope-db-", { accountData: "database" });
  });
  afterAll(async () => {
    await stop(s);
  });

  it("describes the other table and offers join_keys, but not the account's other databases", async () => {
    const { tools } = await s.client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("join_keys");
    expect(names).not.toContain("tables");
    expect(tools.find((t) => t.name === "sql")?.description).toContain(PAYROLL);
  });

  it("runs a statement over the other table", async () => {
    const result = await call(s, "sql", { query: OTHERS[0] });
    expect(result.ok, String(result.value)).toBe(true);
    expect(result.ops).toContain("query_sql");
  });
});

describe("the table scope: its own table and nothing else of the database", () => {
  let s: Started;
  beforeAll(async () => {
    s = await start(platform(), "cx-scope-table-", { accountData: "table" });
  });
  afterAll(async () => {
    await stop(s);
  });

  it("never describes the other table and offers no join_keys", async () => {
    // The startup reads the server's own table alone.
    expect(s.sent.filter((x) => x.op === "schema").map((x) => x.body?.table_name)).toEqual([JOBS]);
    const { tools } = await s.client.listTools();
    expect(tools.map((t) => t.name)).not.toContain("join_keys");
    for (const tool of tools) expect(tool.description ?? "", tool.name).not.toContain(PAYROLL);
    expect(s.client.getInstructions() ?? "").not.toContain(PAYROLL);
  });

  it("refuses every statement that names the other table, without running it", async () => {
    for (const query of OTHERS) {
      const result = await call(s, "sql", { query });
      expect(result.ok, query).toBe(false);
      expect(String(result.value), query).toContain(`reads the ${JOBS} table alone, and the statement names ${PAYROLL}`);
      expect(result.ops, query).not.toContain("query_sql");
    }
  });

  it("runs a statement over its own table", async () => {
    const result = await call(s, "sql", { query: OWN });
    expect(result.ok, String(result.value)).toBe(true);
    expect(result.ops).toContain("query_sql");
  });
});
