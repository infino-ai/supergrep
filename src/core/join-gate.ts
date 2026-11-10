// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The gate a statement across hosted tables passes before it runs: the
// platform's `join_keys` says which columns the tables join on, found on
// their values, and a statement that spans two or more tables without one
// of those keys in it is refused with the keys, so the model rewrites it on
// a key that holds instead of one that reads well.
//
// Measured before this existed (2026-09-24, host 79, Opus): asked a question
// that needed the issues joined to the logs, the model matched the two
// `instance_id` columns by name and wrote a correlated subquery, and never
// called join_keys though the tool was there and the sql text said to call
// it first. The owner: "either the model calls it or we force a rewrite
// internally". This is the second. The keys reach the model only here, in
// the refusal of a statement it already wrote without them; no key is in any
// tool text.

/** One join as `join_keys` returns it; only the two tables and the ready
 * predicate are read here. */
export interface PlatformJoin {
  from_table: string;
  to_table: string;
  predicate: string;
}

/** What the gate decided: the statement runs as written, or is refused with
 * the keys the platform found and the tables the statement spans. */
export type JoinGateVerdict = { kind: "run"; tables: string[]; keysAsked: boolean } | { kind: "refuse"; tables: string[]; keys: PlatformJoin[] };

/** Words that follow a table name in a statement and are not its alias. */
const NOT_AN_ALIAS = new Set([
  "on", "where", "join", "inner", "left", "right", "full", "cross", "outer", "natural", "using", "group", "order", "limit",
  "offset", "having", "union", "except", "intersect", "and", "or", "not", "as", "set", "window", "qualify", "fetch",
  "for", "with", "select", "from", "values", "returning", "lateral", "tablesample",
]);

/** The table-valued search functions whose first argument names a table
 * and whose result is aliased as that table's rows. */
const SEARCH_FUNCTIONS = ["hybrid_search", "bm25_search", "vector_search", "token_match", "exact_match"];

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The graph functions: `graph_walk('<table>', '<seed table>', [ids], hops, k)`
 * and `graph_rank(...)` name two tables in their arguments and join nothing -
 * the walk is the platform's, over the keys it verified - so the tables
 * named there are not a statement spanning tables. */
const GRAPH_FUNCTIONS = ["graph_walk", "graph_rank"];

/** `query` with every graph function's argument list blanked, so the
 * tables it names are not read as a JOIN the gate must hold to a key. */
export function withoutGraphCalls(query: string): string {
  return query.replace(new RegExp(`\\b(?:${GRAPH_FUNCTIONS.join("|")})\\s*\\([^)]*\\)`, "gi"), (call) => call.replace(/[^()]/g, " "));
}

/** The known tables a statement names, as identifiers or as the string
 * argument of a search function, each once in the order given. */
export function tablesNamed(query: string, tables: readonly string[]): string[] {
  const named: string[] = [];
  for (const table of tables) {
    if (!table) continue;
    const re = new RegExp(`(?<![\\w.])${escapeRegex(table)}(?![\\w])`, "i");
    if (re.test(query) && !named.includes(table)) named.push(table);
  }
  return named;
}

/** Every alias a statement gives one of `tables`: `FROM issues i`,
 * `JOIN logs AS l`, `hybrid_search('chunks', ...) AS c`. Alias to table. */
export function aliasesOf(query: string, tables: readonly string[]): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const table of tables) {
    const plain = new RegExp(`(?<![\\w.'"])${escapeRegex(table)}(?![\\w])\\s+(?:as\\s+)?([A-Za-z_]\\w*)`, "gi");
    for (const m of query.matchAll(plain)) {
      const alias = m[1];
      if (!NOT_AN_ALIAS.has(alias.toLowerCase()) && alias.toLowerCase() !== table.toLowerCase()) aliases.set(alias.toLowerCase(), table);
    }
    const searched = new RegExp(`(?:${SEARCH_FUNCTIONS.join("|")})\\(\\s*'${escapeRegex(table)}'[^)]*\\)\\s+(?:as\\s+)?([A-Za-z_]\\w*)`, "gi");
    for (const m of query.matchAll(searched)) {
      const alias = m[1];
      if (!NOT_AN_ALIAS.has(alias.toLowerCase()) && alias.toLowerCase() !== table.toLowerCase()) aliases.set(alias.toLowerCase(), table);
    }
  }
  return aliases;
}

