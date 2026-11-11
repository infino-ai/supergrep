// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// What the platform's graph adds to a retrieval, applied by this server and
// never chosen by the model: the rows a search or a statement returned are
// handed to the platform, which walks its graph from them - the verified
// joins from their key values, the definitions of the names a code row uses,
// the rows its extraction linked to the same entities - and the rows of the
// other hosted tables it reaches come back beside the result, each named by
// its table (`POST /v1/graph_expand/{db}`, served on the table's worker,
// where the graph store and the engine's indexes live). The platform's own
// answering loop makes the same call on its own retrievals, so the two
// loops are expanded by one implementation.
//
// Why here and not in the tool text: the graph's two SQL functions are named
// to the model in the sql text, with the seed statement written out, and a
// model answering cross-table questions still does not call them. That is
// how graph retrieval systems generally work too - GraphRAG, LightRAG, the
// Neo4j patterns find the seeds themselves, expand a hop or two, and hand
// the model the assembled context; none expects the model to ask. The graph
// is built by the platform's optimizer, kept out of sight, and used by
// retrieval.
//
// What stays on this side: which rows of a session have been walked and
// shown already, and how much of a result the section may add.

import type { RowRecord } from "./hosted.js";
import { ENGINE_ID_COLUMN } from "./table-shape.js";

/** Seeds one retrieval expands from: its first rows. Twenty is a search's
 * default k; a statement's hundred rows would seed a walk of everything. */
export const SEED_ROWS_CAP = 20;
/** The cell a connected code row carries when it defines a name the
 * results use, as the platform marks it. */
export const RELATION_FIELD = "relation";
/** An engine id written as its digits. */
const ID_DIGITS = /^\d+$/;

/** What a retrieval searched by: a search's words, or the statement whose
 * keyword search's terms the platform reads off it. The facts matching them
 * come back from every document, not only from the rows returned. */
export interface Searched {
  query?: string;
  statement?: string;
}

/** A client that expands rows on the platform. */
export interface GraphDb {
  graphExpand(table: string, rows: readonly RowRecord[], searched?: Searched): Promise<RowRecord>;
}

/** Whether `searched` names anything to search the facts by. */
const searchesBy = (searched: Searched | undefined): searched is Searched =>
  Boolean(searched?.query?.trim() || searched?.statement?.trim());

export interface GraphNeighbours {
  table: string;
  rows: RowRecord[];
}

/** What came back: how many rows seeded the platform's walk, the rows of
 * each other table it reached, strongest first, and the facts its graph
 * holds for the results - what their own text states (`via: row`), facts
 * about the things those name read elsewhere (`via: name`), and facts
 * matching the words searched from any document (`via: query`) - each with
 * the table and document it was read from. `facts` is absent when there
 * are none. */
export interface GraphExpansion {
  seeds: number;
  tables: GraphNeighbours[];
  facts?: RowRecord[];
  note: string;
}

/** How the platform's answer begins when its graph covers nothing from the
 * table asked about: the deployment builds no graph, or its
 * `optimizer_settings.graph.tables` leaves the table out. Either holds for the whole session, so a caller stops
 * asking for that table - an expansion is a gateway and a worker round trip
 * on every retrieval. */
export const UNCOVERED_NOTES = ["this deployment builds no knowledge graph", "the graph does not cover table"] as const;

/** Whether the platform's note says its graph covers nothing from the table. */
export function isUncovered(note: string | null): boolean {
  return note !== null && UNCOVERED_NOTES.some((prefix) => note.startsWith(prefix));
}

/** The sentence beside the neighbours: what they are and that they cite
 * like any row. */
export const CONNECTED_NOTE =
  "Rows of the other tables linked to these results through the platform's graph - the keys it " +
  "verified, the names the texts mention, and what code defines and uses - ordered by how strongly " +
  "the results point at them. A row marked `relation: defines <name>` is where a name these results " +
  "use is defined, so there is no need to find it. Read and cite them like any row; the statement " +
  "to see more of one is a sql by its key.";

/** What one session's expansions have carried already: the rows walked
 * from and the rows shown under `connected`, each by its table and engine
 * `_id`. A row walked again reaches the same rows at the same cost, and the
 * caller reads every earlier copy again on each later turn - so a row is
 * walked from once a session, and a row shown once is not shown again (it
 * is one statement away by its key). A row
 * that came without its `_id` - a hit placed by its keys - is not
 * remembered: the platform looks its id up to walk from it, and what that
 * walk reaches again is not shown again. A fact shown once is not shown
 * again either, known by what it says and where it was read. */
export interface ExpansionMemory {
  seeds: Map<string, Set<bigint>>;
  rows: Map<string, Set<bigint>>;
  facts: Set<string>;
}

export function newExpansionMemory(): ExpansionMemory {
  return { seeds: new Map(), rows: new Map(), facts: new Set() };
}

/** A fact as one session knows it: what it says and where it was read. */
function factKey(fact: RowRecord): string {
  return JSON.stringify([fact.subject, fact.relation, fact.object, fact.qualifiers, fact.table, fact.document]);
}

/** The engine id `row` carries, whole: the bigint the JSON reviver keeps, a
 * number small enough to hold it, or its digits as text. Null for a row
 * that carries none. */
export function engineId(row: RowRecord): bigint | null {
  const id = row[ENGINE_ID_COLUMN];
  if (typeof id === "bigint") return id;
  if (typeof id === "number" && Number.isSafeInteger(id) && id >= 0) return BigInt(id);
  if (typeof id === "string" && ID_DIGITS.test(id)) return BigInt(id);
  return null;
}

