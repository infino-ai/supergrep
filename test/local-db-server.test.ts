// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The MCP server over a local database (CX_LOCAL_DB), end to end on an
// in-memory transport against a real engine folder in a temp dir. The
// hermes-infino plugin's tables are written in the plugin's own shape -
// memory, conversations, traces and skills, and memory_vectors beside
// memory (hermes_infino/tables.py and local.py) - and find, search, sql and
// read run over them with no platform behind the server. A stand-in
// embedder maps words to a few concepts, so a paraphrase that shares no
// word with a memory is found by meaning alone, as the real model finds it.
// Rows appended by another connection while the server runs are seen by the
// next call: every call opens its own connection.

import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as arrow from "apache-arrow";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, scriptPlatform, start, stop, type Started } from "./mcp-harness.js";

/** The table a call reads when it names none: the plugin's example. */
const PRIMARY = "conversations";

// The environment the server reads at module load (TABLE is a constant of
// config.ts) and at startup, set before either module is imported - which is
// why every import of the client's own code below is dynamic.
process.env.CX_TABLE = PRIMARY;
delete process.env.CX_REMOTE_SEARCH;
delete process.env.CX_NO_EMBED;
delete process.env.CX_AUTO_INDEX;
delete process.env.CX_NO_RECEIPT;
delete process.env.CX_INDEX_DIR;

const { API_KEY_ENV, configureHosted, hostedSettingsFromFlags, LOCAL_DB_ENV } = await import("../src/core/config.js");
const { fuseByRank, keyLiteral, LocalDatabase, noCodeIndex, RRF_K } = await import("../src/core/local-db.js");
const { createLocalDatabaseEmbedder } = await import("../src/core/embedder.js");
const { connect, IndexSpec } = await import("@infino-ai/infino");

/** The width of the plugin's vectors (all-MiniLM-L6-v2). */
const DIM = 384;

/** The stand-in model's concepts: each word names the dimension it lights.
 * Words of one concept share no letters with each other, so a keyword
 * search for one never finds a row holding another. */
const CONCEPTS: Record<string, number> = {
  cat: 0,
  feline: 0,
  kitten: 0,
  deploy: 1,
  release: 1,
  friday: 2,
  coffee: 3,
  espresso: 3,
  peanuts: 4,
  allergy: 4,
};
/** The dimension every text lights a little, so no vector is all zeros -
 * a cosine distance needs a length. */
const BIAS_DIM = DIM - 1;
const BIAS = 0.05;

/** A deterministic embedder over CONCEPTS, unit length. */
const fakeEmbedder = {
  embed: async (texts: string[]) =>
    texts.map((text) => {
      const v = new Array<number>(DIM).fill(0);
      v[BIAS_DIM] = BIAS;
      for (const word of text.toLowerCase().split(/\W+/)) if (word in CONCEPTS) v[CONCEPTS[word]] += 1;
      const norm = Math.hypot(...v);
      return v.map((x) => x / norm);
    }),
  dim: async () => DIM,
  provider: "fake",
  model: "fake-concepts-384",
};

/** The plugin's column types, as Arrow builds them. */
const TYPES = {
  utf8: () => new arrow.Utf8(),
  large_utf8: () => new arrow.LargeUtf8(),
  i64: () => new arrow.Int64(),
  f64: () => new arrow.Float64(),
};
type Column = [string, keyof typeof TYPES];

