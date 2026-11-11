// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The server's start-up waits on the database's other tables for a fixed
// time only (STARTUP_BUDGET_MS), end to end through the MCP server on an
// in-memory transport against a scripted platform. On a database of a few
// hundred tables behind the platform's per-account rate limit, describing
// every other table before the handshake can take longer than Claude Code
// gives a server to start, and the session gets no tools at all. Here one other table never answers
// its schema, or one never answers its card: the handshake goes ahead at the
// budget, the table the server is for is described whole whatever it takes,
// what was read of the others is described, and what was not is named as a
// table that could not be described.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { scriptPlatform, start, stop, type Answer, type Started } from "./mcp-harness.js";

/** The table the server is for, and the others of its database. */
const TRANS_TABLE = "berka_trans";
const ACCOUNT_TABLE = "berka_account";
/** A table whose schema the platform never answers. */
const MUTE_SCHEMA_TABLE = "mute_schema";
/** A table whose card the platform never answers. */
const MUTE_CARD_TABLE = "mute_card";

/** The wait on the other tables these servers are started with. */
const BUDGET_MS = 300;
/** How long the primary's own card takes in the slow-primary case: longer
 * than the budget, which must not cut it. */
const SLOW_PRIMARY_CARD_MS = 600;
/** The most a start-up here may take: the budget, the slow primary's card,
 * and room for a loaded test machine - far below what it took to wait out a
 * read that never answers (the call's own 60 s). */
const STARTUP_CEILING_MS = 5_000;

process.env.CX_TABLE = TRANS_TABLE;
process.env.CX_REMOTE_SEARCH = "1";
process.env.CX_NO_EMBED = "1";
delete process.env.CX_AUTO_INDEX;
delete process.env.CX_NO_RECEIPT;
delete process.env.CX_INDEX_DIR;

const { API_KEY_ENV, configureHosted, hostedSettingsFromFlags } = await import("../src/core/config.js");

const SCHEMAS: Record<string, Array<{ name: string; type: string }>> = {
  [TRANS_TABLE]: [
    { name: "trans_id", type: "i64" },
    { name: "account_id", type: "i64" },
    { name: "amount", type: "f64" },
  ],
  [ACCOUNT_TABLE]: [
    { name: "account_id", type: "i64" },
    { name: "frequency", type: "utf8" },
  ],
  [MUTE_SCHEMA_TABLE]: [{ name: "never_seen", type: "i64" }],
  [MUTE_CARD_TABLE]: [
    { name: "card_id", type: "i64" },
    { name: "issued", type: "i64" },
  ],
};

/** A card the optimizer would write for a table with no index. */
const cardOf = (table: string, rows: number) => ({ table, rows, schema: SCHEMAS[table].map((c) => ({ name: c.name, index: "scalar" })) });
/** Distinct row counts, so each card is told apart in the text. */
const ROWS: Record<string, number> = { [TRANS_TABLE]: 1_056_320, [ACCOUNT_TABLE]: 4_500, [MUTE_CARD_TABLE]: 892 };

/** An answer that never comes: the request hangs until the client abandons
 * it, as a platform call that answers nothing does. */
const never = (signal?: AbortSignal): Promise<Answer> =>
  new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(signal.reason));
  });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The database of `tables` (the primary first), each answering its schema
 * and card at once, except the mute ones; the primary's card after
 * `primaryCardMs`. */
const platform = (tables: string[], primaryCardMs = 0) =>
  scriptPlatform({
    list_tables: () => [200, tables],
    schema: (body, request) => {
      const table = String(body?.table_name);
      return table === MUTE_SCHEMA_TABLE ? never(request.signal) : [200, SCHEMAS[table]];
    },
    table_card: async (query, request) => {
      const table = String(query?.table);
      if (table === MUTE_CARD_TABLE) return never(request.signal);
      if (table === TRANS_TABLE) await sleep(primaryCardMs);
      return [200, cardOf(table, ROWS[table])];
    },
    hydrate: () => [200, { state: "succeeded", request: { table: TRANS_TABLE, source: { kind: "bucket", prefix: "berka/trans/" } } }],
  });

beforeAll(() => {
  configureHosted(hostedSettingsFromFlags({ db: "http://127.0.0.1:9/testdb" }, { [API_KEY_ENV]: "inf_test_key_do_not_log" }));
});

afterAll(() => {
  configureHosted(null);
});

/** The sql tool's text and the server's instructions. */
async function texts(s: Started): Promise<{ sql: string; instructions: string }> {
  const { tools } = await s.client.listTools();
  return { sql: tools.find((t) => t.name === "sql")?.description ?? "", instructions: s.client.getInstructions() ?? "" };
}

