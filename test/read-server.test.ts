// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// `read` over a hosted table of documents, end to end through the MCP server
// on an in-memory transport against a scripted platform. The table is laid
// out as the live cxbench.chunks_docs is (read 2026-10-08): one row per
// passage of a file, its place in the file in `chunk` and its text in
// `content`; `task` and `title` copied onto every passage, but `path` - a
// long text column the load keeps on a record's first passage alone - on
// `chunk = 0` only, NULL (absent from a JSON row) on the rest. A record's
// passages hold consecutive engine ids, except where a commit boundary fell
// inside one: its rest begins the next commit's block of ids. The scripted
// platform evaluates the statements read sends against those rows, so a read
// that selects passages by path gets what the live table gave: one passage a
// document. Two servers: one whose load's record names the passages and
// their numbering column, and one whose load left no record, where the
// numbering column is the one a hydrate load uses by default.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, scriptPlatform, start, stop, type Answer, type Started } from "./mcp-harness.js";

/** The table the server is started for, in place of `chunks`. */
const DOCS_TABLE = "chunks_docs";

// The environment the server reads at module load (TABLE is a constant of
// config.ts) and at startup, set before either module is imported - which is
// why every import of the client's own code below is dynamic.
process.env.CX_TABLE = DOCS_TABLE;
process.env.CX_REMOTE_SEARCH = "1";
process.env.CX_NO_EMBED = "1";
delete process.env.CX_AUTO_INDEX; // on: the guard needs the path that would build
delete process.env.CX_NO_RECEIPT;
delete process.env.CX_INDEX_DIR;

const { API_KEY_ENV, MANIFEST_NAME, configureHosted, hostedSettingsFromFlags } = await import("../src/core/config.js");
const { READ_LINES_CAP } = await import("../src/core/searcher.js");
const { READ_BUDGET_BYTES, READ_INLINE_MAX_BYTES, readDocumentsSentence } = await import("../src/mcp/server.js");
const { tableShapeFrom } = await import("../src/core/table-shape.js");

/** The width the table's `emb` is embedded at. */
const DOCS_DIM = 768;

/** The documents table's columns, as `POST /v1/schema` describes them. */
const DOCS_SCHEMA = [
  { name: "area", nullable: true, type: "large_utf8" },
  { name: "content", nullable: true, type: "large_utf8" },
  { name: "file_type", nullable: true, type: "utf8" },
  { name: "path", nullable: true, type: "large_utf8" },
  { name: "task", nullable: true, type: "large_utf8" },
  { name: "title", nullable: true, type: "large_utf8" },
  { name: "chunk", nullable: false, type: "i32" },
  { dim: DOCS_DIM, name: "emb", nullable: false, type: "vector" },
];

/** The record of the hydrate job that loaded the table, as the live one
 * reads: content cut into passages, no numbering column named, and `emb`
 * embedded from the title and the passage. */
const DOCS_LOAD = {
  state: "succeeded",
  request: { table: DOCS_TABLE, chunk: { column: "content", max_tokens: 512, markdown: false } },
  schema: { embed: { column: "emb", source: ["title", "content"] } },
};

/** One document: its first-passage-only path, the cells copied onto every
 * passage, and its passages in order. */
interface Doc {
  path: string;
  task: string;
  title: string;
  passages: string[];
}

const TASK = "intellectual-property/analyze-counterparty-markup-of-master-services-agreement";

/** A file of three passages, each running over two lines. */
const ENGAGEMENT: Doc = {
  path: `${TASK}/engagement-letter.docx`,
  task: TASK,
  title: "engagement letter",
  passages: ["ENGAGEMENT LETTER\nDear Acme,", "We are pleased to act for you\nin the merger.", "Fees are hourly.\nSincerely, Renata Vasquez"],
};

/** A file of one passage, whose path holds a quote the statement must double. */
const MEMO: Doc = { path: `${TASK}/o'neil conflict-check memo.docx`, task: TASK, title: "conflict check memo", passages: ["Conflict check: clear."] };