/** The plugin's local tables: columns in order, and the full-text ones. */
const TABLES: Record<string, { columns: Column[]; fts: string[] }> = {
  memory: {
    columns: [
      ["row_id", "utf8"], ["stored_ms", "i64"], ["content", "large_utf8"], ["scope", "utf8"], ["author", "utf8"],
      ["profile", "utf8"], ["session_id", "utf8"], ["origin", "utf8"], ["created_ms", "i64"],
    ],
    fts: ["content"],
  },
  conversations: {
    columns: [
      ["row_id", "utf8"], ["stored_ms", "i64"], ["session_id", "utf8"], ["turn_id", "utf8"], ["seq", "i64"], ["role", "utf8"],
      ["content", "large_utf8"], ["tool_name", "utf8"], ["tool_args", "large_utf8"], ["tool_result", "large_utf8"],
      ["author", "utf8"], ["profile", "utf8"], ["platform", "utf8"], ["created_ms", "i64"],
    ],
    fts: ["content", "tool_result"],
  },
  traces: {
    columns: [
      ["row_id", "utf8"], ["stored_ms", "i64"], ["session_id", "utf8"], ["turn_id", "utf8"], ["request_id", "utf8"], ["kind", "utf8"],
      ["name", "large_utf8"], ["model", "utf8"], ["tool", "utf8"], ["provider", "utf8"], ["status", "utf8"], ["error", "large_utf8"],
      ["duration_ms", "f64"], ["input_tokens", "i64"], ["output_tokens", "i64"], ["cached_tokens", "i64"], ["args", "large_utf8"],
      ["result", "large_utf8"], ["author", "utf8"], ["profile", "utf8"], ["created_ms", "i64"],
    ],
    fts: ["name", "result"],
  },
  skills: {
    columns: [
      ["row_id", "utf8"], ["stored_ms", "i64"], ["name", "utf8"], ["description", "large_utf8"], ["content", "large_utf8"],
      ["author", "utf8"], ["profile", "utf8"], ["created_ms", "i64"],
    ],
    fts: ["description", "content"],
  },
};
const VECTORS = "memory_vectors";

/** One milestone in milliseconds since the epoch, for the rows' times. */
const T0 = 1_762_000_000_000n;

const MEMORIES = [
  { row_id: "m-cat", content: "Tom is the name of my cat", session_id: "s1" },
  { row_id: "m-deploy", content: "The deploy pipeline runs every friday", session_id: "s1" },
  { row_id: "m-coffee", content: "Prefers coffee, black, in the morning", session_id: "s2" },
];
const MESSAGES = [
  { row_id: "c1", session_id: "s1", seq: 0n, role: "user", content: "plan the database migration for the orders service" },
  { row_id: "c2", session_id: "s1", seq: 1n, role: "assistant", content: "I will read the schema first", tool_name: "terminal" },
  { row_id: "c3", session_id: "s1", seq: 2n, role: "tool", content: null, tool_name: "terminal", tool_result: "migration 0042 applied" },
  { row_id: "c4", session_id: "s2", seq: 0n, role: "user", content: "what time is standup" },
];

/** Every column of `table` in a row, the ones `row` leaves out null. */
function full(table: string, row: Record<string, unknown>, at: bigint): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name] of TABLES[table].columns) out[name] = row[name] ?? null;
  return { ...out, stored_ms: at, created_ms: at };
}

/** The plugin's database in `dir`: its tables created as local.py creates
 * them, and the rows above appended, each memory with its vector. */
async function writeDatabase(dir: string): Promise<void> {
  const db = connect(dir);
  for (const [name, { columns, fts }] of Object.entries(TABLES)) {
    const schema = new arrow.Schema(columns.map(([column, type]) => new arrow.Field(column, TYPES[type](), true)));
    db.createTable(name, schema, fts.reduce((spec, column) => spec.fts(column), new IndexSpec()));
  }
  const vectorField = new arrow.Field("embedding", new arrow.FixedSizeList(DIM, new arrow.Field("item", new arrow.Float32(), true)), false);
  db.createTable(VECTORS, new arrow.Schema([new arrow.Field("row_id", new arrow.Utf8(), true), vectorField]), new IndexSpec().vector("embedding", DIM, "cosine"));
  await remember(dir, MEMORIES, T0);
  db.openTable("conversations").append(MESSAGES.map((m, i) => full("conversations", m, T0 + BigInt(i))));
  db.openTable("traces").append([
    full("traces", { row_id: "t1", session_id: "s1", kind: "tool", name: "terminal", tool: "terminal", status: "ok", duration_ms: 12.5, result: "migration 0042 applied" }, T0),
  ]);
  db.openTable("skills").append([
    full("skills", { row_id: "k1", name: "db-migrate", description: "Run a database migration safely", content: "# Migrate\nBack up first." }, T0),
  ]);
}

/** Memories appended as the plugin appends them: the rows, then their
 * vectors, each through a connection of its own. */
