// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The shape of the hosted table the three doors read when `search` reads the
// hosted index (CX_REMOTE_SEARCH): which columns it has, which of them carry
// a text index, which one the platform embeds, and which one names a row.
//
// The doors were written for one table - the chunks table this client
// builds, whose columns are constants (path, start_line, end_line, content,
// embedding). Pointed at a table something else loaded (CX_TABLE naming a
// hydrated corpus), those constants are wrong: a hybrid search asking for
// `embedding` on a table whose vector column is `emb` is a 400, and a find
// over `content` has no such column to match in. So the shape comes from the
// table itself: its schema (POST /v1/schema, the platform's JSON column
// descriptors) and, once the optimizer has written one, its card, whose
// per-column index role says which columns are searchable rather than
// leaving that to be inferred from the types. A chunks-shaped table keeps
// every constant and every code path the doors had, byte for byte; what is
// here is for the other kind.

import { HostedError, type HostedDb, type RowRecord } from "./hosted.js";
import { CONTENT_COLUMN } from "./context.js";
import { LEAN_CARD_TIER } from "./config.js";

/** The status the card route answers when no card is stored for the table
 * at the tier asked for - the one failure `fetchCard` reads as "try the
 * lean card". */
const HTTP_NOT_FOUND = 404;

/** One column as `POST /v1/schema` describes it: a scalar type spelling
 * (`utf8`, `large_utf8`, `f64`, ...) or `vector` / `list` / `embedding` with
 * the field that qualifies it. The platform reports every float vector
 * column as `vector` with its width, the one it embeds itself included; the
 * build before the seam reported that one as `embedding` with its source. */
export interface SchemaField {
  name: string;
  type: string;
  nullable?: boolean;
  /** `type: "list"`: the element type. */
  item?: string;
  /** `type: "vector"`: the width. */
  dim?: number;
  /** `type: "embedding"`: the text columns the platform embeds, in order. */
  source?: string[];
}

/** One column of a table card's `schema`, the part the shape reads: the
 * index role the optimizer assigned it. */
export interface CardColumn {
  name: string;
  index?: string;
}

/** How the load cut a table's rows, when the hydrate job that loaded it cut
 * one long text column into passages: every source record became one row
 * per passage, the other columns copied onto each, the record's long
 * per-document columns kept on its first passage alone. A caller that reads
 * such a table as one row per record measures a first passage and calls it
 * the record (2026-09-30: "which kinds of article run longest" answered from
 * the first 512 tokens of every article). */
export interface TableChunking {
  /** The text column cut into passages; on a row it holds that passage. */
  column: string;
  /** The column numbering a record's passages from 0. */
  indexColumn: string;
  /** The most tokens a passage holds, when the load said; null otherwise. */
  maxTokens: number | null;
}

/** The column a hydrate load numbers a record's passages with when its
 * request names none (the pipeline's `DEFAULT_CHUNK_INDEX_COLUMN`). */
const DEFAULT_CHUNK_INDEX_COLUMN = "chunk";

/** The chunking a hydrate job's record says it loaded `fields` with, or null
 * when it cut nothing - or when the table lacks the chunked or the numbering
 * column, which is a record of some other load under the name, or a
 * numbering column the load had to rename, and says nothing sure about this
 * table. */
export function chunkingFrom(record: RowRecord | null | undefined, fields: SchemaField[]): TableChunking | null {
  const request = record?.request as RowRecord | undefined;
  const chunk = request?.chunk as RowRecord | undefined;
  if (!chunk || typeof chunk.column !== "string" || !chunk.column) return null;
  const indexColumn = typeof chunk.index_column === "string" && chunk.index_column ? chunk.index_column : DEFAULT_CHUNK_INDEX_COLUMN;
  const names = new Set(fields.map((f) => f.name));
  if (!names.has(chunk.column) || !names.has(indexColumn)) return null;
  const maxTokens = typeof chunk.max_tokens === "number" && Number.isFinite(chunk.max_tokens) ? chunk.max_tokens : null;
  return { column: chunk.column, indexColumn, maxTokens };
}

/** The one sentence a table cut into passages carries: what a row is, and
 * how a whole record is read from its rows. Measured 2026-09-30 on the
 * Wikipedia table: told nothing, the caller took a first passage for the
 * article, answered "which kinds of article run longest" from the first 512
 * tokens of each, and spent four of its eleven calls sampling columns to learn
 * what a row was. Both loops read it - the caller in the `sql` text, the
 * platform's retrieval loop in the context of every ask (the owner,
 * 2026-09-30: a prompt change goes to the inner loop and the outer one alike).
 * Empty for a table loaded one row per record. */