/** A statement or predicate reduced to what its join condition is made of:
 * lowercase, aliases replaced by their tables, quotes and blanks gone. */
export function normalizeSql(text: string, aliases: ReadonlyMap<string, string>): string {
  let out = text.toLowerCase();
  for (const [alias, table] of aliases) {
    out = out.replace(new RegExp(`(?<![\\w.])${escapeRegex(alias)}\\.`, "g"), `${table.toLowerCase()}.`);
  }
  return out.replace(/["`]/g, "").replace(/\s+/g, "");
}

/** Whether `predicate` (`a.x = b.y`, either side possibly an expression) is
 * written in the statement, either way round. */
export function predicateHolds(query: string, predicate: string, aliases: ReadonlyMap<string, string>): boolean {
  const statement = normalizeSql(query, aliases);
  const sides = predicate.split(/\s=\s/);
  if (sides.length !== 2) return statement.includes(normalizeSql(predicate, aliases));
  const [l, r] = sides.map((s) => normalizeSql(s, aliases));
  return statement.includes(`${l}=${r}`) || statement.includes(`${r}=${l}`);
}

/** The set operators that put one query's rows after another's: the
 * branches they separate join nothing to each other. */
const SET_OPERATOR = /\b(?:union(?:\s+all)?|intersect|except)\b/gi;
/** The opening of a subquery inside parentheses. */
const SUBQUERY_START = /^\s*(?:select|with)\b/i;
/** A FROM list that names several sources (`FROM a, b`): a join. */
const FROM_LIST = /\bfrom\b([\s\S]*?)(?:\bwhere\b|\bgroup\b|\border\b|\blimit\b|\bhaving\b|\bwindow\b|\bqualify\b|$)/gi;

/** The index just past the parenthesised group that opens at `open`, quotes
 * skipped; the text's end when the group is never closed. */
function groupEnd(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === "'" || c === '"') {
      const close = text.indexOf(c, i + 1);
      i = close < 0 ? text.length : close;
    } else if (c === "(") depth += 1;
    else if (c === ")" && --depth === 0) return i + 1;
  }
  return text.length;
}

/** A quoted text that can name a table: one identifier, as a search
 * function's first argument does (`'chunks'`). Any other quoted text is a
 * value, whatever words it holds. */
