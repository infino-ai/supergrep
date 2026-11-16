// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// Waiting for a load from this machine's disk (core/platform-load.ts). A table
// keeps one load record, under a job name that is the table's own, so the
// wait tells this load's record from an earlier load's by the upload prefix
// the record's request names.

import { describe, expect, it } from "vitest";
import type { RowRecord } from "../src/core/hosted.js";
import { waitForLoad } from "../src/core/platform-load.js";

const TABLE = "chunks";
const JOB = `hydrate/acct/db/${TABLE}`;
const record = (state: string, prefix?: string): RowRecord => ({
  job: JOB,
  state,
  ...(prefix !== undefined ? { request: { table: TABLE, source: { kind: "prefix", prefix } } } : {}),
});

/** A platform whose load record reads as `records` say, one per poll, the
 * last one standing after them. */
function polled(records: RowRecord[]) {
  let polls = 0;
  return {
    hosted: { hydrateJob: async () => records[Math.min(polls++, records.length - 1)] },
    polls: () => polls,
  };
}
const noSleep = { sleep: async () => undefined };

describe("waitForLoad", () => {
  it("reads past an earlier load's ended record, of another upload, until this load's lands", async () => {
    const p = polled([record("succeeded", "_source/old/"), record("running", "_source/new/"), record("succeeded", "_source/new/")]);
    const landed = await waitForLoad(p.hosted, TABLE, "_source/new/", noSleep);
    expect(landed.state).toBe("succeeded");
    expect((landed.request as { source: { prefix: string } }).source.prefix).toBe("_source/new/");
    expect(p.polls()).toBe(3);
  });

  it("takes a prefix the platform stored resolved under the database's root, or without its slash, as this load's", async () => {
    expect((await waitForLoad(polled([record("succeeded", "tenant/db/_source/new/")]).hosted, TABLE, "_source/new/", noSleep)).state).toBe("succeeded");
    expect((await waitForLoad(polled([record("succeeded", "_source/new")]).hosted, TABLE, "_source/new/", noSleep)).state).toBe("succeeded");
  });

  it("takes a record that names no source as this load's", async () => {
    expect((await waitForLoad(polled([record("succeeded")]).hosted, TABLE, "_source/new/", noSleep)).state).toBe("succeeded");
  });

  it("fails on this load's failed record, not on an earlier load's", async () => {
    const p = polled([record("failed", "_source/old/"), { ...record("failed", "_source/new/"), error: "bad row" }]);
    await expect(waitForLoad(p.hosted, TABLE, "_source/new/", noSleep)).rejects.toThrow(/ended failed: bad row/);
    expect(p.polls()).toBe(2);
  });

  it("gives up when this load's record never shows within the wait", async () => {
    const p = polled([record("succeeded", "_source/old/")]);
    await expect(waitForLoad(p.hosted, TABLE, "_source/new/", { ...noSleep, waitMs: 0 })).rejects.toThrow(/never showed the load/);
  });
});
