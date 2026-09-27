// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// A find result as the model reads it: grep's shape, not JSON.
//
// The tool used to write its result as pretty-printed JSON, one object per
// match with the path, the line, the text and the enclosing symbol list on
// their own indented lines. Measured 2026-09-27 on the demo's engine corpus:
// a find for three spellings of `unsafe` came to 41,000 characters where rg
// says the same in 17,000, and a find for the SAFETY comments with four
// lines of context came to 56,000 - over Claude Code's tool-result cap, so
// the model was handed a 2 KB preview and a file path, ran rg itself and
// read every block with sed. The text budget (FIND_RESULT_CHAR_BUDGET)
// counts the matches' own characters; the JSON around them doubled it.
//
// So the result is written the way grep writes it, which every model has
// read a million times: `path:line:text`, one line per match, context lines
// as `path-line-text` with `--` between groups, and after the matches what
// grep cannot say - the places past the text budget, the per-file counts,
// the hint, the receipt. The enclosing definition rides at the end of the
// match line in brackets when the index knows one name for it; a window
// that declares several names says nothing, since the line is inside one
// of them and the list would not say which.

import type { FindLocations, FindMatch, FindResult } from "./searcher.js";

/** Separates one match's context group from the next, as grep does. */
const GROUP_SEPARATOR = "--";
/** Column widths are not padded: a match line is `path:line:text` exactly,
 * so a reader (or a regex) parses it as grep -n output. */
const MATCH_SEPARATOR = ":";
/** Context lines take grep's `-` in both places. */
const CONTEXT_SEPARATOR = "-";
/** The chunker marks a window inside a longer definition as
 * `name (first-last, part)`; the bare name is what a reader wants. */
const PART_MARKER = /^(.*?) \(\d+-\d+, part\)$/;

/** What is written after the result proper: the hint on an empty or wide
 * find, the note that the index was built on this call, the timing, and the
 * receipt - each on its own labelled line, in that order. */
export interface FindTextExtras {
  hint?: string;
  autoIndexed?: string;
  tookMs?: number;
  usage?: string;
}

/** The one definition a match sits in, when the window names exactly one;
 * a comma-joined list names the window, not the line, and yields nothing. */
export function enclosingName(symbol: string | undefined): string | undefined {
  if (!symbol) return undefined;
  // The part marker holds a comma of its own, so it is read before the
  // list check.
  const bare = PART_MARKER.exec(symbol)?.[1] ?? symbol;
  if (bare.includes(",")) return undefined;
  const name = bare.trim();
  return name === "" ? undefined : name;
}

/** One match as grep -n writes it, with its context lines around it when
 * the find carried them. */
export function renderMatch(m: FindMatch): string[] {
  const lines: string[] = [];
  const before = m.before ?? [];
  before.forEach((text, i) => lines.push(`${m.path}${CONTEXT_SEPARATOR}${m.line - before.length + i}${CONTEXT_SEPARATOR}${text}`));
  const name = enclosingName(m.symbol);
  lines.push(`${m.path}${MATCH_SEPARATOR}${m.line}${MATCH_SEPARATOR}${m.text}${name ? `  [${name}]` : ""}`);
  (m.after ?? []).forEach((text, i) => lines.push(`${m.path}${CONTEXT_SEPARATOR}${m.line + 1 + i}${CONTEXT_SEPARATOR}${text}`));
  return lines;
}

const placesOf = (more: FindLocations[] | undefined): number => (more ?? []).reduce((n, f) => n + f.lines.length, 0);

/** The whole result as text: a first line with the counts and the scope,
 * the matches, the places past the text budget, the per-file counts, then
 * the extras. */
export function renderFind(result: FindResult, extras: FindTextExtras = {}): string {
  const out: string[] = [];
  const beyond = placesOf(result.more);
  const listed = result.matches.length + beyond;
  const head =
    `${result.total} matching line${result.total === 1 ? "" : "s"} in ${result.files} file${result.files === 1 ? "" : "s"} ` +
    `for "${result.query}"` +
    (result.under ? ` under ${result.under}` : "") +
    (result.ignoreCase ? ", ignoring case" : "") +
    (result.definedFrom !== undefined ? `; ${result.total} of ${result.definedFrom} inside a definition of it` : "") +
    (result.truncated ? `; the first ${listed} listed` : "");
  out.push(head);
  if (result.partial) out.push(`partial index: ${result.partial.note}`);
  out.push("");
  const withContext = result.matches.some((m) => (m.before?.length ?? 0) + (m.after?.length ?? 0) > 0);
  result.matches.forEach((m, i) => {
    if (withContext && i > 0) out.push(GROUP_SEPARATOR);
    out.push(...renderMatch(m));
  });
  if (result.more?.length) {
    out.push("");
    out.push(`${beyond} more place${beyond === 1 ? "" : "s"}, text not carried (path: lines):`);
    for (const f of result.more) out.push(`${f.path}: ${f.lines.join(", ")}`);
  }
  if (result.byFile.length > 0) {
    out.push("");
    out.push(`per file (${result.byFile.length}):`);
    for (const f of result.byFile) out.push(`${f.path}: ${f.count}`);
  }
  const tail: string[] = [];
  if (extras.hint) tail.push(`hint: ${extras.hint}`);
  if (extras.autoIndexed) tail.push(`note: ${extras.autoIndexed}`);
  if (extras.tookMs !== undefined) tail.push(`took ${extras.tookMs} ms`);
  if (extras.usage) tail.push(`usage: ${extras.usage}`);
  if (tail.length > 0) {
    out.push("");
    out.push(...tail);
  }
  return out.join("\n");
}
