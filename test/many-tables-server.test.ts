// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// A table in a database of many tables: the other tables are named once, in
// the sql tool's text, and nowhere else the model reads. Written out with
// their columns and cards, and named again in the instructions and the other
// tools' texts, a 444-table database made the sql text alone 2.2 million
// characters (2026-11-16). End to end through the MCP server against a
// scripted platform.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scriptPlatform, start, stop, type Started } from "./mcp-harness.js";

const PRIMARY = "events";
// Names that occur in no other word of the texts, so a count of each is a
// count of the times it is named.
const OTHERS = Array.from({ length: 120 }, (_, i) => `zq_other_${String(i).padStart(3, "0")}`);

process.env.CX_TABLE = PRIMARY;
process.env.CX_REMOTE_SEARCH = "1";
process.env.CX_NO_EMBED = "1";
delete process.env.CX_AUTO_INDEX;
delete process.env.CX_NO_RECEIPT;
delete process.env.CX_INDEX_DIR;

const { API_KEY_ENV, configureHosted, hostedSettingsFromFlags } = await import("../src/core/config.js");

const SCHEMA = [
  { name: "id", type: "utf8" },
  { name: "body", type: "large_utf8" },
];
const cardOf = (table: string) => ({
  table,
  rows: 10,
  schema: [
    { name: "id", type: "Utf8", index: "scalar" },
    { name: "body", type: "LargeUtf8", index: "fts", description: `Text of ${table}` },
  ],
});

const platform = () =>
  scriptPlatform({
    list_tables: () => [200, [PRIMARY, ...OTHERS]],
    schema: () => [200, SCHEMA],
    table_card: (query) => {
      if (query?.tables !== undefined) return [500, { error: "no rendering is asked for beside other tables" }];
      return [200, { card: cardOf(String(query?.table)), tier: "enriched" }];
    },
    hydrate: () => [404, { error: "no hydrate job" }],
  });

beforeAll(() => {
  configureHosted(hostedSettingsFromFlags({ db: "http://127.0.0.1:9/db" }, { [API_KEY_ENV]: "inf_test_key_do_not_log" }));
});
afterAll(() => {
  configureHosted(null);
});

describe("a table in a database of many tables", () => {
  let s: Started;
  beforeAll(async () => {
    s = await start(platform(), "cx-many-tables-");
  });
  afterAll(async () => {
    await stop(s);
  });

  it("asks for no rendering of the cards at start-up", () => {
    expect(s.sent.filter((x) => x.op === "table_card" && x.body?.tables !== undefined)).toEqual([]);
  });

  it("names each other table exactly once across the instructions and every tool's text", async () => {
    const { tools } = await s.client.listTools();
    const texts = [s.client.getInstructions() ?? "", ...tools.map((t) => `${t.description ?? ""} ${JSON.stringify(t.inputSchema ?? {})}`)];
    const all = texts.join("\n");
    for (const name of OTHERS) {
      expect(all.split(name).length - 1, name).toBe(1);
    }
    // The once is in the sql text, beside the rule that heads it.
    const sql = tools.find((t) => t.name === "sql")?.description ?? "";
    expect(sql).toContain(`joinable with ${PRIMARY} in one statement: ${OTHERS.join(", ")}. This line is the one place`);
    // None of their columns or cards rides along.
    expect(sql).not.toContain("Text of zq_other_");
    expect(tools.map((t) => t.name)).toContain("describe_columns");
  });

  it("keeps the sql text a size a model can read", async () => {
    const { tools } = await s.client.listTools();
    const sql = tools.find((t) => t.name === "sql")?.description ?? "";
    // The other tables cost their names and a separator, nothing more.
    const names = OTHERS.join(", ").length;
    const without = sql.length - names;
    expect(without).toBeLessThan(40_000);
  });
});