/** Lines of each passage of the long file. */
const LONG_PASSAGE_LINES = 90;
/** Passages of the long file: past the line cap, by fifty lines. */
const LONG_PASSAGES = (READ_LINES_CAP + 50) / LONG_PASSAGE_LINES;

/** `count` lines, numbered from `first`, made of `text`. */
const linesOf = (count: number, first: number, text: (n: number) => string) => Array.from({ length: count }, (_, i) => text(first + i)).join("\n");

/** A file past the line cap, cut into passages of LONG_PASSAGE_LINES lines. */
const LONG: Doc = {
  path: `${TASK}/closing-checklist.xlsx`,
  task: TASK,
  title: "closing checklist",
  passages: Array.from({ length: LONG_PASSAGES }, (_, p) => linesOf(LONG_PASSAGE_LINES, p * LONG_PASSAGE_LINES + 1, (n) => `row ${n}`)),
};

/** The title the split file and its decoy share. */
const RIDER_TITLE = "talent merchandise rider";
/** A file a commit boundary cuts after its second passage, as one did on the
 * live table: its last two passages begin the next commit's block of ids. */
const SPLIT: Doc = {
  path: "diligence/sports-media-consolidation/talent-merchandise-rider.docx",
  task: "diligence/sports-media-consolidation",
  title: RIDER_TITLE,
  passages: ["RIDER part one", "RIDER part two", "RIDER part three", "RIDER part four"],
};
/** Passages of SPLIT before the commit boundary. */
const SPLIT_AT = 2;
/** Another task's file of the same title, cut at the same passage by another
 * boundary: its continuation also begins a block, numbered as SPLIT's is, and
 * must not be taken for SPLIT's. */
const DECOY: Doc = {
  path: "diligence/other-deal/talent-merchandise-rider.docx",
  task: "diligence/other-deal",
  title: RIDER_TITLE,
  passages: ["DECOY part one", "DECOY part two", "DECOY part three"],
};

/** Lines and width of each line of the files that fill the result's budget. */
const BIG_LINES = 300;
const BIG_LINE_CHARS = 150;
/** Lines of each of their passages. */
const BIG_PASSAGE_LINES = 100;
/** What pads their lines: a quote, which JSON escapes to two bytes, and a
 * section sign, two bytes in UTF-8 - so a line is sent at about twice its
 * length, as escaping inflated the page that went out as 64 KB. */
const ESCAPED_PAD = '"§';
/** A file of BIG_LINES lines of BIG_LINE_CHARS characters: some 45,000
 * characters, sent as some 90,000 bytes. */
const big = (name: string): Doc => ({
  path: `${TASK}/${name}.docx`,
  task: TASK,
  title: name,
  passages: Array.from({ length: BIG_LINES / BIG_PASSAGE_LINES }, (_, p) =>
    linesOf(BIG_PASSAGE_LINES, p * BIG_PASSAGE_LINES + 1, (n) => `${name} line ${n} `.padEnd(BIG_LINE_CHARS, ESCAPED_PAD)),
  ),
});
const BIG = [big("sow-one"), big("sow-two"), big("sow-three")];

/** The most documents one read names (the tool's own limit), each with a
 * long path: what a result carries besides its lines grows with both. */
const MANY_DOCS = 16;
/** Characters of each of their paths. */
const MANY_PATH_CHARS = 200;
const MANY: Doc[] = Array.from({ length: MANY_DOCS }, (_, i) => {
  const doc = big(`deal-${i}`);
  return { ...doc, path: `${TASK}/${`matter-${i}-`.padEnd(MANY_PATH_CHARS, "folder/")}deal-${i}.docx` };
});

/** A path the table does not hold. */
const NOWHERE = `${TASK}/nothing.docx`;

/** The first ids of the commit blocks, as the live table's look. */
const BLOCK_A = 33045841832672128640984815779816n;
const BLOCK_B = 33045856573307698086114660188160n;
const BLOCK_C = 33045854670980747328263498498048n;
const BLOCK_D = 33045850000000000000000000000000n;
const BLOCK_E = 33045860000000000000000000000000n;

