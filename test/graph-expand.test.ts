// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors

import { describe, expect, it } from "vitest";
import {
  CONNECTED_NOTE,
  SEED_ROWS_CAP,
  engineId,
  expandAcrossGraph,
  isUncovered,
  newExpansionMemory,
  withIdAsText,
  type Searched,
} from "../src/core/graph-expand.js";
import type { RowRecord } from "../src/core/hosted.js";

/** A platform that answers every expansion with `answer` and remembers what
 * it was handed. */
function platform(answer: RowRecord) {
  const asked: Array<{ table: string; rows: readonly RowRecord[]; searched?: Searched }> = [];
  return {
    asked,
    async graphExpand(table: string, rows: readonly RowRecord[], searched?: Searched): Promise<RowRecord> {
      asked.push({ table, rows, ...(searched ? { searched } : {}) });
      return answer;
    },
  };
}

const ISSUES = "swe_issues";

describe("engineId", () => {
  it("reads a row's engine id whole, and nothing else names a row", () => {
    const wide = 33045846845217366828836519439606n;
    expect(engineId({ _id: wide, title: "t" })).toBe(wide);
    expect(engineId({ _id: wide.toString() })).toBe(wide);
    expect(engineId({ _id: 12 })).toBe(12n);
    expect(engineId({ _id: "x" })).toBeNull();
    expect(engineId({ path: "a.py", start_line: 3, content: "x" })).toBeNull();
    expect(engineId({ instance_id: "i1" })).toBeNull();
  });
});