/** Whether `seen` holds the row of `table` with engine id `id`. */
function holds(seen: Map<string, Set<bigint>>, table: string, id: bigint): boolean {
  return seen.get(table)?.has(id) ?? false;
}

/** Put the row of `table` with engine id `id` in `seen`. */
function hold(seen: Map<string, Set<bigint>>, table: string, id: bigint): void {
  const ids = seen.get(table) ?? new Set<bigint>();
  ids.add(id);
  seen.set(table, ids);
}

/** Whether `row` of `table` is new to `seen`: it carries no `_id`, or one
 * `seen` does not hold. */
function isNew(seen: Map<string, Set<bigint>>, table: string, row: RowRecord): boolean {
  const id = engineId(row);
  return id === null || !holds(seen, table, id);
}

/** Put every row of `rows` of `table` that carries its `_id` in `seen`. */
function holdAll(seen: Map<string, Set<bigint>>, table: string, rows: readonly RowRecord[]): void {
  for (const row of rows) {
    const id = engineId(row);
    if (id !== null) hold(seen, table, id);
  }
}

/** `row` as the graph route takes it: a bigint `_id` written as its decimal
 * text. The route reads a JSON number past 2^64 as a float, so an engine id
 * sent as a number lost its digits there and seeded nothing - every result
 * of a table without a place or key column went unexpanded, reported as "no
 * seeds" for rows that carried their ids. The route reads an id's text
 * exactly. */
export function withIdAsText(row: RowRecord): RowRecord {
  const id = row[ENGINE_ID_COLUMN];
  return typeof id === "bigint" ? { ...row, [ENGINE_ID_COLUMN]: id.toString() } : row;
}

/** Whether `value` is a row, an object. */
const isRow = (value: unknown): value is RowRecord => typeof value === "object" && value !== null;

/** The platform's answer as it comes back: the tables reached and their
 * rows, the facts its graph holds for the results, how many rows seeded the
 * walk, and a note when nothing was reached. */
function readAnswer(answer: RowRecord): { tables: GraphNeighbours[]; facts: RowRecord[]; seeds: number; note: string | null } {
  const tables: GraphNeighbours[] = [];
  const connected = answer.connected;
  if (Array.isArray(connected)) {
    for (const entry of connected) {
      if (!isRow(entry)) continue;
      const { table, rows } = entry as { table?: unknown; rows?: unknown };
      if (typeof table !== "string" || !Array.isArray(rows)) continue;
      tables.push({ table, rows: rows.filter(isRow) });
    }
  }
  const facts = Array.isArray(answer.facts) ? answer.facts.filter(isRow) : [];
  const seeds = typeof answer.seeds === "number" ? answer.seeds : 0;
  const note = typeof answer.note === "string" ? answer.note : null;
  return { tables, facts, seeds, note };
}

/** The rows of the hosted tables the platform's graph links to `rows` of
 * `source`, a table, and the facts its graph holds for them and for what
 * the retrieval `searched` by: null when nothing is new to this session to
 * walk from or search by, or the platform reaches nothing new.
 * `onUncovered` is told when the platform says its graph covers nothing
 * from `source` (`UNCOVERED_NOTES`). A failure is the caller's to log; the
 * expansion is an addition to a result that already stands, so a caller
 * treats a throw as no expansion. */
export async function expandAcrossGraph(
  db: GraphDb,
  source: string,
  rows: readonly RowRecord[],
  opts: {
    trace?: (line: string) => void;
    memory?: ExpansionMemory;
    onUncovered?: () => void;
    searched?: Searched;
  } = {},
): Promise<GraphExpansion | null> {
  const searched = searchesBy(opts.searched) ? opts.searched : undefined;
  if (rows.length === 0 && !searched) return null;
  // One line per attempt on stderr, so a drive's log says whether the
  // graph was reached at all: how many rows seeded, what came back.
  const trace = opts.trace ?? (() => {});
  const memory = opts.memory;
  const first = rows.slice(0, SEED_ROWS_CAP);
  const fresh = memory ? first.filter((row) => isNew(memory.seeds, source, row)) : first;
  // With nothing new to walk from, the words searched still find facts.
  if (fresh.length === 0 && !searched) {
    trace(`graph expansion: ${source} ${rows.length} row(s), all walked from before this session`);
    return null;
  }
  const answer = readAnswer(await db.graphExpand(source, fresh.map(withIdAsText), searched));
  if (isUncovered(answer.note)) opts.onUncovered?.();
  if (memory) holdAll(memory.seeds, source, fresh);
  const unseen: GraphNeighbours[] = answer.tables.map(({ table, rows: reached }) => {
    const kept = memory ? reached.filter((row) => isNew(memory.rows, table, row)) : reached;
    if (memory) holdAll(memory.rows, table, kept);
    return { table, rows: kept };
  });
  const facts = memory
    ? answer.facts.filter((fact) => {
        const key = factKey(fact);
        if (memory.facts.has(key)) return false;
        memory.facts.add(key);
        return true;
      })
    : answer.facts;
  trace(
    `graph expansion: ${source} ${rows.length} row(s) -> ${answer.seeds} seed(s) -> ` +
      (unseen.length ? unseen.map((t) => `${t.table} ${t.rows.length}`).join(", ") : (answer.note ?? "nothing")) +
      (facts.length ? `, ${facts.length} fact(s)` : ""),
  );
  // Every row the platform reached, whole: its `_id` and every value as the
  // table holds it. Nothing here cuts a value or drops a row for its size.
  const tables = unseen.filter((t) => t.rows.length > 0);
  if (tables.length === 0 && facts.length === 0) return null;
  return { seeds: answer.seeds, tables, ...(facts.length ? { facts } : {}), note: CONNECTED_NOTE };
}