/** One stored row: its engine id and its cells, nulls absent. */
interface Stored {
  id: bigint;
  cells: Record<string, unknown>;
}

/** The passages `from` up to `to` of `doc`, laid out from `first`. */
function passagesOf(doc: Doc, first: bigint, from = 0, to = doc.passages.length): Stored[] {
  return doc.passages.slice(from, to).map((content, i) => {
    const chunk = from + i;
    const cells: Record<string, unknown> = { area: "contracts", content, file_type: "docx", task: doc.task, title: doc.title, chunk };
    // The load keeps the path on a record's first passage alone.
    if (chunk === 0) cells.path = doc.path;
    return { id: first + BigInt(i), cells };
  });
}

/** Rows laid out one after another from `first`, in the order given. */
function block(first: bigint, ...parts: Array<(at: bigint) => Stored[]>): Stored[] {
  const out: Stored[] = [];
  for (const part of parts) out.push(...part(first + BigInt(out.length)));
  return out;
}

/** The table: block A holds the small files, then SPLIT's first passages,
 * cut there by the commit; block B begins with SPLIT's rest; block D ends
 * with DECOY's first passages, and block C begins with its rest; block E
 * holds the big files. */
const STORED: Stored[] = [
  ...block(
    BLOCK_A,
    (at) => passagesOf(ENGAGEMENT, at),
    (at) => passagesOf(MEMO, at),
    (at) => passagesOf(LONG, at),
    (at) => passagesOf(SPLIT, at, 0, SPLIT_AT),
  ),
  ...block(BLOCK_B, (at) => passagesOf(SPLIT, at, SPLIT_AT), ...BIG.map((doc) => (at: bigint) => passagesOf(doc, at))),
  ...block(BLOCK_D, (at) => passagesOf(DECOY, at, 0, SPLIT_AT)),
  ...block(BLOCK_C, (at) => passagesOf(DECOY, at, SPLIT_AT)),
  ...block(BLOCK_E, ...MANY.map((doc) => (at: bigint) => passagesOf(doc, at))),
];

/** `text` as a SQL string literal, as the statement must spell a path. */
const literal = (text: string) => `'${text.replace(/'/g, "''")}'`;

/** A stored row as the platform's JSON names it: its cells, and its id as
 * text under the alias a statement asked for it by. */
function rowOf(stored: Stored, query: string): Record<string, unknown> {
  const alias = /CAST\((?:a\.)?_id AS VARCHAR\) AS "([^"]+)"/.exec(query)?.[1];
  return alias ? { [alias]: String(stored.id), ...stored.cells } : { ...stored.cells };
}

/** The platform evaluating the statements a read sends, over STORED, rows in
 * no order (the last first): a statement by path keeps the rows whose path
 * cell is one of the literals it names - passages past the first have none -
 * and `chunk = 0` when it says so; one by id ranges keeps the rows inside
 * any; one for the rows that begin a block keeps those numbered as it says
 * that no row precedes by id. */
function evaluate(query: string): Array<Record<string, unknown>> {
  let kept: Stored[];
  if (query.includes("NOT IN (SELECT")) {
    const numbers = (/WHERE a\."chunk" IN \(([\d, ]+)\)/.exec(query)?.[1] ?? "").split(",").map(Number);
    const ids = new Set(STORED.map((s) => s.id));
    kept = STORED.filter((s) => !ids.has(s.id - 1n) && numbers.includes(Number(s.cells.chunk)));
  } else if (query.includes("BETWEEN")) {
    const ranges = [...query.matchAll(/BETWEEN '(\d+)' AND '(\d+)'/g)].map((m) => [BigInt(m[1]), BigInt(m[2])] as const);
    kept = STORED.filter((s) => ranges.some(([low, high]) => s.id >= low && s.id <= high));
  } else if (query.includes('"path" IN (')) {
    const named = new Set([...BIG, ...MANY, ENGAGEMENT, MEMO, LONG, SPLIT, DECOY].map((d) => d.path).filter((p) => query.includes(literal(p))));
    kept = STORED.filter((s) => named.has(String(s.cells.path)) && (!/"chunk" = 0/.test(query) || s.cells.chunk === 0));
  } else {
    return [];
  }
  return kept.map((s) => rowOf(s, query)).reverse();
}