describe("another table whose card never answers", () => {
  let s: Started;
  let logged: string[];
  beforeAll(async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      s = await start(platform([TRANS_TABLE, ACCOUNT_TABLE, MUTE_CARD_TABLE]), "cx-budget-card-", { startupBudgetMs: BUDGET_MS });
    } finally {
      logged = spy.mock.calls.map((args) => String(args[0]));
      spy.mockRestore();
    }
  });
  afterAll(async () => {
    await stop(s);
  });

  it("goes ahead at the budget instead of waiting the card out", () => {
    expect(s.startupMs).toBeGreaterThanOrEqual(BUDGET_MS - 50);
    expect(s.startupMs).toBeLessThan(STARTUP_CEILING_MS);
    // Every read was made, the mute card's too: it was abandoned, not skipped.
    expect(s.startup).toEqual(["list_tables", "schema", "schema", "schema", "table_card", "hydrate", "table_card", "table_card"]);
  });

  it("describes every table, the mute one from its schema alone, and folds in the cards that came", async () => {
    const { sql } = await texts(s);
    expect(sql).toContain(`Also in this database, and joinable with ${TRANS_TABLE} in one statement: `);
    expect(sql).toContain(`${ACCOUNT_TABLE}(account_id`);
    expect(sql).toContain(`${MUTE_CARD_TABLE}(card_id`);
    expect(sql).not.toContain("could not be described when this server started");
    expect(sql).toContain(`${TRANS_TABLE}: ${JSON.stringify(cardOf(TRANS_TABLE, ROWS[TRANS_TABLE]))}`);
    expect(sql).toContain(`${ACCOUNT_TABLE}: ${JSON.stringify(cardOf(ACCOUNT_TABLE, ROWS[ACCOUNT_TABLE]))}`);
    expect(sql).not.toContain(`${MUTE_CARD_TABLE}: {`);
  });

  it("offers describe_columns for the card left out, though every card that came lists its columns whole", async () => {
    const { tools } = await s.client.listTools();
    const describe = tools.find((t) => t.name === "describe_columns");
    expect(describe).toBeDefined();
    expect(JSON.stringify(describe?.inputSchema)).toContain(MUTE_CARD_TABLE);
    expect(s.client.getInstructions()).toContain("describe_columns");
  });

  it("says once on stderr what the budget cut, not once a table", () => {
    const cut = logged.filter((line) => line.includes("of this server's start-up"));
    expect(cut).toEqual([
      `the database's other tables were read for ${BUDGET_MS / 1000} s of this server's start-up: of 2, 1 are described ` +
        "without their cards and 0 not at all (the sql text names them as tables that could not be described)",
    ]);
    expect(logged.filter((line) => line.startsWith("no table card in the sql description"))).toEqual([]);
  });
});

describe("another table whose schema never answers, and a primary slower than the budget", () => {
  let s: Started;
  beforeAll(async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      s = await start(platform([TRANS_TABLE, ACCOUNT_TABLE, MUTE_SCHEMA_TABLE], SLOW_PRIMARY_CARD_MS), "cx-budget-schema-", {
        startupBudgetMs: BUDGET_MS,
      });
    } finally {
      spy.mockRestore();
    }
  });
  afterAll(async () => {
    await stop(s);
  });

  it("waits for its own table's card past the budget, and asks nothing of the others after it", () => {
    expect(s.startupMs).toBeGreaterThanOrEqual(SLOW_PRIMARY_CARD_MS);
    expect(s.startupMs).toBeLessThan(STARTUP_CEILING_MS);
    // The primary's card and load record come after the schemas, as always;
    // by then the budget is spent, so no other table's card is asked for.
    expect(s.startup).toEqual(["list_tables", "schema", "schema", "schema", "table_card", "hydrate"]);
  });

  it("describes its own table whole, the others as far as they were read, and names the one it could not", async () => {
    const { sql, instructions } = await texts(s);
    expect(sql).toContain(JSON.stringify(cardOf(TRANS_TABLE, ROWS[TRANS_TABLE])));
    expect(sql).toContain(`${ACCOUNT_TABLE}(account_id`);
    expect(sql).not.toContain(JSON.stringify(cardOf(ACCOUNT_TABLE, ROWS[ACCOUNT_TABLE])));
    expect(sql).toContain(`(${MUTE_SCHEMA_TABLE} could not be described when this server started;`);
    // The table is still one of the database's: the model is told it is there.
    expect(instructions).toContain(`${TRANS_TABLE}, ${ACCOUNT_TABLE}, ${MUTE_SCHEMA_TABLE}`);
  });

  it("keeps the tools a table of rows has, and describe_columns for the card the budget left out", async () => {
    const { tools } = await s.client.listTools();
    const names = tools.map((t) => t.name);
    for (const name of ["sql", "join_keys", "describe_columns"]) expect(names, name).toContain(name);
    expect(names).not.toContain("ask");
  });
});
