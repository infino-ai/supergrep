// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The two doors over a hosted table of another shape, end to end through
// the MCP server on an in-memory transport against a scripted platform. Two
// servers are started, each against its own scripted platform, for the two
// things under test.
//
// The first: with an account and CX_TABLE naming a table that is not the
// chunks table, find, search and sql answer from that table with the
// requests the platform's workers accept, the tool text describes
// it, and the shape is read from the platform ONCE, at startup - no call asks
// the platform what it is about to run against, so each call's requests are
// its own and nothing else. A non-default CX_TABLE always means rows mode
// while an account is configured - there is no local-doors fallback for it,
// since a local build would drop and recreate the platform table it is
// pointed at, and this process never owns that table.
//
// The second: the same table, but the platform cannot describe it at
// startup. The server then registers the rows tools - never the chunks text,
// which would name columns the table does not have - and every call says why
// it cannot run. In both, no manifest appears and no drop_table /
// create_table / append ever reaches the platform.

import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NO_GRAPH, call, scriptPlatform, start, stop, type Routes, type Started } from "./mcp-harness.js";

/** The table the server is started for, in place of `chunks`. */
const JOBS_TABLE = "chunks_jobs";

// The environment the server reads at module load (TABLE is a constant of
// config.ts) and at startup, set before either module is imported - which is
// why every import of the client's own code below is dynamic.
process.env.CX_TABLE = JOBS_TABLE;
process.env.CX_NO_EMBED = "1";
delete process.env.CX_AUTO_INDEX; // on: the guard needs the path that would build
delete process.env.CX_NO_RECEIPT;
delete process.env.CX_INDEX_DIR;

const { API_KEY_ENV, MANIFEST_NAME, configureHosted, hostedSettingsFromFlags } = await import("../src/core/config.js");
const { SNIPPET_CHARS } = await import("../src/core/table-shape.js");
const { BATCH_MAX } = await import("../src/mcp/server.js");
const { MEMORY_ENV, MEMORY_ON } = await import("../src/core/config.js");
const { MEMORY_HITS, MEMORY_NOTE } = await import("../src/core/memory.js");
const { USAGE_LOG } = await import("../src/core/usage.js");

/** The live table's columns, as `POST /v1/schema` returned them, but the
 * vector column. */
const JOBS_COLUMNS = [
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
];

/** The width the jobs table's `emb` is embedded at. */
const JOBS_DIM = 768;

/** The jobs table's vector column the two ways the platform has described
 * it, each with the record of the hydrate job that loaded the table (one row
 * per posting, cut into nothing): as the build before the seam spelled it,
 * `embedding` with its source, the spelling the record need not back; and as
 * the platform spells it since, `vector` with its width (2026-10-01: every
 * hydrated table's), whose record says the job embedded it. */
const SPELLINGS = [
  {
    spelling: "embedding",
    schema: [...JOBS_COLUMNS, { name: "emb", nullable: false, source: ["title"], type: "embedding" }],
    load: { state: "succeeded", request: { table: JOBS_TABLE, source: { kind: "prefix", prefix: "_source/jobs/" } } },
  },
  {
    spelling: "vector",
    schema: [...JOBS_COLUMNS, { dim: JOBS_DIM, name: "emb", nullable: false, type: "vector" }],
    load: {
      state: "succeeded",
      request: { table: JOBS_TABLE, source: { kind: "prefix", prefix: "_source/jobs/" } },
      schema: { fts: [{ column: "description_html", analyzer: "standard" }], embed: { column: "emb", source: ["title"] } },
    },
  },
];

/** One row as the platform returns it: nulls omitted, the text entity-escaped HTML. */
const ROW = {
  id: "greenhouse:datadog:4599111",
  source_slug: "datadog",
  title: "Senior Software Engineer - Distributed Systems",
  apply_url: "https://careers.datadoghq.com/detail/4599111/",
  description_html: "&lt;p&gt;&lt;span&gt;Distributed Systems engineers design, implement and run&amp;nbsp;the platforms.&lt;/span&gt;&lt;/p&gt;",
  department: "Dev Eng",
  locations: ["Paris, France"],
  remote: false,
};

/** A whole job description as the table stores one: entity-escaped HTML
 * running to thousands of characters - what a fact carries when the loop's
 * statement selects the column, and what ten facts of would cost more than
 * the answer. */