describe("expandAcrossGraph", () => {
  it("returns every row the platform reached whole: its _id and every value, none cut", async () => {
    const long = "the filing deadline moved ".repeat(400);
    const passages = Array.from({ length: 40 }, (_, i) => ({ _id: `${1000 + i}`, area: "tax", content: `${long}${i}` }));
    const db = platform({ connected: [{ table: "chunks_lab", rows: passages }], seeds: 1 });
    const out = await expandAcrossGraph(db, "chunks_lab", [{ _id: "7", content: "seed" }]);
    expect(out?.tables).toEqual([{ table: "chunks_lab", rows: passages }]);
  });

  const answer: RowRecord = {
    connected: [
      { table: "chunks_swe", rows: [{ path: "m.py", start_line: 9, symbol: "roc_curve", relation: "defines roc_curve" }] },
      { table: "swe_issues", rows: [{ instance_id: "i2", problem_statement: "the same test" }] },
    ],
    seeds: 1,
  };

  it("hands an engine id to the platform as its digits in text, which the route reads exactly", async () => {
    const db = platform(answer);
    const id = 33045846845217366828836519439606n;
    await expandAcrossGraph(db, "chunks_lab", [{ _id: id, title: "t" }, { _id: "7", title: "u" }]);
    expect(db.asked[0].rows).toEqual([
      { _id: "33045846845217366828836519439606", title: "t" },
      { _id: "7", title: "u" },
    ]);
    expect(withIdAsText({ title: "no id" })).toEqual({ title: "no id" });
  });

  it("hands the first rows to the platform and returns what it reached, with the note", async () => {
    const db = platform(answer);
    const rows = Array.from({ length: SEED_ROWS_CAP + 5 }, (_, i) => ({ instance_id: `i${i}` }));
    const out = await expandAcrossGraph(db, ISSUES, rows);
    expect(db.asked).toHaveLength(1);
    expect(db.asked[0].table).toBe("swe_issues");
    expect(db.asked[0].rows).toHaveLength(SEED_ROWS_CAP);
    expect(out).toEqual({
      seeds: 1,
      tables: [
        { table: "chunks_swe", rows: [{ path: "m.py", start_line: 9, symbol: "roc_curve", relation: "defines roc_curve" }] },
        { table: "swe_issues", rows: [{ instance_id: "i2", problem_statement: "the same test" }] },
      ],
      note: CONNECTED_NOTE,
    });
  });

  it("is null with no rows, or when the platform reaches nothing", async () => {
    expect(await expandAcrossGraph(platform(answer), ISSUES, [])).toBeNull();
    const nothing = platform({ connected: [], seeds: 1, note: "nothing reached from these rows" });
    const trace: string[] = [];
    expect(await expandAcrossGraph(nothing, ISSUES, [{ instance_id: "i1" }], { trace: (l) => trace.push(l) })).toBeNull();
    expect(trace.at(-1)).toContain("nothing reached");
  });

  it("with a memory, walks from a row once a session and shows a row once, each by its _id", async () => {
    // Every row the platform reaches carries its _id: it reads them with it.
    const reached: RowRecord = {
      connected: [
        { table: "chunks_swe", rows: [{ _id: "90", path: "m.py", start_line: 9, relation: "defines roc_curve" }] },
        { table: "swe_issues", rows: [{ _id: "2", instance_id: "i2", problem_statement: "the same test" }] },
      ],
      seeds: 1,
    };
    const db = platform(reached);
    const memory = newExpansionMemory();
    const trace: string[] = [];
    const first = await expandAcrossGraph(db, ISSUES, [{ _id: 1n, instance_id: "i1" }], { memory, trace: (l) => trace.push(l) });
    expect(first?.tables.map((t) => t.rows.length)).toEqual([1, 1]);
    expect(memory.seeds).toEqual(new Map([["swe_issues", new Set([1n])]]));
    expect(memory.rows).toEqual(
      new Map([
        ["chunks_swe", new Set([90n])],
        ["swe_issues", new Set([2n])],
      ]),
    );
    // The same rows again: no call, one trace line saying so.
    expect(await expandAcrossGraph(db, ISSUES, [{ _id: 1n, instance_id: "i1" }], { memory, trace: (l) => trace.push(l) })).toBeNull();
    expect(db.asked).toHaveLength(1);
    expect(trace.at(-1)).toContain("walked from before");
    // A new row beside an old one walks from the new one alone, and rows
    // shown before are not shown again, so the same answer is nothing new.
    expect(
      await expandAcrossGraph(db, ISSUES, [{ _id: 1n, instance_id: "i1" }, { _id: 3n, instance_id: "i3" }], { memory }),
    ).toBeNull();
    expect(db.asked[1].rows).toEqual([{ _id: "3", instance_id: "i3" }]);
    // A row placed by its key alone is walked from each time: the platform
    // looks its _id up, and the rows it reaches are not shown again.
    expect(await expandAcrossGraph(db, ISSUES, [{ instance_id: "i9" }], { memory })).toBeNull();
    expect(await expandAcrossGraph(db, ISSUES, [{ instance_id: "i9" }], { memory })).toBeNull();
    expect(db.asked).toHaveLength(4);
  });

  it("carries the facts the platform's graph holds for the results, each once a session", async () => {
    const own = { subject: "Acme Corp", relation: "must repay", object: "$50,000", table: "docs", document: "a.md", via: "row" };
    const linked = { subject: "Prairie State Bank", relation: "is located in", object: "Springfield", table: "docs", document: "b.md", via: "name" };
    const db = platform({ connected: [], facts: [own, linked, "not a fact"], seeds: 1 });
    const memory = newExpansionMemory();
    const trace: string[] = [];
    const out = await expandAcrossGraph(db, "docs", [{ _id: "1", content: "seed" }], { memory, trace: (l) => trace.push(l) });
    expect(out).toEqual({ seeds: 1, tables: [], facts: [own, linked], note: CONNECTED_NOTE });
    expect(trace.at(-1)).toContain("2 fact(s)");
    // The same facts from another row: nothing new to show.
    expect(await expandAcrossGraph(db, "docs", [{ _id: "2", content: "another" }], { memory })).toBeNull();
    // An answer with no facts carries no facts field.
    const rowsOnly = await expandAcrossGraph(platform(answer), ISSUES, [{ instance_id: "i1" }]);
    expect(rowsOnly && "facts" in rowsOnly).toBe(false);
  });

  it("hands over what was searched, and asks with no row new or none at all when there is", async () => {
    const found = { subject: "The revolver", relation: "terminates upon", object: "a change of control", table: "docs", document: "b.md", via: "query" };
    const db = platform({ connected: [], facts: [found], seeds: 0 });
    const memory = newExpansionMemory();
    const out = await expandAcrossGraph(db, "docs", [], { memory, searched: { query: "change of control" } });
    expect(out).toEqual({ seeds: 0, tables: [], facts: [found], note: CONNECTED_NOTE });
    expect(db.asked[0]).toEqual({ table: "docs", rows: [], searched: { query: "change of control" } });
    // Rows walked from before, with words searched: asked again for the words.
    await expandAcrossGraph(db, "docs", [{ _id: "1" }], { memory });
    expect(await expandAcrossGraph(db, "docs", [{ _id: "1" }], { memory, searched: { statement: "SELECT 1" } })).toBeNull();
    expect(db.asked.at(-1)).toEqual({ table: "docs", rows: [], searched: { statement: "SELECT 1" } });
    // Blank words search by nothing: no call.
    const calls = db.asked.length;
    expect(await expandAcrossGraph(db, "docs", [], { searched: { query: "  " } })).toBeNull();
    expect(db.asked).toHaveLength(calls);
  });

  it("says when the platform's graph covers nothing from the table, and only then", async () => {
    const answers: Array<[string, boolean]> = [
      ["this deployment builds no knowledge graph (optimizer_settings.graph)", true],
      ["the graph does not cover table swe_issues (optimizer_settings.graph.tables)", true],
      ["nothing reached from these rows", false],
      ["no seeds: the rows carry no _id, key or place to walk from", false],
    ];
    for (const [note, uncovered] of answers) {
      let told = false;
      const db = platform({ connected: [], seeds: 0, note });
      expect(await expandAcrossGraph(db, ISSUES, [{ instance_id: "i1" }], { onUncovered: () => (told = true) }), note).toBeNull();
      expect(told, note).toBe(uncovered);
      expect(isUncovered(note), note).toBe(uncovered);
    }
    expect(isUncovered(null)).toBe(false);
  });
});