export function chunkingNote(chunking: TableChunking | undefined): string {
  if (!chunking) return "";
  const { column, indexColumn, maxTokens } = chunking;
  const size = maxTokens === null ? "" : ` of up to ${maxTokens} tokens`;
  return (
    `Each row is one passage of a record, not the record: the load cut every record's ${column} into passages${size}, ` +
    `one row each, numbered by ${indexColumn} from 0, so ${column} on a row is that passage alone - a record's whole ` +
    `${column} is all of its rows (SUM(LENGTH(${column})) grouped by a column every passage of the record shares, ` +
    `such as its name or id), a record is counted once with ${indexColumn} = 0, and the record's other long text and ` +
    `nested columns are filled on its ${indexColumn} = 0 row alone. `
  );
}

/** What the record of the hydrate job that loaded a table says the job
 * embedded: the vector column, and the text columns it embeds, in order. */
export interface LoadEmbedding {
  column: string;
  source: string[];
}

/** The embedding a hydrate job's record says it filled `fields` with, from
 * the names and roles the job settled on (`schema.embed`), or null when it
 * embedded nothing - or when the table lacks the column or a source the
 * record names, which is a record of some other load under the name and
 * says nothing sure about this table. */
export function loadEmbeddingFrom(record: RowRecord | null | undefined, fields: SchemaField[]): LoadEmbedding | null {
  const settled = record?.schema as RowRecord | undefined;
  const embed = settled?.embed as RowRecord | undefined;
  if (!embed || typeof embed.column !== "string" || !embed.column) return null;
  const source = Array.isArray(embed.source) ? embed.source.filter((name): name is string => typeof name === "string") : [];
  const names = new Set(fields.map((f) => f.name));
  if (!names.has(embed.column) || !source.every((name) => names.has(name))) return null;
  return { column: embed.column, source };
}

/** One column of the table as the tool text names it. */
export interface TableColumn {
  name: string;
  /** The type as shown to the model: the platform's spelling for a scalar,
   * `list<item>` for a list, `vector<dim>` for a vector column - whoever
   * fills it, as the platform reports it - and `embedding` for the column
   * the build before the seam reported the platform fills. */
  type: string;
}

export interface TableShape {
  table: string;
  /** Every column in schema order, the embedding column included. */
  columns: TableColumn[];
  /** The column the platform embeds and can embed a query for, or null when
   * the table has none: the candidate `vectorCandidate` reads off the
   * descriptors - a column the schema types `embedding`, or a `vector`
   * column the record of the hydrate job that loaded the table says the job
   * embedded - and, in a shape `resolveTableShape` built, one the platform
   * then embedded a query for (`platformEmbedsQueriesFor`), the check of the
   * column's model. Never the card's role alone or the `vector` type alone:
   * both mark a client-filled vector column too, and a query can only be
   * sent as text against a column the platform embeds itself, with the
   * model that filled it. */
  vectorColumn: string | null;
  /** What the embedding column embeds - the schema's `source`, or the load
   * record's - empty without one. */
  vectorSource: string[];
  /** The columns carrying a full-text index: the card's `fts` roles when a
   * card names any, else the LargeUtf8 columns - hydrate casts exactly the
   * indexed and embedded text columns to LargeUtf8 and leaves the rest Utf8,
   * so for a table with no card yet the type is the role. */
  textColumns: string[];
  /** True when no card named a full-text role and the LargeUtf8 types stood
   * in for one. An inferred list can name a column the platform embeds but
   * does not index (hydrate casts both kinds to LargeUtf8), so the tool text
   * says the list is inferred rather than stating it as the table's. */
  textColumnsInferred: boolean;
  /** The text column the doors search by default - one of `textColumns`
   * whenever there is one, since a search or token match over a column with
   * no full-text index is refused by the engine: the one the deployment
   * named (`ShapeOptions.textColumn`) when it is among them, else one picked
   * by its name; "" when the table has no full-text column, and then no
   * search or find is offered over it. */
  primaryText: string;
  /** The columns a filter or GROUP BY reads as on any table: neither text,
   * nor list, nor vector. The tool text writes its examples with these. */
  scalarColumns: string[];
  /** The list columns - several values per row, filtered with array
   * functions rather than equality; the tool text says so when there are any. */
  listColumns: string[];
  /** The column that names a row: the card's `key` role, else the first
   * `id` / `*_id` column, else the engine's own `_id`. A lookup's key - the
   * whole of a row is one sql away by it - and never what an answer cites:
   * see `linkColumn`. */
  keyColumn: string;
  /** The text column holding each row's link (`url`, `link`, `href`, `uri`,
   * or a name ending in one after an underscore, `apply_url`), or null when
   * the table has none. What a row is cited by, as a markdown link, by the
   * owner's rule (2026-10-01: "either have those ids be links or not show
   * them on non-code corpora"): on the Wikipedia table, keyed by the
   * engine's `_id`, the answer cited rows by 32-digit ids that meant nothing
   * to a reader. Read off the name because nothing else marks it: a card's
   * roles are fts, scalar and vector (ask/src/card/build.rs), none a link. */
  linkColumn: string | null;
  /** The text column naming what a row is (`name`, `title`, or a name ending
   * in one after an underscore), the text of a row's link; null when no
   * column is named so. */
  titleColumn: string | null;
  /** Whether the table is the chunks table this client builds - path,
   * start_line, end_line and content. Such a table takes the constants and
   * code paths the doors always had. */
  isChunks: boolean;
  /** The row as a hit carries it: every column but the vector ones, with
   * `_id` first when nothing in the table keys a row. What a find selects -
   * a token match has no rank, so no `score` is asked for beyond a column
   * of the table's own that happens to bear the name. */
  rowColumns: string[];
  /** What a search asks the platform for: `rowColumns` and `score`, which
   * the platform returns only when it is named - once, whether or not the
   * table has a column called that. */
  projection: string[];
  /** The lean card as the platform served it, when the table has one - read
   * here for its roles and kept so the tool text can fold it in without a
   * second fetch. Absent for a table the optimizer has not swept yet. */
  card?: RowRecord;
  /** How the load cut the table's rows into passages, from the hydrate job
   * that loaded it (`chunkingFrom`). Absent for a table loaded one row per
   * record, or whose load left no record. */
  chunking?: TableChunking;
}