const LONG_HTML_ITEM = "&lt;li&gt;Own the platform&lt;/li&gt;";
const LONG_HTML_ITEMS = 220;
const LONG_HTML = `&lt;ul&gt;${LONG_HTML_ITEM.repeat(LONG_HTML_ITEMS)}&lt;/ul&gt;`;

/** The writes this file exists to catch: none of them may ever be sent. */
const FORBIDDEN_OPS = ["drop_table", "create_table", "append", "delete", "update"];

/** The card asks at startup for a table the platform holds no card for: the
 * enriched card, the default tier, then the lean one it falls back to. */
const CARD_ASKS = ["table_card", "table_card"];

/** The platform with the table there and describable, its schema and its
 * load's record `spelling`'s: it has no card yet, and every read answers -
 * the search by meaning that checks the vector column's model among them,
 * as a deployment that embeds with the model that filled it answers it -
 * but where `overrides` answer instead. The database holds the table alone,
 * so no other is described beside it. */
const describable = ({ schema, load }: (typeof SPELLINGS)[number], overrides: Routes = {}) =>
  scriptPlatform({
    list_tables: () => [200, [JOBS_TABLE]],
    schema: () => [200, schema],
    table_card: () => [404, { error: `no lean card for table ${JOBS_TABLE}` }],
    // The jobs table was loaded one row per posting: its load cut nothing.
    hydrate: () => [200, load],
    vector_search: () => [200, [{ _id: 1, score: 0.26 }]],
    hybrid_search: () => [200, [{ ...ROW, score: 0.0164 }]],
    bm25_search: () => [200, [{ ...ROW, score: 2.5 }]],
    query_sql: (body) => {
      const query = String(body?.query);
      if (query.includes("token_match")) return [200, [{ __cx_total: 2, ...ROW }]];
      // A row with a start-named column beside text spanning lines: what the
      // chunks path would number, and a table of rows must not.
      if (query.includes("start_year")) return [200, [{ start_year: 2019, description_html: "Build\nfast things" }]];
      return [200, [{ n: 42 }]];
    },
    validate: () => [200, { valid: true, check: "unchecked" }],
    // A request that asks for the written answer gets one; the loop's facts
    // either way.
    graph_expand: () => NO_GRAPH,
    ...overrides,
  });

/** The platform with the table NOT there: not listed, and its schema a 404
 * (terminal - not the cold-start 503 the client would retry for its budget).
 * The one table the database lists is described beside it, and its schema,
 * in this script, is a 404 as well. */
const undescribable = () =>
  scriptPlatform({
    list_tables: () => [200, ["chunks"]],
    schema: (body) => [404, { error: `no such table ${String(body?.table_name)}` }],
    table_card: () => [404, { error: `no lean card for table ${JOBS_TABLE}` }],
  });

/** The guard every server here is held to: no write reached the platform
 * and no local index was built. */
function expectNothingBuilt(started: Started): void {
  const ops = started.sent.map((s) => s.op);
  for (const forbidden of FORBIDDEN_OPS) expect(ops, `the server sent ${forbidden}`).not.toContain(forbidden);
  // Auto-index was on and the repo had no index: had any door taken the
  // local path, a manifest would be here (and the table would be gone).
  expect(existsSync(join(started.root, ".infino", MANIFEST_NAME))).toBe(false);
}

beforeAll(() => {
  configureHosted(hostedSettingsFromFlags({ db: "http://127.0.0.1:9/testdb" }, { [API_KEY_ENV]: "inf_test_key_do_not_log" }));
});

afterAll(() => {
  configureHosted(null);
});

