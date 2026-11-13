// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// `cx status` over an index an earlier version built (`ascii_lower`), which
// this engine does not open: every query tool refuses it until a build
// replaces it, so status says so - in its hook line, its report and its
// JSON - rather than describe it as ready. A current index reads as before.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { connect } from "@infino-ai/infino";
import { indexRepo } from "../src/core/indexer.js";
import { readManifest, writeManifest, type Manifest } from "../src/core/manifest.js";
import { statusCmd } from "../src/commands/query-cmds.js";

let root: string;
let dir: string;
let current: Manifest;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "cx-status-"));
  dir = join(root, ".infino");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "export const answer = 42;\n");
  await indexRepo({ root, db: connect(dir), indexDirPath: dir, embedder: null });
  current = readManifest(dir)!;
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

afterEach(() => {
  writeManifest(dir, current);
  vi.restoreAllMocks();
});

/** What statusCmd printed. */
async function printed(opts: { hook?: boolean; json?: boolean }): Promise<string> {
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => void lines.push(args.join(" ")));
  await statusCmd({ ...opts, path: root });
  return lines.join("\n");
}

describe("cx status over an index an earlier version built", () => {
  for (const [why, analyzer] of [
    ["records ascii_lower", "ascii_lower"],
    ["records no analyzer", undefined],
  ] as const) {
    it(`says to rebuild it when its manifest ${why}`, async () => {
      writeManifest(dir, { ...current, analyzer });
      const hook = await printed({ hook: true });
      expect(hook).toContain("built by an earlier version of code-context (analyzer ascii_lower)");
      expect(hook).toContain("the MCP server rebuilds it on its first query");
      expect(hook).not.toContain("MCP tools:");
      expect(await printed({})).toContain("run `cx index` here to rebuild it");
      expect(JSON.parse(await printed({ json: true })).rebuild).toContain("analyzer ascii_lower");
    });
  }

  it("describes a current index as before", async () => {
    const hook = await printed({ hook: true });
    expect(hook).toContain("MCP tools:");
    expect(hook).not.toContain("earlier version");
    expect(await printed({})).not.toContain("rebuild");
    expect(JSON.parse(await printed({ json: true })).rebuild).toBeUndefined();
  });
});