async function remember(dir: string, rows: Array<Record<string, unknown>>, at: bigint): Promise<void> {
  connect(dir).openTable("memory").append(rows.map((r) => full("memory", { scope: "personal", origin: "remember", ...r }, at)));
  const vectors = await fakeEmbedder.embed(rows.map((r) => String(r.content)));
  connect(dir).openTable(VECTORS).append(rows.map((r, i) => ({ row_id: r.row_id, embedding: vectors[i] })));
}

type Hit = Record<string, unknown>;
const hitsOf = (value: unknown) => (value as { hits: Hit[] }).hits;

describe("fusing rankings by reciprocal rank", () => {
  it("scores a row by the sum of 1 / (RRF_K + rank) over the rankings that found it, ties in the order first met", () => {
    const a = { id: "a" };
    const b = { id: "b" };
    const c = { id: "c" };
    const fused = fuseByRank([[a, b, c], [c, a]], "id", 3);
    expect(fused.map((f) => f.id)).toEqual(["a", "c", "b"]);
    expect(fused[0].score).toBeCloseTo(1 / (RRF_K + 1) + 1 / (RRF_K + 2), 12);
    expect(fused[1].score).toBeCloseTo(1 / (RRF_K + 3) + 1 / (RRF_K + 1), 12);
    expect(fused[2].score).toBeCloseTo(1 / (RRF_K + 2), 12);
    // Two rows each found once at the same rank tie, and keep the order of
    // the rankings they came from.
    expect(fuseByRank([[a], [b]], "id", 2).map((f) => f.id)).toEqual(["a", "b"]);
  });
});

describe("the local database's query embedder", () => {
  it("is the model the plugin embeds memories with, at full precision, whatever this client's index is set to", () => {
    const embedder = createLocalDatabaseEmbedder();
    expect(embedder.model).toBe("Xenova/all-MiniLM-L6-v2");
    expect(embedder.dtype).toBe("fp32");
  });
});

describe("a connection that stands in for the code index", () => {
  it("refuses every use, so nothing can build or read a code index", () => {
    const db = noCodeIndex("/nowhere/.infino");
    expect(() => db.listTables()).toThrow(/not used while CX_LOCAL_DB names a local database/);
    expect(() => db.querySql("SELECT 1")).toThrow(/not used/);
  });
});