/** The platform's type spellings for the three non-scalar column kinds. */
const EMBEDDING_TYPE = "embedding";
const VECTOR_TYPE = "vector";
const LIST_TYPE = "list";

/** The wire types of a vector column in the platform's described schema:
 * `vector`, what the platform reports for every float vector column, the
 * one it embeds itself included; `embedding`, what the build before the seam
 * reported for that one. The demo's rule (`isVectorField` in
 * demo/platform-health.mjs), matched here exactly rather than imported: the
 * client is its own npm package, built from client/src alone (tsconfig
 * rootDir, package.json `files`), so it cannot import a file of the demo's;
 * and the demo runs from source with no build step and reaches the client
 * only as a spawned process (client/dist/cli.js), so it imports none of the
 * client's modules either. */
const VECTOR_TYPES = new Set([VECTOR_TYPE, EMBEDDING_TYPE]);

/** Whether a described field is a vector column, by the demo's rule. That
 * alone does not make it searchable by meaning: see `vectorCandidate` and
 * `platformEmbedsQueriesFor`. */
export function isVectorField(field: SchemaField | null | undefined): field is SchemaField {
  return field != null && VECTOR_TYPES.has(field.type) && typeof field.name === "string";
}

/** The text spellings hydrate gives the columns it indexes and embeds. */
const LARGE_TEXT_TYPES = new Set(["large_utf8", "large_string"]);

/** Every text spelling: the types a link or a title can be held in. */
const TEXT_TYPES = new Set(["utf8", "string", ...LARGE_TEXT_TYPES]);

/** The card's index roles this shape reads (the platform's vocabulary). */
const ROLE_FTS = "fts";
const ROLE_KEY = "key";
const ROLE_VECTOR = "vector";

/** The engine's own row id, present on every table and returned by every
 * search function; the key of last resort. */
export const ENGINE_ID_COLUMN = "_id";

/** The column a search hit's rank travels in; returned only when asked for. */
export const SCORE_COLUMN = "score";

/** The columns that make a table the chunks table this client builds. */
const CHUNK_COLUMNS = ["path", "start_line", "end_line", CONTENT_COLUMN];

/** A text column whose name says it holds the text: preferred as the column
 * the doors search when a table has several. */
const TEXT_NAME_HINT = /content|body|description|text|abstract|summary/i;

/** A column whose name says it identifies the row. */
const KEY_NAME = /^(id|_id|.+_id)$/i;

/** The words a column holding a row's link is named by, alone or after an
 * underscore (`url`, `apply_url`). */
const LINK_WORDS = ["url", "link", "href", "uri"];
/** The words a column naming what a row is goes by, alone or after an
 * underscore (`title`, `display_name`). */
const TITLE_WORDS = ["name", "title"];

