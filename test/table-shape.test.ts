// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The shape of a hosted table and the doors that run over its rows: what a
// schema (and a card) resolve to, how a row becomes a hit, the SQL a row find
// sends, how the caller's embed map folds into the platform's placeholder,
// the tool text built from the shape, and the ledger entries. No network:
// the one client call is against a scripted fetch.

import { describe, expect, it } from "vitest";
import { TABLE } from "../src/core/config.js";
import { HostedDb, HostedError, type RowRecord } from "../src/core/hosted.js";
import {
  ENGINE_ID_COLUMN,
  SNIPPET_CHARS,
  chunkingFrom,
  isVectorField,
  loadEmbeddingFrom,
  platformEmbedsQueriesFor,
  resolveTableShape,
  rowFact,
  rowHit,
  rowKey,
  snippet,
  sqlLiteral,
  tableShapeFrom,
  vectorCandidate,
  cardLayouts,
  databaseTables,
  familiesAllowance,
  wholeAllowances,
  type SchemaField,
} from "../src/core/table-shape.js";
import { embedsAQuery, findRows, findRowsSql, foldEmbeds, normalizeQueryPlaceholders, RERANK_POOL_ROWS, searchHosted, searchRows } from "../src/core/searcher.js";
import { topKAggregateRefusal } from "../src/core/topk-aggregate.js";
import { rowFindEntry, rowSearchEntry, formatReceipt } from "../src/core/usage.js";
import {
  COUNTS_IN_THE_ANSWER,
  READING_HABITS,
  ARITHMETIC_SENTENCE,
  JOIN_KEYS_RULE,
  KEEP_CONDITIONS_SENTENCE,
  LANGUAGE_KIND_SENTENCE,
  ONE_STATEMENT_SENTENCE,
  RELATED_TO_SENTENCE,
  SEARCH_RULE_SENTENCE,
  SEVERAL_TABLES_SENTENCE,
  SQL_DESCRIPTION,
  SWEEP_TO_A_TOOL,
  TEXT_COLUMNS_LISTED,
  DESCRIBE_COLUMNS_LINE,
  cardMapsColumns,
  cardNamesKinds,
  codeInstructions,
  instructionsFor,
  rowsSurface,
  columnList,
  logIndexInstructions,
  rowCitation,
  rowsFindDescription,
  rowsInstructions,
  rowsProjection,
  rowsSearchDescription,
  rowsSqlDescription,
  severalTermsSentence,
  siblingsInstruction,
  siblingsNote,
  siblingsSearchable,
  unresolvedInstructions,
} from "../src/mcp/server.js";

/** The chunks table as `POST /v1/schema` describes the one this client loads. */
const CHUNKS_SCHEMA: SchemaField[] = [
  { name: "path", type: "large_utf8" },
  { name: "start_line", type: "int32" },
  { name: "end_line", type: "int32" },
  { name: "lang", type: "large_utf8" },
  { name: "symbol", type: "large_utf8" },
  { name: "content", type: "large_utf8" },
  { name: "embedding", type: "embedding", source: ["content"] },
];

/** The live job-postings table (testdb.chunks_jobs), as its schema came
 * back on 2026-09-11: hydrate cast the indexed and embedded text columns to
 * large_utf8 and left the rest utf8. */
const JOBS_SCHEMA: SchemaField[] = [
  { name: "id", nullable: true, type: "utf8" },
  { name: "source_slug", nullable: true, type: "utf8" },
  { name: "title", nullable: true, type: "large_utf8" },
  { name: "apply_url", nullable: true, type: "utf8" },
  { name: "description_html", nullable: true, type: "large_utf8" },
  { name: "employment_type", nullable: true, type: "utf8" },
  { name: "department", nullable: true, type: "utf8" },
  { item: "utf8", name: "locations", nullable: true, type: "list" },
  { name: "remote", nullable: true, type: "bool" },
  { name: "posted_at", nullable: true, type: "utf8" },
  { name: "updated_at", nullable: true, type: "utf8" },
  { name: "salary_min", nullable: true, type: "f64" },
  { name: "salary_max", nullable: true, type: "f64" },
  { name: "salary_currency", nullable: true, type: "utf8" },
  { name: "salary_period", nullable: true, type: "utf8" },
  { name: "emb", nullable: false, source: ["title"], type: "embedding" },
];

const JOBS = tableShapeFrom("chunks_jobs", JOBS_SCHEMA);

describe("tableShapeFrom", () => {
  it("recognizes the chunks table by its place columns and content", () => {
    const shape = tableShapeFrom("chunks", CHUNKS_SCHEMA);
    expect(shape.isChunks).toBe(true);
    expect(shape.vectorColumn).toBe("embedding");
    expect(shape.primaryText).toBe("content");
  });

  it("reads the jobs table from its schema alone: the embedded column, the LargeUtf8 text, the key", () => {
    expect(JOBS.isChunks).toBe(false);
    expect(JOBS.vectorColumn).toBe("emb");
    expect(JOBS.vectorSource).toEqual(["title"]);
    expect(JOBS.textColumns).toEqual(["title", "description_html"]);
    // No card named the roles: the LargeUtf8 types stood in, and the shape says so.
    expect(JOBS.textColumnsInferred).toBe(true);
    // Named like the text, so preferred over the embedding's source.
    expect(JOBS.primaryText).toBe("description_html");
    expect(JOBS.keyColumn).toBe("id");
    expect(JOBS.listColumns).toEqual(["locations"]);
    expect(JOBS.scalarColumns).not.toContain("title");
    expect(JOBS.scalarColumns).not.toContain("locations");
    expect(JOBS.scalarColumns).toContain("source_slug");
  });

  it("projects every column but the vector, with score, and the types as the tool text shows them", () => {
    expect(JOBS.projection).not.toContain("emb");
    expect(JOBS.projection).not.toContain(ENGINE_ID_COLUMN);
    expect(JOBS.projection[JOBS.projection.length - 1]).toBe("score");
    expect(JOBS.projection).toContain("locations");
    expect(JOBS.columns.find((c) => c.name === "locations")?.type).toBe("list<utf8>");
    expect(JOBS.columns.find((c) => c.name === "emb")?.type).toBe("embedding");
  });

  it("takes the card's roles over the types when a card names them", () => {
    const card = {
      table: "chunks_jobs",
      rows: 10,
      schema: [
        { name: "title", type: "LargeUtf8", index: "scalar" },
        { name: "description_html", type: "LargeUtf8", index: "fts" },
        { name: "emb", type: "FixedSizeList(768 x non-null Float32)", index: "vector" },
        { name: "source_slug", type: "Utf8", index: "key" },
      ],
    };
    const shape = tableShapeFrom("chunks_jobs", JOBS_SCHEMA, card);
    expect(shape.textColumns).toEqual(["description_html"]);
    expect(shape.textColumnsInferred).toBe(false);
    expect(shape.keyColumn).toBe("source_slug");
    expect(shape.card).toBe(card);
  });

  it("searches an indexed column, never the embedding's source when that is not indexed", () => {
    // The jobs pattern - a column embedded but not indexed - under names the
    // hint misses: the card indexes `notes` and marks `subject`, the
    // embedding's source, scalar. A hybrid search or token match over
    // `subject` is refused by the engine, which has no full-text index there.
    const fields: SchemaField[] = [
      { name: "ticket", type: "utf8" },
      { name: "notes", type: "large_utf8" },
      { name: "subject", type: "large_utf8" },
      { name: "vec", type: "embedding", source: ["subject"] },
    ];
    const card = {
      table: "tickets",
      schema: [
        { name: "notes", type: "LargeUtf8", index: "fts" },
        { name: "subject", type: "LargeUtf8", index: "scalar" },
        { name: "vec", type: "FixedSizeList(768 x non-null Float32)", index: "vector" },
      ],
    };
    const shape = tableShapeFrom("tickets", fields, card);
    expect(shape.textColumns).toEqual(["notes"]);
    expect(shape.primaryText).toBe("notes");
    // Without the card both columns are LargeUtf8 and so taken as indexed,
    // and the embedding's source is the pick among them, as before.
    expect(tableShapeFrom("tickets", fields).primaryText).toBe("subject");
  });

  it("believes a card that names no full-text column: nothing is searched, and nothing is called inferred", () => {
    // The optimizer probed every text column; a card with no fts role is a
    // table with no full-text index, not a table with no card. The embedded
    // column and the key must not stand in for one - the engine would refuse
    // a hybrid_search or token_match over either.
    const fields: SchemaField[] = [
      { name: "ticket", type: "utf8" },
      { name: "subject", type: "large_utf8" },
      { name: "vec", type: "embedding", source: ["subject"] },
    ];
    const card = {
      table: "tickets",
      schema: [
        { name: "ticket", type: "Utf8", index: "key" },
        { name: "subject", type: "LargeUtf8", index: "scalar" },
        { name: "vec", type: "FixedSizeList(768 x non-null Float32)", index: "vector" },
      ],
    };
    const shape = tableShapeFrom("tickets", fields, card);
    expect(shape.textColumns).toEqual([]);
    expect(shape.textColumnsInferred).toBe(false);
    expect(shape.primaryText).toBe("");
    expect(shape.keyColumn).toBe("ticket");
    // Nor does a plain text column become the searched one when a card exists.
    const plain = tableShapeFrom("tickets", [{ name: "ticket", type: "utf8" }, { name: "subject", type: "utf8" }], card);
    expect(plain.primaryText).toBe("");
    // Nor without one: with no card only the LargeUtf8 types stand in for
    // the fts role, and a Utf8 column never does - the platform's optimizer
    // probes LargeUtf8 columns alone for an index, and the engine refuses a
    // search or token match over a column with none. This asserted the
    // opposite until 2026-10-01, when the Berka tables, hydrated with no
    // full-text index, would have been searched on a transaction's `type`.
    const uncarded = tableShapeFrom("tickets", [{ name: "ticket", type: "utf8" }, { name: "subject", type: "utf8" }]);
    expect(uncarded.textColumns).toEqual([]);
    expect(uncarded.primaryText).toBe("");
  });

  it("falls back to the embedding's source, then the engine id, on a table with neither hint", () => {
    const shape = tableShapeFrom("t", [
      { name: "headline", type: "large_utf8" },
      { name: "n", type: "i64" },
      { name: "vec", type: "embedding", source: ["headline"] },
    ]);
    expect(shape.primaryText).toBe("headline");
    expect(shape.keyColumn).toBe(ENGINE_ID_COLUMN);
    // With nothing of the table's to key a row, the engine's id is asked for.
    expect(shape.projection[0]).toBe(ENGINE_ID_COLUMN);
  });

  it("nominates a table's one vector column with nothing to say who filled it, for the platform's check to accept or refuse", () => {
    // The schema spells a vector a caller filled as it spells the platform's
    // own, and with no record of a load that embedded it nothing here says
    // which this is. The shape alone offers the one such column;
    // resolveTableShape then asks the platform to embed a query for it, and
    // a column the platform did not fill is refused there (the checks
    // below). The projection never carries it either way.
    const shape = tableShapeFrom("t", [
      { name: "body", type: "large_utf8" },
      { name: "v", type: "vector", dim: 16 },
    ]);
    expect(shape.vectorColumn).toBe("v");
    expect(shape.vectorSource).toEqual([]);
    expect(shape.projection).not.toContain("v");
    expect(shape.columns.find((c) => c.name === "v")?.type).toBe("vector<16>");
  });
});