describe.each(SPELLINGS)("a table of another shape, described at startup, its vector spelled $spelling", (spelling) => {
  let s: Started;
  beforeAll(async () => {
    s = await start(describable(spelling), "cx-rows-");
  });
  afterAll(async () => {
    await stop(s);
  });

  it("listed the database's tables once, then read the shape once at startup - schema, one card, the load's record and one check of the vector column", () => {
    expect(s.startup).toEqual(["list_tables", "schema", ...CARD_ASKS, "hydrate", "vector_search"]);
    // The check is a search by meaning for one row against the column, which
    // the platform runs only for an embedding column of the model it embeds
    // queries with: text, no vector and no projection.
    const check = s.sent.find((x) => x.op === "vector_search")?.body;
    expect(check).toMatchObject({ table_name: JOBS_TABLE, field_name: "emb", k: 1 });
    expect(typeof check?.query_text).toBe("string");
    expect(Object.keys(check ?? {}).sort()).toEqual(["field_name", "k", "query_text", "table_name"]);
  });

  it("says nothing about passages for a table loaded one row per record", async () => {
    const { tools } = await s.client.listTools();
    expect(tools.find((t) => t.name === "sql")?.description).not.toContain("one passage of a record");
    expect(s.client.getInstructions()).toContain(`an index of the ${JOBS_TABLE} table, one row per record.`);
  });

  it("names the table's columns and search functions in the tool text, and speaks of rows and the key", async () => {
    const { tools } = await s.client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t.description ?? ""]));
    expect(byName.get("sql")).toContain(`hybrid_search('${JOBS_TABLE}','description_html','terms','emb', {{q:"..."}}, k)`);
    expect(byName.get("sql")).toContain("locations list<utf8>");
    // No card named the indexes, so the text says the list is inferred.
    expect(byName.get("sql")).toContain("Full-text indexed: title, description_html (inferred from the schema");
    // The verdict note still rides on it: the platform is there to give one.
    expect(byName.get("sql")).toContain("'validation'");
    // A row is cited as a link to its own link column with its title as the
    // text, never by an id (the owner, 2026-10-01: "either have those ids be
    // links or not show them"); the key stays the lookup.
    const cite =
      "Cite a row as a markdown link to its apply_url, with its title as the text - [<title>](<apply_url>) - never by an id such as its id or _id. " +
      "A row that came without its apply_url is named by its title, never given a link it did not carry.";
    for (const text of [byName.get("search"), s.client.getInstructions()]) {
      expect(text).toContain(cite);
      expect(text).not.toMatch(/cite (a row|them) by/);
    }
    expect(byName.get("search")).toContain(`one sql away (SELECT * FROM ${JOBS_TABLE} WHERE id = '...')`);
    expect(byName.get("sql")).toContain("select apply_url and title beside it so a row can be cited as its link");
    expect(byName.get("find")).toContain(`Every row of ${JOBS_TABLE}`);
    // A table of rows has no files to read: no read tool on this surface.
    expect(byName.has("read")).toBe(false);
    expect(byName.has("ask")).toBe(false);
    expect(byName.has("answer")).toBe(false);
    expect(s.client.getInstructions()).toContain(`an index of the ${JOBS_TABLE} table`);
    // A table of records with no path column holds no document to read: no
    // read tool, and no text sends the caller to one.
    expect(byName.has("read")).toBe(false);
    expect(s.client.getInstructions()).not.toContain("- read -");
    for (const text of byName.values()) expect(text).not.toContain("one read away");
  });

  it("search sends the table's own text and embedding columns, renders rows as hits, and asks the graph once a session", async () => {
    const { ok, value, ops } = await call(s, "search", { query: "distributed systems", k: 3 });
    expect(ok, String(value)).toBe(true);
    // The session's first retrieval asks the platform's graph; this
    // deployment builds none, so a second search is the search alone.
    expect(ops).toEqual(["hybrid_search", "graph_expand"]);
    expect((await call(s, "search", { query: "distributed systems", k: 3 })).ops).toEqual(["hybrid_search"]);
    const result = value as { index: string; ranking: string; key: string; hits: Array<Record<string, unknown>>; usage?: string };
    expect(result.index).toBe("platform");
    expect(result.ranking).toBe("hybrid");
    expect(result.key).toBe("id");
    expect(result.hits[0].score).toBe(0.0164);
    expect(result.hits[0].id).toBe(ROW.id);
    expect(result.hits[0].description_html).toBe("Distributed Systems engineers design, implement and run the platforms.");
    expect(result.usage).toMatch(/1 row/);
    const request = s.sent.find((x) => x.op === "hybrid_search")?.body;
    expect(request).toMatchObject({
      table_name: JOBS_TABLE,
      text_field: "description_html",
      text_query: "distributed systems",
      vector_field: "emb",
      vector_text: "distributed systems",
      k: 3,
      mode: "Or",
    });
    expect(request?.projection).toContain("locations");
    expect(request?.projection).toContain("score");
    expect(request?.projection).not.toContain("emb");
  });

  it("find runs token_match over the text column through one query_sql, reads the total off the rows, and strips only its alias", async () => {
    const { ok, value, ops } = await call(s, "find", { query: "distributed systems", limit: 5, defines: true, under: "src" });
    expect(ok, String(value)).toBe(true);
    expect(ops).toEqual(["query_sql"]);
    const result = value as { index: string; column: string; total: number; matches: Array<Record<string, unknown>> };
    expect(result.index).toBe("platform");
    expect(result.column).toBe("description_html");
    expect(result.total).toBe(2);
    expect(result.matches[0].id).toBe(ROW.id);
    expect(result.matches[0]).not.toHaveProperty("__cx_total");
    const statement = String(s.sent.find((x) => x.op === "query_sql" && String(x.body?.query).includes("token_match"))?.body?.query);
    expect(statement).toContain(`FROM token_match('${JOBS_TABLE}', 'description_html', 'distributed systems', 'and') LIMIT 5`);
    expect(statement).toContain("COUNT(*) OVER () AS __cx_total");
  });

  it("sql runs on the platform with the embed map folded into its placeholder, asks the verdict against the text column, and numbers no lines", async () => {
    const { ok, value, ops } = await call(s, "sql", {
      query: `SELECT COUNT(*) AS n FROM hybrid_search('${JOBS_TABLE}','description_html','rust','emb', {{q}}, 50)`,
      embed: { q: "rust engineering roles" },
      question: "how many rust roles?",
    });
    expect(ok, String(value)).toBe(true);
    // The statement, its verdict and its rerank in one read, and nothing else.
    expect(ops).toEqual(["query_sql"]);
    const result = value as { index: string; rows: unknown[]; validation?: Record<string, unknown> };
    expect(result.index).toBe("platform");
    expect(result.rows).toEqual([{ n: 42 }]);
    expect(result.validation).toEqual({ valid: true, check: "unchecked" });
    const statement = s.sent.find((x) => x.op === "query_sql" && String(x.body?.query).includes("hybrid_search"))?.body;
    expect(statement?.query).toBe(`SELECT COUNT(*) AS n FROM hybrid_search('${JOBS_TABLE}','description_html','rust','emb', {{q:"rust engineering roles"}}, 50)`);
    // The check against the text column, on the statement itself.
    expect(statement?.validate).toMatchObject({ table_name: JOBS_TABLE, field_name: "description_html", question: "how many rust roles?" });
    expect(statement?.rerank).toEqual({ question: "how many rust roles?" });
  });

  it("find with queries runs every string at once and returns the results in order, each under its query", async () => {
    const { ok, value, ops } = await call(s, "find", { queries: ["distributed systems", "rust", "paris"], limit: 5 });
    expect(ok, String(value)).toBe(true);
    // One platform read per query, and nothing else.
    expect(ops).toEqual(["query_sql", "query_sql", "query_sql"]);
    const result = value as { results: Array<{ query: string; total?: number; error?: string }>; took_ms: number };
    expect(result.results.map((r) => r.query)).toEqual(["distributed systems", "rust", "paris"]);
    for (const r of result.results) expect(r.total).toBe(2);
    expect(typeof result.took_ms).toBe("number");
  });

  it("sql with queries runs every statement at once, a refused one as its message beside the others", async () => {
    const { ok, value } = await call(s, "sql", {
      queries: [`SELECT COUNT(*) AS n FROM ${JOBS_TABLE}`, `DROP TABLE ${JOBS_TABLE}`, `SELECT start_year, description_html FROM ${JOBS_TABLE} LIMIT 1`],
    });
    expect(ok, String(value)).toBe(true);
    const result = value as { results: Array<{ query: string; rows?: unknown[]; error?: string }> };
    expect(result.results).toHaveLength(3);
    expect(result.results[0].rows).toEqual([{ n: 42 }]);
    expect(result.results[1].error).toMatch(/read-only/);
    expect(result.results[1].rows).toBeUndefined();
    expect(result.results[2].rows).toEqual([{ start_year: 2019, description_html: "Build\nfast things" }]);
  });

  it("a call with neither query nor queries, or with too many, is refused before anything reaches the platform", async () => {
    const neither = await call(s, "find", { limit: 5 });
    expect(neither.ok).toBe(false);
    expect(neither.value).toMatch(/give query, or queries/);
    expect(neither.ops).toEqual([]);
    // The cap is the schema's, so the refusal is the SDK's own wording.
    const tooMany = await call(s, "search", { queries: Array.from({ length: BATCH_MAX + 1 }, (_, i) => `q${i}`) });
    expect(tooMany.ok).toBe(false);
    expect(tooMany.value).toMatch(new RegExp(`<=${BATCH_MAX} items`));
    expect(tooMany.ops).toEqual([]);
  });

  it("sql reads a placeholder spelled close to the platform's as the platform's, in the statement it runs and the one the verdict reads", async () => {
    // As Sonnet wrote it on the demo (2026-10-01): one brace, single quotes,
    // and an embed map beside it naming nothing the statement references.
    const before = s.sent.length;
    const { ok, value, ops } = await call(s, "sql", {
      query: `SELECT COUNT(*) AS n FROM hybrid_search('${JOBS_TABLE}','description_html','rust','emb', {q: 'rust engineering roles'}, 50)`,
      embed: { q: "rust engineering roles" },
      question: "how many rust roles?",
    });
    expect(ok, String(value)).toBe(true);
    expect(ops).toEqual(["query_sql"]);
    const runs = `SELECT COUNT(*) AS n FROM hybrid_search('${JOBS_TABLE}','description_html','rust','emb', {{q:"rust engineering roles"}}, 50)`;
    const sent = s.sent.slice(before);
    expect(sent.find((x) => x.op === "query_sql")?.body?.query).toBe(runs);
    // The verdict reads the statement that ran: the one the platform judged.
    expect(sent.find((x) => x.op === "query_sql")?.body?.validate).toBeDefined();
  });

  it("sql returns a row's multi-line text as the platform gave it: a table has no lines to number", async () => {
    // The chunks path numbers every multi-line cell from the smallest
    // start-named column; here that would read "2019: Build\n2020: fast things".
    const { ok, value } = await call(s, "sql", { query: `SELECT start_year, description_html FROM ${JOBS_TABLE} LIMIT 1` });
    expect(ok, String(value)).toBe(true);
    expect((value as { rows: unknown[] }).rows).toEqual([{ start_year: 2019, description_html: "Build\nfast things" }]);
  });

  it("sql still refuses a write before anything reaches the platform", async () => {
    const { ok, value, ops } = await call(s, "sql", { query: `DROP TABLE ${JOBS_TABLE}` });
    expect(ok).toBe(false);
    expect(value).toMatch(/read-only/);
    expect(ops).toEqual([]);
  });

  it("never reached the platform with a drop, create or append, and wrote no manifest", () => {
    expectNothingBuilt(s);
  });
});

