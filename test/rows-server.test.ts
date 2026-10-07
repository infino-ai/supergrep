// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The three doors over a hosted table of another shape, end to end through
// the MCP server on an in-memory transport against a scripted platform. Three
// servers are started, each against its own scripted platform, for the three
// things under test.
//
// The first: with CX_REMOTE_SEARCH on and CX_TABLE naming a table that is not
// the chunks table, find, search, sql and ask answer from that table with the
// requests the platform's workers accept (the shapes the live
// cxbench.chunks_jobs probes returned on 2026-09-11), the tool text describes
// it, and the shape is read from the platform ONCE, at startup - no call asks
// the platform what it is about to run against, so each call's requests are
// its own and nothing else.
//
// The second: the same table, but the platform cannot describe it at startup.
// The server then registers the rows tools - never the chunks text, which
// would name columns the table does not have - and every call says why it
// cannot run.
//
// The third: no CX_REMOTE_SEARCH at all, so the doors are local, and the
// repository has no index. Auto-index is on, yet nothing builds one: a build
// DROPS and recreates the platform table it is pointed at, and this process
// did not load that table (CX_TABLE is not the default), so the server refuses
// by ownership rather than by luck of the column names. In all three, no
// manifest appears and no drop_table / create_table / append ever reaches the
// platform.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { call, scriptPlatform, start, stop, type Routes, type Started } from "./mcp-harness.js";

/** The table the server is started for, in place of `chunks`. */
const JOBS_TABLE = "chunks_jobs";

// The environment the server reads at module load (TABLE is a constant of
// config.ts) and at startup, set before either module is imported - which is
// why every import of the client's own code below is dynamic.
process.env.CX_TABLE = JOBS_TABLE;
process.env.CX_REMOTE_SEARCH = "1";
process.env.CX_NO_EMBED = "1";
delete process.env.CX_AUTO_INDEX; // on: the guard needs the path that would build
delete process.env.CX_NO_RECEIPT;
delete process.env.CX_INDEX_DIR;

const { API_KEY_ENV, MANIFEST_NAME, configureHosted, hostedSettingsFromFlags } = await import("../src/core/config.js");
const { SNIPPET_CHARS } = await import("../src/core/table-shape.js");

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

/** The platform's loop answering one question over the table: a fact placed
 * by the columns the projection names - the row's id, its link and its
 * title - carrying the searched text whole and a list cell beside it, as the
 * platform's facts do. */
const ASKED = {
  facts: [
    {
      table: JOBS_TABLE,
      row: { id: ROW.id, apply_url: ROW.apply_url, title: ROW.title, description_html: LONG_HTML, locations: ROW.locations, score: 0.0164 },
    },
  ],
  statement: `SELECT id, title FROM bm25_search('${JOBS_TABLE}','description_html','distributed', 10)`,
  coverage: { rows_total: 1, rows_returned: 1, truncated: false },
  terminate: "answered",
  turns: 1,
  retries: 0,
  model_tokens: 640,
};

/** The writes this file exists to catch: none of them may ever be sent. */
const FORBIDDEN_OPS = ["drop_table", "create_table", "append", "delete", "update"];

/** The card asks at startup for a table the platform holds no card for: the
 * enriched card, the default tier, then the lean one it falls back to. */
const CARD_ASKS = ["table_card", "table_card"];

/** The platform with the table there and describable, its schema and its
 * load's record `spelling`'s: it has no card yet, and every read answers -
 * the search by meaning that checks the vector column's model among them,
 * as a deployment that embeds with the model that filled it answers it -
 * but where `overrides` answer instead. */
const describable = ({ schema, load }: (typeof SPELLINGS)[number], overrides: Routes = {}) =>
  scriptPlatform({
    list_tables: () => [200, ["chunks", JOBS_TABLE]],
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
    sub_agent: (body) => [200, body?.answer ? { ...ASKED, answer: WRITTEN_ANSWER } : ASKED],
    ...overrides,
  });

/** The platform's written answer, as `answer` asks for it. */
const WRITTEN_ANSWER = "Two distributed-systems roles are open: Own the platform (id 7), in Paris.";