describe("snippet", () => {
  it("decodes entity-escaped HTML, strips the tags, collapses whitespace", () => {
    // The shape a stored job description has: HTML, itself entity-escaped.
    const stored = "&lt;div class=&quot;intro&quot;&gt;&lt;p&gt;&lt;strong&gt;About&lt;/strong&gt; us&amp;nbsp;&amp;mdash; we\n\n  build&lt;/p&gt;&lt;/div&gt;";
    expect(snippet(stored)).toBe("About us — we build");
  });

  it("strips plain HTML and decodes numeric references too", () => {
    expect(snippet("<p>That&#39;s <em>fine</em> &amp; done</p>")).toBe("That's fine & done");
  });

  it("caps the text at SNIPPET_CHARS and marks the cut", () => {
    const long = "word ".repeat(SNIPPET_CHARS);
    const out = snippet(long);
    expect(out.length).toBe(SNIPPET_CHARS + "...".length);
    expect(out.endsWith("...")).toBe(true);
    expect(snippet("short")).toBe("short");
  });

  it("keeps plain text verbatim, angle brackets and entities included: only HTML is stripped", () => {
    // Prose that holds a `<` is not markup, and a tag stripper that does not
    // ask first turns "a < b and c > d" into "a d".
    expect(snippet("retry while a < b and c > d")).toBe("retry while a < b and c > d");
    expect(snippet("returns a Vec<T> of rows", "title")).toBe("returns a Vec<T> of rows");
    expect(snippet("Tom &amp; Jerry", "title")).toBe("Tom &amp; Jerry");
    // Two tags make it HTML, and so does a column whose name says so - the
    // one `<T>` above is neither.
    expect(snippet("<p>Vec<T></p>")).toBe("Vec");
    expect(snippet("Vec<T>", "description_html")).toBe("Vec");
  });
});

describe("rowHit", () => {
  const row = {
    id: "greenhouse:acme:1",
    source_slug: "acme",
    title: "Rust Engineer",
    apply_url: "https://acme.test/1",
    description_html: "&lt;p&gt;Build &lt;b&gt;fast&lt;/b&gt; things&lt;/p&gt;",
    locations: ["Remote"],
    remote: true,
    score: 0.5,
  };

  it("orders a hit score, key, scalars, then the text columns as snippets, and drops omitted cells", () => {
    const hit = rowHit(row, JOBS);
    expect(Object.keys(hit)).toEqual(["score", "id", "source_slug", "apply_url", "locations", "remote", "title", "description_html"]);
    expect(hit.description_html).toBe("Build fast things");
    expect(hit.title).toBe("Rust Engineer");
    expect(hit).not.toHaveProperty("salary_min");
    expect(rowKey(row, JOBS)).toBe("greenhouse:acme:1");
  });

  it("renders a fact of the loop the same way, keeping the statement's own aliases and leaving the vector out", () => {
    // A loop's statement is not a projection of the table: an aggregate's
    // count travels under an alias no schema carries, and a hit of the
    // table's columns alone would drop the answer.
    const fact = rowFact({ ...row, n: 7, ranked_rows: 3, emb: [0.1, 0.2] }, JOBS);
    expect(Object.keys(fact)).toEqual(["score", "id", "source_slug", "apply_url", "locations", "remote", "title", "description_html", "n", "ranked_rows"]);
    expect(fact.description_html).toBe("Build fast things");
    expect(fact.locations).toEqual(["Remote"]);
    expect(fact).not.toHaveProperty("emb");
    expect(rowFact({ department: "Eng", n: 42 }, JOBS)).toEqual({ department: "Eng", n: 42 });
  });
});

