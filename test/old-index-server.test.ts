// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// A local index an earlier version built, met by the MCP server. Earlier
// versions built every local index with `ascii_lower`, which the pinned
// engine no longer opens. The server reads such an index as no index, so the
// first query rebuilds it the way it builds a missing one and answers on the
// same call; with CX_AUTO_INDEX=0 it says to run `cx index`, as for a
// repository never indexed.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { connect } from "@infino-ai/infino";
import { call, scriptPlatform, start, stop, type Started } from "./mcp-harness.js";

// Read at module load and at startup: no platform, the code index alone.
delete process.env.CX_TABLE;
delete process.env.CX_INDEX_DIR;
delete process.env.CX_AUTO_INDEX;
process.env.CX_NO_EMBED = "1";

const { indexRepo } = await import("../src/core/indexer.js");
const { readManifest, writeManifest } = await import("../src/core/manifest.js");

let s: Started | undefined;
afterEach(async () => {
  delete process.env.CX_AUTO_INDEX;
  if (s) await stop(s);
  s = undefined;
});

/** Give the server's root an index, then make its manifest say an earlier
 * version built it: under `ascii_lower`, or with no analyzer recorded. */
async function olderIndex(started: Started, analyzer: "ascii_lower" | undefined): Promise<string> {
  mkdirSync(join(started.root, "src"), { recursive: true });
  writeFileSync(join(started.root, "src", "store.ts"), "export function flush() { self.reconcile_tombstone_seqs(); }\n");
  const dir = join(started.root, ".infino");
  await indexRepo({ root: started.root, db: connect(dir), indexDirPath: dir, embedder: null });
  writeManifest(dir, { ...readManifest(dir)!, analyzer });
  return dir;
}

describe("an index an earlier version built", () => {
  for (const analyzer of ["ascii_lower", undefined] as const) {
    it(`is rebuilt by the first query, which answers from it (manifest ${analyzer ?? "without an analyzer"})`, async () => {
      s = await start(scriptPlatform({}), "cx-old-index-");
      const dir = await olderIndex(s, analyzer);
      const found = (await s.client.callTool({ name: "find", arguments: { query: "reconcile_tombstone_seqs" } })) as {
        content: Array<{ text: string }>;
        isError?: boolean;
      };
      expect(found.isError, found.content[0].text).toBeFalsy();
      expect(found.content[0].text).toContain('1 matching line in 1 file for "reconcile_tombstone_seqs"');
      expect(readManifest(dir)!.analyzer).toBe("standard");
    });
  }

  it("with CX_AUTO_INDEX=0 says to run cx index, and builds nothing", async () => {
    process.env.CX_AUTO_INDEX = "0";
    s = await start(scriptPlatform({}), "cx-old-index-");
    const dir = await olderIndex(s, "ascii_lower");
    const found = await call(s, "find", { query: "reconcile_tombstone_seqs" });
    expect(found.ok).toBe(false);
    expect(String(found.value)).toContain("run `cx index` there once");
    expect(readManifest(dir)!.analyzer).toBe("ascii_lower");
  });
});