/** The writes this file must never see sent. */
const FORBIDDEN_OPS = ["drop_table", "create_table", "append", "delete", "update"];

/** The two loads: with the record that names the passages, and with none,
 * the platform answering the record's route 404. */
const LOADS: Array<{ case: string; hydrate: () => Answer }> = [
  { case: "its load's record naming the passages", hydrate: () => [200, DOCS_LOAD] },
  { case: "no record of its load", hydrate: () => [404, { error: `no hydrate job for ${DOCS_TABLE}` }] },
];

/** One file of a read's result. */
interface ReadFile {
  path: string;
  from: number;
  to: number;
  total: number;
  lines: string;
  more?: { from: number };
  note?: string;
}

/** A read's files' lines with their numbers taken off, joined. */
const textOf = (file: ReadFile) =>
  file.lines
    .split("\n")
    .map((line) => line.replace(/^\d+: /, ""))
    .join("\n");

/** A read's result as the server sent it: its size in bytes, and its value. */
interface Sent {
  bytes: number;
  value: { files: ReadFile[]; next?: Array<Record<string, unknown>> };
}

/** One read, with the result's text as the server sent it. */
async function readSent(s: Started, args: Record<string, unknown>): Promise<Sent> {
  const result = (await s.client.callTool({ name: "read", arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
  const text = result.content[0].text;
  expect(result.isError ?? false, text).toBe(false);
  return { bytes: Buffer.byteLength(text), value: JSON.parse(text) as Sent["value"] };
}

/** `docs` read as a caller following the result would: one read of every
 * path, then every call `next` names, until none is left. Every result is
 * held to what Claude Code shows inline; each document's text, its pages in
 * the order they came, is returned with the first result. */
async function readThrough(s: Started, docs: readonly Doc[]): Promise<{ first: Sent; text: Map<string, string> }> {
  const pages = new Map(docs.map((d) => [d.path, [] as string[]]));
  const first = await readSent(s, { paths: docs.map((d) => d.path) });
  const pending: Array<Record<string, unknown>> = [];
  const take = (sent: Sent) => {
    expect(sent.bytes).toBeLessThanOrEqual(READ_INLINE_MAX_BYTES);
    for (const file of sent.value.files) if (file.lines) pages.get(file.path)!.push(textOf(file));
    pending.push(...(sent.value.next ?? []));
  };
  take(first);
  const lines = docs.reduce((n, d) => n + d.passages.join("\n").split("\n").length, 0);
  for (let calls = 0; pending.length > 0; calls++) {
    expect(calls, "next keeps naming calls").toBeLessThan(lines);
    take(await readSent(s, pending.shift()!));
  }
  return { first, text: new Map([...pages].map(([path, parts]) => [path, parts.join("\n")])) };
}

beforeAll(() => {
  configureHosted(hostedSettingsFromFlags({ db: "http://127.0.0.1:9/cxbench" }, { [API_KEY_ENV]: "inf_test_key_do_not_log" }));
});

afterAll(() => {
  configureHosted(null);
});

describe.each(LOADS)("read over a table of documents held as passages, $case", ({ hydrate }) => {
  let s: Started;
  beforeAll(async () => {
    s = await start(
      scriptPlatform({
        list_tables: () => [200, ["chunks", DOCS_TABLE]],
        schema: () => [200, DOCS_SCHEMA],
        table_card: () => [404, { error: `no lean card for table ${DOCS_TABLE}` }],
        hydrate,
        vector_search: () => [200, [{ _id: 1, score: 0.26 }]],
        query_sql: (body) => [200, evaluate(String(body?.query))],
        validate: () => [200, { valid: true, check: "unchecked" }],
      }),
      "cx-read-",
    );
  });
  afterAll(async () => {
    await stop(s);
  });

  it("registers read for the table's documents and routes whole documents to it from the instructions and every other door", async () => {
    const { tools } = await s.client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t.description ?? ""]));
    expect(byName.get("read")).toContain(`a document of ${DOCS_TABLE} is every row sharing its path, put in chunk order and joined`);
    expect(byName.get("read")).toContain("in place of paging one through sql by chunk");
    expect(byName.get("read")).toContain("the result's next lists the read calls that fetch the rest");
    const sentence = readDocumentsSentence(tableShapeFrom(DOCS_TABLE, DOCS_SCHEMA, null, DOCS_LOAD));
    expect(sentence).toContain("never page one through sql by chunk");
    for (const name of ["sql", "search", "find"]) expect(byName.get(name), name).toContain(sentence);
    expect(s.client.getInstructions()).toContain(`- read - ${sentence.trimEnd()}\n`);
  });

  it("reads every passage of several documents though only the first carries the path - one statement for the first rows, one per round for the rest - a missing path a miss beside them", async () => {
    const { ok, value, ops } = await call(s, "read", { paths: [ENGAGEMENT.path, MEMO.path, NOWHERE] });
    expect(ok, String(value)).toBe(true);
    // The first rows of every document named, then their passages by id.
    expect(ops).toEqual(["query_sql", "query_sql"]);
    const sent = s.sent.filter((x) => x.op === "query_sql").slice(-2).map((x) => String(x.body?.query));
    expect(sent[0]).toContain(`WHERE "path" IN (${[ENGAGEMENT.path, MEMO.path, NOWHERE].map(literal).join(", ")}) AND "chunk" = 0`);
    expect(sent[1]).toMatch(/^SELECT CAST\(_id AS VARCHAR\) AS "__cx_id", "chunk", "content" FROM chunks_docs WHERE \(_id BETWEEN '\d+' AND '\d+'\) OR/);
    const result = value as { index: string; files: Array<Record<string, unknown>>; next?: unknown; usage?: string };
    expect(result.index).toBe("platform");
    expect(result.files.map((f) => f.path)).toEqual([ENGAGEMENT.path, MEMO.path, NOWHERE]);
    expect(result.files[0]).toEqual({
      path: ENGAGEMENT.path,
      from: 1,
      to: 6,
      total: 6,
      lines: [
        "1: ENGAGEMENT LETTER",
        "2: Dear Acme,",
        "3: We are pleased to act for you",
        "4: in the merger.",
        "5: Fees are hourly.",
        "6: Sincerely, Renata Vasquez",
      ].join("\n"),
    });
    expect(result.files[1]).toMatchObject({ path: MEMO.path, from: 1, to: 1, lines: "1: Conflict check: clear." });
    expect(result.files[2]).toEqual({ path: NOWHERE, error: `not in ${DOCS_TABLE}` });
    expect(result.next).toBeUndefined();
    expect(result.usage).toMatch(/2 documents/);
  });

  it("follows a document across a commit boundary to the passage that begins the next block and copies its first row's cells, never another document's", async () => {
    const { ok, value } = await call(s, "read", { paths: [SPLIT.path, DECOY.path] });
    expect(ok, String(value)).toBe(true);
    const [split, decoy] = (value as { files: ReadFile[] }).files;
    expect(textOf(split)).toBe(SPLIT.passages.join("\n"));
    expect(textOf(decoy)).toBe(DECOY.passages.join("\n"));
    expect(split.note).toBeUndefined();
  });

  it("cuts every document to the ranges asked for, a gap marked between ranges that do not meet", async () => {
    const { ok, value } = await call(s, "read", { paths: [ENGAGEMENT.path], from: [1, 5], to: [2, 6] });
    expect(ok, String(value)).toBe(true);
    const [doc] = (value as { files: ReadFile[] }).files;
    expect(doc.lines.split("\n")).toEqual(["1: ENGAGEMENT LETTER", "2: Dear Acme,", "--", "5: Fees are hourly.", "6: Sincerely, Renata Vasquez"]);
    // A list sent as its JSON text is read as the list.
    const again = await call(s, "read", { paths: [ENGAGEMENT.path], from: "[1, 5]", to: "[2, 6]" });
    expect(again.ok, String(again.value)).toBe(true);
    expect((again.value as { files: unknown[] }).files).toEqual((value as { files: unknown[] }).files);
  });

  it("pages a document past the line cap, and next names the call for the rest", async () => {
    const first = await call(s, "read", { paths: [LONG.path] });
    expect(first.ok, String(first.value)).toBe(true);
    const { files, next } = first.value as { files: ReadFile[]; next: unknown };
    const [page] = files;
    expect(page.from).toBe(1);
    expect(page.to).toBe(READ_LINES_CAP);
    expect(page.total).toBe(READ_LINES_CAP + 50);
    expect(page.more).toEqual({ from: READ_LINES_CAP + 1 });
    expect(next).toEqual([{ paths: [LONG.path], from: READ_LINES_CAP + 1 }]);
    const lines = page.lines.split("\n");
    expect(lines).toHaveLength(READ_LINES_CAP);
    // The passages came last first; the page reads in order across them.
    expect(lines[0]).toBe("1: row 1");
    expect(lines[LONG_PASSAGE_LINES]).toBe(`${LONG_PASSAGE_LINES + 1}: row ${LONG_PASSAGE_LINES + 1}`);
    const rest = await call(s, "read", { paths: [LONG.path], from: page.more!.from });
    expect(rest.ok, String(rest.value)).toBe(true);
    const [following] = (rest.value as { files: ReadFile[] }).files;
    expect(following.from).toBe(READ_LINES_CAP + 1);
    expect(following.to).toBe(READ_LINES_CAP + 50);
    expect(following.more).toBeUndefined();
    expect(following.lines.split("\n")[0]).toBe(`${READ_LINES_CAP + 1}: row ${READ_LINES_CAP + 1}`);
  });

  it("keeps every page's result, as sent, under what Claude Code shows inline, and next's calls fetch the rest of every document", async () => {
    const { first, text } = await readThrough(s, BIG);
    const [one, two, three] = first.value.files;
    // The page as sent - escaped and encoded - holds to the budget.
    expect(Buffer.byteLength(JSON.stringify(first.value.files.map((f) => f.lines).join("")))).toBeLessThanOrEqual(READ_BUDGET_BYTES);
    // The first document as far as the budget reaches; the others with no
    // line in this result, each told where to start.
    expect(one.to).toBeGreaterThan(1);
    expect(one.more).toEqual({ from: one.to + 1 });
    expect(two.lines).toBe("");
    expect(two.more).toEqual({ from: 1 });
    expect(three.more).toEqual({ from: 1 });
    expect(first.value.next).toEqual([
      { paths: [BIG[0].path], from: one.to + 1 },
      { paths: [BIG[1].path, BIG[2].path], from: 1 },
    ]);
    // Followed to the end, every document whole, in order, once.
    for (const doc of BIG) expect(text.get(doc.path), doc.path).toBe(doc.passages.join("\n"));
  });

  it("keeps a read of the most documents with long paths under the inline limit too, every result of it", async () => {
    const { first, text } = await readThrough(s, MANY);
    expect(first.value.files).toHaveLength(MANY_DOCS);
    expect(first.value.files[0].lines).not.toBe("");
    for (const doc of MANY) expect(text.get(doc.path), doc.path).toBe(doc.passages.join("\n"));
  });

  it("refuses ranges that do not pair before anything reaches the platform", async () => {
    const { ok, value, ops } = await call(s, "read", { paths: [ENGAGEMENT.path], from: [1, 5], to: 6 });
    expect(ok).toBe(false);
    expect(value).toMatch(/^read failed: several ranges are lists of the same length/);
    expect(ops).toEqual([]);
  });

  it("never reached the platform with a write and built no local index", () => {
    const ops = s.sent.map((x) => x.op);
    for (const forbidden of FORBIDDEN_OPS) expect(ops, `the server sent ${forbidden}`).not.toContain(forbidden);
    expect(existsSync(join(s.root, ".infino", MANIFEST_NAME))).toBe(false);
  });
});
