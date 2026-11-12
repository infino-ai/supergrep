// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The tools each consumer of a data table is offered, pinned: a server whose
// primary corpus is one table of an account (CX_TABLE) rather than the code
// index. As in consumers-code.test.ts, a tool that reaches one of these
// consumers changes a list here, and docs/plugins.md with it.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { scriptPlatform, start, stop } from "./mcp-harness.js";

/** The table the server is started for. */
const TABLE_NAME = "conversations";

// Read at module load (TABLE is a constant of config.ts) and at startup.
process.env.CX_TABLE = TABLE_NAME;
delete process.env.CX_SIBLING_TABLES;
delete process.env.CX_INDEX_DIR;
process.env.CX_NO_EMBED = "1";
const SWITCHES = ["CX_ACCOUNT_DATA", "CX_API_TOOLS", "CX_READ_ONLY", "CX_MEMORY", "CX_WEB_FETCH", "CX_PLAYBOOK"];
for (const name of SWITCHES) delete process.env[name];

const { API_KEY_ENV, configureHosted, hostedSettingsFromFlags } = await import("../src/core/config.js");

/** A table of turns: a key, a session, who spoke, and what they said. */
const SCHEMA = [
  { name: "id", nullable: true, type: "utf8" },
  { name: "session_id", nullable: true, type: "utf8" },
  { name: "role", nullable: true, type: "utf8" },
  { name: "content", nullable: true, type: "large_utf8" },
];

/** The platform with the table there and described. `card` is what the
 * platform answers for the table's card: none, or one that names the column
 * telling its kinds of row apart, which is what offers describe_columns. */
const platform = (card: "none" | "kinds") =>
  scriptPlatform({
    list_tables: () => [200, [TABLE_NAME]],
    schema: () => [200, SCHEMA],
    table_card: () =>
      card === "kinds"
        ? [
            200,
            {
              table: TABLE_NAME,
              kind_column: "role",
              schema: SCHEMA.map((c) => ({ name: c.name, type: c.type, ...(c.name === "content" ? { index: "fts" } : {}) })),
            },
          ]
        : [404, { error: `no card for table ${TABLE_NAME}` }],
    hydrate: () => [404, { error: "no load record" }],
  });

async function toolsOf(card: "none" | "kinds"): Promise<string[]> {
  const s = await start(platform(card), "cx-consumer-table-");
  try {
    const { tools } = await s.client.listTools();
    return tools.map((t) => t.name).sort();
  } finally {
    await stop(s);
  }
}

beforeAll(() => {
  configureHosted(hostedSettingsFromFlags({ db: "http://127.0.0.1:9/agent" }, { [API_KEY_ENV]: "inf_test_key_do_not_log" }));
});
afterAll(() => {
  configureHosted(null);
});
afterEach(() => {
  for (const name of SWITCHES) delete process.env[name];
});

/** A table's doors: no `read`, which reads a repository's files. */
const TABLE_DOORS = ["find", "join_keys", "search", "sql"];
const HYDRATE = ["hydrate", "hydrate_cancel", "hydrate_status"];

describe("a table server with CX_ACCOUNT_DATA unset: the table and the whole account", () => {
  it("offers the table's doors, and the account's databases through tables and hydrate", async () => {
    expect(await toolsOf("none")).toEqual([...TABLE_DOORS, ...HYDRATE, "tables"].sort());
  });
});

describe("Hermes, cloud: its conversations table, and nothing else of the account", () => {
  it("offers the table's search and sql alone (CX_ACCOUNT_DATA=table)", async () => {
    process.env.CX_ACCOUNT_DATA = "table";
    expect(await toolsOf("none")).toEqual(TABLE_DOORS.filter((t) => t !== "join_keys"));
  });
});

describe("a hosted page over one database: its tables, the checks, no other database", () => {
  it("offers the table's doors and describe_columns where the card allows (CX_ACCOUNT_DATA=database)", async () => {
    process.env.CX_ACCOUNT_DATA = "database";
    expect(await toolsOf("kinds")).toEqual(["describe_columns", ...TABLE_DOORS]);
  });

  it("with CX_API_TOOLS, the platform's routes as tools", async () => {
    process.env.CX_ACCOUNT_DATA = "database";
    process.env.CX_API_TOOLS = "1";
    expect(await toolsOf("kinds")).toEqual(["describe_columns", ...TABLE_DOORS, "table_card", "validate"]);
  });
});