/** The first text column named by one of `words`: a name that is the word
 * itself before one that ends in `_word`, so a table with `url` and
 * `image_url` links a row by its `url`. Null when no text column is. */
function textColumnNamed(fields: SchemaField[], words: string[]): string | null {
  const text = fields.filter((f) => TEXT_TYPES.has(f.type));
  const bare = text.find((f) => words.includes(f.name.toLowerCase()));
  const suffixed = text.find((f) => words.some((word) => f.name.toLowerCase().endsWith(`_${word}`)));
  return (bare ?? suffixed)?.name ?? null;
}

/** One column's type as the tool text shows it. */
function renderType(field: SchemaField): string {
  if (field.type === LIST_TYPE) return `list<${field.item ?? "?"}>`;
  if (field.type === VECTOR_TYPE) return `vector<${field.dim ?? "?"}>`;
  return field.type;
}

/** The column a query can be sent against as text, and what it embeds. */
export interface QueryableVector {
  name: string;
  source: string[];
}

/** The card's columns that carry a name, the index role it gives each, and
 * whether it names any column at all - a card that does is the truth about
 * the table's roles. */
function cardRoles(card: RowRecord | null | undefined): {
  cardColumns: CardColumn[];
  roles: Map<string, string | undefined>;
  hasCard: boolean;
} {
  const cardColumns = Array.isArray(card?.schema) ? (card.schema as CardColumn[]).filter((c) => typeof c?.name === "string") : [];
  return { cardColumns, roles: new Map(cardColumns.map((c) => [c.name, c.index])), hasCard: cardColumns.length > 0 };
}

/** The vector column a search by meaning could run over, before the
 * platform is asked whether it embeds a query for it
 * (`platformEmbedsQueriesFor`), or null. The inner loop offers a vector
 * column only where the column's embedding spec names the model the worker
 * embeds queries with (ask/src/worker/ask.rs `embeddable_vectors`); any
 * other vector column - filled by a caller, or under another model - is not
 * offered, since a query embedded by this deployment would rank against it
 * meaninglessly.
 *
 * Nothing the client reads names the model. /v1/schema gives a vector
 * column its width alone, the card its role, and the load's record its
 * column and source; the model rides in the column's Arrow field metadata,
 * which /v1/schema does not carry. So the candidate is a column on the
 * platform's own word that it filled it - the schema's `embedding` type (the
 * build before the seam said so in the type), or a `vector` column the
 * record of the hydrate job that loaded the table says the job embedded,
 * with a width, and with the card's `vector` role where there is a card -
 * and whether the model that filled it is the one the platform embeds
 * queries with is the platform's to say. Any other vector column is no
 * candidate, and `onNote` hears why. */
export function vectorCandidate(
  fields: SchemaField[],
  card: RowRecord | null | undefined,
  load: RowRecord | null | undefined,
  onNote: (line: string) => void = () => {},
): QueryableVector | null {
  const { roles, hasCard } = cardRoles(card);
  const embedding = fields.find((f) => f.type === EMBEDDING_TYPE);
  if (embedding) return { name: embedding.name, source: embedding.source ?? [] };
  const vectors = fields.filter(isVectorField);
  if (vectors.length === 0) return null;
  const embedded = loadEmbeddingFrom(load, fields);
  const field = embedded ? vectors.find((f) => f.name === embedded.column) : undefined;
  const refuse = (name: string, why: string): null => {
    onNote(`vector column ${name} is not searched by meaning: ${why}`);
    return null;
  };
  if (!embedded || !field) {
    return refuse(vectors.map((f) => f.name).join(", "), "no record of the load that made the table says the platform embedded it");
  }
  if (!(typeof field.dim === "number" && field.dim > 0)) return refuse(field.name, "the schema gives it no width");
  if (hasCard && roles.get(field.name) !== ROLE_VECTOR) {
    return refuse(field.name, `the table's card gives it the role ${roles.get(field.name) ?? "none"}, not ${ROLE_VECTOR}`);
  }
  return { name: field.name, source: embedded.source };
}

/** The text the vector check embeds. Any text serves: the platform checks
 * the column's model before it embeds anything, and one word is the least
 * there is to embed. */
const VECTOR_CHECK_TEXT = "check";
/** The rows the vector check asks for: the fewest a search returns. */
const VECTOR_CHECK_K = 1;