describe("the plugin's database on this machine, served with no account", () => {
  const home = mkdtempSync(join(tmpdir(), "cx-localdb-"));
  const dir = join(home, "db");
  const platform = scriptPlatform({});
  let s: Started;
  beforeAll(async () => {
    configureHosted(null);
    await writeDatabase(dir);
    process.env[LOCAL_DB_ENV] = dir;
    s = await start(platform, "cx-localdb-root-", { localEmbedder: fakeEmbedder });
  });
  afterAll(async () => {
    await stop(s);
    delete process.env[LOCAL_DB_ENV];
    rmSync(home, { recursive: true, force: true });
  });

  it("offers find, search, sql and read, and nothing of the platform's", async () => {
    const { tools } = await s.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["find", "read", "search", "sql"]);
  });

  it("names the plugin's tables, not the table that holds memory's vectors, and takes a table on find, search and read", async () => {
    const instructions = s.client.getInstructions() ?? "";
    // In the order the engine lists them, memory's vectors left out.
    const served = connect(dir)
      .listTables()
      .filter((t) => t !== VECTORS);
    expect([...served].sort()).toEqual(Object.keys(TABLES).sort());
    expect(instructions).toContain(`at ${dir}: the tables ${served.join(", ")}, one row per record`);
    expect(instructions).toContain("memory by exact terms over content and meaning over its vectors (memory_vectors)");
    expect(instructions).toContain("conversations by exact terms over content, tool_result");
    expect(instructions).toContain(`find, search and read each take the table they read, ${PRIMARY} when none is named`);
    expect(instructions).toContain("are the platform's and are not offered here");
    for (const absent of ["- ask -", "join_keys BEFORE", "describe_columns -", "on the platform"]) expect(instructions).not.toContain(absent);
    const { tools } = await s.client.listTools();
    for (const name of ["find", "search", "read"]) {
      const schema = tools.find((t) => t.name === name)?.inputSchema as { properties: Record<string, { enum?: string[] }> };
      expect(schema.properties.table?.enum, name).toEqual(served);
    }
    const sql = tools.find((t) => t.name === "sql")?.description ?? "";
    expect(sql).toContain("its vectors in memory_vectors(row_id, embedding)");
    expect(sql).toContain("vector_search('memory_vectors','embedding', {{q}}, 20) v JOIN memory t ON t.row_id = v.row_id");
    expect(sql).not.toContain("join_keys");
  });

  it("finds a memory by meaning alone, from a paraphrase that shares none of its words", async () => {
    const { ok, value, ops } = await call(s, "search", { query: "feline companion", table: "memory", k: 2 });
    expect(ok, String(value)).toBe(true);
    expect(ops).toEqual([]);
    expect(value).toMatchObject({ ranking: "hybrid", table: "memory", key: "row_id", index: "local" });
    const hits = hitsOf(value);
    expect(hits[0]).toMatchObject({ row_id: "m-cat", content: "Tom is the name of my cat", session_id: "s1" });
    // The vectors' first place alone: 1 / (RRF_K + 1).
    expect(hits[0].score).toBeCloseTo(1 / (RRF_K + 1), 12);
  });

  it("ranks a memory both rankings found first, its score the sum of its two places", async () => {
    const { ok, value } = await call(s, "search", { query: "coffee", table: "memory", k: 3 });
    expect(ok, String(value)).toBe(true);
    const hits = hitsOf(value);
    expect(hits[0].row_id).toBe("m-coffee");
    expect(hits[0].score).toBeCloseTo(2 / (RRF_K + 1), 12);
    expect(hits).toHaveLength(3);
  });

  it("searches the primary by keyword over each of its full-text columns when the call names no table", async () => {
    const { ok, value } = await call(s, "search", { query: "migration" });
    expect(ok, String(value)).toBe(true);
    expect(value).toMatchObject({ ranking: "keyword", table: PRIMARY });
    // One row matched in content, one in tool_result: both rankings fused.
    expect(hitsOf(value).map((h) => h.row_id).sort()).toEqual(["c1", "c3"]);
  });

  it("finds every row holding every word, with the table-wide count, in the table named", async () => {
    const found = await call(s, "find", { query: "database migration" });
    expect(found.ok, String(found.value)).toBe(true);
    expect(found.value).toMatchObject({ table: PRIMARY, column: "content", total: 1, index: "local" });
    expect((found.value as { matches: Hit[] }).matches.map((m) => m.row_id)).toEqual(["c1"]);
    const skill = await call(s, "find", { query: "migration", table: "skills" });
    expect(skill.ok, String(skill.value)).toBe(true);
    expect(skill.value).toMatchObject({ table: "skills", column: "description", total: 1 });
  });

  it("runs a statement over any table, and one ranking memory by meaning with {{q}} embedded here", async () => {
    const counted = await call(s, "sql", { query: `SELECT role, COUNT(*) AS n FROM ${PRIMARY} GROUP BY role ORDER BY n DESC, role` });
    expect(counted.ok, String(counted.value)).toBe(true);
    expect((counted.value as { rows: Hit[]; index: string }).index).toBe("local");
    expect((counted.value as { rows: Hit[] }).rows.map((r) => [r.role, Number(r.n)])).toEqual([["user", 2], ["assistant", 1], ["tool", 1]]);
    const meaning = await call(s, "sql", {
      query: "SELECT t.row_id, v.score FROM vector_search('memory_vectors','embedding', {{q}}, 3) v JOIN memory t ON t.row_id = v.row_id ORDER BY v.score",
      embed: { q: "a kitten" },
    });
    expect(meaning.ok, String(meaning.value)).toBe(true);
    expect((meaning.value as { rows: Hit[] }).rows[0].row_id).toBe("m-cat");
  });

  it("refuses a statement that writes", async () => {
    const { ok, value } = await call(s, "sql", { query: "DELETE FROM memory" });
    expect(ok).toBe(false);
    expect(String(value)).toMatch(/read-only/);
  });

  it("reads a whole session in the order its rows were written", async () => {
    const { ok, value } = await call(s, "read", { paths: ["s1"] });
    expect(ok, String(value)).toBe(true);
    const [file] = (value as { files: Array<{ path: string; lines: string; total: number }> }).files;
    expect(file.path).toBe("s1");
    expect(file.total).toBe(3);
    expect(file.lines).toContain("plan the database migration for the orders service");
    expect(file.lines.indexOf("plan the database migration")).toBeLessThan(file.lines.indexOf("I will read the schema first"));
  });

  it("sees what another process wrote after the server started, on the next call", async () => {
    const before = await call(s, "search", { query: "peanuts", table: "memory" });
    expect(hitsOf(before.value).map((h) => h.row_id)).not.toContain("m-peanuts");
    await remember(dir, [{ row_id: "m-peanuts", content: "Has a peanuts allergy", session_id: "s3" }], T0 + 10n);
    const after = await call(s, "search", { query: "peanuts", table: "memory" });
    expect(hitsOf(after.value)[0].row_id).toBe("m-peanuts");
    const counted = await call(s, "sql", { query: "SELECT COUNT(*) AS n FROM memory" });
    expect(Number((counted.value as { rows: Hit[] }).rows[0].n)).toBe(MEMORIES.length + 1);
  });

  it("refuses a table the database does not serve, and the table of memory's vectors as one", async () => {
    for (const table of ["nope", VECTORS]) {
      const refused = await s.client
        .callTool({ name: "search", arguments: { query: "cat", table } })
        .then((result) => (result as { isError?: boolean }).isError === true, () => true);
      expect(refused, table).toBe(true);
    }
  });

  it("reached no platform, built no code index, and left the database's tables as they were", () => {
    expect(platform.sent).toEqual([]);
    expect(existsSync(join(s.root, ".infino"))).toBe(false);
    expect(connect(dir).listTables().sort()).toEqual([...Object.keys(TABLES), VECTORS].sort());
    expect(readdirSync(home)).toEqual(["db"]);
  });

  // Last: it drops a table the tests above search.
  it("searches by keyword once a sign-in drops memory's vectors, with no restart", async () => {
    connect(dir).dropTable(VECTORS);
    const { ok, value } = await call(s, "search", { query: "coffee", table: "memory", k: 3 });
    expect(ok, String(value)).toBe(true);
    expect(value).toMatchObject({ ranking: "keyword", table: "memory" });
    expect(hitsOf(value)[0].row_id).toBe("m-coffee");
  });
});