/** The platform with the table NOT there: not listed, and its schema a 404
 * (terminal - not the cold-start 503 the client would retry for its budget). */
const undescribable = () =>
  scriptPlatform({
    list_tables: () => [200, ["chunks"]],
    schema: () => [404, { error: `no such table ${JOBS_TABLE}` }],
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
  configureHosted(hostedSettingsFromFlags({ db: "http://127.0.0.1:9/cxbench" }, { [API_KEY_ENV]: "inf_test_key_do_not_log" }));
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

  it("read the shape once at startup - schema, one card, the load's record and one check of the vector column - and never listed the tables", () => {
    expect(s.startup).toEqual(["schema", ...CARD_ASKS, "hydrate", "vector_search"]);
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
    for (const text of [byName.get("search"), byName.get("ask"), s.client.getInstructions()]) {
      expect(text).toContain(cite);
      expect(text).not.toMatch(/cite (a row|them) by/);
    }
    expect(byName.get("search")).toContain(`one sql away (SELECT * FROM ${JOBS_TABLE} WHERE id = '...')`);
    expect(byName.get("sql")).toContain("select apply_url and title beside it so a row can be cited as its link");
    expect(byName.get("find")).toContain(`Every row of ${JOBS_TABLE}`);
    expect(byName.get("ask")).toContain(`the ${JOBS_TABLE} table's index`);
    // The facts of ask are rows, cut to snippets, never hits.
    expect(byName.get("ask")).toContain("returns the rows it found, never hits");
    expect(byName.get("ask")).toContain(`snippet`);
    expect(byName.get("ask")).toContain(`${SNIPPET_CHARS} characters`);
    expect(byName.get("ask")).not.toContain("from its hits");
    expect(s.client.getInstructions()).toContain(`an index of the ${JOBS_TABLE} table`);
  });

  it("search sends the table's own text and embedding columns, renders rows as hits, and makes no other request", async () => {
    const { ok, value, ops } = await call(s, "search", { query: "distributed systems", k: 3 });
    expect(ok, String(value)).toBe(true);
    expect(ops).toEqual(["hybrid_search"]);
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
    // The statement, then the verdict: the call's own two reads and nothing else.
    expect(ops).toEqual(["query_sql", "validate"]);
    const result = value as { index: string; rows: unknown[]; validation?: Record<string, unknown> };
    expect(result.index).toBe("platform");
    expect(result.rows).toEqual([{ n: 42 }]);
    expect(result.validation).toEqual({ valid: true, check: "unchecked" });
    const statement = s.sent.find((x) => x.op === "query_sql" && String(x.body?.query).includes("hybrid_search"))?.body;
    expect(statement?.query).toBe(`SELECT COUNT(*) AS n FROM hybrid_search('${JOBS_TABLE}','description_html','rust','emb', {{q:"rust engineering roles"}}, 50)`);
    const verdict = s.sent.find((x) => x.op === "validate")?.body;
    expect(verdict).toMatchObject({ table_name: JOBS_TABLE, field_name: "description_html", question: "how many rust roles?" });
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
    expect(ops).toEqual(["query_sql", "validate"]);
    const runs = `SELECT COUNT(*) AS n FROM hybrid_search('${JOBS_TABLE}','description_html','rust','emb', {{q:"rust engineering roles"}}, 50)`;
    const sent = s.sent.slice(before);
    expect(sent.find((x) => x.op === "query_sql")?.body?.query).toBe(runs);
    expect(sent.find((x) => x.op === "validate")?.body?.statement).toBe(runs);
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

  it("ask hands the platform's loop the row key, link and title as the projection, probes nothing first, and returns its facts as rows with the text cut to snippets", async () => {
    const { ok, value, ops } = await call(s, "ask", { question: "which distributed systems roles are there?" });
    expect(ok, String(value)).toBe(true);
    expect(ops).toEqual(["sub_agent"]);
    const request = s.sent.find((x) => x.op === "sub_agent")?.body;
    // The link and the title ride beside the key, so every search and find
    // fact the loop returns carries what the answer cites a row by.
    expect(request?.projection).toEqual(["id", "apply_url", "title"]);
    expect(request?.question).toBe("which distributed systems roles are there?");
    const result = value as { sql?: string; hits: unknown[]; rows: Array<Record<string, unknown>>; turns: number };
    expect(result.sql).toBe(ASKED.statement);
    // The fact came with the whole description - thousands of characters of
    // escaped HTML - and a list cell; the row keeps the list and carries the
    // text as a search hit would, a snippet, never as a hit of the chunks
    // shape (nothing here names a place in code).
    expect(LONG_HTML.length).toBeGreaterThanOrEqual(8_000);
    expect(result.hits).toEqual([]);
    expect(result.rows).toHaveLength(1);
    const [row] = result.rows;
    expect(Object.keys(row)).toEqual(["score", "id", "apply_url", "locations", "title", "description_html"]);
    expect(row).toMatchObject({ score: 0.0164, id: ROW.id, apply_url: ROW.apply_url, title: ROW.title, locations: ["Paris, France"] });
    const text = String(row.description_html);
    expect(text.length).toBe(SNIPPET_CHARS + "...".length);
    expect(text.startsWith("Own the platform Own the platform")).toBe(true);
    expect(text).not.toContain("&lt;");
  });

  it("answer asks the loop for the written answer from the rows this server returned, with the hook's narration as context, keeps a copy under the index dir, and hands the model the text to relay", async () => {
    const before = s.sent.length;
    // `narration` is what the installed PreToolUse hook fills from the
    // session transcript; the model itself is asked for the question alone.
    const result = (await s.client.callTool({ name: "answer", arguments: { question: "which distributed systems roles are there?", narration: "id 7 is the one in Paris" } })) as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    expect(result.isError ?? false, result.content[0].text).toBe(false);
    expect(s.sent.slice(before).map((x) => x.op)).toEqual(["sub_agent"]);
    const request = s.sent.slice(before).find((x) => x.op === "sub_agent")?.body;
    expect(request?.answer).toBe(true);
    expect(String(request?.context)).toContain("What the model said while it gathered the rows:\nid 7 is the one in Paris");
    expect(request?.question).toBe("which distributed systems roles are there?");
    // The rows the tests above had this server return - the ask's fact by
    // the table's key among them - go to the platform as the facts to write
    // from, each named by its table, so no loop runs there.
    const facts = request?.facts as Array<{ table: string; row: Record<string, unknown> }>;
    expect(Array.isArray(facts) && facts.length > 0).toBe(true);
    expect(facts.every((f) => f.table === JOBS_TABLE)).toBe(true);
    expect(facts).toContainEqual({ table: JOBS_TABLE, row: { id: ROW.id } });
    // Without the install's hook the model is told to relay the text, and
    // the text is the whole result: no rows, no coverage, no receipt to
    // rewrite from.
    const text = result.content[0].text;
    expect(text).toBe(`Reply with the following answer exactly as written, in full, and nothing else:\n\n${WRITTEN_ANSWER}`);
    // The file the hook would have read.
    const answers = join(s.root, ".infino", "answers");
    const files = readdirSync(answers);
    expect(files).toHaveLength(1);
    expect(readFileSync(join(answers, files[0]), "utf8")).toBe(WRITTEN_ANSWER);
    // The answer consumed the record: a second answer with nothing retrieved
    // since sends no facts, and the platform retrieves for itself.
    const again = s.sent.length;
    await s.client.callTool({ name: "answer", arguments: { question: "and in Paris?" } });
    const second = s.sent.slice(again).find((x) => x.op === "sub_agent")?.body;
    expect(second?.answer).toBe(true);
    expect(second?.facts).toBeUndefined();
    expect(second?.context).toBeUndefined();
  });

  it("never reached the platform with a drop, create or append, and wrote no manifest", () => {
    expectNothingBuilt(s);
  });
});

// A `vector` column is spelled the same whoever filled it, and the client
// cannot read the model it was filled with: without the load's word that the
// platform embedded it, it is no candidate, the platform is not asked, and it
// is not searched by meaning - the inner loop's rule for a column whose model
// it cannot match.
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

  it("runs search by keyword alone, and the sql text says there is no vector column", async () => {
    // No candidate, so nothing to ask the platform to check.
    expect(s.startup).toEqual(["schema", ...CARD_ASKS, "hydrate"]);
    const { tools } = await s.client.listTools();
    const sql = tools.find((t) => t.name === "sql")?.description ?? "";
    expect(sql).toContain("No vector column: rank by terms alone.");
    expect(sql).not.toContain("hybrid_search");
    const { ok, value, ops } = await call(s, "search", { query: "distributed systems", k: 3 });
    expect(ok, String(value)).toBe(true);
    expect(ops).toEqual(["bm25_search"]);
    expect((value as { ranking: string }).ranking).toBe("keyword");
    expectNothingBuilt(s);
  });
});

