// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The startup description kept in a file for a window: a start within it
// reads the file, a start after it reads the platform and writes a new one,
// and a failed call is never kept. No network: the client is a stand-in.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { HostedDb } from "../src/core/hosted.js";
import { StartupCache, startupCachePath, startupCacheSecs, STARTUP_CACHE_ENV } from "../src/core/startup-cache.js";

/** A client that counts its description calls; `missing` names tables whose
 * card the platform does not have. */
function standIn(missing: string[] = []) {
  const calls = { listTables: 0, schema: 0, tableCard: 0, joinKeys: 0 };
  const db = {
    async listTables() {
      calls.listTables += 1;
      return ["events", "accounts"];
    },
    async schema(table: string) {
      calls.schema += 1;
      return { table, fields: [{ name: "id", type: "Int64" }] };
    },
    async tableCard(table: string, tier?: string) {
      calls.tableCard += 1;
      if (missing.includes(table)) throw new Error(`no lean card for table ${table}`);
      return { table, tier, rows: 12, max: 9007199254740993n };
    },
    async joinKeys() {
      calls.joinKeys += 1;
      return { joins: [] };
    },
  };
  return { calls, db: db as unknown as HostedDb };
}

const T0 = 1_800_000_000_000;
const WINDOW = 300;

function freshPath() {
  return startupCachePath("https://api.example/acme#events", mkdtempSync(join(tmpdir(), "cx-startup-")));
}

describe("the startup cache", () => {
  it("is off unless its variable names a window", () => {
    expect(startupCacheSecs({})).toBe(0);
    expect(startupCacheSecs({ [STARTUP_CACHE_ENV]: "0" })).toBe(0);
    expect(startupCacheSecs({ [STARTUP_CACHE_ENV]: "soon" })).toBe(0);
    expect(startupCacheSecs({ [STARTUP_CACHE_ENV]: "300" })).toBe(300);
  });

  it("reads the platform on a cold start, then the file for a start within the window", async () => {
    const path = freshPath();
    const cold = standIn();
    const first = new StartupCache(path, WINDOW, T0);
    expect(first.hit).toBe(false);
    const db1 = first.wrap(cold.db);
    expect(await db1.listTables()).toEqual(["events", "accounts"]);
    await db1.schema("accounts");
    const card = await db1.tableCard("accounts", "lean");
    first.save(T0);
    expect(cold.calls).toMatchObject({ listTables: 1, schema: 1, tableCard: 1 });

    const warm = standIn();
    const second = new StartupCache(path, WINDOW, T0 + (WINDOW - 1) * 1000);
    expect(second.hit).toBe(true);
    const db2 = second.wrap(warm.db);
    expect(await db2.listTables()).toEqual(["events", "accounts"]);
    expect(await db2.schema("accounts")).toEqual({ table: "accounts", fields: [{ name: "id", type: "Int64" }] });
    const again = await db2.tableCard("accounts", "lean");
    expect(again).toEqual(card);
    expect(typeof (again as { max: unknown }).max).toBe("bigint");
    expect(warm.calls).toMatchObject({ listTables: 0, schema: 0, tableCard: 0 });
  });

  it("reads the platform again once the window has passed, and a start within it writes nothing", async () => {
    const path = freshPath();
    const first = new StartupCache(path, WINDOW, T0);
    await first.wrap(standIn().db).listTables();
    first.save(T0);

    const within = new StartupCache(path, WINDOW, T0 + 1000);
    await within.wrap(standIn().db).listTables();
    within.save(T0 + 1000);

    const late = standIn();
    const after = new StartupCache(path, WINDOW, T0 + WINDOW * 1000);
    expect(after.hit).toBe(false);
    await after.wrap(late.db).listTables();
    expect(late.calls.listTables).toBe(1);
  });

  it("never keeps a failed call, and passes other calls straight through", async () => {
    const path = freshPath();
    const first = new StartupCache(path, WINDOW, T0);
    const db1 = first.wrap(standIn(["events"]).db);
    await expect(db1.tableCard("events", "lean")).rejects.toThrow(/no lean card/);
    await db1.tableCard("accounts", "lean");
    first.save(T0);

    const warm = standIn(["events"]);
    const db2 = new StartupCache(path, WINDOW, T0 + 1000).wrap(warm.db);
    await expect(db2.tableCard("events", "lean")).rejects.toThrow(/no lean card/);
    await db2.tableCard("accounts", "lean");
    await db2.joinKeys(["a", "b"]);
    expect(warm.calls).toMatchObject({ tableCard: 1, joinKeys: 1 });
  });
});
