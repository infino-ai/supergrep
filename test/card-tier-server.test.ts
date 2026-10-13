// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The sql text with the semantic layer folded in (CX_CARD_TIER=enriched),
// end to end through the MCP server against a scripted platform: the primary
// table's enriched card at the end of the text, each sibling's meanings
// beside the columns, and a table the optimizer has written no enriched card
// for falling back to its lean one. The lean text is the other server test
// files'; this one is the measurement the owner asked for (2026-10-01:
// "let's test it on the outer model first").

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scriptPlatform, start, stop, type Started } from "./mcp-harness.js";

/** The table the server is started for, a sibling carded at both tiers, and
 * a sibling the optimizer has carded at the lean tier only. */
const TRANS_TABLE = "berka_trans";
const DISTRICT_TABLE = "berka_district";
const LOAN_TABLE = "berka_loan";

// The environment the server reads at module load (CX_CARD_TIER and TABLE
// are constants of the modules) and at startup, set before either module is
// imported - which is why every import of the client's own code is dynamic.
process.env.CX_TABLE = TRANS_TABLE;
process.env.CX_REMOTE_SEARCH = "1";
process.env.CX_NO_EMBED = "1";
process.env.CX_CARD_TIER = "enriched";
process.env.CX_SIBLING_TABLES = `${DISTRICT_TABLE},${LOAN_TABLE}`;
delete process.env.CX_AUTO_INDEX;
delete process.env.CX_NO_RECEIPT;
delete process.env.CX_INDEX_DIR;

const { API_KEY_ENV, configureHosted, hostedSettingsFromFlags } = await import("../src/core/config.js");

/** The three tables' schemas as `POST /v1/schema` would describe them. */
const SCHEMAS: Record<string, unknown[]> = {
  [TRANS_TABLE]: [
    { name: "trans_id", type: "i64" },
    { name: "account_id", type: "i64" },
    { name: "type", type: "utf8" },
  ],
  [DISTRICT_TABLE]: [
    { name: "a1", type: "i64" },
    { name: "a4", type: "i64" },
  ],
  [LOAN_TABLE]: [
    { name: "loan_id", type: "i64" },
    { name: "status", type: "utf8" },
  ],
};

/** What the optimizer's enrichment wrote for the primary: the dataset on its
 * data source, and a column's meaning beside its decoded codes. */
const TRANS_DESCRIPTION = "Account-level transaction ledger from the PKDD'99 Discovery Challenge financial dataset";
const TRANS_ENRICHED = {
  table: TRANS_TABLE,
  rows: 1056320,
  data_source: { category: "Retail Banking Transaction Ledger", description: TRANS_DESCRIPTION, context: "Transactions table of the PKDD'99 Financial dataset." },
  schema: [
    { name: "trans_id", type: "Int64", index: "scalar", description: "Unique identifier for each posted transaction record" },
    { name: "account_id", type: "Int64", index: "scalar", description: "Account owning the transaction; foreign key to account table" },
    { name: "type", type: "Utf8", index: "scalar", description: "Direction of the transaction", values: { PRIJEM: "credit", VYDAJ: "withdrawal" } },
  ],
};
const TRANS_LEAN = { table: TRANS_TABLE, rows: 1056320, schema: [{ name: "type", type: "Utf8", index: "scalar", values: { PRIJEM: "credit" } }] };

/** A sibling carded at both tiers: its enriched card says what the cryptic
 * column names mean. */
const DISTRICT_CONTEXT = "Demographic reference table of the PKDD'99 Discovery Challenge Czech banking (Berka) dataset.";
const DISTRICT_ENRICHED = {
  table: DISTRICT_TABLE,
  rows: 77,
  data_source: { context: DISTRICT_CONTEXT },
  schema: [
    { name: "a1", type: "Int64", index: "scalar", description: "District identifier, primary key joined by client and account tables", synonyms: ["district_id"] },
    { name: "a4", type: "Int64", index: "scalar", description: "Number of inhabitants living in the district", synonyms: ["population", "inhabitants"] },
    // A text column whose card says what a value is made of.
    { name: "notes", type: "Utf8", index: "fts", description: "Free text about the district", structure: "a heading line, then `- ` bullet lines, each one fact" },
  ],
};