describe("a local database that is not there", () => {
  const home = mkdtempSync(join(tmpdir(), "cx-localdb-missing-"));
  const dir = join(home, "db");
  let s: Started;
  beforeAll(async () => {
    configureHosted(null);
    process.env[LOCAL_DB_ENV] = dir;
    s = await start(scriptPlatform({}), "cx-localdb-missing-root-", { localEmbedder: fakeEmbedder });
  });
  afterAll(async () => {
    await stop(s);
    delete process.env[LOCAL_DB_ENV];
    rmSync(home, { recursive: true, force: true });
  });

  it("says so on every door, without creating the folder or building anything", async () => {
    expect(s.client.getInstructions()).toContain("could not be read when this server started");
    for (const [name, args] of [
      ["search", { query: "cat" }],
      ["find", { query: "cat" }],
      ["sql", { query: "SELECT 1" }],
    ] as const) {
      const { ok, value } = await call(s, name, args);
      expect(ok, name).toBe(false);
      expect(String(value), name).toContain(`no local database at ${dir}`);
    }
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(join(s.root, ".infino"))).toBe(false);
  });
});

describe("a table keyed by a number", () => {
  // The plugin keys its rows by text, but a table another writer made may
  // key them by a number. A row only the vectors found is read back by its
  // key, written as the number it is: `note_id IN (5)`, never `IN ('5')`.
  const home = mkdtempSync(join(tmpdir(), "cx-localdb-numkey-"));
  const dir = join(home, "db");
  const statements: string[] = [];
  /** A connection that records every statement it is asked to run. */
  const recording = (path: string) => {
    const db = connect(path);
    const querySql = db.querySql.bind(db) as (sql: string) => Array<Record<string, unknown>>;
    return Object.assign(db, { querySql: (sql: string) => (statements.push(sql), querySql(sql)) }) as typeof db;
  };
  beforeAll(async () => {
    const db = connect(dir);
    db.createTable("notes", { note_id: "int64", content: "large_utf8" }, new IndexSpec().fts("content"));
    db.createTable("notes_vectors", { note_id: "int64", embedding: { vector: DIM } }, new IndexSpec().vector("embedding", DIM, "cosine"));
    const notes = [
      { note_id: 5n, content: "Tom is the name of my cat" },
      { note_id: 7n, content: "The deploy pipeline runs every friday" },
    ];
    db.openTable("notes").append(notes);
    const vectors = await fakeEmbedder.embed(notes.map((n) => n.content));
    db.openTable("notes_vectors").append(notes.map((n, i) => ({ note_id: n.note_id, embedding: vectors[i] })));
  });
  afterAll(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("writes a number key bare and a text key quoted", () => {
    expect(keyLiteral("5", "i64")).toBe("5");
    expect(keyLiteral("-2.5", "f64")).toBe("-2.5");
    expect(keyLiteral("5", "utf8")).toBe("'5'");
    expect(keyLiteral("o'brien", "large_utf8")).toBe("'o''brien'");
    expect(keyLiteral("5", undefined)).toBe("'5'");
  });

  it("reads back a row the vectors alone found by its number key, the key a number", async () => {
    const local = new LocalDatabase(dir, () => fakeEmbedder, recording);
    const [notes] = local.describe();
    expect(notes.shape.keyColumn).toBe("note_id");
    expect(notes.vectors).toMatchObject({ table: "notes_vectors", key: "note_id" });
    const result = await local.search(notes.shape, "feline companion", 1);
    expect(result.ranking).toBe("hybrid");
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]).toMatchObject({ note_id: 5n, content: "Tom is the name of my cat" });
    expect(statements.some((sql) => sql.includes(`"note_id" IN (5)`)), statements.join("\n")).toBe(true);
  });
});

