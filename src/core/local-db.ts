// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// A local database (CX_LOCAL_DB): an Infino database in a folder on this
// machine, opened with the engine's own binding, whose tables the MCP
// server's rows doors run over with no account and no platform behind them.
// Another process writes the folder - the hermes-infino plugin keeps its
// memory, conversations, traces and skills there - so nothing here writes
// it: every call is a read, and the code-index build, which drops and
// recreates the tables it names, never runs against it (`noCodeIndex`).
//
// What the rows doors ask of the platform's copy of a table, this answers
// from the folder: each table's shape (`tableShapeFrom` over the engine's
// schema document, with a lean card made from the index each column
// declares), `querySql` for find, read and a statement, and a search. The
// search is its own: the platform fuses keyword and meaning within one
// table, where here a table's vectors can sit in a table of their own beside
// it - the plugin keeps each memory's vector in `memory_vectors`, since
// signing in drops it and the engine drops a table, never the column behind a
// vector index - so a search fuses the rankings of the two tables by
// reciprocal rank, by the row's key, exactly as the plugin's own recall does
// (hermes_infino/local.py, `search_memory`).
//
// Every call opens its own connection. An open connection keeps the snapshot
// it opened with and never sees a commit another process made after it -
// measured on the engine's 0.11 line: not even a table reopened on it does -
// and the writer here is another process, appending while the server runs.
// Opening one on a local folder is cheap. The binding has no close: a
// connection goes when the garbage collector takes it, and nothing here
// holds one past its call. Measured on 0.11.15 over 8000 calls: open files
// stay flat (no handle outlives its connection), but about 95 KB of the
// engine's memory per connection that opened a table stays after the
// connection is collected - the engine's to free, since reusing one would
// read a stale snapshot.

import { existsSync } from "node:fs";
import { connect, type Connection, type SchemaField as EngineField } from "@infino-ai/infino";
import type { Embedder } from "./embedder.js";
import type { CheckedRows, RowRecord } from "./hosted.js";
import { applyEmbeds, guardSql, type RowSearchResult } from "./searcher.js";
import { rowHit, SCORE_COLUMN, sqlIdentifier, sqlLiteral, tableShapeFrom, type SchemaField, type TableShape } from "./table-shape.js";

/** The name a table of a base table's vectors carries: the base's name and
 * this, as the plugin names `memory_vectors` for `memory`. */
export const VECTORS_SUFFIX = "_vectors";

/** The column a row of a conversation, a trace or a memory names its session
 * by in the plugin's tables: a table holding it reads back whole by it (the
 * `read` door), a session as a document of rows. */
export const SESSION_COLUMN = "session_id";

/** Reciprocal-rank fusion's damping constant - the plugin's `RRF_K`, the
 * usual 60: a row's fused score is the sum of 1 / (RRF_K + rank) over the
 * rankings that found it, its rank counted from 1. */
export const RRF_K = 60;

/** How many more rows each ranking of a fused search fetches than the search
 * returns - the plugin's `FUSION_DEPTH`: a row placed low in both rankings
 * can still fuse above one placed high in one. */
export const FUSION_DEPTH = 3;

/** The engine's boolean mode for a keyword search's terms: a row need not
 * carry every term, as the platform's searches and the plugin's recall run. */
const BM25_MODE = "or";

/** The index kinds of the engine's schema document, and the roles a card
 * gives a column for each (table-shape.ts reads the roles). */
const FTS_KIND = "fts";
const VECTOR_KIND = "vector";
const SCALAR_ROLE = "scalar";

/** The engine's numeric column types, in its schema document's words: a key
 * of one is written bare in a statement, as the number it is. */
const NUMERIC_TYPE = /^(?:[iu](?:8|16|32|64)|f(?:16|32|64))$/;

/** A number as a key's text holds it (`String` of the cell). */
const NUMBER_TEXT = /^-?\d+(?:\.\d+)?(?:e[-+]?\d+)?$/i;

