// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The MCP server and a platform load that stopped before it finished: the
// platform manifest a build leaves provisional (`vectors: "building"`) until
// its load lands, found by a later sync with no process holding the index's
// lock. A file of its own because the server reads its environment when its
// module loads (core/index-lock.test.ts runs it with no platform).

import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { scriptPlatform } from "./mcp-harness.js";

delete process.env.CX_TABLE; // the default: the chunks table this client builds
process.env.CX_NO_EMBED = "1"; // a keyword-only platform table: no embedder to load
process.env.CX_AUTO_INDEX = "1";
process.env.CX_AUTO_SYNC = "1";
process.env.CX_SYNC_INTERVAL_SECS = "0";
delete process.env.CX_INDEX_DIR;

const { API_KEY_ENV, TABLE, configureHosted, hostedSettingsFromFlags } = await import("../src/core/config.js");
const { readPlatformManifest } = await import("../src/core/manifest.js");
const { lockPath } = await import("../src/core/index-lock.js");

/** A platform database with one table registry: enough for a keyword-only
 * build and a sync's recount. */
function platform() {
  const live = new Set<string>();
  return scriptPlatform({
    list_tables: () => [200, [...live]],
    drop_table: (body) => (live.delete(String(body?.table_name)), [200, {}]),
    create_table: (body) => (live.add(String(body?.table_name)), [200, {}]),
    append: () => [200, {}],
    query_sql: () => [200, [{ n: 1, f: 1 }]],
  });
}

beforeAll(() => {
  configureHosted(hostedSettingsFromFlags({ db: "http://127.0.0.1:9/testdb" }, { [API_KEY_ENV]: "inf_test_key_do_not_log" }));
});

afterAll(() => {
  configureHosted(null);
});

describe("the MCP server and a platform load that stopped before it finished", () => {
  it("rebuilds an index whose platform manifest is still marked building when no process holds its lock", async () => {
    const root = mkdtempSync(join(tmpdir(), "cx-lock-abandoned-hosted-"));
    try {
      writeFileSync(join(root, "a.ts"), "export function abandoned() { return 1; }\n");
      const indexDir = join(root, ".infino");
      const p = platform();
      const { serveMcp } = await import("../src/mcp/server.js");
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await serveMcp(root, { transport: serverSide, hostedOptions: { fetch: p.fetch } });
      const client = new Client({ name: "abandoned-hosted-test", version: "0" });
      await client.connect(clientSide);
      const until = async (done: () => boolean) => {
        for (let i = 0; i < 200 && !done(); i++) await new Promise((r) => setTimeout(r, 25));
        expect(done()).toBe(true);
      };
      try {
        const find = () => client.callTool({ name: "find", arguments: { query: "abandoned" } });
        await find(); // builds the index and loads the platform table
        await until(() => readPlatformManifest(indexDir)?.vectors !== undefined && readPlatformManifest(indexDir)!.vectors !== "building" && !existsSync(lockPath(indexDir)));
        // What a server killed mid-load leaves: the provisional platform
        // manifest, and no live lock.
        const path = join(indexDir, "platform.json");
        const before = { ...(JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>), vectors: "building", indexedAt: "2026-01-01T00:00:00.000Z" };
        writeFileSync(path, JSON.stringify(before));
        const creates = p.sent.filter((s) => s.op === "create_table").length;
        await find(); // the query's auto-sync finds the marker under the lock
        await until(() => readPlatformManifest(indexDir)?.indexedAt !== before.indexedAt && !existsSync(lockPath(indexDir)));
        expect(readPlatformManifest(indexDir)?.vectors).not.toBe("building");
        // A rebuild, not a sync: the table was created again.
        expect(p.sent.filter((s) => s.op === "create_table" && s.body?.table_name === TABLE).length).toBe(creates + 1);
      } finally {
        await client.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
