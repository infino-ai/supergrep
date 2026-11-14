// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The join gate: which hosted tables a statement names, the aliases it
// gives them, whether the platform's predicate is written in it either way
// round, and the verdict - run, or refuse with the keys.

import { describe, expect, it } from "vitest";
import { aliasesOf, joinGate, joinRefusal, joinsTables, predicateHolds, tablesNamed, withoutGraphCalls, type PlatformJoin } from "../src/core/join-gate.js";

const TABLES = ["chunks", "swe_issues", "chunks_swelogs"];
const BY_ID: PlatformJoin = { from_table: "chunks_swelogs", to_table: "swe_issues", predicate: "chunks_swelogs.instance_id = swe_issues.instance_id" };
const BY_PREFIX: PlatformJoin = { from_table: "chunks", to_table: "swe_issues", predicate: "split_part(chunks.path, '/', 1) = swe_issues.project" };
const keys = (joins: PlatformJoin[]) => {
  const asked: string[][] = [];
  return { asked, fetch: async (tables: string[]) => { asked.push(tables); return joins; } };
};

describe("tablesNamed and aliasesOf", () => {
  it("names the known tables a statement uses, as identifiers or as a search function's table", () => {
    expect(tablesNamed("SELECT * FROM swe_issues i JOIN chunks_swelogs l ON l.instance_id = i.instance_id", TABLES)).toEqual(["swe_issues", "chunks_swelogs"]);
    expect(tablesNamed("SELECT path FROM hybrid_search('chunks', 'content', 'x', 'embedding', {{q}}, 20) AS c JOIN swe_issues s ON split_part(c.path, '/', 1) = s.project", TABLES)).toEqual(["chunks", "swe_issues"]);
    // `chunks_swelogs` is not a mention of `chunks`.
    expect(tablesNamed("SELECT count(*) FROM chunks_swelogs WHERE resolved = 'false'", TABLES)).toEqual(["chunks_swelogs"]);
  });

  it("reads each table's alias, with or without AS, and never a keyword", () => {
    const aliases = aliasesOf("SELECT i.project FROM swe_issues i JOIN chunks_swelogs AS l ON l.instance_id = i.instance_id WHERE l.resolved = 'false' GROUP BY i.project", TABLES);
    expect([...aliases]).toEqual([["i", "swe_issues"], ["l", "chunks_swelogs"]]);
    const searched = aliasesOf("SELECT c.path FROM hybrid_search('chunks', 'content', 'x', 'embedding', {{q}}, 20) AS c JOIN swe_issues ON split_part(c.path, '/', 1) = swe_issues.project", TABLES);
    expect([...searched]).toEqual([["c", "chunks"]]);
  });
});

describe("predicateHolds", () => {
  it("finds the key either way round, through aliases, blanks and quotes", () => {
    const q = 'SELECT 1 FROM swe_issues i JOIN chunks_swelogs l ON i."instance_id"=l.instance_id';
    expect(predicateHolds(q, BY_ID.predicate, aliasesOf(q, TABLES))).toBe(true);
    const expr = "SELECT 1 FROM hybrid_search('chunks','content','x','embedding',{{q}},20) AS c JOIN swe_issues s ON s.project = split_part( c.path , '/', 1 )";
    expect(predicateHolds(expr, BY_PREFIX.predicate, aliasesOf(expr, TABLES))).toBe(true);
    const other = "SELECT 1 FROM swe_issues i JOIN chunks_swelogs l ON l.project = i.project";
    expect(predicateHolds(other, BY_ID.predicate, aliasesOf(other, TABLES))).toBe(false);
    const subquery = "SELECT 1 FROM swe_issues WHERE instance_id IN (SELECT instance_id FROM chunks_swelogs)";
    expect(predicateHolds(subquery, BY_ID.predicate, aliasesOf(subquery, TABLES))).toBe(false);
  });
});