/** The platform's words for a column filled under another model than the
 * one it embeds queries with (ask/src/worker/query_text.rs). */
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
    expect(s.startup).toEqual(["schema", ...CARD_ASKS, "hydrate", "vector_search"]);
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
    expect(ops).toEqual(["bm25_search"]);
    expect((value as { ranking: string }).ranking).toBe("keyword");
    expectNothingBuilt(s);
  });
});

// CX_TEXT_COLUMN names the column the doors search, read once at startup:
// the jobs table's pick by name is description_html, and a deployment that
// names title gets title in every door and in the sql text's examples.
describe("a table whose deployment names the text column to search", () => {
  let s: Started;
  beforeAll(async () => {
    process.env.CX_TEXT_COLUMN = "title";
    try {
      s = await start(describable(SPELLINGS[1]), "cx-rows-");
    } finally {
      delete process.env.CX_TEXT_COLUMN;
    }
  });
  afterAll(async () => {
    await stop(s);
  });

  it("searches, finds and writes its examples over the named column, the vector beside it", async () => {
    const { tools } = await s.client.listTools();
    const sql = tools.find((t) => t.name === "sql")?.description ?? "";
    expect(sql).toContain(`hybrid_search('${JOBS_TABLE}','title','terms','emb', {{q:"..."}}, k)`);
    expect(sql).not.toContain(`'${JOBS_TABLE}','description_html'`);
    const searched = await call(s, "search", { query: "distributed systems", k: 3 });
    expect(searched.ok, String(searched.value)).toBe(true);
    expect(searched.ops).toEqual(["hybrid_search"]);
    expect(s.sent.find((x) => x.op === "hybrid_search")?.body).toMatchObject({ text_field: "title", vector_field: "emb" });
    const found = await call(s, "find", { query: "engineer" });
    expect(found.ok, String(found.value)).toBe(true);
    expect((found.value as { column: string }).column).toBe("title");
    expectNothingBuilt(s);
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
    expect(s.startup).toEqual(["schema"]);
    const { tools } = await s.client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t.description ?? ""]));
    for (const name of ["find", "search", "sql", "ask"]) {
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
      ["ask", { question: "how many rust roles?" }],
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

describe("the same table without CX_REMOTE_SEARCH: local doors, no index, auto-index on", () => {
  let s: Started;
  beforeAll(async () => {
    delete process.env.CX_REMOTE_SEARCH;
    s = await start(undescribable(), "cx-rows-");
  });
  afterAll(async () => {
    await stop(s);
    process.env.CX_REMOTE_SEARCH = "1";
  });

  it("refuses to build by ownership - CX_TABLE names a table this process does not own - whatever CX_AUTO_INDEX says", async () => {
    // Only the card was asked for at startup, as it always was without
    // CX_REMOTE_SEARCH; the chunks text stands because the doors ARE local.
    expect(s.startup).toEqual(CARD_ASKS);
    for (const [name, args] of [
      ["find", { query: "rust" }],
      ["search", { query: "rust" }],
      ["sql", { query: `SELECT COUNT(*) FROM ${JOBS_TABLE}` }],
      ["ask", { question: "how many rust roles?" }],
    ] as Array<[string, Record<string, unknown>]>) {
      const { ok, value, ops } = await call(s, name, args);
      expect(ok, name).toBe(false);
      expect(value, name).toContain(`CX_TABLE=${JOBS_TABLE} names a table this process does not own`);
      expect(value, name).toContain("build it with `cx index` explicitly");
      expect(ops, name).toEqual([]);
    }
    expectNothingBuilt(s);
  });
});