/** A row's key, as `fuseByRank` holds it, as a literal of a statement that
 * reads the row back: bare when its column is a number, a quoted string
 * otherwise - a number written as a string reaches the engine as text, and
 * what it makes of text compared with a number column is its own rule, not
 * this client's (`type` is the column's type, as `TableShape.columns` has it). */
export function keyLiteral(id: string, type: string | undefined): string {
  return type !== undefined && NUMERIC_TYPE.test(type) && NUMBER_TEXT.test(id) ? id : sqlLiteral(id);
}

/** A base table's vectors in a table of their own: the table, its vector
 * column and width, and the base's key both carry, which fuses a row of one
 * ranking with the other's. */
export interface LocalVectors {
  table: string;
  column: string;
  dim: number;
  key: string;
}

/** A table of the local database as the doors serve it: its shape, and its
 * vectors when a table beside it holds them. */
export interface LocalTable {
  shape: TableShape;
  vectors: LocalVectors | null;
}

/** A connection that refuses every use: what the MCP server's code-index
 * context holds in local-database mode, so no path that builds, syncs or
 * reads a code index can run - the build drops and recreates the tables it
 * names, and in this mode nothing should be built at all. Opening a real one
 * would also create the index's folder in the working directory (the engine
 * creates a missing catalog root on connect). */
export function noCodeIndex(dir: string): Connection {
  const refuse = (): never => {
    throw new Error(`the code index at ${dir} is not used while CX_LOCAL_DB names a local database: find, search, sql and read run over that database`);
  };
  return new Proxy({} as Connection, {
    // Only names are refused: a symbol is a runtime's own probe (a
    // conversion, an inspection), and `then` is how an await asks whether a
    // value is a promise - neither is a use of the index.
    get: (_target, name) => (typeof name === "symbol" || name === "then" ? undefined : refuse),
  });
}

/** One field of the engine's schema document as the shape reads a field. */
function shapeField(field: EngineField): SchemaField {
  return { name: field.name, type: field.type, nullable: field.nullable, ...(field.dim !== undefined ? { dim: field.dim } : {}) };
}

/** A lean card made from the schema document: each column's role as the
 * index it declares gives it. The shape reads a card's roles as the truth
 * about which columns are searchable; without one it would take every
 * LargeUtf8 column for an indexed one, and the plugin's tables carry
 * LargeUtf8 columns no index covers (`tool_args`, `error`, `args`). */
function leanCard(table: string, fields: EngineField[]): RowRecord {
  return {
    table,
    schema: fields.map((f) => ({
      name: f.name,
      type: f.type,
      index: f.index?.kind === FTS_KIND ? FTS_KIND : f.index?.kind === VECTOR_KIND ? VECTOR_KIND : SCALAR_ROLE,
    })),
  };
}

/** The rankings of one search fused by reciprocal rank, by each row's `key`:
 * the `k` best, best first, each with its fused score. Ties keep the order
 * the rows were first met in, rankings in the order given - the plugin's
 * order, whose sort is stable over a dict filled the same way. */