/** Whether the platform embeds a query for `vector` with the model that
 * filled it, asked of the platform itself: one search by meaning for one row
 * (`vector_search` with `query_text`). The platform runs it only for an
 * embedding column of the model it embeds queries with, and refuses any
 * other, naming both models when they differ (ask/src/worker/query_text.rs
 * `embed_against_column`) - the inner loop's own check, made by the code that
 * embeds every `search` and every `{{q:"..."}}`, and the one place the
 * column's model can be read: a `vector` column the load's record names was
 * filled with the model the platform embedded with then, which need not be
 * the one it embeds with now, and a table can be loaded under a model of
 * its own. The demo's checks send the same search before every run
 * (demo/platform-health.mjs `requireTextQuery`).
 *
 * Any failure leaves the column unoffered, said to `onNote` in the
 * platform's words: a refusal is the platform's no, and anything else - an
 * embedding server that is starting, a platform that cannot be reached -
 * leaves the match unestablished, and the inner loop's rule for a column
 * whose model it cannot match is not to offer it. `check` should not wait
 * out a starting server: the check runs before the session it serves can
 * start, and a server's start takes longer than that can wait. */
export async function platformEmbedsQueriesFor(
  check: Pick<HostedDb, "vectorSearchText">,
  table: string,
  vector: QueryableVector,
  onNote: (line: string) => void = () => {},
): Promise<boolean> {
  try {
    await check.vectorSearchText(table, vector.name, VECTOR_CHECK_TEXT, VECTOR_CHECK_K);
    return true;
  } catch (err) {
    onNote(
      `vector column ${vector.name} is not searched by meaning: the platform did not embed a query for it ` +
        `(${(err as Error).message})`,
    );
    return false;
  }
}

/** What a caller of `tableShapeFrom` can ask of the choices it makes, and
 * hear about them. */
export interface ShapeOptions {
  /** The text column the deployment named for the doors to search
   * (CX_TEXT_COLUMN): taken as `primaryText` when it is one of the table's
   * full-text columns, since a search or token match over any other is
   * refused by the engine; otherwise the pick by name stands. */
  textColumn?: string;
  /** Hears each column the shape could have used and did not, and why - a
   * vector column it does not search by meaning, a named text column it
   * could not take. For a log line. */
  onNote?: (line: string) => void;
  /** The vector column the shape takes, when the caller has settled it:
   * `resolveTableShape` passes the candidate the platform embedded a query
   * for, or null. Absent, the shape takes the candidate unchecked - a read
   * of the descriptors alone, for a caller that hands it a table. */
  vector?: QueryableVector | null;
}

/** The shape of `table` from its schema descriptors and, when it has one,
 * its card, and the record of the hydrate job that loaded it. Pure, so a
 * test can hand it any table. Its vector column is `options.vector` when
 * given, else the unchecked candidate (`vectorCandidate`). */