// A `vector` column is spelled the same whoever filled it, and the client
// cannot read the model it was filled with. Without the load's word that the
// platform embedded it, the table's one vector column is still the candidate
// - a table copied from a hydrated one carries its vectors and no such
// record - and the platform's own check
// says: asked to embed a query for it, it does, so search runs by meaning.
// A column it refuses is left to keyword alone (UNEMBEDDED, below).
describe("a table whose vector column no load record says the platform embedded", () => {
  let s: Started;
  beforeAll(async () => {
    // The `vector` spelling, its load's record without what the job settled
    // on: a request and a state, and no word of an embedding.
    const [, vector] = SPELLINGS;
    const load = { state: vector.load.state, request: vector.load.request };
    s = await start(describable({ ...vector, load }), "cx-rows-");
  });
  afterAll(async () => {
    await stop(s);
  });

  it("checks the one vector column with the platform and, as it embeds a query for it, searches by meaning", async () => {
    expect(s.startup).toEqual(["list_tables", "schema", ...CARD_ASKS, "hydrate", "vector_search"]);
    const { tools } = await s.client.listTools();
    const sql = tools.find((t) => t.name === "sql")?.description ?? "";
    expect(sql).toContain(`hybrid_search('${JOBS_TABLE}','description_html','terms','emb', {{q:"..."}}, k)`);
    const { ok, value, ops } = await call(s, "search", { query: "distributed systems", k: 3 });
    expect(ok, String(value)).toBe(true);
    expect(ops).toEqual(["hybrid_search", "graph_expand"]);
    expect((value as { ranking: string }).ranking).toBe("hybrid");
    expectNothingBuilt(s);
  });
});

