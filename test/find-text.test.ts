// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors

import { describe, expect, it } from "vitest";
import { enclosingName, renderFind, renderMatch } from "../src/core/find-text.js";
import type { FindResult } from "../src/core/searcher.js";

const base: FindResult = {
  query: "needle",
  ignoreCase: false,
  total: 3,
  files: 2,
  byFile: [
    { path: "src/a.rs", count: 2 },
    { path: "src/b.rs", count: 1 },
  ],
  matches: [
    { path: "src/a.rs", line: 3, text: "let x = needle;", symbol: "f" },
    { path: "src/a.rs", line: 9, text: "needle()", symbol: "f, g" },
    { path: "src/b.rs", line: 1, text: "// needle", symbol: "run (1-40, part)" },
  ],
};

describe("find as text", () => {
  it("writes grep -n lines with the one enclosing definition in brackets, then the per-file counts", () => {
    const text = renderFind(base);
    expect(text.split("\n")).toEqual([
      '3 matching lines in 2 files for "needle"',
      "",
      "src/a.rs:3:let x = needle;  [f]",
      "src/a.rs:9:needle()",
      "src/b.rs:1:// needle  [run]",
      "",
      "per file (2):",
      "src/a.rs: 2",
      "src/b.rs: 1",
    ]);
  });

  it("is less than half the JSON it replaced", () => {
    // The shape the tool wrote until 2026-09-27: a find for `unsafe` came to
    // 41,000 characters where rg said the same in 17,000, and this is rg's
    // shape.
    const many: FindResult = {
      ...base,
      matches: Array.from({ length: 200 }, (_, i) => ({
        path: `src/module_${i % 7}/file_${i % 13}.rs`,
        line: 100 + i,
        text: "        let map = unsafe { Mmap::map(&file).expect(\"mmap text corpus\") };",
        symbol: "open, from_file, from_file_with_dim, as_slice, n_docs, dim",
      })),
    };
    const json = JSON.stringify({ ...many, byFile: [] }, null, 2).length;
    const text = renderFind({ ...many, byFile: [] }).length;
    expect(text * 2).toBeLessThan(json);
  });

  it("carries context lines as grep -B/-A does, groups apart", () => {
    const withContext: FindResult = {
      ...base,
      matches: [
        { path: "src/a.rs", line: 3, text: "let x = needle;", before: ["fn f() {", "  // set up"], after: ["  x"] },
        { path: "src/b.rs", line: 1, text: "// needle", after: ["fn run() {}"] },
      ],
    };
    expect(renderFind(withContext).split("\n").slice(2, 9)).toEqual([
      "src/a.rs-1-fn f() {",
      "src/a.rs-2-  // set up",
      "src/a.rs:3:let x = needle;",
      "src/a.rs-4-  x",
      "--",
      "src/b.rs:1:// needle",
      "src/b.rs-2-fn run() {}",
    ]);
  });

  it("names the scope, the case, the defines filter and the cut on the first line, and lists the places past the text budget", () => {
    const wide: FindResult = {
      ...base,
      ignoreCase: true,
      under: "src",
      definedFrom: 40,
      truncated: true,
      total: 30,
      more: [
        { path: "src/c.rs", lines: [4, 8] },
        { path: "src/d.rs", lines: [2] },
      ],
    };
    const text = renderFind(wide, { hint: "narrow it", tookMs: 1.5, usage: "returned ~1k tokens | 30 matches / 2 files" });
    const lines = text.split("\n");
    expect(lines[0]).toBe('30 matching lines in 2 files for "needle" under src, ignoring case; 30 of 40 inside a definition of it; the first 6 listed');
    expect(text).toContain("3 more places, text not carried (path: lines):\nsrc/c.rs: 4, 8\nsrc/d.rs: 2");
    expect(lines.slice(-3)).toEqual(["hint: narrow it", "took 1.5 ms", "usage: returned ~1k tokens | 30 matches / 2 files"]);
  });

  it("lists the files with the most matches and sums the rest on one line", () => {
    const wide: FindResult = {
      ...base,
      total: 300,
      files: 100,
      byFile: Array.from({ length: 100 }, (_, i) => ({ path: `repo_${i}/f.py`, count: 100 - i })),
    };
    const lines = renderFind(wide).split("\n");
    const at = lines.indexOf("per file (100):");
    expect(at).toBeGreaterThan(0);
    expect(lines[at + 1]).toBe("repo_0/f.py: 100");
    expect(lines[at + 40]).toBe("repo_39/f.py: 61");
    expect(lines[at + 41]).toBe("... and 60 more files with 1830 lines between them");
    expect(lines[at + 42]).toBeUndefined();
  });

  it("says when the index left files out, and when nothing matched", () => {
    const partial: FindResult = {
      ...base,
      total: 0,
      files: 0,
      byFile: [],
      matches: [],
      partial: { filesSkipped: 5, fileCap: 1000, note: "5 file(s) over the 1000-file cap were left out of the index" },
    };
    const text = renderFind(partial);
    expect(text.split("\n")).toEqual(['0 matching lines in 0 files for "needle"', "partial index: 5 file(s) over the 1000-file cap were left out of the index", ""]);
  });

  it("writes a chunks find as blocks: a heading with the citation and the matching lines, then the lines numbered", () => {
    const blocks: FindResult = {
      ...base,
      total: 3,
      matches: base.matches,
      blocks: [
        {
          path: "src/a.rs",
          start: 1,
          end: 4,
          symbol: "f",
          lines: ["fn f() {", "  // SAFETY: x is in bounds", "  let x = needle;", "}"].map((text, i) => ({ line: 1 + i, text })),
          hits: [3],
        },
        {
          path: "src/b.rs",
          start: 10,
          end: 31,
          symbol: "open, close",
          lines: [
            { line: 10, text: "// needle" },
            { line: 11, text: "// needle again" },
            { line: 30, text: "// SAFETY: the map outlives it" },
            { line: 31, text: "unsafe { needle }" },
          ],
          hits: [10, 11, 31],
        },
      ],
      more: [{ path: "src/c.rs", lines: [7] }],
    };
    const text = renderFind(blocks);
    expect(text.split("\n").slice(2, 14)).toEqual([
      "== src/a.rs:1-4  [f]  match at 3",
      "1: fn f() {",
      "2:   // SAFETY: x is in bounds",
      "3:   let x = needle;",
      "4: }",
      "",
      "== src/b.rs:10-31  matches at 10, 11, 31",
      "10: // needle",
      "11: // needle again",
      "--",
      "30: // SAFETY: the map outlives it",
      "31: unsafe { needle }",
    ]);
    expect(text).toContain("1 more matching line, block not carried (path: lines):\nsrc/c.rs: 7");
  });

  it("with more pages, says so first and does not list the rest by file", () => {
    const paged: FindResult = {
      ...base,
      total: 40,
      skip: 10,
      matches: base.matches,
      more: [{ path: "src/c.rs", lines: [7, 9] }],
      pages: [13, 25, 33],
    };
    const lines = renderFind(paged).split("\n");
    expect(lines[1]).toBe(
      "this result carries matches 11-13 of 40. The rest are in 3 more pages: call find now with the same query and " +
        "options and skip 13, skip 25, skip 33 - all 3 calls in this one reply, not a find per file.",
    );
    expect(renderFind(paged)).not.toContain("src/c.rs");
    // The per-file counts stay: they are the grep -c answer.
    expect(lines).toContain("per file (2):");
  });

  it("names the one definition a match sits in and no list of several", () => {
    expect(enclosingName("parseConfig")).toBe("parseConfig");
    expect(enclosingName("run_compaction_job (603-809, part)")).toBe("run_compaction_job");
    expect(enclosingName("open, from_file, as_slice")).toBeUndefined();
    expect(enclosingName("")).toBeUndefined();
    expect(enclosingName(undefined)).toBeUndefined();
    expect(renderMatch({ path: "a.rs", line: 7, text: "x" })).toEqual(["a.rs:7:x"]);
  });
});