/** A sibling with a lean card only: its codes decoded, nothing described. */
const LOAN_LEAN = {
  table: LOAN_TABLE,
  rows: 682,
  schema: [{ name: "status", type: "Utf8", index: "scalar", values: { A: "Contract finished, no problems", D: "Running contract, client in debt" } }],
};

/** The cards the platform holds, by table and tier. */
const CARDS: Record<string, Record<string, unknown>> = {
  [`${TRANS_TABLE}:enriched`]: TRANS_ENRICHED,
  [`${TRANS_TABLE}:lean`]: TRANS_LEAN,
  [`${DISTRICT_TABLE}:enriched`]: DISTRICT_ENRICHED,
  [`${LOAN_TABLE}:lean`]: LOAN_LEAN,
};

const platform = () =>
  scriptPlatform({
    schema: (body) => {
      const fields = SCHEMAS[String(body?.table_name)];
      return fields ? [200, fields] : [404, { error: "no such table" }];
    },
    table_card: (query) => {
      const tier = String(query?.tier ?? "lean");
      const card = CARDS[`${String(query?.table)}:${tier}`];
      return card ? [200, { card, tier }] : [404, { error: `no ${tier} card for table ${String(query?.table)}` }];
    },
    hydrate: () => [404, { error: "no hydrate job" }],
  });

beforeAll(() => {
  configureHosted(hostedSettingsFromFlags({ db: "http://127.0.0.1:9/cxbench" }, { [API_KEY_ENV]: "inf_test_key_do_not_log" }));
});

afterAll(() => {
  configureHosted(null);
  delete process.env.CX_CARD_TIER;
  delete process.env.CX_SIBLING_TABLES;
});

describe("the sql text with the semantic layer folded in", () => {
  let s: Started;
  beforeAll(async () => {
    s = await start(platform(), "cx-card-tier-");
  });
  afterAll(async () => {
    await stop(s);
  });

  it("asks for each table's enriched card, and the lean one where there is no enriched card", () => {
    const asked = s.sent.filter((x) => x.op === "table_card").map((x) => `${String(x.body?.table)}:${String(x.body?.tier)}`);
    expect(asked).toEqual([`${TRANS_TABLE}:enriched`, `${DISTRICT_TABLE}:enriched`, `${LOAN_TABLE}:enriched`, `${LOAN_TABLE}:lean`]);
  });

  it("folds in the primary's enriched card and each sibling's meanings beside the columns", async () => {
    const { tools } = await s.client.listTools();
    const sql = tools.find((t) => t.name === "sql")?.description ?? "";
    // The primary's whole enriched card, its data source and its columns'
    // descriptions with it.
    expect(sql).toContain(TRANS_DESCRIPTION);
    expect(sql).toContain("Account owning the transaction; foreign key to account table");
    // The siblings' meanings follow their column list.
    expect(sql).toContain(`What the other tables hold, from their cards: ${DISTRICT_TABLE}: ${DISTRICT_CONTEXT}`);
    expect(sql).toContain("a4 (population, inhabitants): Number of inhabitants living in the district");
    // A text column's sections and markers ride beside its description.
    expect(sql).toContain("notes: Free text about the district, structure: a heading line, then `- ` bullet lines, each one fact");
    // A sibling with a lean card only still has its codes decoded.
    expect(sql).toContain(`${LOAN_TABLE}: Columns - status: codes: "A" = Contract finished, no problems; "D" = Running contract, client in debt.`);
    // The descriptions name the keys, so the text does not say they are absent.
    expect(sql).not.toContain("The keys are not written here");
    expect(sql).toContain("Call join_keys with the tables first and paste its predicate into ON.");
  });
});
