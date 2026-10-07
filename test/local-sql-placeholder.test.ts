// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The sql tool on a server with no platform behind it, over a real local
// index. A query placeholder spelled close to the platform's `{{q:"..."}}` is
// read as the platform's only where the platform runs the statement
// (core/searcher.ts, `normalizeQueryPlaceholders`): here it runs as written,
// so when it fails the engine's error names the struct the caller wrote, not
// a brace the client put there. And a statement holding a dollar-quoted
// string comes back with its rows: the `'` inside one opens nothing, and a
// placeholder-like text inside a later string is the string's.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, scriptPlatform, start, stop, type Started } from "./mcp-harness.js";

// The environment the server reads at module load and at startup, set before
// either module is imported - which is why every import of the client's own
// code below is dynamic.
delete process.env.CX_TABLE;
delete process.env.CX_REMOTE_SEARCH;
delete process.env.CX_SIBLING_TABLES;
process.env.CX_NO_EMBED = "1";
process.env.CX_AUTO_INDEX = "0";
process.env.CX_NO_RECEIPT = "1";
delete process.env.CX_INDEX_DIR;

const { configureHosted } = await import("../src/core/config.js");
const { indexRepo } = await import("../src/core/indexer.js");
const { connect } = await import("@infino-ai/infino");

/** The width of the stand-in embedder's vectors: any small width will do,
 * since nothing here ranks by them. */
const FAKE_DIM = 16;

/** An embedder with no model behind it, so the index has a vector column the
 * statements below can name. */
const fakeEmbedder = {
  embed: async (texts: string[]) =>
    texts.map((t) => {
      const v = new Array(FAKE_DIM).fill(0.01);
      for (let i = 0; i < t.length; i++) v[i % FAKE_DIM] += t.charCodeAt(i) / 1000;
      return v;
    }),
  dim: async () => FAKE_DIM,
  provider: "fake",
  model: "fake-16d",
};

describe("sql on a server with no platform behind it", () => {
  let s: Started;
  beforeAll(async () => {
    configureHosted(null);
    s = await start(scriptPlatform({}), "cx-local-sql-");
    mkdirSync(join(s.root, "src"), { recursive: true });
    writeFileSync(join(s.root, "src", "a.ts"), "// don't panic\nexport const x = `hybrid_search('x', {q: \"y\"}, 5)`;\n");
    writeFileSync(join(s.root, "src", "b.ts"), "export function verifySession(token: string): boolean { return token.length > 10; }\n");
    const dir = join(s.root, ".infino");
    await indexRepo({ root: s.root, db: connect(dir), indexDirPath: dir, embedder: fakeEmbedder });
  });
  afterAll(async () => {
    await stop(s);
  });

  it("runs a near spelling of the placeholder as written, so the engine's error names the struct the caller wrote", async () => {
    const { ok, value, ops } = await call(s, "sql", { query: "SELECT path FROM vector_search('chunks','embedding', {q: 'session'}, 5)" });
    expect(ok).toBe(false);
    expect(ops).toEqual([]);
    expect(String(value)).toMatch(/Struct/);
    expect(String(value)).not.toMatch(/ParserError/);
  });

  it("returns the rows of a statement whose dollar-quoted string holds an apostrophe, its later string untouched", async () => {
    const { ok, value } = await call(s, "sql", {
      query: "SELECT path FROM chunks WHERE content LIKE $$%it's%$$ OR content LIKE '%hybrid_search(''x'', {q: \"y\"}, 5)%'",
    });
    expect(ok, String(value)).toBe(true);
    expect((value as { rows: Array<{ path: string }> }).rows.map((r) => r.path)).toContain("src/a.ts");
  });
});