const QUOTED_NAME = /^['"][A-Za-z_]\w*['"]$/;

/** `text` with its subqueries taken out and blanked, and the subqueries
 * themselves, at whatever depth they sit (inside a function call's
 * arguments too). A parenthesised group that is not a query - a function's
 * arguments, a search function's table - stays in place; a quoted value is
 * blanked, a quoted name kept. */
function splitSubqueries(text: string): { outer: string; subqueries: string[] } {
  let outer = "";
  const subqueries: string[] = [];
  for (let i = 0; i < text.length; ) {
    const c = text[i];
    if (c === "'" || c === '"') {
      const close = text.indexOf(c, i + 1);
      const end = close < 0 ? text.length : close + 1;
      const quoted = text.slice(i, end);
      outer += QUOTED_NAME.test(quoted) ? quoted : " ".repeat(quoted.length);
      i = end;
    } else if (c === "(") {
      const end = groupEnd(text, i);
      const inner = text.slice(i + 1, Math.max(i + 1, end - 1));
      if (SUBQUERY_START.test(inner)) {
        subqueries.push(inner);
        outer += " ".repeat(end - i);
      } else {
        const nested = splitSubqueries(inner);
        outer += `(${nested.outer})`;
        subqueries.push(...nested.subqueries);
      }
      i = end;
    } else {
      outer += c;
      i += 1;
    }
  }
  return { outer, subqueries };
}

/** `text` cut at its set operators outside parentheses and quotes. */
function setBranches(text: string): string[] {
  const { outer } = splitSubqueries(text);
  const cuts: number[] = [];
  for (const m of outer.matchAll(SET_OPERATOR)) cuts.push(m.index ?? 0, (m.index ?? 0) + m[0].length);
  const branches: string[] = [];
  let from = 0;
  for (let k = 0; k < cuts.length; k += 2) {
    branches.push(text.slice(from, cuts[k]));
    from = cuts[k + 1];
  }
  branches.push(text.slice(from));
  return branches;
}

/** Whether a statement joins known tables, so that its rows pair one
 * table's with another's and the pairing must be on a key the data holds:
 * two tables in one query's FROM or JOIN; a subquery over another table
 * than the query around it (`IN (SELECT ... FROM b)`, a correlated
 * subquery); or queries over different tables joined to each other (CTEs
 * JOINed, or listed in one FROM). Queries that only sit side by side join
 * nothing and run as written: the branches of a UNION, INTERSECT or EXCEPT,
 * and subqueries over one table each in a SELECT list with no table of its
 * own. A UNION of two tables' counts is the natural answer to how many rows
 * each has; refusing it sent the model back to one query per table. */
export function joinsTables(query: string, known: readonly string[]): boolean {
  for (const branch of setBranches(query)) {
    const { outer, subqueries } = splitSubqueries(branch);
    const own = tablesNamed(outer, known);
    if (own.length >= 2) return true;
    if (subqueries.some((sub) => joinsTables(sub, known))) return true;
    const below = [...new Set(subqueries.flatMap((sub) => tablesNamed(sub, known)))];
    if (own.length === 1 && below.some((table) => table !== own[0])) return true;
    if (own.length === 0 && below.length >= 2) {
      const joined = /\bjoin\b/i.test(outer) || [...outer.matchAll(FROM_LIST)].some((m) => m[1].includes(","));
      if (joined) return true;
    }
  }
  return false;
}

/** The gate. `known` is every hosted table the statement may name; `keys`
 * fetches the platform's joins among the named tables and is called only
 * when the statement joins two or more of them (`joinsTables`). */
export async function joinGate(
  query: string,
  known: readonly string[],
  keys: (tables: string[]) => Promise<PlatformJoin[]>,
): Promise<JoinGateVerdict> {
  const unwalked = withoutGraphCalls(query);
  const tables = tablesNamed(unwalked, known);
  if (tables.length < 2) return { kind: "run", tables, keysAsked: false };
  if (!joinsTables(unwalked, known)) return { kind: "run", tables, keysAsked: false };
  const joins = (await keys(tables)).filter((j) => tables.includes(j.from_table) && tables.includes(j.to_table));
  // Two tables the platform found no key between: nothing to hold the
  // statement to; it runs as written.
  if (joins.length === 0) return { kind: "run", tables, keysAsked: true };
  const aliases = aliasesOf(query, tables);
  if (joins.some((j) => predicateHolds(query, j.predicate, aliases))) return { kind: "run", tables, keysAsked: true };
  return { kind: "refuse", tables, keys: joins };
}

/** The refusal's text: what was spanned, what joins it, what to do. */
export function joinRefusal(tool: string, verdict: { tables: string[]; keys: PlatformJoin[] }): string {
  const list = verdict.keys.map((j) => `  ${j.predicate}`).join("\n");
  return (
    `${tool} refused: the statement spans ${verdict.tables.join(", ")} without a key the platform found on their values. ` +
    `join_keys says they join on:\n${list}\nRewrite the statement with one of these as its ON (or WHERE) condition and run it again; ` +
    "a subquery or a condition on other columns is not a join the data supports."
  );
}
