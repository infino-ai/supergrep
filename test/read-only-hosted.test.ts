// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The MCP server on the stored account with CX_PLATFORM_READ_ONLY: a
// checkout reading a shared index builds its local index and writes nothing
// to the platform - no database registered, no table created, dropped,
// appended to or deleted from. The same server without the flag registers
// the database and loads the table, so the test sees the gate and not a
// platform that was never asked. A file of its own because the server reads
// its environment when its module loads.

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { scriptPlatform } from "./mcp-harness.js";

delete process.env.CX_TABLE; // the default: the chunks table this client builds
process.env.CX_NO_EMBED = "1"; // a keyword-only platform table: no embedder to load
process.env.CX_AUTO_INDEX = "1";
process.env.CX_AUTO_SYNC = "1";
process.env.CX_SYNC_INTERVAL_SECS = "0";
delete process.env.CX_INDEX_DIR;
delete process.env.CX_PLATFORM_READ_ONLY;

const { API_KEY_ENV, MANIFEST_NAME, configureHosted, hostedSettingsFromFlags } = await import("../src/core/config.js");
const { lockPath } = await import("../src/core/index-lock.js");

const PLATFORM = "http://127.0.0.1:9";
const KEY = "inf_test_key_do_not_log";
/** The platform ops that write: every table write, and registering the
 * database (a `POST` to `databases`; a `GET` only lists them). */
const TABLE_WRITES = new Set(["create_table", "drop_table", "append", "delete", "hydrate"]);
const writes = (sent: Array<{ op: string; method: string }>) =>
  sent.filter((s) => TABLE_WRITES.has(s.op) || (s.op === "databases" && s.method === "POST")).map((s) => s.op);

/** A platform with one table registry: enough for a keyword-only build. */
function platform() {
  const live = new Set<string>();
  return scriptPlatform({
    databases: () => [200, { name: "shared" }],
    list_tables: () => [200, [...live]],
    drop_table: (body) => (live.delete(String(body?.table_name)), [200, {}]),
    create_table: (body) => (live.add(String(body?.table_name)), [200, {}]),
    append: () => [200, {}],
    query_sql: () => [200, [{ n: 1, f: 1 }]],
  });
}

/** Serve a fresh repository on the stored account, its database named by
 * CX_DATABASE; ask `find` once, which builds the index; and return the
 * writes the platform was sent by the time the build has let go of its lock. */
async function buildOnAccount(): Promise<string[]> {
  const root = mkdtempSync(join(tmpdir(), "cx-read-only-"));
  try {
    writeFileSync(join(root, "a.ts"), "export function shared() { return 1; }\n");
    configureHosted(
      hostedSettingsFromFlags({}, { [API_KEY_ENV]: KEY, CX_DATABASE: "shared" }, () => KEY, {
        accountRoot: root,
        storedAccount: () => ({ baseUrl: PLATFORM, storedAt: "2026-11-16T00:00:00Z", uploadConsentAt: "2026-11-16T00:00:00Z" }),
      }),
    );
    const p = platform();
    const { serveMcp } = await import("../src/mcp/server.js");
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await serveMcp(root, { transport: serverSide, hostedOptions: { fetch: p.fetch } });
    const client = new Client({ name: "read-only-test", version: "0" });
    await client.connect(clientSide);
    try {
      await client.callTool({ name: "find", arguments: { query: "shared" } });
      const indexDir = join(root, ".infino");
      const done = () => existsSync(join(indexDir, MANIFEST_NAME)) && !existsSync(lockPath(indexDir));
      for (let i = 0; i < 200 && !done(); i++) await new Promise((r) => setTimeout(r, 25));
      expect(done()).toBe(true);
      return writes(p.sent);
    } finally {
      await client.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

afterEach(() => {
  delete process.env.CX_PLATFORM_READ_ONLY;
});

afterAll(() => {
  configureHosted(null);
});

describe("a checkout reading a shared index (CX_PLATFORM_READ_ONLY)", () => {
  it("without the flag, a first build registers the database and loads the table", async () => {
    const ops = await buildOnAccount();
    expect(ops).toContain("databases");
    expect(ops).toContain("create_table");
  });

  it("with it, builds the local index and writes nothing to the platform, registering no database", async () => {
    process.env.CX_PLATFORM_READ_ONLY = "1";
    expect(await buildOnAccount()).toEqual([]);
  });
});