/** The platform's words for a column filled under another model than the
 * one it embeds queries with (the platform's query embedder). */
const MODEL_MISMATCH =
  'column "emb" was embedded with model "nomic-embed-text-v1.5"; this deployment embeds with "another-embedder", so text cannot be queried against it';
/** The platform's words for an embedding server it could not reach. */
const EMBEDDER_DOWN = "embedding server unreachable; retry after the Retry-After seconds, once it is back";

/** The checks that leave a candidate vector column unoffered: the platform
 * refusing a column filled under another model - whichever way the schema
 * spells it, and though the load's record says the platform embedded it -
 * and an embedding server that is starting, which the check does not wait
 * for. */
const UNEMBEDDED = [
  { case: "filled under another model, spelled vector", spelling: SPELLINGS[1], status: 400, error: MODEL_MISMATCH },
  { case: "filled under another model, spelled embedding", spelling: SPELLINGS[0], status: 400, error: MODEL_MISMATCH },
  { case: "its embedding server starting", spelling: SPELLINGS[1], status: 503, error: EMBEDDER_DOWN },
];

// The load's record says the platform embedded the column; it does not say
// the platform still embeds queries with the model that filled it - the
// embedder can change after a load, and a table can be loaded under a model
// of its own. The platform is asked, the one place the column's model can be
// read, and a column it did not embed a query for is not searched by
// meaning: no {{q:"..."}} in the sql text, and search runs BM25.
describe.each(UNEMBEDDED)("a vector column the platform did not embed a query for at startup, $case", ({ spelling, status, error }) => {
  let s: Started;
  const heard: string[] = [];
  beforeAll(async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      heard.push(args.map(String).join(" "));
    });
    try {
      s = await start(describable(spelling, { vector_search: () => [status, { error }] }), "cx-rows-");
    } finally {
      stderr.mockRestore();
    }
  });
  afterAll(async () => {
    await stop(s);
  });

  it("asks once, retries nothing, and says why on stderr in the platform's words", () => {
    expect(s.startup).toEqual(["list_tables", "schema", ...CARD_ASKS, "hydrate", "vector_search"]);
    const said = `${JOBS_TABLE}: vector column emb is not searched by meaning: the platform did not embed a query for it (vector_search: server returned ${status}: ${error}`;
    expect(heard.filter((line) => line.startsWith(said)), heard.join("\n")).toHaveLength(1);
  });

  it("runs search by keyword alone, and the sql text offers no search by meaning", async () => {
    const { tools } = await s.client.listTools();
    const sql = tools.find((t) => t.name === "sql")?.description ?? "";
    expect(sql).toContain("No vector column: rank by terms alone.");
    expect(sql).not.toContain("hybrid_search");
    expect(sql).not.toContain('{{q:"..."}}');
    expect(tools.find((t) => t.name === "search")?.description).toContain("ranked by exact keyword matching (BM25)");
    const { ok, value, ops } = await call(s, "search", { query: "distributed systems", k: 3 });
    expect(ok, String(value)).toBe(true);
    expect(ops).toEqual(["bm25_search", "graph_expand"]);
    expect((value as { ranking: string }).ranking).toBe("keyword");
    expectNothingBuilt(s);
  });
});