describe("the doors over rows", () => {
  it("search asks the platform for the table's own text and embedding columns with its projection", async () => {
    const calls: unknown[][] = [];
    const hosted = {
      hybridSearch: async (...args: unknown[]) => {
        calls.push(args);
        return [{ id: "a", title: "T", description_html: "&lt;p&gt;x&lt;/p&gt;", score: 1 }];
      },
      bm25Search: async () => {
        throw new Error("not the keyword route: the table has an embedding column");
      },
    };
    const result = await searchRows(hosted, JOBS, "rust jobs", 3);
    expect(calls).toEqual([["chunks_jobs", "description_html", "emb", "rust jobs", 3, JOBS.projection]]);
    expect(result).toMatchObject({ ranking: "hybrid", table: "chunks_jobs", key: "id" });
    expect(result.hits).toEqual([{ score: 1, id: "a", title: "T", description_html: "x" }]);
  });

  it("search with the question asks the platform to rerank its pool for it, and returns k", async () => {
    const calls: unknown[][] = [];
    const hosted = {
      hybridSearch: async (...args: unknown[]) => {
        calls.push(args);
        return [{ id: "a", title: "T", description_html: "x", score: 1 }];
      },
      bm25Search: async () => [],
    };
    await searchRows(hosted, JOBS, "rust jobs", 3, "  which jobs want rust?  ");
    expect(calls).toEqual([
      ["chunks_jobs", "description_html", "emb", "rust jobs", 3, JOBS.projection, { question: "which jobs want rust?", k: 3 }],
    ]);
  });

  it("code search with the question asks the platform to rerank its pool for it; without one it asks nothing", async () => {
    const calls: unknown[][] = [];
    const hosted = {
      hybridSearch: async (...args: unknown[]) => {
        calls.push(args);
        return [{ path: "a.rs", start_line: 1, end_line: 2, lang: "rust", symbol: "f", content: "fn f() {}", score: 1 }];
      },
    };
    await searchHosted(hosted, "parse config", 4, { question: "  where is the config parsed?  " });
    await searchHosted(hosted, "parse config", 4);
    expect(calls[0].at(-1)).toEqual({ question: "where is the config parsed?", k: 4 });
    expect(calls[1]).toHaveLength(6);
  });

  it("find with the question fetches the rerank pool for the grader and asks for its limit; without one it fetches the limit", async () => {
    const asked: Array<{ sql: string; checks: unknown }> = [];
    const hosted = {
      querySqlChecked: async (sql: string, checks: unknown) => {
        asked.push({ sql, checks });
        return { rows: [{ __cx_total: 1, id: "a", title: "A" }] };
      },
    };
    await findRows(hosted, JOBS, "rust", { limit: 2, question: "which jobs want rust?" });
    await findRows(hosted, JOBS, "rust", { limit: 2 });
    expect(asked.map((a) => a.checks)).toEqual([{ rerank: { question: "which jobs want rust?", k: 2 } }, {}]);
    expect(asked[0].sql).toMatch(new RegExp(`LIMIT ${RERANK_POOL_ROWS}$`));
    expect(asked[1].sql).toMatch(/LIMIT 2$/);
  });

  it("find with the question still returns its limit when the platform did not rerank, and counts every match", async () => {
    const pool = Array.from({ length: 5 }, (_, i) => ({ __cx_total: 9, id: `r${i}`, title: "A" }));
    const hosted = { querySqlChecked: async () => ({ rows: pool }) };
    const result = await findRows(hosted, JOBS, "rust", { limit: 2, question: "which jobs want rust?" });
    expect(result.matches.map((m) => m.id)).toEqual(["r0", "r1"]);
    expect(result).toMatchObject({ total: 9, truncated: true });
  });

  it("find with the question fetches only its limit once the platform has said it runs no grader", async () => {
    const asked: Array<{ sql: string; checks: unknown }> = [];
    const hosted = {
      reranksOnRead: false,
      querySqlChecked: async (sql: string, checks: unknown) => {
        asked.push({ sql, checks });
        return { rows: [{ __cx_total: 1, id: "a", title: "A" }] };
      },
    };
    await findRows(hosted, JOBS, "rust", { limit: 2, question: "which jobs want rust?" });
    expect(asked[0].checks).toEqual({});
    expect(asked[0].sql).toMatch(/LIMIT 2$/);
  });

  it("search falls back to the keyword route when the table has no embedding column", async () => {
    const shape = tableShapeFrom("t", [{ name: "body", type: "large_utf8" }, { name: "n", type: "i64" }]);
    const calls: unknown[][] = [];
    const hosted = {
      hybridSearch: async () => {
        throw new Error("no vector to fuse");
      },
      bm25Search: async (...args: unknown[]) => {
        calls.push(args);
        return [];
      },
    };
    const result = await searchRows(hosted, shape, "q", 5);
    expect(calls).toEqual([["t", "body", "q", 5, shape.projection]]);
    expect(result.ranking).toBe("keyword");
  });

  it("find spells the token_match statement with quotes doubled and the total beside each row under a name no schema carries", () => {
    const sql = findRowsSql(JOBS, "o'reilly rust", 40);
    expect(sql).toBe(
      'SELECT COUNT(*) OVER () AS __cx_total, "id", "source_slug", "title", "apply_url", "description_html", ' +
        '"employment_type", "department", "locations", "remote", "posted_at", "updated_at", "salary_min", ' +
        '"salary_max", "salary_currency", "salary_period" ' +
        "FROM token_match('chunks_jobs', 'description_html', 'o''reilly rust', 'and') LIMIT 40",
    );
    expect(sqlLiteral("it's")).toBe("'it''s'");
  });

  it("find blanks the query grammar, reads the total off the rows, and marks a cut", async () => {
    const sent: string[] = [];
    const hosted = {
      querySqlChecked: async (sql: string) => {
        sent.push(sql);
        return {
          rows: [
            { __cx_total: 7, id: "a", title: "A" },
            { __cx_total: 7, id: "b", title: "B" },
          ],
        };
      },
    };
    const result = await findRows(hosted, JOBS, 'senior -rust "engineer"', { limit: 2 });
    expect(sent[0]).toContain("'senior  rust  engineer '");
    expect(sent[0]).toContain("LIMIT 2");
    expect(result).toMatchObject({ table: "chunks_jobs", column: "description_html", key: "id", total: 7, truncated: true });
    expect(result.matches).toEqual([
      { id: "a", title: "A" },
      { id: "b", title: "B" },
    ]);
  });

  it("keeps a table's own total and score columns: the count alias collides with neither, and score is named once", async () => {
    const shape = tableShapeFrom("t", [
      { name: "id", type: "utf8" },
      { name: "total", type: "i64" },
      { name: "score", type: "f64" },
      { name: "body", type: "large_utf8" },
    ]);
    expect(shape.rowColumns).toEqual(["id", "total", "score", "body"]);
    expect(shape.projection).toEqual(["id", "total", "score", "body"]);
    expect(shape.projection.filter((name) => name === "score")).toHaveLength(1);
    expect(findRowsSql(shape, "x", 5)).toBe(
      'SELECT COUNT(*) OVER () AS __cx_total, "id", "total", "score", "body" FROM token_match(\'t\', \'body\', \'x\', \'and\') LIMIT 5',
    );
    const hosted = { querySqlChecked: async () => ({ rows: [{ __cx_total: 2, id: "a", total: 9, score: 0.5, body: "x" }] }) };
    const result = await findRows(hosted, shape, "x");
    expect(result.total).toBe(2);
    expect(result.matches).toEqual([{ score: 0.5, id: "a", total: 9, body: "x" }]);
  });

  it("find refuses what the chunks find refuses, and reports no rows as zero", async () => {
    const hosted = { querySqlChecked: async () => ({ rows: [] }) };
    await expect(findRows(hosted, JOBS, "")).rejects.toThrow(/non-empty/);
    await expect(findRows(hosted, JOBS, "a\nb")).rejects.toThrow(/newline/);
    await expect(findRows(hosted, JOBS, "->")).rejects.toThrow(/regexp_like\(description_html/);
    await expect(findRows(hosted, JOBS, "x", { limit: 0 })).rejects.toThrow(/positive integer/);
    expect(await findRows(hosted, JOBS, "nothing")).toMatchObject({ total: 0, matches: [] });
  });

  it("foldEmbeds turns {{q}} with an embed map into the platform's inline form and leaves that form alone", () => {
    expect(foldEmbeds("SELECT * FROM hybrid_search('t','b','x','e', {{q}}, 5)", { q: "rust jobs" })).toBe(
      'SELECT * FROM hybrid_search(\'t\',\'b\',\'x\',\'e\', {{q:"rust jobs"}}, 5)',
    );
    const inline = 'SELECT * FROM vector_search(\'t\',\'e\', {{q:"already inline"}}, 5)';
    expect(foldEmbeds(inline, undefined)).toBe(inline);
    expect(foldEmbeds("SELECT 1", undefined)).toBe("SELECT 1");
    expect(() => foldEmbeds("SELECT {{q}}", undefined)).toThrow(/no 'embed' map/);
    expect(() => foldEmbeds("SELECT {{q}}", {})).toThrow(/no 'embed' text/);
    expect(() => foldEmbeds("SELECT {{q}}", { q: 'a"}}b' })).toThrow(/ends the platform's placeholder/);
  });

  // The three hybrid_search calls Sonnet wrote over the Wikipedia table on
  // the demo, 2026-10-01, each refused by the platform as written.
  const WRITTEN = [
    {
      as: '{q: "..."}',
      sql: "SELECT url, name FROM hybrid_search('chunks_wikipedia_v5', 'sections', 'Brexit', 'emb', {q: \"Brexit United Kingdom European Union\"}, 50) WHERE chunk = 0",
      text: "Brexit United Kingdom European Union",
    },
    {
      as: '{{"q": "..."}}',
      sql: "SELECT url, name FROM hybrid_search('chunks_wikipedia_v5', 'sections', 'Brexit', 'emb', {{\"q\": \"Brexit United Kingdom European Union\"}}, 50) WHERE chunk = 0",
      text: "Brexit United Kingdom European Union",
    },
    {
      as: "{q: '...'}",
      sql: "SELECT url, name FROM hybrid_search('chunks_wikipedia_v5', 'sections', 'Brexit India', 'emb', {q: 'Brexit impact on India Indian perspective'}, 50) WHERE chunk = 0",
      text: "Brexit impact on India Indian perspective",
    },
  ];

  it.each(WRITTEN)("normalizeQueryPlaceholders reads $as in a hybrid_search call as the platform's placeholder", ({ sql, text }) => {
    const out = normalizeQueryPlaceholders(sql);
    expect(out).toContain(`'emb', {{q:"${text}"}}, 50) WHERE chunk = 0`);
    expect(out.startsWith("SELECT url, name FROM hybrid_search('chunks_wikipedia_v5', 'sections', 'Brexit")).toBe(true);
    expect(embedsAQuery(out)).toBe(true);
  });

  it("normalizeQueryPlaceholders unquotes a SQL string, takes either function in any case, and every call in a statement", () => {
    expect(normalizeQueryPlaceholders("SELECT _id FROM vector_search('t','emb', { q : 'India''s response' }, 5)")).toBe(
      "SELECT _id FROM vector_search('t','emb', {{q:\"India's response\"}}, 5)",
    );
    expect(normalizeQueryPlaceholders("SELECT _id FROM HYBRID_SEARCH ('t','b','x','emb', {'q': 'x'}, 5)")).toBe(
      "SELECT _id FROM HYBRID_SEARCH ('t','b','x','emb', {{q:\"x\"}}, 5)",
    );
    expect(
      normalizeQueryPlaceholders("SELECT _id FROM vector_search('t','e', {q: 'a'}, 1) UNION ALL SELECT _id FROM vector_search('t','e', {q: \"b\"}, 1)"),
    ).toBe("SELECT _id FROM vector_search('t','e', {{q:\"a\"}}, 1) UNION ALL SELECT _id FROM vector_search('t','e', {{q:\"b\"}}, 1)");
    // A comment between the name and its parenthesis is whitespace.
    expect(normalizeQueryPlaceholders("SELECT * FROM vector_search /* top 5 */ ('t','e', {q: 'x'}, 5)")).toBe(
      "SELECT * FROM vector_search /* top 5 */ ('t','e', {{q:\"x\"}}, 5)",
    );
  });

  it("normalizeQueryPlaceholders keeps the platform's own form byte for byte, read as the platform reads it", () => {
    for (const sql of [
      "SELECT * FROM vector_search('t','e', {{q:\"a\\b\"}}, 1)",
      "SELECT * FROM vector_search('t','e', {{q:\"the \"best\" one\"}}, 1)",
      // The platform reads the text to the first `"}}`: `12"} monitor` here.
      "SELECT * FROM vector_search('t','emb', {{q:\"12\"} monitor\"}}, 5)",
      "SELECT * FROM vector_search('t','emb', {{q:\"a\" }}b\"}}, 5)",
      // One closing brace short: the platform reads it its own way, not ours.
      "SELECT * FROM vector_search('t','e', {{q:\"x\"}, 1)",
      "SELECT * FROM hybrid_search('t','b','x','e', {{q}}, 5)",
      "SELECT 1",
    ]) {
      expect(normalizeQueryPlaceholders(sql)).toBe(sql);
    }
    // An odd count of quotes in its text does not put what follows out of step.
    expect(
      normalizeQueryPlaceholders("SELECT * FROM vector_search('t','emb', {{q:\"27\" monitor\"}}, 5) UNION ALL SELECT * FROM vector_search('t','emb', {q: \"laptop\"}, 5)"),
    ).toBe("SELECT * FROM vector_search('t','emb', {{q:\"27\" monitor\"}}, 5) UNION ALL SELECT * FROM vector_search('t','emb', {{q:\"laptop\"}}, 5)");
    const later = "SELECT * FROM vector_search('t','emb', {{q:\"27\" monitor\"}}, 5) WHERE title <> 'a \"b' AND body LIKE '%{q: \"x\"}%'";
    expect(normalizeQueryPlaceholders(later)).toBe(later);
  });

  it("normalizeQueryPlaceholders leaves a struct literal alone wherever it is not a vector search's argument", () => {
    for (const sql of [
      // A struct in the select list, and in a function that merely ends in a search function's name.
      "SELECT {q: 'x'} AS s FROM t",
      "SELECT * FROM my_hybrid_search('t', {q: 'x'})",
      // Inside a string, an escape string, an identifier or a comment, nested ones included.
      "SELECT * FROM hybrid_search('t','b','{q: ''x''}','e', {{q:\"x\"}}, 5)",
      "SELECT * FROM hybrid_search('t','c',E'it\\'s {q: \"x\"}', 'emb', {{q}}, 5)",
      "SELECT * FROM hybrid_search('t','b','x','e', /* {q: 'x'} */ {{q:\"x\"}}, 5) -- {q: 'y'}",
      "SELECT * FROM vector_search('t','emb', /* a /* b */ {q: 'x'} */ {{q}}, 5)",
      // A vector search's name inside a comment calls nothing.
      "SELECT * FROM t UNION ALL -- then hybrid_search\n(SELECT {q: 'x'} AS s)",
      // Not a direct argument: inside another call, or another struct, within the search's.
      "SELECT * FROM vector_search('t','e', coalesce({q: 'x'}), 5)",
      "SELECT * FROM vector_search('t','e', {a: {q: 'x'}}, 5)",
    ]) {
      expect(normalizeQueryPlaceholders(sql)).toBe(sql);
    }
    // Quotes the engine reads - a comment's, a backticked name's, an escape
    // string's, a dollar-quoted string's - do not shift what is read as
    // quoted after them.
    for (const before of [
      "-- don't\nSELECT *",
      "SELECT title AS `Brexit's article`",
      "SELECT E'Brexit\\'s impact' AS a",
      "SELECT $$Brexit's impact$$ AS a",
      "SELECT $q$Brexit's {impact$q$ AS a",
    ]) {
      expect(normalizeQueryPlaceholders(`${before} FROM vector_search('t','e', {q: 'x'}, 5)`)).toBe(
        `${before} FROM vector_search('t','e', {{q:"x"}}, 5)`,
      );
    }
    // Inside a dollar-quoted string, a placeholder's spelling is the string's.
    const inside = "SELECT title FROM hybrid_search('t', 'sections', $$about {q: 'x'} syntax$$, 'emb', {{q:\"Brexit\"}}, 5)";
    expect(normalizeQueryPlaceholders(inside)).toBe(inside);
    // A `$` within a name is part of the name, not a dollar quote.
    expect(normalizeQueryPlaceholders("SELECT a$b FROM vector_search('t','e', {q: 'x'}, 5) WHERE c$ = 1")).toBe(
      "SELECT a$b FROM vector_search('t','e', {{q:\"x\"}}, 5) WHERE c$ = 1",
    );
  });

  it("normalizeQueryPlaceholders reads a near spelling whole, so one a brace short leaves no struct open behind it", () => {
    expect(
      normalizeQueryPlaceholders("SELECT _id FROM vector_search('t','e', {{q: 'a'}, 5) UNION ALL SELECT _id FROM vector_search('t','e', {q: 'b'}, 5)"),
    ).toBe("SELECT _id FROM vector_search('t','e', {{q:\"a\"}}, 5) UNION ALL SELECT _id FROM vector_search('t','e', {{q:\"b\"}}, 5)");
    expect(
      normalizeQueryPlaceholders(
        "SELECT _id FROM hybrid_search('t','c','x','e', {{\"q\": \"a\"}, 5) UNION ALL SELECT _id FROM vector_search('t','e', {{\"q\": \"b\"}}, 5)",
      ),
    ).toBe("SELECT _id FROM hybrid_search('t','c','x','e', {{q:\"a\"}}, 5) UNION ALL SELECT _id FROM vector_search('t','e', {{q:\"b\"}}, 5)");
  });

  it("normalizeQueryPlaceholders leaves a near spelling whose text holds a double quote as written, so the top-k check still reads it", () => {
    for (const sql of [
      "SELECT * FROM vector_search('t','e', {q: 'a\"}}b'}, 5)",
      "SELECT path, COUNT(*) AS n FROM hybrid_search('chunks','content','disk','embedding', {q: 'a 3.5\" disk'}, 50) GROUP BY path",
    ]) {
      expect(normalizeQueryPlaceholders(sql)).toBe(sql);
    }
    expect(
      topKAggregateRefusal("sql", normalizeQueryPlaceholders("SELECT path, COUNT(*) AS n FROM hybrid_search('chunks','content','disk','embedding', {q: 'a 3.5\" disk'}, 50) GROUP BY path")),
    ).toMatch(/^sql refused: a GROUP BY over hybrid_search\(\.\.\., 50\)/);
  });

  it("embedsAQuery counts the platform's own placeholder only where a vector search takes it", () => {
    expect(embedsAQuery("SELECT * FROM vector_search('t','e', {{q:\"x\"}}, 5)")).toBe(true);
    expect(embedsAQuery("SELECT * FROM hybrid_search('t','b','x','e', {{q}}, 5)")).toBe(true);
    // After a dollar-quoted string holding an apostrophe too.
    expect(embedsAQuery("SELECT path FROM hybrid_search('chunks', 'content', $$it's$$, 'embedding', {{q:\"Brexit\"}}, 30)")).toBe(true);
    for (const sql of [
      "SELECT path, start_line FROM chunks WHERE content LIKE '%{{q:\"%'",
      "SELECT path FROM chunks WHERE content LIKE '%{{q:\"text\"}}%'",
      "SELECT COUNT(*) AS n FROM chunks -- the {{q:\"...\"}} form",
    ]) {
      expect(embedsAQuery(sql), sql).toBe(false);
    }
  });

  /** A statement far past any a model writes, of many short parenthesized
   * rows and no placeholder, and the most its reading may take: the pass is
   * linear, so this is generous by orders of magnitude (the first version,
   * which re-read the text before every parenthesis, took 3 s on it). */
  const LARGE_ROWS = 20_000;
  const LARGE_READ_MS_MAX = 500;

  it("normalizeQueryPlaceholders reads a large statement in one pass and returns it as written", () => {
    const rows = Array.from({ length: LARGE_ROWS }, (_, i) => `(${i}, 'r${i}')`).join(", ");
    const sql = `SELECT * FROM (VALUES ${rows}) AS v(a, b)`;
    const t0 = performance.now();
    expect(normalizeQueryPlaceholders(sql)).toBe(sql);
    expect(performance.now() - t0).toBeLessThan(LARGE_READ_MS_MAX);
  });
});

describe("the tool text for a table of another shape", () => {
  it("names the table's real columns, types, indexes and search functions in the sql description", () => {
    const text = rowsSqlDescription(JOBS);
    expect(text).toContain("chunks_jobs(id utf8, source_slug utf8, title large_utf8");
    expect(text).toContain("locations list<utf8>");
    expect(text).toContain("Full-text indexed: title, description_html");
    expect(text).toContain("Vector column: emb, the platform's embedding of title");
    expect(text).toContain("hybrid_search('chunks_jobs','description_html','terms','emb', {{q:\"...\"}}, k)");
    expect(text).toContain("bm25_search('chunks_jobs','description_html','terms', k)");
    expect(text).toContain("vector_search('chunks_jobs','emb', {{q:\"...\"}}, k)");
    expect(text).toContain("token_match('chunks_jobs','description_html','terms','and')");
    expect(text).toContain("returns _id, the table's scalar columns and score");
    expect(text).toContain("array_has(locations, '...')");
    // The measured clauses, transposed: hybrid before bm25, the placeholder
    // the caller's, a ranked total never the table's count, the scan named.
    expect(text.indexOf("hybrid_search")).toBeLessThan(text.indexOf("bm25_search"));
    expect(text).toMatch(/are yours to fill in, not literals to copy/);
    expect(text).toContain("never the table's count");
    for (const predicate of ["ILIKE", "LIKE", "regexp_like"]) expect(text).toContain(predicate);
    // The function models write and DataFusion lacks, with its stand-in -
    // the same sentence the loop's dialect note carries.
    expect(text).toContain("has no regexp_extract: regexp_match(text, 'pattern')[1] is the first capture group");
    // Nothing of the chunks table leaks into it.
    expect(text).not.toContain("start_line");
    expect(text).not.toContain("'content'");
  });

  it("states the regex dialect on a table with no full-text index too", () => {
    // A table of plain columns is still queried with regexp_match.
    const shape = tableShapeFrom("t", [{ name: "n", type: "i64" }, { name: "label", type: "utf8" }]);
    expect(rowsSqlDescription(shape)).toContain("has no regexp_extract");
  });

  it("tells the caller to compare a row id as a string, as the loop's dialect note does", () => {
    // A bare 32-digit id is read as a float and the statement fails on overflow.
    const plain = rowsSqlDescription(tableShapeFrom("t", [{ name: "n", type: "i64" }, { name: "label", type: "utf8" }]));
    for (const text of [rowsSqlDescription(JOBS), plain]) {
      expect(text).toContain("A row id is too wide for a number: compare it as a string, _id = '32995980872922260363525666898294'");
    }
  });

  it("tells the caller to put the whole question into one statement, and to count several terms one token_match each", () => {
    const text = rowsSqlDescription(JOBS);
    expect(text).toContain(ONE_STATEMENT_SENTENCE);
    expect(text).toContain(severalTermsSentence("chunks_jobs", "description_html"));
    // Why one pattern of alternatives will not do.
    expect(text).toContain("the first capture group of the first match alone");
    expect(text).toContain("never counts several");
    // A table with no full-text column hears the first and not the second:
    // it has no token_match to run.
    const plain = rowsSqlDescription(tableShapeFrom("t", [{ name: "n", type: "i64" }, { name: "label", type: "utf8" }]));
    expect(plain).toContain(ONE_STATEMENT_SENTENCE);
    expect(plain).not.toContain("token_match");
    // The chunks text says both.
    expect(SQL_DESCRIPTION).toContain(ONE_STATEMENT_SENTENCE);
    expect(SQL_DESCRIPTION).toContain(severalTermsSentence(TABLE, "content"));
  });

  it("says terms alone when the table has no embedding column", () => {
    const shape = tableShapeFrom("t", [{ name: "body", type: "large_utf8" }, { name: "n", type: "i64" }]);
    const text = rowsSqlDescription(shape);
    expect(text).toContain("No vector column");
    expect(text).not.toContain("hybrid_search");
    expect(text).toContain("bm25_search('t','body','terms', 300)");
  });

  it("says the full-text columns are inferred from the schema when no card named them, and states them when one did", () => {
    // Without a card the LargeUtf8 types stand in for the fts role, and
    // hydrate casts an embedded-only column to LargeUtf8 too - so the jobs
    // table's `title` is listed although only `description_html` is indexed.
    // The text must not state that list as the table's own.
    const inferred = rowsSqlDescription(JOBS);
    expect(inferred).toContain("Full-text indexed: title, description_html (inferred from the schema - the table has no card naming its indexes yet");
    expect(inferred).toContain("one the platform only embeds may be among them). ");
    const carded = rowsSqlDescription(
      tableShapeFrom("chunks_jobs", JOBS_SCHEMA, { schema: [{ name: "description_html", index: "fts" }, { name: "title", index: "scalar" }] }),
    );
    expect(carded).toContain("Full-text indexed: description_html. ");
    expect(carded).not.toContain("inferred from the schema");
  });

  it("says table and row and names the key where the chunks text says repository and path:line", () => {
    for (const text of [rowsInstructions(JOBS), rowsSearchDescription(JOBS), rowsFindDescription(JOBS)]) {
      expect(text).toContain("chunks_jobs");
      expect(text).toMatch(/\brow/);
      expect(text).not.toContain("path:line");
      expect(text).not.toContain("repository index");
    }
    expect(rowsSearchDescription(JOBS)).toContain("Cite a row as a markdown link to its apply_url");
    expect(rowsFindDescription(JOBS)).toContain("ignoreCase, defines and under describe a code index and do nothing here");
    expect(rowsInstructions(JOBS)).not.toContain("- ask -");
  });

  it("holds the caller's statements and answers to the rules the platform's loop writes under", () => {
    // The loop's retrieval prompt carries the same sentences (the owner,
    // 2026-09-30: a prompt change goes to the inner and the outer loop).
    const withVector = rowsSqlDescription(JOBS);
    expect(withVector).toContain(KEEP_CONDITIONS_SENTENCE);
    expect(withVector).toContain(RELATED_TO_SENTENCE);
    expect(withVector).toContain(LANGUAGE_KIND_SENTENCE);
    // Related-to and a kind of language rank by meaning, so they are said
    // only where there is a vector.
    const termsOnly = rowsSqlDescription(tableShapeFrom("t", [{ name: "body", type: "large_utf8" }, { name: "n", type: "i64" }]));
    expect(termsOnly).toContain(KEEP_CONDITIONS_SENTENCE);
    expect(termsOnly).not.toContain(RELATED_TO_SENTENCE);
    expect(termsOnly).not.toContain(LANGUAGE_KIND_SENTENCE);
    // The code table's text says both too.
    expect(SQL_DESCRIPTION).toContain(KEEP_CONDITIONS_SENTENCE);
    expect(SQL_DESCRIPTION).toContain(RELATED_TO_SENTENCE);
    // The one rule for hybrid against keyword, in the sql text and the
    // instructions wherever a vector can rank, and nowhere a table has none
    // to rank by: keyword matching only to count or list every exact
    // occurrence. The platform loop's text carries the same words.
    expect(withVector).toContain(SEARCH_RULE_SENTENCE);
    expect(SQL_DESCRIPTION).toContain(SEARCH_RULE_SENTENCE);
    expect(rowsInstructions(JOBS)).toContain(SEARCH_RULE_SENTENCE.trimEnd());
    expect(rowsInstructions(JOBS)).toContain(SEARCH_RULE_SENTENCE.trimEnd());
    expect(termsOnly).not.toContain("Finding rows is a hybrid_search");
    const termsOnlyShape = tableShapeFrom("t", [{ name: "body", type: "large_utf8" }, { name: "n", type: "i64" }]);
    expect(rowsInstructions(termsOnlyShape)).not.toContain("Finding rows is a hybrid_search");
    // Hybrid is named before any keyword function in the rule itself.
    expect(SEARCH_RULE_SENTENCE.indexOf("hybrid_search")).toBeLessThan(SEARCH_RULE_SENTENCE.indexOf("token_match"));
    // A count question's answer states the counts.
    expect(rowsInstructions(JOBS)).toContain(COUNTS_IN_THE_ANSWER);
    expect(rowsInstructions(JOBS)).toContain(COUNTS_IN_THE_ANSWER);
    // How a figure is read out of documents, with or without the platform's tools.
    expect(rowsInstructions(JOBS)).toContain(READING_HABITS);
    expect(rowsInstructions(JOBS)).toContain(READING_HABITS);
    // The latest printing wins only when it is a revision: a misprint its own
    // totals contradict, a reclassification or another period leaves the
    // earlier printing standing.
    expect(READING_HABITS).toContain("latest document that revises it");
    expect(READING_HABITS).toContain("is not a revision, and the earlier printing stands");
    // Parts under a named heading are summed, lines by period are chosen; a
    // named series and a named grain are kept; a value keeps its printed sign.
    expect(READING_HABITS).toContain("sub-columns printed under its heading");
    expect(READING_HABITS).toContain("the period the question names picks one");
    expect(READING_HABITS).toContain("never another standing in for it");
    expect(READING_HABITS).toContain("never merged into a coarser group");
    expect(READING_HABITS).toContain("a value keeps the sign it is printed with");
    // Arithmetic goes through a statement, in the instructions and the sql text.
    expect(rowsInstructions(JOBS)).toContain(ARITHMETIC_SENTENCE);
    expect(rowsSqlDescription(JOBS)).toContain(ARITHMETIC_SENTENCE);
  });
});

/** A table a hydrate load cut into passages: the article's columns, the
 * chunked body and the numbering column, as the Wikipedia load has them -
 * its vector column as the platform reports it since the seam (`vector`,
 * with its width and no source), and as the build before reported it. */
const PASSAGES_COLUMNS: SchemaField[] = [
  { name: "name", type: "large_utf8" },
  { name: "url", type: "utf8" },
  { name: "abstract", type: "large_utf8" },
  { name: "sections", type: "large_utf8" },
  { name: "references", type: "large_utf8" },
  { name: "chunk", type: "i32" },
];
/** The width of the Wikipedia table's `emb`. */
const PASSAGES_DIM = 768;
const PASSAGES_SCHEMA: SchemaField[] = [...PASSAGES_COLUMNS, { name: "emb", nullable: false, type: "vector", dim: PASSAGES_DIM }];
const PASSAGES_EMBEDDING_SCHEMA: SchemaField[] = [...PASSAGES_COLUMNS, { name: "emb", type: "embedding", source: ["name", "sections"] }];

/** The record of the hydrate job that loaded the Wikipedia table, as
 * `GET /v1/hydrate` served it (2026-10-01): the request, and the names and
 * roles the job settled on - `embed` the vector column it filled and the
 * columns it embedded. */
const PASSAGES_LOAD = {
  state: "succeeded",
  request: { table: "chunks_wikipedia_v5", no_embed: false, chunk: { column: "sections", max_tokens: 512, markdown: false } },
  schema: {
    fts: [{ column: "name" }, { column: "abstract" }, { column: "sections" }, { column: "references" }],
    embed: { column: "emb", source: ["name", "sections"] },
  },
};

/** The Wikipedia table's lean card, the roles the shape reads. */
const PASSAGES_CARD = {
  table: "chunks_wikipedia_v5",
  schema: [
    { name: "name", index: "fts" },
    { name: "url", index: "scalar" },
    { name: "abstract", index: "fts" },
    { name: "sections", index: "fts" },
    { name: "references", index: "fts" },
    { name: "chunk", index: "scalar" },
    { name: "emb", type: "FixedSizeList(768 x Float32)", index: "vector" },
  ],
};

// The platform reports the vector column it embedded as `vector`, as it
// reports a vector a caller filled; the build before the seam said
// `embedding`. A column is a candidate for search by meaning on the
// platform's word that it embedded it - the `embedding` type, or the hydrate
// job's record naming a `vector` column - and, with no such record, when it
// is the table's one vector column or the one its card names (a table copied
// from a hydrated one carries its vectors and no record); of several that
// nothing names, none. The client cannot read the model a column was
// embedded with, so whether the platform embeds queries for the candidate
// is the platform's to say (the check below).
describe("a vector column the platform embedded", () => {
  const notes = (fields: SchemaField[], card?: object | null, load?: object | null) => {
    const heard: string[] = [];
    const shape = tableShapeFrom("chunks_wikipedia_v5", fields, card, load, { onNote: (line) => heard.push(line) });
    return { shape, heard };
  };

  it("recognises a vector column by both spellings, nothing else", () => {
    const fields = [
      { name: "emb", type: "vector", dim: PASSAGES_DIM },
      { name: "emb", type: "embedding", source: ["sections"] },
      { name: "sections", type: "large_utf8" },
      { name: "tags", type: "list", item: "utf8" },
      { type: "vector", dim: 4 },
      null,
      undefined,
    ] as unknown as SchemaField[];
    expect(fields.map((f) => isVectorField(f))).toEqual([true, true, false, false, false, false, false]);
  });

  it("reads what the load embedded from its record, and only when the table has the columns it names", () => {
    expect(loadEmbeddingFrom(PASSAGES_LOAD, PASSAGES_SCHEMA)).toEqual({ column: "emb", source: ["name", "sections"] });
    // A load that embedded nothing, and no record at all.
    expect(loadEmbeddingFrom({ state: "succeeded", request: { no_embed: true }, schema: { fts: [] } }, PASSAGES_SCHEMA)).toBeNull();
    expect(loadEmbeddingFrom(null, PASSAGES_SCHEMA)).toBeNull();
    // A record of some other load under the name: a column, or a source,
    // this table does not have.
    expect(loadEmbeddingFrom({ schema: { embed: { column: "vec", source: ["sections"] } } }, PASSAGES_SCHEMA)).toBeNull();
    expect(loadEmbeddingFrom({ schema: { embed: { column: "emb", source: ["body"] } } }, PASSAGES_SCHEMA)).toBeNull();
  });

  it("searches the platform's vector spelling by meaning when the load's record says the platform embedded it", () => {
    for (const card of [null, PASSAGES_CARD]) {
      const { shape, heard } = notes(PASSAGES_SCHEMA, card, PASSAGES_LOAD);
      expect(shape.vectorColumn).toBe("emb");
      expect(shape.vectorSource).toEqual(["name", "sections"]);
      expect(shape.columns.find((c) => c.name === "emb")?.type).toBe(`vector<${PASSAGES_DIM}>`);
      expect(shape.projection).not.toContain("emb");
      expect(shape.scalarColumns).not.toContain("emb");
      expect(heard).toEqual([]);
    }
  });

  it("keeps the spelling of the build before the seam as it was, record or not", () => {
    for (const load of [null, PASSAGES_LOAD]) {
      const shape = tableShapeFrom("chunks_wikipedia_v5", PASSAGES_EMBEDDING_SCHEMA, null, load);
      expect(shape.vectorColumn).toBe("emb");
      expect(shape.vectorSource).toEqual(["name", "sections"]);
    }
  });

  it("with no record naming one, offers the table's one vector column, or the one its card names, and of several unnamed none - and says why", () => {
    // No record: a table copied from a hydrated one carries its vectors and
    // no record. The one vector column is
    // the candidate, with no source to name; the platform's check decides.
    let { shape, heard } = notes(PASSAGES_SCHEMA, PASSAGES_CARD, null);
    expect(shape.vectorColumn).toBe("emb");
    expect(shape.vectorSource).toEqual([]);
    expect(heard).toEqual([]);
    ({ shape, heard } = notes(PASSAGES_SCHEMA, null, null));
    expect(shape.vectorColumn).toBe("emb");
    expect(heard).toEqual([]);
    // Of two vector columns, the one the record says the load embedded, and
    // not the other.
    ({ shape, heard } = notes([...PASSAGES_SCHEMA, { name: "own", type: "vector", dim: 16 }], null, { schema: { embed: { column: "own", source: ["sections"] } } }));
    expect(shape.vectorColumn).toBe("own");
    // Of two that no record names: the one the card gives the vector role;
    // with no card either, neither, and why.
    ({ shape, heard } = notes([...PASSAGES_SCHEMA, { name: "own", type: "vector", dim: 16 }], PASSAGES_CARD, null));
    expect(shape.vectorColumn).toBe("emb");
    ({ shape, heard } = notes([...PASSAGES_SCHEMA, { name: "own", type: "vector", dim: 16 }], null, null));
    expect(shape.vectorColumn).toBeNull();
    expect(heard).toEqual([
      "vector column emb, own is not searched by meaning: no record of the load that made the table says the platform embedded it, and nothing names one of them",
    ]);
    // A load that embedded nothing: the one vector column is still the
    // candidate - whoever filled it, the check says whether the platform
    // embeds queries for it.
    ({ shape, heard } = notes(PASSAGES_SCHEMA, null, { request: { no_embed: true }, schema: {} }));
    expect(shape.vectorColumn).toBe("emb");
    expect(heard).toEqual([]);
    // A width the schema does not give.
    ({ shape, heard } = notes([...PASSAGES_COLUMNS, { name: "emb", type: "vector" }], null, PASSAGES_LOAD));
    expect(shape.vectorColumn).toBeNull();
    expect(heard).toEqual(["vector column emb is not searched by meaning: the schema gives it no width"]);
    // A card that does not give it the vector role.
    const scalarCard = { schema: PASSAGES_CARD.schema.map((c) => (c.name === "emb" ? { ...c, index: "scalar" } : c)) };
    ({ shape, heard } = notes(PASSAGES_SCHEMA, scalarCard, PASSAGES_LOAD));
    expect(shape.vectorColumn).toBeNull();
    expect(heard).toEqual(["vector column emb is not searched by meaning: the table's card gives it the role scalar, not vector"]);
  });

  it("runs search as a hybrid over the text and the vector, and writes the same text for either spelling", async () => {
    const live = tableShapeFrom("chunks_wikipedia_v5", PASSAGES_SCHEMA, PASSAGES_CARD, PASSAGES_LOAD);
    const before = tableShapeFrom("chunks_wikipedia_v5", PASSAGES_EMBEDDING_SCHEMA, PASSAGES_CARD, PASSAGES_LOAD);
    const calls: unknown[][] = [];
    const hosted = {
      hybridSearch: async (...args: unknown[]) => {
        calls.push(args);
        return [{ name: "Species", url: "https://en.wikipedia.org/wiki/Species", score: 0.016 }];
      },
      bm25Search: async () => {
        throw new Error("not the keyword route: the platform embedded emb");
      },
    };
    const result = await searchRows(hosted, live, "an animal species", 5);
    expect(calls).toEqual([["chunks_wikipedia_v5", live.primaryText, "emb", "an animal species", 5, live.projection]]);
    expect(result.ranking).toBe("hybrid");

    const sql = rowsSqlDescription(live);
    expect(sql).toContain("Vector column: emb, the platform's embedding of name, sections. ");
    expect(sql).toContain(`hybrid_search('chunks_wikipedia_v5','${live.primaryText}','terms','emb', {{q:"..."}}, k)`);
    expect(sql).toContain(`vector_search('chunks_wikipedia_v5','emb', {{q:"..."}}, k) is meaning alone`);
    expect(sql).not.toContain("No vector column");
    expect(rowsSearchDescription(live)).toContain("with semantic similarity over emb (the platform's embedding of name, sections)");
    // The two spellings differ in the type the column list shows, and in
    // nothing else.
    expect(sql).toBe(rowsSqlDescription(before).replace("emb embedding", `emb vector<${PASSAGES_DIM}>`));
    expect(rowsSearchDescription(live)).toBe(rowsSearchDescription(before));
    expect(rowsInstructions(live)).toBe(rowsInstructions(before));
  });
});

// The load's record says the platform embedded a column; it does not say the
// platform still embeds queries with the model that filled it - the embedder
// can change after a load, and a table can be loaded under a model of its
// own - and nothing the client reads names the model. So the platform is
// asked, the one place the model can be read: a search by meaning for one
// row, which it runs only for an embedding column of the model it embeds
// queries with (the platform's query embedder). A column it did not embed a
// query for is not searched by meaning, whatever stopped it.
describe("the platform's check of a vector column's model", () => {
  /** The platform's words for a column filled under another model. */
  const MISMATCH =
    'column "emb" was embedded with model "nomic-embed-text-v1.5"; this deployment embeds with "another-embedder", so text cannot be queried against it';
  /** What the platform answers a check it ran: the nearest row. */
  const NEAREST = [{ _id: 1, score: 0.26 }];
  const TABLE = "chunks_wikipedia_v5";
  /** An articles table's card naming `sections`, the passages the platform
   * embeds, as the table's prose: the column the doors search. */
  const SECTIONS_CARD = { ...PASSAGES_CARD, text_column: "sections" };

  /** The Wikipedia table on a platform whose check answers as `check` does,
   * every check it was asked recorded. */
  const platform = (
    check: () => Promise<RowRecord[]>,
    fields: SchemaField[] = PASSAGES_SCHEMA,
    load: object | null = PASSAGES_LOAD,
    card: object = PASSAGES_CARD,
  ) => {
    const checks: unknown[][] = [];
    const hosted = {
      schema: async () => fields as unknown as RowRecord,
      tableCard: async () => ({ card }) as RowRecord,
      hydrateJob: async () => {
        if (load === null) throw new HostedError("hydrate", 404, `no hydrate job for ${TABLE}`);
        return load as RowRecord;
      },
      vectorSearchText: async (...args: unknown[]) => {
        checks.push(args);
        return check();
      },
    };
    return { hosted, checks };
  };
  const resolve = async (hosted: ReturnType<typeof platform>["hosted"], options: Parameters<typeof resolveTableShape>[5] = {}) => {
    const heard: string[] = [];
    const shape = await resolveTableShape(hosted, TABLE, "lean", undefined, true, { onNote: (line) => heard.push(line), ...options });
    return { shape, heard };
  };
  const refused = (status: number, words: string) => async (): Promise<RowRecord[]> => {
    throw new HostedError("vector_search", status, words);
  };

  it("searches by meaning a column the platform embedded a query for, asked once for one row", async () => {
    const { hosted, checks } = platform(async () => NEAREST, PASSAGES_SCHEMA, PASSAGES_LOAD, SECTIONS_CARD);
    const { shape, heard } = await resolve(hosted);
    expect(shape.vectorColumn).toBe("emb");
    expect(shape.vectorSource).toEqual(["name", "sections"]);
    expect(shape.primaryText).toBe("sections");
    expect(heard).toEqual([]);
    expect(checks).toHaveLength(1);
    const [table, column, text, k] = checks[0];
    expect([table, column, k]).toEqual([TABLE, "emb", 1]);
    expect(typeof text === "string" && text.length > 0).toBe(true);
    expect(rowsSqlDescription(shape)).toContain(`hybrid_search('${TABLE}','sections','terms','emb', {{q:"..."}}, k)`);
  });

  // The other tables of a database are described with no check: each check
  // is a search by meaning that loads the table's vector index, and one per
  // table of a database of dozens of tables at startup stalls the worker.
  it("asks the platform nothing when told not to check, and offers the column the load and card describe", async () => {
    const { hosted, checks } = platform(refused(400, MISMATCH), PASSAGES_SCHEMA, PASSAGES_LOAD, SECTIONS_CARD);
    const { shape, heard } = await resolve(hosted, { checkVector: false });
    expect(checks).toHaveLength(0);
    expect(shape.vectorColumn).toBe("emb");
    expect(heard).toEqual([]);
  });

  it("offers no column the platform refuses to embed a query for - filled under another model - and says so in its words", async () => {
    for (const fields of [PASSAGES_SCHEMA, PASSAGES_EMBEDDING_SCHEMA]) {
      const { hosted, checks } = platform(refused(400, MISMATCH), fields, PASSAGES_LOAD, SECTIONS_CARD);
      const { shape, heard } = await resolve(hosted);
      expect(checks).toHaveLength(1);
      expect(shape.vectorColumn).toBeNull();
      expect(shape.vectorSource).toEqual([]);
      expect(heard).toEqual([
        `vector column emb is not searched by meaning: the platform did not embed a query for it (vector_search: server returned 400: ${MISMATCH})`,
      ]);
      // Nothing else of the shape moves: the card's text column, the rows.
      expect(shape.primaryText).toBe("sections");
      expect(shape.projection).not.toContain("emb");
      const sql = rowsSqlDescription(shape);
      expect(sql).toContain("No vector column: rank by terms alone. ");
      expect(sql).not.toContain("hybrid_search");
      expect(sql).not.toContain('{{q:"..."}}');
      expect(rowsSearchDescription(shape)).toContain("ranked by exact keyword matching (BM25) over sections");
      const searched: unknown[][] = [];
      const result = await searchRows(
        {
          hybridSearch: async () => {
            throw new Error("not the hybrid route: the platform does not embed a query for emb");
          },
          bm25Search: async (...args: unknown[]) => {
            searched.push(args);
            return [];
          },
        },
        shape,
        "species",
        5,
      );
      expect(result.ranking).toBe("keyword");
      expect(searched).toEqual([[TABLE, "sections", "species", 5, shape.projection]]);
    }
  });

  it("takes a check it could not make as no: an embedding server that is starting, a platform out of reach", async () => {
    for (const [status, words] of [
      [503, "embedding server unreachable; retry after the Retry-After seconds, once it is back"],
      [0, "request failed: connect ECONNREFUSED"],
    ] as Array<[number, string]>) {
      const { hosted } = platform(refused(status, words));
      const { shape, heard } = await resolve(hosted);
      expect(shape.vectorColumn).toBeNull();
      expect(heard).toHaveLength(1);
      expect(heard[0]).toMatch(/^vector column emb is not searched by meaning: the platform did not embed a query for it \(vector_search: /);
      expect(heard[0]).toContain(words);
    }
  });

  it("asks through the check client when one is given, and asks nothing where there is no candidate", async () => {
    // The check goes through `checkWith`, not the client that read the schema.
    const { hosted } = platform(async () => {
      throw new Error("not this client: the check goes through checkWith");
    });
    const viaCheck: unknown[][] = [];
    const checkWith = {
      vectorSearchText: async (...args: unknown[]) => {
        viaCheck.push(args);
        return NEAREST;
      },
    };
    const { shape } = await resolve(hosted, { checkWith });
    expect(shape.vectorColumn).toBe("emb");
    expect(viaCheck).toHaveLength(1);
    // No record of the load: the card names the one vector column, so it is
    // the candidate all the same, checked once, with no source to name.
    const unrecorded = platform(async () => NEAREST, PASSAGES_SCHEMA, null);
    const { shape: bare, heard } = await resolve(unrecorded.hosted);
    expect(unrecorded.checks).toHaveLength(1);
    expect(bare.vectorColumn).toBe("emb");
    expect(bare.vectorSource).toEqual([]);
    expect(heard).toEqual([]);
    // A table with no vector column at all: nothing asked, nothing said.
    const berka = platform(async () => NEAREST, BERKA_TRANS_SCHEMA, { state: "succeeded", request: {} });
    const { shape: trans, heard: quiet } = await resolve(berka.hosted);
    expect(berka.checks).toEqual([]);
    expect(trans.vectorColumn).toBeNull();
    expect(quiet).toEqual([]);
  });

  it("checks the candidate the descriptors give, and only it", async () => {
    // The candidate is what the check is asked about.
    expect(vectorCandidate(PASSAGES_SCHEMA, PASSAGES_CARD, PASSAGES_LOAD)).toEqual({ name: "emb", source: ["name", "sections"] });
    const asked: unknown[][] = [];
    const check = {
      vectorSearchText: async (...args: unknown[]) => {
        asked.push(args);
        return NEAREST;
      },
    };
    expect(await platformEmbedsQueriesFor(check, TABLE, { name: "emb", source: ["name", "sections"] })).toBe(true);
    expect(asked.map(([table, column, , k]) => [table, column, k])).toEqual([[TABLE, "emb", 1]]);
    expect(await platformEmbedsQueriesFor({ vectorSearchText: refused(400, MISMATCH) }, TABLE, { name: "emb", source: [] })).toBe(false);
  });
});

describe("HostedDb.vectorSearchText", () => {
  const TARGET = { baseUrl: "https://api.example.test", database: "cx", apiKey: "inf_test_key_do_not_log" };
  /** The Retry-After an embedding server that is starting answers with. */
  const EMBEDDER_RETRY_AFTER_SECS = "30";

  it("posts query_text with no projection, decodes the rows, and carries the platform's refusal", async () => {
    const seen: Array<{ url: string; body: unknown }> = [];
    let answer: [number, unknown] = [200, [{ _id: 1, score: 0.26 }]];
    const fetchImpl: typeof fetch = async (input, init) => {
      seen.push({ url: String(input), body: JSON.parse(init?.body as string) });
      return new Response(JSON.stringify(answer[1]), { status: answer[0], headers: { "content-type": "application/json" } });
    };
    const db = new HostedDb(TARGET, { fetch: fetchImpl });
    expect(await db.vectorSearchText("chunks_wikipedia_v5", "emb", "check", 1)).toEqual([{ _id: 1, score: 0.26 }]);
    expect(seen[0].url).toBe("https://api.example.test/v1/vector_search/cx");
    expect(seen[0].body).toEqual({ table_name: "chunks_wikipedia_v5", field_name: "emb", query_text: "check", k: 1 });
    answer = [400, { error: 'column "emb" was embedded with model "a"; this deployment embeds with "b", so text cannot be queried against it' }];
    await expect(db.vectorSearchText("chunks_wikipedia_v5", "emb", "check", 1)).rejects.toThrow(
      'vector_search: server returned 400: column "emb" was embedded with model "a"',
    );
  });

  it("asks once, with no cold-start budget, while an embedding server starts", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls++;
      return new Response("embedding server unreachable", { status: 503, headers: { "retry-after": EMBEDDER_RETRY_AFTER_SECS } });
    };
    const db = new HostedDb(TARGET, { fetch: fetchImpl, coldStartSecs: 0 });
    await expect(db.vectorSearchText("chunks_wikipedia_v5", "emb", "check", 1)).rejects.toMatchObject({ status: 503 });
    expect(calls).toBe(1);
  });
});

// The text column the doors search on a table with several full-text
// columns is the one the table's card names as its prose (`text_column`).
// Picked by name, an articles table's was `abstract`, filled on an
// article's first passage alone, while the platform embeds `name` and
// `sections`: a hybrid search paired keywords on abstracts with meaning on
// passages.
describe("the text column the card names for search", () => {
  const shapeWith = (textColumn: string | undefined) =>
    tableShapeFrom("chunks_wikipedia_v5", PASSAGES_SCHEMA, { ...PASSAGES_CARD, text_column: textColumn }, PASSAGES_LOAD);

  it("is the card's full-text column ahead of the pick by name, and the pick by name where the card names none it can search", () => {
    expect(shapeWith(undefined).primaryText).toBe("abstract");
    expect(shapeWith("url").primaryText).toBe("abstract");
    const shape = shapeWith("sections");
    expect(shape.primaryText).toBe("sections");
    // The rest of the shape does not move: the same text columns, the same vector.
    expect(shape.textColumns).toEqual(shapeWith(undefined).textColumns);
    expect(shape.vectorColumn).toBe("emb");
  });

  it("pairs the keyword half of search and of the sql text's hybrid with the meaning half's own text", async () => {
    const shape = shapeWith("sections");
    const calls: unknown[][] = [];
    const hosted = {
      hybridSearch: async (...args: unknown[]) => {
        calls.push(args);
        return [];
      },
      bm25Search: async () => {
        throw new Error("not the keyword route");
      },
    };
    await searchRows(hosted, shape, "species", 10);
    expect(calls).toEqual([["chunks_wikipedia_v5", "sections", "emb", "species", 10, shape.projection]]);
    const sql = rowsSqlDescription(shape);
    expect(sql).toContain(`hybrid_search('chunks_wikipedia_v5','sections','terms','emb', {{q:"..."}}, k)`);
    expect(sql).toContain("token_match('chunks_wikipedia_v5','sections','terms','and')");
    expect(findRowsSql(shape, "species", 5)).toContain("FROM token_match('chunks_wikipedia_v5', 'sections', 'species', 'and')");
    expect(rowsSearchDescription(shape)).toContain("fusing exact keyword matching over sections with semantic similarity over emb");
  });
});

// A load that cut a text column into passages says so in the table's tool
// text, from the hydrate job's own record; a load that cut nothing, or a
// record that does not match the table's columns, says nothing.
describe("a table cut into passages", () => {
  const load = { request: { chunk: { column: "sections", max_tokens: 512, markdown: false } } };

  it("reads the chunking from the load's record, and only when the table has its columns", () => {
    expect(chunkingFrom(load, PASSAGES_SCHEMA)).toEqual({ column: "sections", indexColumn: "chunk", maxTokens: 512 });
    // a numbering column the request named
    const named = { request: { chunk: { column: "sections", index_column: "part" } } };
    expect(chunkingFrom(named, [...PASSAGES_SCHEMA, { name: "part", type: "i32" }])).toEqual({ column: "sections", indexColumn: "part", maxTokens: null });
    // the table lacks the numbering column the record implies: nothing sure
    expect(chunkingFrom(named, PASSAGES_SCHEMA)).toBeNull();
    // a load that cut nothing, and no record at all
    expect(chunkingFrom({ request: { table: "t" } }, PASSAGES_SCHEMA)).toBeNull();
    expect(chunkingFrom(null, PASSAGES_SCHEMA)).toBeNull();
    expect(tableShapeFrom("t", PASSAGES_SCHEMA).chunking).toBeUndefined();
  });

  it("says in the sql text what a row is and how a whole record is read, and the instructions say passage", () => {
    const shape = tableShapeFrom("chunks_wikipedia_v5", PASSAGES_SCHEMA, null, load);
    const sql = rowsSqlDescription(shape);
    expect(sql).toContain("Each row is one passage of a record, not the record");
    expect(sql).toContain("passages of up to 512 tokens, one row each, numbered by chunk from 0");
    expect(sql).toContain("SUM(LENGTH(sections))");
    expect(sql).toContain("a record is counted once with chunk = 0");
    expect(rowsInstructions(shape)).toContain("an index of the chunks_wikipedia_v5 table, one row per passage of a record's sections.");
    // one row per record where nothing was cut
    expect(rowsSqlDescription(tableShapeFrom("t", PASSAGES_SCHEMA))).not.toContain("one passage of a record");
    expect(rowsInstructions(tableShapeFrom("t", PASSAGES_SCHEMA))).toContain("one row per record.");
  });
});

// What an answer cites a row by, by the owner's rule (2026-10-01: "either
// have those ids be links or not show them on non-code corpora"): a table
// with a link column cites a row as a markdown link to it; a table without
// one cites no row by an id. The key stays the lookup either way.
describe("a row's citation", () => {
  const passages = tableShapeFrom("chunks_wikipedia_v5", PASSAGES_SCHEMA);

  it("reads the link and the title off the columns' names, a bare name before a suffixed one", () => {
    expect([passages.linkColumn, passages.titleColumn]).toEqual(["url", "name"]);
    expect([JOBS.linkColumn, JOBS.titleColumn]).toEqual(["apply_url", "title"]);
    const both = tableShapeFrom("t", [
      { name: "image_url", type: "utf8" },
      { name: "url", type: "large_utf8" },
      { name: "display_name", type: "utf8" },
    ]);
    expect([both.linkColumn, both.titleColumn]).toEqual(["url", "display_name"]);
    // Only a text column holds a link, and the chunks table has none.
    expect(tableShapeFrom("t", [{ name: "url", type: "i64" }]).linkColumn).toBeNull();
    expect(tableShapeFrom("chunks", CHUNKS_SCHEMA).linkColumn).toBeNull();
  });

  it("cites a row with a link as a markdown link to it, and never by the engine's id", () => {
    // The Wikipedia table is keyed by `_id`: until this rule the answer
    // printed 32-digit ids in parentheses.
    expect(passages.keyColumn).toBe(ENGINE_ID_COLUMN);
    // A row held without its link is named, never given a link the rows did
    // not carry.
    const cite =
      "Cite a row as a markdown link to its url, with its name as the text - [<name>](<url>) - never by an id such as its _id. " +
      "A row that came without its url is named by its name, never given a link it did not carry.";
    expect(rowCitation(passages)).toBe(cite);
    for (const text of [rowsInstructions(passages), rowsSearchDescription(passages)]) {
      expect(text).toContain(cite);
      expect(text).not.toMatch(/cite (a row|them) by/i);
    }
    // The key is still how a row is read whole: a lookup, not a citation.
    expect(rowsSearchDescription(passages)).toContain("one sql away (SELECT * FROM chunks_wikipedia_v5 WHERE _id = '...')");
    expect(rowsSqlDescription(passages)).toContain("select url and name beside it so a row can be cited as its link");
    // A link with nothing naming the row still links it.
    const untitled = tableShapeFrom("t", [{ name: "body", type: "large_utf8" }, { name: "href", type: "utf8" }]);
    expect(rowCitation(untitled)).toBe(
      "Cite a row as a markdown link to its href, with words naming the row as the text - [<the row>](<href>) - never by an id such as its _id. " +
        "A row that came without its href is named by its own values, never given a link it did not carry.",
    );
  });

  // The loop's facts are what the caller cites from, so they carry the link:
  // the projection the client sends names it and the row's name, and the
  // platform's loop places every search and find fact with those columns.
  // Without them the Wikipedia table's facts were `_id`, the searched text
  // and a score, and the caller held no url to cite (2026-10-01).
  it("asks the platform's loop for the link and the name beside the table's own key", () => {
    expect(rowsProjection(passages)).toEqual(["url", "name"]);
    expect(rowsProjection(JOBS)).toEqual(["id", "apply_url", "title"]);
    const untitled = tableShapeFrom("t", [{ name: "body", type: "large_utf8" }, { name: "href", type: "utf8" }]);
    expect(rowsProjection(untitled)).toEqual(["href"]);
    // No link: the key alone, as it always was, and nothing for a table the
    // engine's id keys - no column of the table's, which the platform refuses.
    const tickets = tableShapeFrom("tickets", [{ name: "ticket_id", type: "utf8" }, { name: "name", type: "utf8" }, { name: "body", type: "large_utf8" }]);
    expect(rowsProjection(tickets)).toEqual(["ticket_id"]);
    expect(rowsProjection(tableShapeFrom("t", [{ name: "body", type: "large_utf8" }]))).toEqual([]);
  });

  it("cites no row by an id on a table with no link column", () => {
    const tickets = tableShapeFrom("tickets", [
      { name: "ticket_id", type: "utf8" },
      { name: "body", type: "large_utf8" },
    ]);
    const cite = "Cite no row by an id: its ticket_id or _id looks a row up and never goes in the answer as a reference - answer with the rows' own values.";
    expect(rowCitation(tickets)).toBe(cite);
    expect(rowsInstructions(tickets)).toContain(cite);
    expect(rowsSqlDescription(tickets)).toContain("select ticket_id beside it so the row can be looked up");
    expect(rowsSqlDescription(tickets)).not.toContain("so a row can be cited");
  });
});

/** One of the Berka tables as the hydrate dry run described it (2026-10-01):
 * numbers and short codes, loaded with no full-text index and no vector, so
 * every text column is Utf8. */
const BERKA_TRANS_SCHEMA: SchemaField[] = [
  { name: "trans_id", type: "i64" },
  { name: "account_id", type: "i64" },
  { name: "date", type: "i64" },
  { name: "type", type: "utf8" },
  { name: "operation", type: "utf8" },
  { name: "amount", type: "f64" },
  { name: "balance", type: "f64" },
  { name: "k_symbol", type: "utf8" },
  { name: "bank", type: "utf8" },
  { name: "account", type: "i64" },
];
const BERKA_ACCOUNT_SCHEMA: SchemaField[] = [
  { name: "account_id", type: "i64" },
  { name: "district_id", type: "i64" },
  { name: "frequency", type: "utf8" },
  { name: "date", type: "i64" },
];

/** The functions a table with no full-text column cannot run. */
const FULL_TEXT_FUNCTIONS = ["hybrid_search", "bm25_search", "token_match", "exact_match"];

// A table with no full-text column offers no search and no find, and no text
// names a function it cannot run; sql stays, and says so.
describe("a table with no full-text column", () => {
  const trans = tableShapeFrom("berka_trans", BERKA_TRANS_SCHEMA);
  // The optimizer's card for such a table names every column scalar.
  const carded = tableShapeFrom("berka_trans", BERKA_TRANS_SCHEMA, {
    schema: BERKA_TRANS_SCHEMA.map((f) => ({ name: f.name, index: "scalar" })),
  });
  const account = tableShapeFrom("berka_account", BERKA_ACCOUNT_SCHEMA);

  it("has no text column, carded or not, and keys its rows by their own id", () => {
    for (const shape of [trans, carded]) {
      expect(shape.textColumns).toEqual([]);
      expect(shape.primaryText).toBe("");
      expect(shape.vectorColumn).toBeNull();
      expect(shape.linkColumn).toBeNull();
      expect(shape.keyColumn).toBe("trans_id");
    }
  });

  it("routes to sql alone, and says why there is no find or search", () => {
    const text = rowsInstructions(trans);
    expect(text).not.toContain("- find -");
    expect(text).not.toContain("- search -");
    expect(text).toContain("- sql - one statement you already know");
    expect(text).not.toContain("- ask -");
    expect(text).toContain(
      "No column of berka_trans is full-text indexed, so there is no find or search over it and no search function in a statement: filter, group and join its columns.",
    );
    expect(text).toContain("Rows come back with the columns their statement selected. Answer from the rows. Cite no row by an id");
    for (const name of [...FULL_TEXT_FUNCTIONS, "vector_search", "snippet"]) expect(text, name).not.toContain(name);
  });

  it("writes the sql text as plain SQL over the columns, naming no search function and no inferred index", () => {
    for (const shape of [trans, carded]) {
      const text = rowsSqlDescription(shape);
      expect(text).toContain("berka_trans(trans_id i64, account_id i64, date i64, type utf8");
      expect(text).toContain("Full-text indexed: none. ");
      expect(text).not.toContain("inferred from the schema");
      expect(text).toContain("No vector column. ");
      expect(text).not.toContain("rank by terms alone");
      expect(text).toContain("the search functions do not apply to this table: answer from plain SQL over the columns above");
      expect(text).toContain("SELECT account_id, COUNT(*) AS rows FROM berka_trans GROUP BY account_id");
      expect(text).toContain("has no regexp_extract");
      for (const name of [...FULL_TEXT_FUNCTIONS, "vector_search", "Match words on"]) expect(text, name).not.toContain(name);
    }
  });

  it("names vector_search alone where the platform embeds a column but indexes none", () => {
    const vectorOnly = tableShapeFrom(
      "t",
      [
        { name: "id", type: "utf8" },
        { name: "body", type: "large_utf8" },
        { name: "emb", type: "embedding", source: ["body"] },
      ],
      { schema: [{ name: "id", index: "scalar" }, { name: "body", index: "scalar" }, { name: "emb", index: "vector" }] },
    );
    expect(vectorOnly.primaryText).toBe("");
    const sql = rowsSqlDescription(vectorOnly);
    expect(sql).toContain(`only vector_search('t','emb', {{q:"..."}}, k) applies, ranking rows by meaning alone`);
    for (const name of FULL_TEXT_FUNCTIONS) expect(sql, name).not.toContain(name);
    expect(rowsInstructions(vectorOnly)).toContain(`vector_search('t','emb', {{q:"..."}}, k) ranks its rows by meaning alone`);
  });

  it("writes the JOIN across such tables over the tables themselves, with no search inside it", () => {
    expect(siblingsSearchable(trans, [account], [])).toBe(false);
    // A searchable table among them, one that could not be described, or
    // the chunks table as the primary, and the search stays in the shape.
    expect(siblingsSearchable(trans, [account, JOBS], [])).toBe(true);
    expect(siblingsSearchable(trans, [account], ["berka_loan"])).toBe(true);
    expect(siblingsSearchable(null, [account], [])).toBe(true);
    const note = siblingsNote("berka_trans", [account], [], false);
    expect(note).toContain(JOIN_KEYS_RULE);
    expect(note).toContain("berka_account(account_id i64, district_id i64, frequency utf8, date i64)");
    expect(note).toContain(
      "none of these tables has a full-text column, so the JOIN is over the tables themselves: write the JOIN - " +
        "FROM berka_account JOIN berka_trans ON <the predicate join_keys returned> WHERE ... - and not one query per table.",
    );
    expect(note).not.toContain("hybrid_search");
    expect(note).not.toContain("search functions");
    // Where a table can be searched, the shape is the one it always was.
    expect(siblingsNote("chunks", [JOBS], [])).toContain(
      "and the search functions take any of them as their first argument and their rows join like a table's: write the JOIN - " +
        "FROM hybrid_search('chunks_jobs', '<text column>', '<terms>', 'embedding', {{q}}, 50) AS chunks_jobs JOIN chunks ON",
    );
    // Where the keys come from, said both ways: the lean text says no key
    // is written in it; the text carrying the semantic layer (the server's
    // default since 2026-10-01) says only to call join_keys first.
    expect(siblingsNote("chunks", [JOBS], [])).toContain("The keys are not written here: call join_keys with the tables first and paste its predicate into ON.");
    const withMeanings = siblingsNote("chunks", [JOBS], [], true, true);
    expect(withMeanings).toContain("Call join_keys with the tables first and paste its predicate into ON.");
    expect(withMeanings).not.toContain("The keys are not written here");
    const routing = siblingsInstruction("berka_trans", ["berka_account"], false);
    expect(routing).toContain("is one JOIN, not one query per table");
    expect(routing).not.toContain("search functions");
    expect(siblingsInstruction("chunks", ["swe_issues"])).toContain("is one JOIN, with the search functions inside it, not one query per table");
    // The graph's routing form rides beside the join rule in both shapes
    // of the instructions, and the sql text carries the rule for when.
    expect(routing).toContain("is graph_walk in sql, not a chain of joins");
    expect(siblingsInstruction("berka_trans", ["berka_account", "berka_loan"], false)).toContain("is graph_rank");
    expect(siblingsNote("chunks", [JOBS], [])).toContain("USE graph_walk, NOT A JOIN, WHEN THE QUESTION STARTS FROM PARTICULAR ROWS");
    // The graph's own addition to a result is named, so the model reads it.
    expect(siblingsNote("chunks", [JOBS], [])).toContain("also carries `connected`");
  });
});

describe("a wide table's card, laid out within the loop's budget", () => {
  /** A table of events: a few plain columns, a family of hundreds of
   * `property_<n>` columns, and a list column of tools with no value in any
   * row - the shape that put 2.4 million characters into the sql text. */
  const EVENT_COLUMNS = 400;
  const EVENTS_SCHEMA: SchemaField[] = [
    { name: "visitorid", type: "utf8" },
    { name: "eventtype", type: "utf8" },
    { name: "title", type: "large_utf8" },
    { name: "title_visitor_permission_summary", type: "large_utf8" },
    { item: "utf8", name: "toolsused", type: "list" },
    ...Array.from({ length: EVENT_COLUMNS }, (_, i) => ({ name: `property_${i}`, type: "utf8" })),
    { name: "emb", type: "embedding", source: ["title"] },
  ];
  /** The card as the platform lays it out within a budget of four whole
   * columns and one family: the plain columns whole, the family and the
   * empty column as entries, and the table's prose column named. */
  const EVENTS_CARD = {
    table: "events",
    rows: 100,
    text_column: "title",
    schema: [
      { name: "visitorid", type: "Utf8", index: "scalar", count: 100 },
      { name: "eventtype", type: "Utf8", index: "scalar", count: 100 },
      { name: "title_visitor_permission_summary", type: "LargeUtf8", index: "fts", count: 90 },
      { name: "title", type: "LargeUtf8", index: "fts", count: 10 },
      { name: "property_*", type: "Utf8", index: "scalar", description: `${EVENT_COLUMNS} columns named property_<n>; describe_columns("events", "property_*") lists them` },
      { name: "(empty columns)", type: "List(Utf8)", index: "scalar", count: 0, description: "1 columns with no value in any row: toolsused" },
    ],
  };
  const events = tableShapeFrom("events", EVENTS_SCHEMA, EVENTS_CARD);

  it("shares the whole columns among the tables as the loop does, floors included", () => {
    // Two wide tables: an even share. A narrow table beside a wide one
    // takes what it has and leaves the rest. Floors past the budget grow
    // the text by a floor a table.
    expect(wholeAllowances([4865, 4692], 200, 20)).toEqual([100, 100]);
    expect(wholeAllowances([3, 4865], 200, 20)).toEqual([3, 197]);
    expect(wholeAllowances(Array(12).fill(5000), 200, 20)).toEqual(Array(12).fill(20));
    expect(familiesAllowance(5, 20, 4)).toBe(4);
    expect(familiesAllowance(1, 20, 4)).toBe(20);
    expect(familiesAllowance(12, 20, 4)).toBe(4);
  });

  it("reads every table's schema first and asks each card for its share", async () => {
    const asked: string[] = [];
    const hosted = {
      schema: async (table: string) => {
        asked.push(table);
        if (table === "unreadable") throw new Error("no such table");
        return table === "wide" ? EVENTS_SCHEMA : EVENTS_SCHEMA.slice(0, 3);
      },
    };
    const { layouts, failures } = await cardLayouts(hosted, ["wide", "narrow", "unreadable"]);
    expect(asked).toEqual(["wide", "narrow", "unreadable"]);
    expect(layouts.get("narrow")).toMatchObject({ whole: 3, families: 10 });
    expect(layouts.get("wide")).toMatchObject({ whole: 197, families: 10 });
    expect(layouts.get("wide")?.fields).toBe(EVENTS_SCHEMA);
    expect(layouts.has("unreadable")).toBe(false);
    // The one read's error, for the caller to report; the schema is not
    // asked for a second time.
    expect(failures.get("unreadable")?.message).toBe("no such table");
  });

  it("lists a laid-out card's entries in the sql text, never every column of the table", () => {
    const list = columnList(events);
    expect(list).toContain("visitorid utf8");
    expect(list).toContain(`property_*: ${EVENT_COLUMNS} columns named property_<n>`);
    expect(list).toContain("(empty columns): 1 columns with no value in any row: toolsused");
    expect(list).not.toContain("property_7 ");
    expect(list.length).toBeLessThan(600);
    // The search text names the scalar columns the card names whole, and
    // the sql text opens on the same list; the empty list column, in the
    // card's empty entry, is not named as a list to unnest.
    expect(rowsSearchDescription(events)).toContain("the scalar columns (visitorid, eventtype)");
    expect(rowsSqlDescription(events)).toContain(`over events(${list})`);
    expect(rowsSqlDescription(events)).not.toContain("A list column (toolsused)");
    expect(rowsSqlDescription(JOBS)).toContain("A list column (locations)");
    // A card listing every column changes nothing: the schema is the list.
    expect(columnList(JOBS)).toContain("locations list<utf8>");
  });

  it("searches the column the card names as the table's prose, over one named like text", () => {
    // The pick by name would take the column named like a summary; the
    // card names `title` as the table's prose, and that is the one searched.
    expect(events.textColumns).toEqual(["title", "title_visitor_permission_summary"]);
    expect(events.primaryText).toBe("title");
    expect(tableShapeFrom("events", EVENTS_SCHEMA, { ...EVENTS_CARD, text_column: undefined }).primaryText).toBe("title_visitor_permission_summary");
    expect(events.vectorColumn).toBe("emb");
  });

  it("names the first text columns and counts the rest", () => {
    const many: SchemaField[] = [
      { name: "id", type: "utf8" },
      ...Array.from({ length: TEXT_COLUMNS_LISTED + 5 }, (_, i) => ({ name: `note_${i}`, type: "large_utf8" })),
    ];
    const shape = tableShapeFrom("notes", many);
    const phrase = rowsSqlDescription(shape);
    expect(phrase).toContain(`and 5 more (describe_columns("notes", "*") lists them)`);
    expect(rowsSqlDescription(JOBS)).toContain("Full-text indexed: title, description_html");
  });

  it("tells the model over several tables what the loop is told, in the loop's words", () => {
    const text = instructionsFor(rowsSurface(events, ["events_track"], { describeColumns: true }), ["events_track"]);
    expect(text).toContain("code-context is an index of the tables events, events_track, one database, one row per record in each.");
    expect(text).toContain(SEVERAL_TABLES_SENTENCE.trim());
    expect(text).toContain("- describe_columns -");
    expect(rowsInstructions(events)).toContain("code-context is an index of the events table, one row per record.");
    expect(rowsInstructions(events)).not.toContain(SEVERAL_TABLES_SENTENCE.trim());
    expect(rowsInstructions(events)).not.toContain("- describe_columns -");
    expect(siblingsNote("events", [JOBS], [])).toContain(SEVERAL_TABLES_SENTENCE.trim());
    expect(siblingsInstruction("events", ["events_track"], true)).toContain("A question about one of these tables alone is answered over that table alone");
  });
});

// The tables a statement may join with the primary are the database's own,
// as the platform lists them: never a list a deployment typed.
describe("the database's other tables", () => {
  it("are every table the platform lists but the given one, and none, with the reason said, when it cannot list them", async () => {
    const listed = { listTables: async () => ["berka_account", "berka_trans", "berka_loan", "berka_district"] };
    const heard: string[] = [];
    expect(await databaseTables(listed, "berka_trans", (line) => heard.push(line))).toEqual(["berka_account", "berka_loan", "berka_district"]);
    expect(heard).toEqual([]);
    const refusing = {
      listTables: async (): Promise<string[]> => {
        throw new HostedError("list_tables", 503, "the database is starting");
      },
    };
    expect(await databaseTables(refusing, "berka_trans", (line) => heard.push(line))).toEqual([]);
    expect(heard).toEqual(["the database's tables could not be listed, so berka_trans is described alone: list_tables: server returned 503: the database is starting"]);
  });
});

describe("the one instructions builder over every shape of index", () => {
  const code = codeInstructions("chunks", ["swe_issues"], { describeColumns: true });
  const rows = rowsInstructions(JOBS, ["chunks_other"]);
  const logs = logIndexInstructions(35, 4903);

  it("lays every shape out the same way: the frame, the tool lines, the sweep, the hits, the closing", () => {
    for (const text of [code, rows, logs]) {
      expect(text).toContain(" Which tool for which question:\n");
      // The sweep sentence ends its line, or carries the batch sentence on it.
      expect(text).toMatch(new RegExp(`${SWEEP_TO_A_TOOL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}( [^\n]*)?\n`));
      expect(text).toContain(COUNTS_IN_THE_ANSWER);
      expect(text.endsWith(".")).toBe(true);
    }
    // A table the platform could not describe routes nothing: the notice alone.
    const unresolved = unresolvedInstructions("tickets", "no platform");
    expect(unresolved).not.toContain("Which tool for which question");
    expect(unresolved).toContain("find, search and sql each return that error");
  });

  it("reaches every shape with what they share: the choosing sentence and describe_columns", () => {
    // The code text with tables beside it says the question may be about any
    // of them, in the loop's words, as the rows text does.
    expect(code).toContain("and beside it in the same database the tables swe_issues, which one sql statement joins with it");
    expect(code).toContain(SEVERAL_TABLES_SENTENCE.trim());
    expect(codeInstructions("chunks", [])).not.toContain(SEVERAL_TABLES_SENTENCE.trim());
    expect(code).toContain(DESCRIBE_COLUMNS_LINE);
    expect(codeInstructions("chunks", [])).not.toContain("- describe_columns -");
  });

  it("keeps each shape's own sentences: find first on code and logs, the table's columns on rows", () => {
    expect(code.indexOf("- find -")).toBeLessThan(code.indexOf("- sql -"));
    expect(logs.indexOf("- find -")).toBeLessThan(logs.indexOf("- sql -"));
    expect(logs).toContain("Start with find or sql - a literal, a count, a ranking across the logs. ");
    expect(rows).toContain("- sql - one statement you already know: a count, a filter, a lookup by id, a ranking in one SELECT.");
    expect(rows).toContain("Hits are rows: a score, the row's id, its scalar columns");
    expect(code).toContain("Hits carry the code: when a hit answers the question, answer from it.");
  });

  it("routes to no ask and no answer tool on any shape", () => {
    for (const text of [code, rows, logs]) {
      expect(text).not.toContain("- ask -");
      expect(text).not.toContain("- answer -");
      expect(text).not.toMatch(/\bask first\b|is ask's|an ask\b/);
    }
  });
});

describe("the ledger over rows", () => {
  it("records each row by its key, the table, and prices the hits as returned", () => {
    const search = rowSearchEntry({
      query: "q",
      ranking: "hybrid",
      table: "chunks_jobs",
      key: "id",
      hits: [{ score: 1, id: "a", title: "T" }],
    });
    expect(search).toMatchObject({ tool: "search", table: "chunks_jobs", ranking: "hybrid", hits: [{ path: "a", startLine: 0, endLine: 0 }] });
    expect(search.wholeFileTokens).toBeUndefined();
    expect(formatReceipt(search)).toMatch(/^returned ~\d+ tokens \| 1 row$/);

    const find = rowFindEntry({
      query: "q",
      table: "chunks_jobs",
      column: "description_html",
      key: "id",
      matches: [{ id: "a" }, { id: "b" }],
      total: 12,
      truncated: true,
    });
    expect(find).toMatchObject({ tool: "find", table: "chunks_jobs", matches: 12, hits: [{ path: "a" }, { path: "b" }] });
    expect(formatReceipt(find)).toMatch(/^returned ~\d+ tokens \| 12 rows$/);
  });
});

describe("HostedDb.bm25Search", () => {
  it("posts the platform's Bm25SearchRequest shape and decodes the rows", async () => {
    let seen: { url: string; body: unknown } | undefined;
    const fetchImpl: typeof fetch = async (input, init) => {
      seen = { url: String(input), body: JSON.parse(init?.body as string) };
      return new Response(JSON.stringify([{ id: "a", score: 2 }]), { status: 200, headers: { "content-type": "application/json" } });
    };
    const db = new HostedDb({ baseUrl: "https://api.example.test", database: "cx", apiKey: "inf_test_key_do_not_log" }, { fetch: fetchImpl });
    expect(await db.bm25Search("chunks_jobs", "description_html", "rust engineer", 3, ["id", "title", "score"])).toEqual([{ id: "a", score: 2 }]);
    expect(seen?.url).toBe("https://api.example.test/v1/bm25_search/cx");
    expect(seen?.body).toEqual({
      table_name: "chunks_jobs",
      field_name: "description_html",
      query: "rust engineer",
      k: 3,
      mode: "Or",
      projection: ["id", "title", "score"],
    });
  });
});

// The wide-table text (the card preamble's map sentences, the table's name
// before its card, the describe_columns tool and line) is for a card that
// maps columns. A narrow table's card lists every column whole, and the text
// about maps only confuses a model reading it, so a card with no map entry
// is introduced as before.
describe("cardMapsColumns", () => {
  it("is true only for a card that lays out a column as a map entry", () => {
    expect(cardMapsColumns({ schema: [{ name: "path" }, { name: "text" }, { name: "year" }] })).toBe(false);
    expect(cardMapsColumns({ schema: [{ name: "id" }, { name: "property_*" }] })).toBe(true);
    expect(cardMapsColumns({ schema: [{ name: "id" }, { name: "(other columns)" }] })).toBe(true);
    expect(cardMapsColumns({ schema: [{ name: "id" }, { name: "(empty columns)" }] })).toBe(true);
    expect(cardMapsColumns({})).toBe(false);
    expect(cardMapsColumns(undefined)).toBe(false);
  });
});

// A card naming its table's kind column has every column's rows by kind
// behind describe_columns, which a laid-out card leaves out: the tool is
// offered for it however narrow the card, and for no other narrow card.
describe("cardNamesKinds", () => {
  it("is true only for a card naming a kind column", () => {
    expect(cardNamesKinds({ kind_column: "elementpath", schema: [{ name: "elementpath" }] })).toBe(true);
    expect(cardNamesKinds({ schema: [{ name: "path" }, { name: "text" }] })).toBe(false);
    expect(cardNamesKinds({ kind_column: "" })).toBe(false);
    expect(cardNamesKinds(undefined)).toBe(false);
  });
});