export function tableShapeFrom(
  table: string,
  fields: SchemaField[],
  card?: RowRecord | null,
  load?: RowRecord | null,
  options: ShapeOptions = {},
): TableShape {
  const { cardColumns, roles, hasCard } = cardRoles(card);
  const names = new Set(fields.map((f) => f.name));
  const onNote = options.onNote ?? (() => {});

  // The card's roles are the truth when there is a card: the optimizer probed
  // every text column for an index, so a card that names no fts column
  // describes a table with none, and the doors must say so rather than search
  // a column the engine will refuse. Only with NO card are the types read -
  // hydrate casts exactly the columns it indexes or embeds to LargeUtf8.
  //
  // A plain Utf8 column no longer stands in when nothing is LargeUtf8: the
  // optimizer probes LargeUtf8 columns alone for an index (ask/src/card/
  // build.rs), so the platform's own card never calls a Utf8 column
  // full-text, and standing one in sent a search and a find the engine
  // refuses - the Berka tables (2026-10-01), hydrated with no full-text
  // index, would have been searched on a transaction's `type`. Such a table
  // has no text column, and its tool text says so.
  const cardText = fields.filter((f) => roles.get(f.name) === ROLE_FTS).map((f) => f.name);
  const typedText = fields.filter((f) => LARGE_TEXT_TYPES.has(f.type)).map((f) => f.name);
  const textColumnsInferred = !hasCard;
  const textColumns = hasCard ? cardText : typedText;

  // The platform reports its own embedding column as `vector` since the
  // seam, and this read only `embedding`: on the Wikipedia table (emb,
  // 768 wide, embedded from name and sections by the hydrate job) every
  // search ran BM25 alone and the sql text said "No vector column"
  // (2026-10-01, 27 searches on chunks_wikipedia_v5, every one `keyword`).
  // The column is offered only once the platform has said it embeds a query
  // for it with the model that filled it (`resolveTableShape`).
  const vector = options.vector !== undefined ? options.vector : vectorCandidate(fields, card, load, onNote);
  const vectorColumn = vector?.name ?? null;
  const vectorSource = vector?.source ?? [];
  // The embedding's source is preferred only when it is itself indexed: a
  // table can embed a column it does not index (the jobs table embeds
  // `title` and indexes `description_html`), and a search sent against the
  // unindexed one is refused by the engine.
  const picked =
    textColumns.find((name) => TEXT_NAME_HINT.test(name)) ??
    vectorSource.find((name) => textColumns.includes(name)) ??
    textColumns[0] ??
    "";
  // The column the deployment named comes before the pick by name, when the
  // engine can search it.
  const named = options.textColumn;
  const takeNamed = named !== undefined && textColumns.includes(named);
  if (named !== undefined && !takeNamed) {
    const why = names.has(named) ? "is not full-text indexed" : "is no column of the table";
    onNote(
      `the text column named for search (CX_TEXT_COLUMN=${named}) ${why} - full-text indexed: ${textColumns.join(", ") || "none"}; ` +
        `searching ${picked || "no column"} instead`,
    );
  }
  const primaryText = takeNamed ? named : picked;

  const cardKey = cardColumns.find((c) => c.index === ROLE_KEY && names.has(c.name))?.name;
  const keyColumn = cardKey ?? fields.find((f) => KEY_NAME.test(f.name))?.name ?? ENGINE_ID_COLUMN;

  const rowColumns = fields.filter((f) => f.type !== EMBEDDING_TYPE && f.type !== VECTOR_TYPE).map((f) => f.name);
  if (keyColumn === ENGINE_ID_COLUMN) rowColumns.unshift(ENGINE_ID_COLUMN);
  // A table with its own `score` column names it once: the platform reads a
  // repeated name as one projection either way, and a hit has one cell.
  const projection = rowColumns.includes(SCORE_COLUMN) ? [...rowColumns] : [...rowColumns, SCORE_COLUMN];

  const chunking = chunkingFrom(load, fields);
  const text = new Set(textColumns);
  const listColumns = fields.filter((f) => f.type === LIST_TYPE).map((f) => f.name);
  const scalarColumns = fields
    .filter((f) => !text.has(f.name) && f.type !== LIST_TYPE && f.type !== EMBEDDING_TYPE && f.type !== VECTOR_TYPE)
    .map((f) => f.name);

  return {
    table,
    columns: fields.map((f) => ({ name: f.name, type: renderType(f) })),
    vectorColumn,
    vectorSource,
    textColumns,
    textColumnsInferred,
    primaryText,
    scalarColumns,
    listColumns,
    keyColumn,
    linkColumn: textColumnNamed(fields, LINK_WORDS),
    titleColumn: textColumnNamed(fields, TITLE_WORDS),
    isChunks: CHUNK_COLUMNS.every((name) => names.has(name)),
    rowColumns,
    projection,
    ...(card ? { card } : {}),
    ...(chunking ? { chunking } : {}),
  };
}

/** How `resolveTableShape` reads a table: `tableShapeFrom`'s options but the
 * vector, which it settles itself, and the client it asks the platform
 * through whether it embeds a query for the table's vector column. */
export interface ResolveOptions extends Omit<ShapeOptions, "vector"> {
  /** The client the vector check goes through (`platformEmbedsQueriesFor`);
   * the `hosted` client when absent. A caller whose `hosted` client waits out
   * a cold start passes one that does not: an embedding server that is
   * starting takes longer than a session's startup can wait. */
  checkWith?: Pick<HostedDb, "vectorSearchText">;
}

/** The stored card of `table` at `tier`, or the lean one where the
 * optimizer has written no card at that tier yet - the lean card is the one
 * every swept table has, and the platform's own loop falls back the same way
 * for a rung whose tier a table has no card at (`rung_prompt`). `onNote`
 * hears the fallback. Only "no card at that tier" falls back: any other
 * failure - a database still starting, a refused key - would fail the lean
 * read the same way, so it rejects at once rather than ask twice (a cold
 * start must not hold the session's startup for a second attempt). Rejects
 * as the lean read does when there is no card at all. */
export async function fetchCard(
  hosted: Pick<HostedDb, "tableCard">,
  table: string,
  tier: string | undefined,
  onNote?: (line: string) => void,
): Promise<RowRecord> {
  if (tier === undefined || tier === LEAN_CARD_TIER) return hosted.tableCard(table, tier);
  try {
    return await hosted.tableCard(table, tier);
  } catch (err) {
    if (!(err instanceof HostedError && err.status === HTTP_NOT_FOUND)) throw err;
    onNote?.(`no ${tier} card for ${table} (${err.message}); folding in the ${LEAN_CARD_TIER} card`);
    return hosted.tableCard(table, LEAN_CARD_TIER);
  }
}

