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

import { citeOf, type FindBlock, type FindLocations, type FindMatch, type FindResult } from "./searcher.js";

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
/** Files listed with their counts: the ones with the most matches, then one
 * line for the rest. A term across a 64-repository corpus matches in
 * hundreds of files, and the whole list was a third of a flood
 * (2026-09-27); the totals on the first line count them all either way. */
const PER_FILE_LISTED = 40;

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

/** Opens a block in a chunks-mode find, before its citation. */
const BLOCK_HEADING = "==";
/** Between a carried line's number and its text: the numbering search hits
 * and file reads use, so a block reads as a file read reads. */
const BLOCK_LINE_SEPARATOR = ": ";

/** Stands between two runs of a trimmed block, where lines were left out:
 * grep's own group separator, so the numbers on either side say how many. */
const BLOCK_GAP = GROUP_SEPARATOR;

/** One block of a chunks-mode find: a heading with the block's citation, its
 * one definition when there is one, and the lines that matched, then the
 * block's lines numbered, `--` where a trimmed block leaves lines out. The
 * citation is the carried span, so it can be quoted as it stands. */
export function renderBlock(b: FindBlock): string[] {
  const name = enclosingName(b.symbol);
  const heading =
    `${BLOCK_HEADING} ${citeOf(b.path, b.start, b.end)}${name ? `  [${name}]` : ""}` +
    `  match${b.hits.length === 1 ? "" : "es"} at ${b.hits.join(", ")}`;
  const out = [heading];
  b.lines.forEach((l, i) => {
    if (i > 0 && l.line !== b.lines[i - 1].line + 1) out.push(BLOCK_GAP);
    out.push(`${l.line}${BLOCK_LINE_SEPARATOR}${l.text}`);
  });
  return out;
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
    (result.skip ? `; from match ${result.skip + 1}` : "") +
    (result.truncated ? `; ${result.skip ? "the next" : "the first"} ${listed} listed` : "");
  out.push(head);
  if (result.partial) out.push(`partial index: ${result.partial.note}`);
  // More pages: said first, in so many words, and the matches they carry
  // are NOT listed by file below. Listed by file, they read as a to-do list
  // of files, and the model took them a file at a time - ten and then
  // fifteen scoped finds over several turns on the demo (2026-09-28), with
  // the page starts ignored in the hint at the bottom.
  const pages = result.pages ?? [];
  if (result.trimmedTo !== undefined) {
    out.push(
      `blocks trimmed to ${result.trimmedTo} lines around each match, since whole blocks would take many more pages; ` +
        "set context for another width",
    );
  }
  if (pages.length > 0) {
    const from = (result.skip ?? 0) + 1;
    out.push(
      `this result carries matches ${from}-${from + result.matches.length - 1} of ${result.total}. The rest are in ` +
        `${pages.length} more page${pages.length === 1 ? "" : "s"}: call find now with the same query and options and ` +
        `skip ${pages.join(", skip ")} - ${pages.length === 1 ? "that call" : `all ${pages.length} calls in this one reply`}, ` +
        "not a find per file.",
    );
  }
  out.push("");
  if (result.blocks) {
    result.blocks.forEach((b, i) => {
      if (i > 0) out.push("");
      out.push(...renderBlock(b));
    });
  } else {
    const withContext = result.matches.some((m) => (m.before?.length ?? 0) + (m.after?.length ?? 0) > 0);
    result.matches.forEach((m, i) => {
      if (withContext && i > 0) out.push(GROUP_SEPARATOR);
      out.push(...renderMatch(m));
    });
  }
  if (result.more?.length && pages.length === 0) {
    out.push("");
    out.push(
      result.blocks
        ? `${beyond} more matching line${beyond === 1 ? "" : "s"}, block not carried (path: lines):`
        : `${beyond} more place${beyond === 1 ? "" : "s"}, text not carried (path: lines):`,
    );
    for (const f of result.more) out.push(`${f.path}: ${f.lines.join(", ")}`);
  }
  if (result.byFile.length > 0) {
    out.push("");
    out.push(`per file (${result.byFile.length}):`);
    for (const f of result.byFile.slice(0, PER_FILE_LISTED)) out.push(`${f.path}: ${f.count}`);
    const rest = result.byFile.slice(PER_FILE_LISTED);
    if (rest.length > 0) {
      const lines = rest.reduce((n, f) => n + f.count, 0);
      out.push(`... and ${rest.length} more file${rest.length === 1 ? "" : "s"} with ${lines} line${lines === 1 ? "" : "s"} between them`);
    }
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
