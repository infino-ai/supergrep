// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// A table whose values run past 2^53 - an OpenTelemetry log table's
// nanosecond timestamps - end to end through the MCP server against a
// scripted platform. The client parses such an integer into a bigint, and on
// 2026-10-05 the server died at startup serializing that table's card into
// the sql text ("Do not know how to serialize a BigInt"): the caller's model
// was left with no tools and wrote its tool calls as prose. The server must
// start, carry the card's integers exactly, and answer an ask whose facts
// hold them.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scriptPlatform, start, stop, type Started } from "./mcp-harness.js";

/** The visitor's table, as the demo's My data names it. */
const LOGS_TABLE = "data";

process.env.CX_TABLE = LOGS_TABLE;
process.env.CX_REMOTE_SEARCH = "1";
process.env.CX_NO_EMBED = "1";
process.env.CX_CARD_TIER = "enriched";
delete process.env.CX_AUTO_INDEX;
delete process.env.CX_NO_RECEIPT;
delete process.env.CX_INDEX_DIR;

const { API_KEY_ENV, configureHosted, hostedSettingsFromFlags } = await import("../src/core/config.js");

/** Two nanosecond timestamps, both past 2^53, as the platform writes them:
 * every digit, a JSON number (JSON.rawJSON keeps them so in the scripted
 * reply). */
const FIRST_NANOS = "1759617853701123457";
const LAST_NANOS = "1759618059188654321";

const SCHEMA = [
  { name: "timestamp", type: "u64" },
  { name: "severity_text", type: "utf8" },
  { name: "body", type: "large_utf8" },
];

/** The table's enriched card: the timestamp column's range among its
 * statistics, the values that killed the server. */
const CARD = {
  table: LOGS_TABLE,
  rows: 4587,
  data_source: { context: "OpenTelemetry log records from a Kubernetes cluster." },
  schema: [
    { name: "timestamp", type: "UInt64", index: "scalar", description: "When the record was emitted, in nanoseconds", min: JSON.rawJSON(FIRST_NANOS), max: JSON.rawJSON(LAST_NANOS) },
    { name: "severity_text", type: "Utf8", index: "scalar", values: { INFO: "informational", ERROR: "error" } },
    { name: "body", type: "LargeUtf8", index: "fts", description: "The log message" },
  ],
};

/** One fact row, twice: the loop's facts may repeat a row, and the client
 * keys rows to keep one of each. */
const FACT = { table: LOGS_TABLE, row: { timestamp: JSON.rawJSON(FIRST_NANOS), severity_text: "ERROR", body: "probe failed" } };
const ASKED = {
  facts: [FACT, FACT],
  statement: `SELECT timestamp, severity_text, body FROM ${LOGS_TABLE} WHERE severity_text = 'ERROR'`,
  coverage: { rows_total: 1, rows_returned: 1, truncated: false },
  terminate: "answered",
  turns: 1,
  retries: 0,
  model_tokens: 320,
};

const platform = () =>
  scriptPlatform({
    list_tables: () => [200, [LOGS_TABLE]],
    schema: () => [200, SCHEMA],
    table_card: (query) => (String(query?.tier ?? "lean") === "enriched" ? [200, { card: CARD, tier: "enriched" }] : [404, { error: "no lean card" }]),
    hydrate: () => [404, { error: "no hydrate job" }],
    sub_agent: () => [200, ASKED],
  });

beforeAll(() => {
  configureHosted(hostedSettingsFromFlags({ db: "http://127.0.0.1:9/mydata" }, { [API_KEY_ENV]: "inf_test_key_do_not_log" }));
});

afterAll(() => {
  configureHosted(null);
  delete process.env.CX_CARD_TIER;
});

describe("a table whose values run past 2^53", () => {
  let s: Started;
  beforeAll(async () => {
    s = await start(platform(), "cx-bigint-card-");
  });
  afterAll(async () => {
    await stop(s);
  });

  it("starts, and serves its tools", async () => {
    const { tools } = await s.client.listTools();
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(["sql", "ask"]));
  });

  it("carries the card's integers into the sql text exactly", async () => {
    const { tools } = await s.client.listTools();
    const sql = tools.find((t) => t.name === "sql")?.description ?? "";
    expect(sql).toContain(`"min":${FIRST_NANOS}`);
    expect(sql).toContain(`"max":${LAST_NANOS}`);
  });

  it("answers an ask whose facts hold them, exactly and once", async () => {
    const before = s.sent.length;
    // The tool's own text, not `call`'s parse of it: JSON.parse would round
    // the digits this checks.
    const result = (await s.client.callTool({ name: "ask", arguments: { question: "Which errors did the pods log?" } })) as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    const text = result.content[0].text;
    expect(result.isError, text).not.toBe(true);
    expect(s.sent.slice(before).map((x) => x.op)).toContain("sub_agent");
    expect(text).toContain("probe failed");
    expect(text.split(FIRST_NANOS).length - 1, "the timestamp, exactly, in the one row kept").toBe(1);
  });
});
