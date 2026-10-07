// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The card tier the sql text folds in (CX_CARD_TIER), the fallback to the
// lean card where a table has no card at the tier asked for, and the line a
// sibling table's card is said in when the semantic layer is folded in.

import { afterEach, describe, expect, it } from "vitest";
import { configuredCardTier } from "../src/core/config.js";
import { HostedError } from "../src/core/hosted.js";
import { fetchCard } from "../src/core/table-shape.js";
import { cardMeanings } from "../src/mcp/server.js";

/** The statuses the card route answers with: no card at that tier, a
 * database still starting, a refused key. */
const NOT_FOUND = 404;
const STARTING = 503;
const UNAUTHORIZED = 401;

afterEach(() => {
  delete process.env.CX_CARD_TIER;
});

describe("CX_CARD_TIER", () => {
  it("is enriched unless it names the lean tier, and says why it did not take a name", () => {
    const heard: string[] = [];
    expect(configuredCardTier((l) => heard.push(l))).toBe("enriched");
    process.env.CX_CARD_TIER = "lean";
    expect(configuredCardTier((l) => heard.push(l))).toBe("lean");
    process.env.CX_CARD_TIER = "enriched";
    expect(configuredCardTier((l) => heard.push(l))).toBe("enriched");
    process.env.CX_CARD_TIER = "semantic";
    expect(configuredCardTier((l) => heard.push(l))).toBe("enriched");
    expect(heard).toEqual(["CX_CARD_TIER=semantic is not a card tier (lean|enriched); folding in the enriched card"]);
  });
});

describe("fetchCard", () => {
  /** A platform holding the given cards, by `<table>:<tier>`, recording what it was asked. */
  const holding = (cards: Record<string, unknown>) => {
    const asked: string[] = [];
    return {
      asked,
      tableCard: async (table: string, tier?: string) => {
        asked.push(`${table}:${tier}`);
        const card = cards[`${table}:${tier ?? "lean"}`];
        if (!card) throw new HostedError("table_card", NOT_FOUND, `no ${tier} card for table ${table}`);
        return card as Record<string, unknown>;
      },
    };
  };

  it("reads the tier asked for, and the lean card where that tier has none", async () => {
    const platform = holding({ "t:enriched": { tier: "enriched" }, "u:lean": { tier: "lean" } });
    const heard: string[] = [];
    expect(await fetchCard(platform, "t", "enriched", (l) => heard.push(l))).toEqual({ tier: "enriched" });
    expect(await fetchCard(platform, "u", "enriched", (l) => heard.push(l))).toEqual({ tier: "lean" });
    expect(platform.asked).toEqual(["t:enriched", "u:enriched", "u:lean"]);
    expect(heard).toEqual(["no enriched card for u (table_card: server returned 404: no enriched card for table u); folding in the lean card"]);
  });

  it("asks the lean tier once, and rejects where a table has no card at all", async () => {
    const platform = holding({});
    await expect(fetchCard(platform, "t", "lean")).rejects.toThrow(/no lean card/);
    await expect(fetchCard(platform, "t", "enriched")).rejects.toThrow(/no lean card/);
    expect(platform.asked).toEqual(["t:lean", "t:enriched", "t:lean"]);
  });

  it("reads only a missing card as a reason to try the lean one: a cold start or a refused key is asked once", async () => {
    for (const [status, words] of [[STARTING, "the database is starting"], [UNAUTHORIZED, "invalid API key"]] as const) {
      const asked: string[] = [];
      const platform = {
        tableCard: async (table: string, tier?: string) => {
          asked.push(`${table}:${tier}`);
          throw new HostedError("table_card", status, words);
        },
      };
      await expect(fetchCard(platform, "t", "enriched")).rejects.toThrow(words);
      expect(asked).toEqual(["t:enriched"]);
    }
  });
});

describe("cardMeanings", () => {
  it("says the dataset's context and each described or decoded column, synonyms first", () => {
    expect(
      cardMeanings({
        data_source: { context: "One row = one Czech district." },
        schema: [
          { name: "a1", description: "District identifier", synonyms: ["district_id"] },
          { name: "a2" },
          { name: "a12", description: "Unemployment rate in 1995", values: { "?": "missing value" } },
        ],
      }),
    ).toBe('One row = one Czech district. Columns - a1 (district_id): District identifier; a12: Unemployment rate in 1995, codes: "?" = missing value.');
  });

  it("says the JSON field a column was measured to hold, and the one named like it that it does not", () => {
    expect(
      cardMeanings({
        schema: [
          { name: "id" },
          {
            name: "lastvisit",
            equals_field: "metadata.auto.lastupdated",
            differs_from_field: "metadata.auto.lastvisit",
          },
        ],
      }),
    ).toBe("Columns - lastvisit: equals_field: metadata.auto.lastupdated, differs_from_field: metadata.auto.lastvisit.");
  });

  it("is empty for a card that says nothing of what its table means", () => {
    expect(cardMeanings(undefined)).toBe("");
    expect(cardMeanings({ schema: [{ name: "n", min: "0", max: "9" }] })).toBe("");
  });
});