/** The shape of `table` on the hosted database: its schema, and its card at
 * `cardTier` when the platform has one (`fetchCard`). The card is best-effort - a table
 * the optimizer has not swept yet has none, and the schema alone describes
 * such a table well enough to search it - but the schema is not: without it
 * nothing here knows what to ask for. `onNoCard` hears why the card was not
 * served, for a caller that wants to log the platform's words; the shape
 * itself just goes without one. Two reads, and a third with `readLoad`: the
 * record of the hydrate job that loaded the table, for how it cut the rows
 * (`chunking`) and whether the platform embedded its vector column
 * (`vectorCandidate`) - best-effort like the card, since a table loaded
 * another way has no such record. Without the record a `vector` column is
 * not searched by meaning. And one more where the table has a candidate
 * vector column: the platform asked to embed a query for it
 * (`platformEmbedsQueriesFor`), through `options.checkWith` when given,
 * else `hosted`; a column it does not embed one for is not searched by
 * meaning either. The rest of `options` go to `tableShapeFrom`. */
export async function resolveTableShape(
  hosted: Pick<HostedDb, "schema" | "tableCard" | "vectorSearchText"> & Partial<Pick<HostedDb, "hydrateJob">>,
  table: string,
  cardTier?: string,
  onNoCard?: (err: unknown) => void,
  readLoad = false,
  options: ResolveOptions = {},
): Promise<TableShape> {
  const fields = (await hosted.schema(table)) as unknown;
  if (!Array.isArray(fields)) throw new Error(`schema of ${table}: expected the platform's column descriptors, got ${typeof fields}`);
  let card: RowRecord | null = null;
  try {
    // The route answers the card bare or wrapped in a record, as the sql
    // description's own fetch has always allowed for.
    const record = await fetchCard(hosted, table, cardTier, options.onNote);
    const inner = record?.card ?? record;
    if (inner && typeof inner === "object") card = inner as RowRecord;
  } catch (err) {
    // no card yet: the schema alone stands
    onNoCard?.(err);
  }
  let load: RowRecord | null = null;
  if (readLoad && hosted.hydrateJob) {
    try {
      load = await hosted.hydrateJob(table);
    } catch {
      // not loaded by a hydrate job, or its record is gone: nothing is said
      // about passages, and no `vector` column is searched by meaning
    }
  }
  const { textColumn, onNote } = options;
  const candidate = vectorCandidate(fields as SchemaField[], card, load, onNote);
  const vector = candidate && (await platformEmbedsQueriesFor(options.checkWith ?? hosted, table, candidate, onNote)) ? candidate : null;
  return tableShapeFrom(table, fields as SchemaField[], card, load, { textColumn, onNote, vector });
}

// --- rows as hits -----------------------------------------------------------------

/** Characters kept of a text column in a search or find hit. The text is a
 * snippet - enough to tell what the row is and whether it is the one - and
 * the whole value is one `sql` away by the row's key. A job description runs
 * to several thousand characters of HTML, and ten of those per search would
 * cost more than the answer. */
export const SNIPPET_CHARS = 500;

/** The named entities HTML text carries most - the five the escaping itself
 * produces, and the typographic ones a posting's editor writes - decoded so a
 * snippet reads as prose; numeric references are decoded by rule, and any
 * other name is left as it came. */
const HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "\u{2014}",
  ndash: "\u{2013}",
  hellip: "\u{2026}",
  lsquo: "\u{2018}",
  rsquo: "\u{2019}",
  ldquo: "\u{201C}",
  rdquo: "\u{201D}",
  bull: "\u{2022}",
};
const ENTITY = /&(#x[0-9a-f]+|#\d+|[a-z]+);/gi;
const TAG = /<[^>]*>/g;
const WHITESPACE = /\s+/g;

/** What marks a value as HTML rather than prose that happens to hold a `<`:
 * a tag - `<` and a letter, an optional closing slash before it - found at
 * least HTML_TAGS_MIN times, or a column whose name says so. One tag is not
 * enough: `Vec<T>` is one, and so is a bare `<br>` in a sentence that is
 * otherwise plain. Below the bar the text is kept as it came - a description
 * saying `retry while attempts < max and backoff > 0` loses its middle to a
 * tag stripper that does not ask first. */
const HTML_TAG = /<\/?[a-zA-Z][^>]*>/g;
const HTML_TAGS_MIN = 2;
const HTML_COLUMN = /html/i;

/** The largest Unicode scalar value; a numeric reference past it is left as
 * it came rather than thrown on. */
const MAX_CODE_POINT = 0x10ffff;

function decodeEntities(text: string): string {
  return text.replace(ENTITY, (whole, body: string) => {
    if (body[0] !== "#") return HTML_ENTITIES[body.toLowerCase()] ?? whole;
    const hex = body[1] === "x" || body[1] === "X";
    const codePoint = hex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    return Number.isFinite(codePoint) && codePoint >= 0 && codePoint <= MAX_CODE_POINT ? String.fromCodePoint(codePoint) : whole;
  });
}

/** Whether `text`, in a column named `column`, is HTML: the column says so,
 * or the text holds HTML_TAGS_MIN tags once its entities are decoded - a
 * stored description is often HTML that was itself entity-escaped, so
 * `&lt;p&gt;` is a tag only once decoded. */
export function looksLikeHtml(text: string, column = ""): boolean {
  if (HTML_COLUMN.test(column)) return true;
  const tags = decodeEntities(text).match(HTML_TAG);
  return tags !== null && tags.length >= HTML_TAGS_MIN;
}

/** `text` as a snippet: whitespace collapsed, cut to SNIPPET_CHARS with a
 * marker on the cut; and when the value is HTML (looksLikeHtml), its tags
 * stripped and its entities decoded first. Entities are decoded before the
 * tags go, since an escaped `&lt;p&gt;` is a tag only once decoded, and once
 * more after, for the `&amp;nbsp;` the first pass turns into an entity.
 * Plain text keeps every character it came with, `<` and `&` included. */
export function snippet(text: string, column?: string): string {
  const prose = looksLikeHtml(text, column) ? decodeEntities(decodeEntities(text).replace(TAG, " ")) : text;
  const plain = prose.replace(WHITESPACE, " ").trim();
  return plain.length > SNIPPET_CHARS ? `${plain.slice(0, SNIPPET_CHARS)}...` : plain;
}

/** A row as a hit: `score` first, then the key, then the other columns in
 * schema order, then the text columns as snippets - so a reader sees what
 * the row is before what it says, and a long text never buries the columns
 * after it. Cells the platform omitted (nulls) stay absent. */
export function rowHit(row: RowRecord, shape: TableShape): RowRecord {
  const text = new Set(shape.textColumns);
  const out: RowRecord = {};
  if (row[SCORE_COLUMN] !== undefined) out[SCORE_COLUMN] = row[SCORE_COLUMN];
  if (row[shape.keyColumn] !== undefined) out[shape.keyColumn] = row[shape.keyColumn];
  for (const name of shape.rowColumns) {
    if (name === SCORE_COLUMN || name === shape.keyColumn || text.has(name) || row[name] === undefined) continue;
    out[name] = row[name];
  }
  for (const name of shape.textColumns) {
    const cell = row[name];
    if (typeof cell === "string") out[name] = snippet(cell, name);
    else if (cell !== undefined) out[name] = cell;
  }
  return out;
}

/** A fact of the platform's loop as a row: `rowHit`'s order and snippets for
 * the table's own columns, then every cell the statement made that is no
 * column of the table's - an aggregate's count, an expression's alias - as
 * it came. A loop's statement is not a projection of the table: `SELECT
 * department, COUNT(*) AS n` is a fact whose answer is the alias, and a hit
 * that carried the table's columns alone would drop it. A cell named for a
 * column the hit leaves out (the vector) stays out. */
export function rowFact(row: RowRecord, shape: TableShape): RowRecord {
  const columns = new Set(shape.columns.map((c) => c.name));
  const out = rowHit(row, shape);
  for (const [name, value] of Object.entries(row)) {
    if (!(name in out) && !columns.has(name) && value !== undefined) out[name] = value;
  }
  return out;
}

/** What identifies `row` in the usage ledger: its key, or the engine id
 * when the key was not returned. */
export function rowKey(row: RowRecord, shape: TableShape): string {
  return String(row[shape.keyColumn] ?? row[ENGINE_ID_COLUMN] ?? "");
}

// --- SQL spelling -------------------------------------------------------------------

/** `text` as a SQL string literal: quotes doubled, the only escaping a
 * literal needs and the whole of the injection surface. */
export function sqlLiteral(text: string): string {
  return `'${text.replace(/'/g, "''")}'`;
}

/** `name` as a quoted SQL identifier, so a column named with a capital or a
 * space reaches the engine as spelled. */
export function sqlIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
