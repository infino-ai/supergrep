// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The cards the model outside the loop reads are the platform's rendering
// of them, the one its own loop's prompt carries (the owner, 2026-11-07:
// "we must have the same process inner and outer"): one call at start-up
// for every carded table (`GET /v1/table_card/{db}?tables=`), its text
// folded into the sql tool unchanged, and describe_columns handing the
// platform the caller's question so the columns it needs come first, ranked
// by the pass the loop ranks its own lookups by. End to end through the MCP
// server against a scripted platform.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, scriptPlatform, start, stop, type Started } from "./mcp-harness.js";

const EVENTS_TABLE = "events";
const VISITORS_TABLE = "visitors";

process.env.CX_TABLE = EVENTS_TABLE;
process.env.CX_REMOTE_SEARCH = "1";
process.env.CX_NO_EMBED = "1";
process.env.CX_CARD_TIER = "enriched";
delete process.env.CX_AUTO_INDEX;
delete process.env.CX_NO_RECEIPT;
delete process.env.CX_INDEX_DIR;

const { API_KEY_ENV, configureHosted, hostedSettingsFromFlags } = await import("../src/core/config.js");

const SCHEMAS: Record<string, unknown[]> = {
  [EVENTS_TABLE]: [
    { name: "event_id", type: "i64" },
    { name: "browser_name", type: "utf8" },
  ],
  [VISITORS_TABLE]: [{ name: "visitor_id", type: "i64" }],
};

/** The cards as read, one a table: what a platform that predates the
 * rendering would have the client fold in. */
const CARDS: Record<string, Record<string, unknown>> = {
  [EVENTS_TABLE]: {
    table: EVENTS_TABLE,
    rows: 10,
    schema: [
      { name: "event_id", type: "Int64", index: "scalar", description: "AS-READ-EVENTS" },
      { name: "browser_name", type: "Utf8", index: "scalar" },
    ],
  },
  [VISITORS_TABLE]: { table: VISITORS_TABLE, rows: 3, schema: [{ name: "visitor_id", type: "Int64", index: "scalar" }] },
};

/** The platform's renderings: the cards as its loop lays them out (ranked
 * when they do not fit), the overview a line a table, and the cards a
 * question needs. */
const RENDERED =
  '{"dataset": "db", "tables": [{"table": "events", "schema": [{"name": "tag_*", "description": "RENDERED-BY-PLATFORM"}]}]}';
const OVERVIEW = '{"dataset": "db", "note": "OVERVIEW-NOTE", "tables": [{"table": "events"}, {"table": "visitors"}]}';
const FOR_QUESTION = '{"dataset": "db", "tables": [{"table": "events", "schema": [{"name": "browser_name"}]}]}';
const VOCABULARY = "Search vocabulary: RENDERED-VOCABULARY";

/** `fits`: whether the scope's cards fit a prompt as they are (the
 * platform answers `ranked: false`), or would be ranked (`ranked: true`). */
const platform = (fits: boolean) =>
  scriptPlatform({
    list_tables: () => [200, [EVENTS_TABLE, VISITORS_TABLE]],
    schema: (body) => {
      const fields = SCHEMAS[String(body?.table_name)];
      return fields ? [200, fields] : [404, { error: "no such table" }];
    },
    table_card: (query) => {
      const tables = String(query?.tables ?? "").split(",").filter(Boolean);
      if (tables.length > 0) {
        const base = { database: "db", tier: "enriched", missing: [], graded: false };
        if (query?.overview !== undefined) {
          return [200, { ...base, cards: OVERVIEW, vocabulary: "", shown: [], listed: tables, ranked: false }];
        }
        if (query?.question !== undefined) {
          return [200, { ...base, cards: FOR_QUESTION, vocabulary: "", shown: [EVENTS_TABLE], listed: [VISITORS_TABLE], ranked: true, note: "QUESTION-NOTE" }];
        }
        return [
          200,
          { ...base, cards: RENDERED, vocabulary: VOCABULARY, shown: fits ? tables : [EVENTS_TABLE], listed: fits ? [] : [VISITORS_TABLE], ranked: !fits },
        ];
      }
      if (query?.pattern !== undefined) {
        return [200, { card: { table: query.table, schema: [{ name: "browser_name", type: "Utf8" }] }, matched: 2, note: "SIZE-NOTE" }];
      }
      const card = CARDS[String(query?.table)];
      return card ? [200, { card, tier: "enriched" }] : [404, { error: "no card" }];
    },
    hydrate: () => [404, { error: "no hydrate job" }],
  });