// A deployment that names no place for the rows' pages and gives the run no
// web gets neither tool.
describe("a table whose deployment names no page source and gives no web", () => {
  let s: Started;
  beforeAll(async () => {
    s = await start(describable(SPELLINGS[1]), "cx-rows-");
  });
  afterAll(async () => {
    await stop(s);
  });

  it("offers no page tool: the deployment named no place for the rows' pages", async () => {
    const { tools } = await s.client.listTools();
    expect(tools.map((t) => t.name)).not.toContain("page");
  });

  it("offers no web_fetch tool: the deployment gave the run no web", async () => {
    const { tools } = await s.client.listTools();
    expect(tools.map((t) => t.name)).not.toContain("web_fetch");
  });
});

// CX_WEB_FETCH gives the run the web: the server offers `web_fetch`, which has
// the platform read the page a search named and hand back its text.
describe("a run the deployment gives the web", () => {
  const PAGE = {
    url: "https://fred.stlouisfed.org/data/PPIACO",
    content_type: "text/plain",
    text: "DATE VALUE\n1960-01-01 31.7",
    offset: 0,
    total_chars: 60_000,
    next_offset: 40_000,
  };
  let s: Started;
  beforeAll(async () => {
    process.env.CX_WEB_FETCH = "1";
    try {
      s = await start(describable(SPELLINGS[1], { fetch: () => [200, PAGE] }), "cx-rows-");
    } finally {
      delete process.env.CX_WEB_FETCH;
    }
  });
  afterAll(async () => {
    await stop(s);
  });

  it("answers a page's address with the platform's text and where to read on", async () => {
    const { tools } = await s.client.listTools();
    expect(tools.map((t) => t.name)).toContain("web_fetch");
    const result = await s.client.callTool({ name: "web_fetch", arguments: { url: PAGE.url } });
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([
      {
        type: "text",
        text:
          "https://fred.stlouisfed.org/data/PPIACO (text/plain): characters 0-26 of 60000; read on with offset 40000" +
          "\n\nDATE VALUE\n1960-01-01 31.7",
      },
    ]);
    expect(s.sent.find((x) => x.op === "fetch")?.body).toEqual({ url: PAGE.url, offset: 0 });
    expectNothingBuilt(s);
  });
});