export function fuseByRank(rankings: ReadonlyArray<readonly RowRecord[]>, key: string, k: number): Array<{ id: string; score: number }> {
  const fused = new Map<string, number>();
  for (const ranking of rankings) {
    ranking.forEach((row, rank) => {
      const id = String(row[key]);
      fused.set(id, (fused.get(id) ?? 0) + 1 / (RRF_K + rank + 1));
    });
  }
  return [...fused.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
    .map(([id, score]) => ({ id, score }));
}

export class LocalDatabase {
  /** The folder, as resolved from CX_LOCAL_DB. */
  readonly path: string;
  private readonly embedder: () => Embedder | null;
  private readonly open: (path: string) => Connection;
  /** Each base table's vectors, as `describe` found them. */
  private readonly vectorsOf = new Map<string, LocalVectors>();

  /** `embedder` is asked for the query embedder when a search or a statement
   * first needs one: the model loads on first use, not at startup. */
  constructor(path: string, embedder: () => Embedder | null, open: (path: string) => Connection = connect) {
    this.path = path;
    this.embedder = embedder;
    this.open = open;
  }

  /** A fresh connection to the folder (see the note at the top). A folder
   * that is not there is refused rather than opened: the engine would create
   * it, and an empty database where the plugin's should be would answer
   * every question with nothing. */
  private connection(): Connection {
    if (!existsSync(this.path)) throw new Error(`no local database at ${this.path} (CX_LOCAL_DB): the folder does not exist`);
    return this.open(this.path);
  }

  /** The tables the doors serve, each with its shape and its vectors, read
   * once - the server decides its tool text from them at startup, as it does
   * a hosted table's. A table of a base table's vectors is not one of them:
   * it is the base's index, held apart, and the base's search reads it. */
  describe(): LocalTable[] {
    const db = this.connection();
    const names = db.listTables();
    const fields = new Map(names.map((name) => [name, db.schema(name).fields]));
    const shapes = new Map(
      names.map((name) => {
        const own = fields.get(name)!;
        // No vector column of a table's own is searched by meaning: nothing
        // here knows the model that filled it. A table's vectors are its
        // companion's, embedded the plugin's way (`vectorsBeside`).
        const shape = tableShapeFrom(name, own.map(shapeField), leanCard(name, own), null, { vector: null });
        return [name, withSessions(shape)] as const;
      }),
    );
    const companions = new Set<string>();
    this.vectorsOf.clear();
    for (const [name, shape] of shapes) {
      const vectors = vectorsBeside(shape, `${name}${VECTORS_SUFFIX}`, fields.get(`${name}${VECTORS_SUFFIX}`));
      if (!vectors) continue;
      this.vectorsOf.set(name, vectors);
      companions.add(vectors.table);
    }
    return names.filter((name) => !companions.has(name)).map((name) => ({ shape: shapes.get(name)!, vectors: this.vectorsOf.get(name) ?? null }));
  }

  /** A statement's rows, on a fresh connection. */
  async querySql(sql: string): Promise<RowRecord[]> {
    return this.connection().querySql(sql);
  }

  /** No grader runs here: a find over a local table asks for no rerank and
   * fetches only its limit (searcher.ts, `findRows`). */
  readonly reranksOnRead = false;

  /** A statement's rows, as a platform read with checks answers them: the
   * checks (a verdict, a rerank) are the platform's, and nothing here runs
   * them, so the rows come back as the statement gave them. */
  async querySqlChecked(sql: string, _checks: unknown): Promise<CheckedRows> {
    return { rows: await this.querySql(sql) };
  }

  /** A `sql` tool statement: read-only (`guardSql`), its `{{name}}`
   * placeholders embedded on this machine with the query embedder, then run
   * on a fresh connection. */
  async runSql(sql: string, embeds: Record<string, string> | undefined): Promise<RowRecord[]> {
    const statement = await applyEmbeds(guardSql(sql), embeds, this.embedder());
    return this.querySql(statement);
  }

  /** The `k` rows of `shape`'s table best matching `query`: a keyword
   * ranking over each of its full-text columns, and a ranking by meaning
   * over its vectors when a table beside it holds them, each `k` *
   * FUSION_DEPTH deep, fused by reciprocal rank on the row's key; a row only
   * the vectors found is read from the table by its key. One ranking alone -
   * one full-text column, no vectors - is the search, with the engine's own
   * scores, as the plugin's keyword-only recall returns it. */
  async search(shape: TableShape, query: string, k: number): Promise<RowSearchResult> {
    const db = this.connection();
    // The vectors read at startup, while their table is still there: signing
    // in drops it (the cloud embeds from then on), and the server that read
    // it may keep running, so each search looks again and the table's own
    // keyword ranking is the search once they are gone.
    const recorded = this.vectorsOf.get(shape.table) ?? null;
    const vectors = recorded && db.listTables().includes(recorded.table) ? recorded : null;
    if (shape.textColumns.length === 0 && !vectors) throw new Error(`${shape.table} has no full-text column and no vectors to search`);
    const key = shape.keyColumn;
    const depth = k * FUSION_DEPTH;
    // The shape's projection carries the key: every column of the row is in
    // it, and the engine's `_id` when that is the key (table-shape.ts).
    const table = db.openTable(shape.table);
    const keyword = shape.textColumns.map((column) => table.bm25Search(column, query, depth, { projection: shape.projection, mode: BM25_MODE }));
    const result = (hits: RowRecord[]): RowSearchResult => ({
      query,
      ranking: vectors ? "hybrid" : "keyword",
      table: shape.table,
      key,
      hits: hits.map((row) => rowHit(row, shape)),
    });
    if (!vectors && keyword.length === 1) return result(keyword[0].slice(0, k));
    const rankings: RowRecord[][] = [...keyword];
    if (vectors) {
      const [vector] = await this.queryVector(query, vectors);
      rankings.push(db.openTable(vectors.table).vectorSearch(vectors.column, vector, depth, { projection: [vectors.key] }));
    }
    const best = fuseByRank(rankings, key, k);
    // Each row as a keyword ranking returned it, its own cells; the rest - the
    // rows only the vectors found - read by key in one statement.
    const rows = new Map<string, RowRecord>();
    for (const row of keyword.flat()) if (!rows.has(String(row[key]))) rows.set(String(row[key]), row);
    const missing = best.filter(({ id }) => !rows.has(id)).map(({ id }) => id);
    if (missing.length > 0) {
      const keyType = shape.columns.find((c) => c.name === key)?.type;
      const read = db.querySql(
        `SELECT ${shape.rowColumns.map(sqlIdentifier).join(", ")} FROM ${sqlIdentifier(shape.table)} ` +
          `WHERE ${sqlIdentifier(key)} IN (${missing.map((id) => keyLiteral(id, keyType)).join(", ")})`,
      );
      for (const row of read) rows.set(String(row[key]), row);
    }
    // A row whose vector outlived it (deleted from the table, its vector
    // not yet) is not returned, as the plugin's recall does not return it.
    return result(best.filter(({ id }) => rows.has(id)).map(({ id, score }) => ({ ...rows.get(id)!, [SCORE_COLUMN]: score })));
  }

  /** The query embedded for `vectors`, refused when the embedder's width is
   * not the column's: a vector of another model's width ranks nothing, and
   * one of the same width from another model ranks wrongly in silence. */
  private async queryVector(query: string, vectors: LocalVectors): Promise<number[][]> {
    const embedder = this.embedder();
    if (!embedder) throw new Error(`${vectors.table} holds vectors and no query embedder is configured to search them`);
    const embedded = await embedder.embed([query]);
    if (embedded[0]?.length !== vectors.dim) {
      throw new Error(
        `the query embedder (${embedder.model}) gives ${embedded[0]?.length ?? 0} values where ${vectors.table}.${vectors.column} holds ${vectors.dim}`,
      );
    }
    return embedded;
  }
}

/** `shape` with its sessions as its documents, when it has no document of
 * its own and holds a session column and a text column: the `read` door
 * then reads a whole session - every row sharing a session_id, in the order
 * the rows were written (the order of their engine ids, which is append
 * order) - as it reads a document of a hosted table. */
function withSessions(shape: TableShape): TableShape {
  if (shape.document || shape.primaryText === "" || !shape.columns.some((c) => c.name === SESSION_COLUMN)) return shape;
  return { ...shape, document: { pathColumn: SESSION_COLUMN, textColumn: shape.primaryText, orderColumn: null } };
}

/** The vectors of `base` in the table named `name`, when that table exists
 * and holds the base's key and one vector column with a vector index; null
 * otherwise. The vectors are taken for the plugin's - all-MiniLM-L6-v2 at
 * full precision (embedder.ts, LOCAL_DATABASE_MODEL) - and a query whose
 * width differs is refused when it is searched (`queryVector`). */
function vectorsBeside(base: TableShape, name: string, fields: EngineField[] | undefined): LocalVectors | null {
  if (!fields) return null;
  const vector = fields.filter((f) => f.index?.kind === VECTOR_KIND && typeof f.dim === "number");
  if (vector.length !== 1 || !fields.some((f) => f.name === base.keyColumn)) return null;
  return { table: name, column: vector[0].name, dim: vector[0].dim!, key: base.keyColumn };
}
