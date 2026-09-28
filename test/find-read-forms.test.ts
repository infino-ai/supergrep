// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// What find carries when the caller names no form, and what read takes as a
// line range. Both follow the demo's Haiku (2026-09-28): it never set chunks
// on a question about what each match relies on, and it sent read's ranges
// as lists - sometimes as the JSON text of a list - which the schema refused.

import { describe, expect, it } from "vitest";
import { renderFind } from "../src/core/find-text.js";
import { AUTO_CHUNK_CONTEXT, type FindResult } from "../src/core/searcher.js";
import { findForm, lineOrLines } from "../src/mcp/server.js";

/** A context width a caller might set. */
const CALLER_CONTEXT = 2;

describe("find's form", () => {
  it("carries each match in its trimmed block when the caller names neither chunks nor context", () => {
    expect(findForm(undefined, undefined)).toEqual({ chunks: true, context: AUTO_CHUNK_CONTEXT, aroundByDefault: AUTO_CHUNK_CONTEXT });
  });

  it("leaves the caller's own choice as it is", () => {
    expect(findForm(false, undefined)).toEqual({ chunks: false, context: undefined });
    expect(findForm(true, undefined)).toEqual({ chunks: true, context: undefined });
    expect(findForm(undefined, CALLER_CONTEXT)).toEqual({ chunks: undefined, context: CALLER_CONTEXT });
    expect(findForm(true, CALLER_CONTEXT)).toEqual({ chunks: true, context: CALLER_CONTEXT });
  });

  it("says on the result when the default trimmed the blocks, and names the other forms", () => {
    const result: FindResult = {
      query: "unsafe",
      ignoreCase: false,
      total: 1,
      files: 1,
      byFile: [{ path: "src/a.rs", count: 1 }],
      matches: [{ path: "src/a.rs", line: 3, text: "unsafe { x }" }],
      blocks: [
        {
          path: "src/a.rs",
          start: 2,
          end: 3,
          lines: [
            { line: 2, text: "// SAFETY: x is in bounds" },
            { line: 3, text: "unsafe { x }" },
          ],
          hits: [3],
        },
      ],
    };
    const lines = renderFind(result, { aroundByDefault: AUTO_CHUNK_CONTEXT }).split("\n");
    expect(lines[1]).toBe(
      `each match in its block with the ${AUTO_CHUNK_CONTEXT} lines around it; chunks: false for the matching lines alone, ` +
        "chunks: true for whole blocks, context for another width",
    );
    // A caller that chose its form is not told about the default.
    expect(renderFind(result)).not.toContain("chunks: false");
  });
});

describe("read's line numbers", () => {
  it("takes a number or a list, and the JSON text of either", () => {
    expect(lineOrLines.parse(12)).toBe(12);
    expect(lineOrLines.parse([559, 592])).toEqual([559, 592]);
    expect(lineOrLines.parse("[559, 592, 623]")).toEqual([559, 592, 623]);
    expect(lineOrLines.parse("12")).toBe(12);
  });

  it("still refuses what is not a line number", () => {
    expect(lineOrLines.safeParse("[1870").success).toBe(false);
    expect(lineOrLines.safeParse(0).success).toBe(false);
    expect(lineOrLines.safeParse([]).success).toBe(false);
    expect(lineOrLines.safeParse("ten").success).toBe(false);
  });
});