// The platform's card says the deployment knows where the documents of the
// table's rows lie (`pages`): the server then offers `page`, which hands the
// model a row's page as the image the platform reads off the document. A
// table whose card says nothing of pages gets no such tool.
describe("graph expansion that fails", () => {
  const started = async (status: number) => start(describable(SPELLINGS[1], { graph_expand: () => [status, { error: "graph store unavailable" }] }), "cx-rows-");
  /** The rows of the last search, beside the graph's account of it. */
  const searchOnce = async (s: Started) => {
    const r = await call(s, "search", { query: "distributed systems", k: 3 });
    expect(r.ok, String(r.value)).toBe(true);
    return { ops: r.ops, graph: (r.value as { graph?: string; hits: unknown[] }).graph, hits: (r.value as { hits: unknown[] }).hits };
  };

  it("pauses after a failure that may pass, keeps the rows, and does not ask again during the pause", async () => {
    const s = await started(503);
    try {
      const first = await searchOnce(s);
      expect(first.hits.length).toBeGreaterThan(0);
      // One graph attempt: its own client waits out no cold start.
      expect(first.ops).toEqual(["hybrid_search", "graph_expand"]);
      expect(first.graph).toMatch(/^graph expansion paused for 60 s/);
      const second = await searchOnce(s);
      expect(second.ops).toEqual(["hybrid_search"]);
    } finally {
      await stop(s);
    }
  });

  it("turns off for the session on an answer that will not change", async () => {
    const s = await started(403);
    try {
      expect((await searchOnce(s)).graph).toMatch(/^graph expansion off for this session/);
      expect((await searchOnce(s)).ops).toEqual(["hybrid_search"]);
    } finally {
      await stop(s);
    }
  });
});

describe("graph expansion on the ledger", () => {
  let s: Started;
  beforeAll(async () => {
    s = await start(
      describable(SPELLINGS[1], { graph_expand: () => [200, { seeds: 1, connected: [] }, "0.5"] }),
      "cx-rows-",
    );
  });
  afterAll(async () => {
    await stop(s);
  });

  it("files the graph read beside the search's own on the receipt", async () => {
    const { ok, ops } = await call(s, "search", { query: "distributed systems", k: 3 });
    expect(ok).toBe(true);
    expect(ops).toEqual(["hybrid_search", "graph_expand"]);
    const lines = readFileSync(join(s.root, ".infino", USAGE_LOG), "utf8").trim().split("\n");
    const entry = JSON.parse(lines.at(-1)!) as { tool: string; platform?: { readTokens?: number } };
    expect(entry.tool).toBe("search");
    // The search's metered 0.010 and the graph's 0.5.
    expect(entry.platform?.readTokens).toBeCloseTo(0.51, 5);
  });
});