beforeAll(() => {
  configureHosted(hostedSettingsFromFlags({ db: "http://127.0.0.1:9/db" }, { [API_KEY_ENV]: "inf_test_key_do_not_log" }));
});

afterAll(() => {
  configureHosted(null);
  delete process.env.CX_CARD_TIER;
});

const renderings = (s: Started) => s.sent.filter((x) => x.op === "table_card" && x.body?.tables !== undefined);

describe("cards that fit: the platform's rendering, folded in unchanged", () => {
  let s: Started;
  beforeAll(async () => {
    s = await start(platform(true), "cx-prompt-cards-fit-");
  });
  afterAll(async () => {
    await stop(s);
  });

  it("asks the platform once for every carded table's rendering, at the card tier", () => {
    const asked = renderings(s);
    expect(asked).toHaveLength(1);
    expect(String(asked[0].body?.tables).split(",").sort()).toEqual([EVENTS_TABLE, VISITORS_TABLE].sort());
    expect(asked[0].body?.tier).toBe("enriched");
    expect(asked[0].body?.question).toBeUndefined();
  });

  it("folds the rendering into the sql text, not the cards as read", async () => {
    const { tools } = await s.client.listTools();
    const sql = tools.find((t) => t.name === "sql")?.description ?? "";
    expect(sql).toContain(RENDERED);
    expect(sql).toContain(VOCABULARY);
    expect(sql).not.toContain("AS-READ-EVENTS");
  });
});

describe("cards that do not fit: a line a table, and the cards a question needs on asking", () => {
  let s: Started;
  beforeAll(async () => {
    s = await start(platform(false), "cx-prompt-cards-overview-");
  });
  afterAll(async () => {
    await stop(s);
  });

  it("folds the overview into the sql text, no card", async () => {
    const asked = renderings(s);
    expect(asked).toHaveLength(2);
    expect(asked[1].body?.overview).toBe("true");
    const { tools } = await s.client.listTools();
    const sql = tools.find((t) => t.name === "sql")?.description ?? "";
    expect(sql).toContain(OVERVIEW);
    expect(sql).not.toContain(RENDERED);
    expect(sql).toContain("describe_columns with your question");
  });

  it("describe_columns with a question alone returns the cards that question needs", async () => {
    const { tools } = await s.client.listTools();
    const describe = tools.find((t) => t.name === "describe_columns");
    expect(describe).toBeDefined();
    expect(describe?.description).toContain("Pass the question you are answering as `question`");
    const result = await call(s, "describe_columns", { question: "which browsers rage-click" });
    expect(result.ok).toBe(true);
    const asked = renderings(s).at(-1);
    expect(asked?.body?.question).toBe("which browsers rage-click");
    expect((result.value as Record<string, unknown>).cards).toEqual(JSON.parse(FOR_QUESTION));
    expect((result.value as Record<string, unknown>).note).toBe("QUESTION-NOTE");
  });

  it("describe_columns with a table and a question ranks that table's columns", async () => {
    const result = await call(s, "describe_columns", { table: EVENTS_TABLE, question: "which browsers rage-click" });
    expect(result.ok).toBe(true);
    const asked = s.sent.filter((x) => x.op === "table_card" && x.body?.pattern !== undefined).at(-1);
    expect(asked?.body?.pattern).toBe("*");
    expect(asked?.body?.question).toBe("which browsers rage-click");
    expect((result.value as Record<string, unknown>).note).toBe("SIZE-NOTE");
  });
});