describe("joinGate", () => {
  it("reads a key written between subqueries and CTEs, each over one table, as the tables' key", async () => {
    // Each table grouped by its key in a subquery, then the two joined on it.
    const grouped =
      "SELECT c.instance_id, c.n, e.logs FROM (SELECT instance_id, count(*) AS n FROM swe_issues GROUP BY instance_id HAVING count(*) > 0) c " +
      "LEFT JOIN (SELECT instance_id, count(*) AS logs FROM chunks_swelogs WHERE resolved = 'false' GROUP BY instance_id) e " +
      "ON e.instance_id = c.instance_id ORDER BY c.n DESC LIMIT 40";
    expect([...aliasesOf(grouped, TABLES)]).toEqual([["c", "swe_issues"], ["e", "chunks_swelogs"]]);
    expect(await joinGate(grouped, TABLES, keys([BY_ID]).fetch)).toEqual({ kind: "run", tables: ["swe_issues", "chunks_swelogs"], keysAsked: true });
    const ctes = [
      "WITH i AS (SELECT instance_id FROM swe_issues), l AS (SELECT instance_id FROM chunks_swelogs) SELECT count(*) FROM i JOIN l ON l.instance_id = i.instance_id",
      "WITH recent AS (SELECT * FROM chunks_swelogs WHERE resolved = 'false') SELECT r.instance_id FROM swe_issues s JOIN recent r ON r.instance_id = s.instance_id",
    ];
    for (const q of ctes) expect((await joinGate(q, TABLES, keys([BY_ID]).fetch)).kind, q).toBe("run");
    // On another column than the key, the subqueries are refused as tables are.
    const off = grouped.replace("ON e.instance_id = c.instance_id", "ON e.logs = c.n");
    expect((await joinGate(off, TABLES, keys([BY_ID]).fetch)).kind).toBe("refuse");
  });

  it("gives a subquery over several tables no table of its own", () => {
    const q = "SELECT x.instance_id FROM (SELECT i.instance_id FROM swe_issues i JOIN chunks_swelogs l ON l.instance_id = i.instance_id) x";
    expect(aliasesOf(q, TABLES).get("x")).toBeUndefined();
  });

  it("lets a one-table statement through without asking for keys", async () => {
    const k = keys([BY_ID]);
    const v = await joinGate("SELECT count(*) FROM chunks_swelogs WHERE resolved = 'false'", TABLES, k.fetch);
    expect(v).toEqual({ kind: "run", tables: ["chunks_swelogs"], keysAsked: false });
    expect(k.asked).toEqual([]);
  });

  it("asks for the keys of the tables named and runs a statement written on one of them", async () => {
    const k = keys([BY_ID, BY_PREFIX]);
    const v = await joinGate("SELECT i.project, count(*) FROM swe_issues i JOIN chunks_swelogs l ON l.instance_id = i.instance_id GROUP BY i.project", TABLES, k.fetch);
    expect(v).toEqual({ kind: "run", tables: ["swe_issues", "chunks_swelogs"], keysAsked: true });
    expect(k.asked).toEqual([["swe_issues", "chunks_swelogs"]]);
  });

  it("refuses a statement across tables written on no key, with the keys between those tables only", async () => {
    const k = keys([BY_ID, BY_PREFIX]);
    const v = await joinGate("SELECT i.instance_id FROM swe_issues i WHERE i.instance_id IN (SELECT instance_id FROM chunks_swelogs WHERE resolved = 'false')", TABLES, k.fetch);
    expect(v.kind).toBe("refuse");
    if (v.kind !== "refuse") return;
    expect(v.keys).toEqual([BY_ID]);
    const text = joinRefusal("sql", v);
    expect(text).toContain("spans swe_issues, chunks_swelogs without a key");
    expect(text).toContain("  chunks_swelogs.instance_id = swe_issues.instance_id");
    expect(text).toContain("Rewrite the statement with one of these");
  });

  it("runs a statement across tables the platform found no key between", async () => {
    const k = keys([]);
    const v = await joinGate("SELECT 1 FROM chunks c JOIN chunks_swelogs l ON c.path = l.path", TABLES, k.fetch);
    expect(v).toEqual({ kind: "run", tables: ["chunks", "chunks_swelogs"], keysAsked: true });
  });

  it("holds only a statement that joins tables to a key; queries side by side run as written", async () => {
    const joined = [
      "SELECT 1 FROM swe_issues i JOIN chunks_swelogs l ON i.project = l.path",
      "SELECT 1 FROM swe_issues i, chunks_swelogs l WHERE i.project = l.path",
      "SELECT i.instance_id FROM swe_issues i WHERE i.instance_id IN (SELECT instance_id FROM chunks_swelogs)",
      "SELECT * FROM swe_issues i WHERE EXISTS (SELECT 1 FROM chunks_swelogs l WHERE l.instance_id = i.instance_id)",
      "WITH a AS (SELECT project FROM swe_issues), b AS (SELECT path FROM chunks_swelogs) SELECT * FROM a JOIN b ON a.project = b.path",
      "SELECT count(*) FROM swe_issues UNION ALL SELECT count(*) FROM chunks c JOIN chunks_swelogs l ON c.path = l.path",
    ];
    for (const q of joined) expect(joinsTables(q, TABLES), q).toBe(true);
    const sideBySide = [
      "SELECT 'issues' AS t, count(*) FROM swe_issues UNION ALL SELECT 'logs', count(*) FROM chunks_swelogs",
      "SELECT count(*) FROM swe_issues INTERSECT SELECT count(*) FROM chunks_swelogs",
      "SELECT (SELECT count(*) FROM swe_issues) AS issues, (SELECT count(*) FROM chunks_swelogs) AS logs",
      "WITH a AS (SELECT count(*) n FROM swe_issues), b AS (SELECT count(*) n FROM chunks_swelogs) SELECT n FROM a UNION ALL SELECT n FROM b",
      "SELECT 'a,b' FROM swe_issues UNION SELECT '(select 1 from chunks)' FROM chunks_swelogs",
    ];
    for (const q of sideBySide) expect(joinsTables(q, TABLES), q).toBe(false);
    // A UNION of two tables' counts runs without asking for keys at all.
    const k = keys([BY_ID]);
    const v = await joinGate(sideBySide[0], TABLES, k.fetch);
    expect(v).toEqual({ kind: "run", tables: ["swe_issues", "chunks_swelogs"], keysAsked: false });
    expect(k.asked).toEqual([]);
  });

  it("lets a graph walk through: the tables it names are its arguments, not a join to hold to a key", async () => {
    const walk = "SELECT instance_id, score FROM graph_walk('swe_issues', 'chunks_swelogs', [42, 43], 2, 50) ORDER BY score";
    expect(withoutGraphCalls(walk)).not.toContain("swe_issues");
    const k = keys([BY_ID]);
    expect(await joinGate(walk, TABLES, k.fetch)).toEqual({ kind: "run", tables: [], keysAsked: false });
    expect(k.asked).toEqual([]);
    // A walk JOINed to a third table is still held to that join's key.
    const joined = "SELECT c.path FROM graph_rank('swe_issues', 'chunks_swelogs', [42], 2, 20) g JOIN chunks c ON split_part(c.path, '/', 1) = g.project";
    const held = await joinGate(joined, TABLES, keys([BY_PREFIX]).fetch);
    expect(held.kind).toBe("run");
    expect(held.tables).toEqual(["chunks"]);
  });
});