describe("an account without the agent routes", () => {
  const PAGED_CARD = { card: { schema: [] }, pages: true };
  let s: Started;
  beforeAll(async () => {
    process.env.CX_WEB_FETCH = "1";
    try {
      s = await start(
        describable(SPELLINGS[1], {
          account: () => [200, { agent_apis: false }],
          table_card: () => [200, PAGED_CARD],
        }),
        "cx-rows-",
      );
    } finally {
      delete process.env.CX_WEB_FETCH;
    }
  });
  afterAll(async () => {
    await stop(s);
  });

  it("reads the account's features once at startup, and offers no page and no web_fetch", async () => {
    expect(s.features).toBe(1);
    expect(s.sent.find((x) => x.op === "account")?.path).toBe("account/features");
    const names = (await s.client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain("page");
    expect(names).not.toContain("web_fetch");
    expect(names).toContain("search");
  });

  it("searches without asking the platform's graph for connected rows", async () => {
    const { ok, value, ops } = await call(s, "search", { query: "distributed systems", k: 3 });
    expect(ok, String(value)).toBe(true);
    expect(ops).toEqual(["hybrid_search"]);
  });
});

describe("an account whose features cannot be read", () => {
  let s: Started;
  beforeAll(async () => {
    process.env.CX_WEB_FETCH = "1";
    try {
      s = await start(describable(SPELLINGS[1], { account: () => [404, { error: "no such route" }] }), "cx-rows-");
    } finally {
      delete process.env.CX_WEB_FETCH;
    }
  });
  afterAll(async () => {
    await stop(s);
  });

  it("reads as an account without the agent routes: no web_fetch, and search still runs", async () => {
    const names = (await s.client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain("web_fetch");
    const { ok, ops } = await call(s, "search", { query: "rust", k: 3 });
    expect(ok).toBe(true);
    expect(ops).toEqual(["hybrid_search"]);
  });
});

describe("a table whose deployment says where its rows' pages lie", () => {
  const IMAGE = { media_type: "image/jpeg", data: "/9j/2Q==", width: 1350, height: 1803 };
  /** The table's card as the platform serves it, with the deployment's
   * word that its rows have pages beside it. */
  const PAGED_CARD = { card: { schema: [] }, pages: true };
  let s: Started;
  beforeAll(async () => {
    s = await start(describable(SPELLINGS[1], { table_card: () => [200, PAGED_CARD], page: () => [200, IMAGE] }), "cx-rows-");
  });
  afterAll(async () => {
    await stop(s);
  });

  it("answers a row's page with the platform's image, naming the row's table and document", async () => {
    const { tools } = await s.client.listTools();
    expect(tools.map((t) => t.name)).toContain("page");
    const result = await s.client.callTool({ name: "page", arguments: { document: "cs-1991", page: 17 } });
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([
      { type: "image", data: IMAGE.data, mimeType: IMAGE.media_type },
      { type: "text", text: "cs-1991, page 17 (1350 x 1803 px)" },
    ]);
    expect(s.sent.find((x) => x.op === "page")?.body).toEqual({ table: JOBS_TABLE, document: "cs-1991", page: 17 });
    expectNothingBuilt(s);
  });
});

describe("a table whose card says nothing of pages", () => {
  let s: Started;
  beforeAll(async () => {
    s = await start(describable(SPELLINGS[1]), "cx-rows-");
  });
  afterAll(async () => {
    await stop(s);
  });

  it("offers no page tool", async () => {
    const { tools } = await s.client.listTools();
    expect(tools.map((t) => t.name)).not.toContain("page");
  });
});

describe("a table of another shape the platform could not describe at startup", () => {
  let s: Started;
  beforeAll(async () => {
    s = await start(undescribable(), "cx-rows-");
  });
  afterAll(async () => {
    await stop(s);
  });

  it("registers the rows tools, not the chunks text, and says the table could not be described", async () => {
    // The database's tables once, then the table's schema and the listed
    // table's, read at once and each once - and nothing more of either.
    expect(s.startup).toEqual(["list_tables", "schema", "schema"]);
    expect(s.sent.filter((x) => x.op !== "account").slice(0, s.startup.length).filter((x) => x.op === "schema").map((x) => String(x.body?.table_name)).sort()).toEqual(["chunks", JOBS_TABLE]);
    const { tools } = await s.client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t.description ?? ""]));
    expect(byName.has("ask")).toBe(false);
    for (const name of ["find", "search", "sql"]) {
      expect(byName.get(name), name).toContain(`rows of the ${JOBS_TABLE} table`);
      expect(byName.get(name), name).toContain("could not be described");
      expect(byName.get(name), name).not.toContain("start_line");
      expect(byName.get(name), name).not.toContain("path:line");
    }
    expect(byName.get("sql")).not.toContain(`hybrid_search('${JOBS_TABLE}','content'`);
    expect(s.client.getInstructions()).toContain(`no such table ${JOBS_TABLE}`);
    expect(s.client.getInstructions()).not.toContain("local index of this repository");
  });

  it("every door returns the cause, makes no platform request, and never falls through to a local build", async () => {
    for (const [name, args] of [
      ["find", { query: "rust" }],
      ["search", { query: "rust" }],
      ["sql", { query: `SELECT COUNT(*) FROM ${JOBS_TABLE}` }],
    ] as Array<[string, Record<string, unknown>]>) {
      const { ok, value, ops } = await call(s, name, args);
      expect(ok, name).toBe(false);
      expect(value, name).toMatch(new RegExp(`^${name} failed: table ${JOBS_TABLE} could not be described from the platform at `));
      expect(value, name).toContain(`no such table ${JOBS_TABLE}`);
      expect(value, name).toContain("nothing runs against a local index in its place");
      expect(ops, name).toEqual([]);
    }
    expectNothingBuilt(s);
  });
});