describe("a local database with --db as well", () => {
  const home = mkdtempSync(join(tmpdir(), "cx-localdb-hosted-"));
  afterAll(() => {
    configureHosted(null);
    delete process.env[LOCAL_DB_ENV];
    rmSync(home, { recursive: true, force: true });
  });

  it("stops the server at startup, before it asks the platform anything", async () => {
    configureHosted(hostedSettingsFromFlags({ db: "http://127.0.0.1:9/cxbench" }, { [API_KEY_ENV]: "inf_test_key_do_not_log" }));
    process.env[LOCAL_DB_ENV] = join(home, "db");
    const platform = scriptPlatform({});
    await expect(start(platform, "cx-localdb-hosted-root-", { localEmbedder: fakeEmbedder })).rejects.toThrow(
      `${LOCAL_DB_ENV} serves a database on this machine with no account; it does not combine with --db`,
    );
    expect(platform.sent).toEqual([]);
    expect(existsSync(join(home, "db"))).toBe(false);
  });
});

describe("a local database on a machine with a stored login (cx login)", () => {
  // A login stored on this machine is not named on the command line, as
  // --db is: the local database is what was asked for, so the stored
  // account is set aside and the server serves the folder, asking the
  // platform nothing.
  const home = mkdtempSync(join(tmpdir(), "cx-localdb-login-"));
  const dir = join(home, "db");
  let s: Started;
  const platform = scriptPlatform({});
  beforeAll(async () => {
    configureHosted(
      hostedSettingsFromFlags({}, { [API_KEY_ENV]: "inf_test_key_do_not_log" }, () => "inf_test_key_do_not_log", {
        accountRoot: home,
        storedAccount: () => ({ baseUrl: "http://127.0.0.1:9", uploadConsentAt: "2026-11-01T00:00:00Z" }) as never,
      }),
    );
    await writeDatabase(dir);
    process.env[LOCAL_DB_ENV] = dir;
    s = await start(platform, "cx-localdb-login-root-", { localEmbedder: fakeEmbedder });
  });
  afterAll(async () => {
    await stop(s);
    configureHosted(null);
    delete process.env[LOCAL_DB_ENV];
    rmSync(home, { recursive: true, force: true });
  });

  it("serves the local database and never asks the platform", async () => {
    const counted = await call(s, "sql", { query: `SELECT COUNT(*) AS n FROM ${PRIMARY}` });
    expect(counted.ok, String(counted.value)).toBe(true);
    expect(counted.value).toMatchObject({ index: "local" });
    expect(platform.sent).toEqual([]);
  });
});
