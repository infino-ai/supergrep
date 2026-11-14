// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The dedicated MCP server: three tools over the local code index, and two
// more over the same index's platform copy when a database is configured.
//
//   find     - the grep door: every line containing an exact string, cited
//              path:line - complete and unranked
//   search   - find code: exact terms AND meaning in one ranked pass
//   sql      - the power door: relevance-ranked aggregation over the search
//              table functions (bm25_search / hybrid_search + GROUP BY)
//   read     - the numbered lines of the files the others named - or, over
//              a hosted table of documents, of its documents - several at once
//
// Each tool is a different question: where does this exact text occur, what
// is most relevant to this, how much of what is where, what do the rows say.
// Freshness is not a tool: the first query on an unindexed
// repo builds the index (both places, with --db), and every query re-syncs
// it against the working tree (auto-sync, below). A reindex tool used to be
// one more; measured, no Sonnet run ever called it and Haiku called it where
// it hurt, and every tool in the list is prompt text on every turn.
// `cx index --full` is the forced rebuild.
// No near-duplicate retrieval tools - those worsen the agent's tool
// selection - so find is unranked and complete where search is ranked and
// top-k, and hybrid search's keyword half already ranks exact identifiers.
// Every sentence in the descriptions below is paid for on every turn and
// was measured to steer selection: change them with a measurement, not by
// taste. The harness lives with the demo it also drives, not here.
// Results carry took_ms - server-side time for the call (query embedding
// included where one happens; no transport).
//
// With CX_REMOTE_SEARCH the hosted table is the index `search` reads, and
// when CX_TABLE names a table that is not the chunks table (a hydrated data
// set) all three doors run over its ROWS, driven by the table's own schema
// (TableShape): find and sql then never touch the local index either, since
// a local build would drop and recreate the platform table it was pointed
// at. On the chunks table a `sql` statement that embeds a query (a `{{q}}`
// placeholder - a vector function's) runs on the platform whenever a
// database is configured, switch or no switch: the platform embeds it with
// the table's own model, and the local side is lexical - `find`, plain SQL.
// Which of the two it is - chunks or rows - is decided ONCE, at startup,
// from the table's schema (TableMode below) when CX_TABLE names another
// table, and every call reads that decision: no call asks the platform what
// it is about to run against, so a local tool never waits on the platform
// and the tool text registered at startup always describes what the calls
// do. The default table is never asked about - it is the chunks table this
// client builds - so its startup is what it always was, and the chunks
// table keeps every path and every word of tool text it had.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import { connect } from "@infino-ai/infino";
import {
  indexDir,
  resolveRoot,
  TABLE,
  DEFAULT_TABLE,
  DEFAULT_CAPS,
  DEFAULT_SEARCH_K,
  DEFAULT_FIND_LIMIT,
  MAX_FIND_LIMIT,
  hostedTarget,
  hostedAccount,
  hostedLabel,
  hostedAnalyzer,
  embedProvider,
  autoIndexEnabled as autoIndexSetting,
  autoSyncEnabled as autoSyncSetting,
  apiToolsEnabled,
  readOnlyEnabled,
  accountDataScope,
  type AccountDataScope,
  configuredCardTier,
  LEAN_CARD_TIER,
  memoryEnabled,
  webFetchEnabled,
} from "../core/config.js";
import { StartupCache, startupCachePath, startupCacheSecs } from "../core/startup-cache.js";
import { keyFilePath, readStoredAccount } from "../core/keystore.js";
import { accountFeatures, createDatabase } from "../core/account-api.js";
import { configuredPlaybook, withPlaybook } from "../core/playbook.js";
import { MEMORY_RECALL_TIMEOUT_MS, recallMemory, type Recalled } from "../core/memory.js";
import { readManifest, readPlatformManifest, type Manifest } from "../core/manifest.js";

/** The one refusal whose fix is a person rather than a retry: the account has
 * nothing left to spend. It names the account to add the card to - this same
 * one, not a new sign-up - where to do it, and what keeps working meanwhile,
 * because the three local tools are unaffected and a model told only "402"
 * concludes the whole server is down and stops using any of them. */
export function outOfCreditSteps(): string {
  const where = readStoredAccount()?.consoleUrl ?? "the Infino console";
  return (
    `this Infino account has no credit left. find, sql and read keep working - they run on the ` +
    `local index and cost nothing - but search needs a balance. To restore it, the ` +
    `account's owner adds their billing details and a card to this same account at ${where} ` +
    `(the key on this machine keeps working and nothing needs reinstalling), then retries`
  );
}

/** The platform a first sign-in asks for a free account, when the deployment
 * that installed this server named one (the plugin's MCP entry carries it).
 * Nothing in the source names a host: which platform a published client
 * signs people up to is a release decision (see `install`). */
const PLATFORM_URL_ENV = "CX_PLATFORM_URL";

/** What a server with no account says, in its instructions and on the calls
 * that need one: which tools are off, which are on, and the one command that
 * turns the rest on - run by the person, in a terminal. Said that way on
 * purpose. The step creates an account and agrees to file contents leaving
 * the machine, and the agent must never be the one who agrees (the rule is
 * core/consent.ts's): so the model is told whose command it is and told not
 * to run it, and the command asks the person itself before it does anything.
 * No key is ever typed into a conversation. */
export function noAccountSteps(): string {
  const platform = process.env[PLATFORM_URL_ENV]?.trim() || "<the platform's URL>";
  return (
    "search is off on this server: this machine has no Infino account, or has not agreed to uploads. " +
    "find, sql and read run on the local index and need nothing. To turn search on, the person - not " +
    `you - runs once, in a terminal: \`npx -y @infino-ai/code-context login --platform ${platform}\`. It asks ` +
    "them first, creates a free account (no email, no card), stores its key on this machine, and every " +
    "directory they open after that has search too once the session restarts. Do not run that command " +
    "yourself, and never ask for or paste a key"
  );
}

/** A key the platform would not accept. Names the file, because a machine can
 * hold a key for a different platform than the one this server points at. */
export function keyRefusedSteps(): string {
  return (
    `the Infino key this server is using was refused - expired, revoked, or issued by a different ` +
    `platform than the one configured. Run \`cx login\` to store a new one (it goes in ` +
    `${keyFilePath()}, mode 600). find, search and sql are unaffected`
  );
}

/** What to tell the model - and through it the person reading - when the
 * platform refused a call for a reason no rephrasing will fix. Three of those
 * matter and they have three unrelated fixes, so they get three sentences
 * rather than one status code:
 *
 * - capacity (429): a wait. The client already backed off inside the call's
 *   own budget, so a later call is all that is left.
 * - an empty balance (402): a person adding a payment method - the one fix
 *   not available to the agent at all, so it spells out the steps.
 * - a refused key (401): a sign-in, naming the command that does it.
 *
 * Anything else keeps the server's own words, already in the message. */
export function refusalHint(err: unknown): string {
  if (!(err instanceof HostedError)) return "";
  if (err.atCapacity) return " - the platform is at capacity right now; ask again in a moment";
  if (err.paymentRequired) return ` - ${outOfCreditSteps()}`;
  if (err.unauthenticated) return ` - ${keyRefusedSteps()}`;
  return "";
}

/** Whether a platform call ended at its client's deadline rather than on
 * its own (`HostedError.pastDeadline`): the platform said nothing; the
 * start-up ran out of the time it gives the database's other tables. */
export function pastDeadline(err: unknown): boolean {
  return err instanceof HostedError && err.pastDeadline;
}
import { hostedDbFor, localDb, newHostedMemo, platformLabel, platformTableReady, type IndexHandle } from "../core/context.js";
import { ENGINE_DEFAULT_ANALYZER } from "../core/analyzer.js";
import { budgetSqlRows, foldValidationFacts, rankRows, sqlBudgetHint } from "../core/facts.js";
import { HostedError, type HostedDb, type HostedOptions, type PromptCards, type ReadChecks, type RowRecord } from "../core/hosted.js";
import {
  analyzerOf,
  find,
  findRows,
  search,
  searchHosted,
  searchRows,
  runSql,
  runSqlRows,
  embedsAQuery,
  guardSql,
  jsonify,
  normalizeQueryPlaceholders,
  numberRowLines,
  partialIndex,
  readFiles,
  readHits,
  readNextCalls,
  readRanges,
  readRows,
  READ_LINES_CAP,
  READ_PATHS_MAX,
  withoutComments,
  callTelemetry,
  hostedTelemetry,
  type CallTelemetry,
  CONTENT_COLUMN,
  MAX_FIND_CONTEXT,
  MAX_FIND_PAGES,
  AUTO_CHUNK_CONTEXT,
} from "../core/searcher.js";
import { renderFind } from "../core/find-text.js";
import {
  newSession,
  receiptEnabled,
  cardEntry,
  findEntry,
  rowFindEntry,
  readEntry,
  searchEntry,
  rowSearchEntry,
  sqlEntry,
  withPlatform,
  withCalls,
  withMemoryTokens,
  formatReceipt,
  recordUsage,
} from "../core/usage.js";
import {
  cardLayouts,
  chunkingNote,
  databaseTables,
  ENGINE_ID_COLUMN,
  fetchCard,
  isMapEntry,
  resolveTableShape,
  rowHit,
  SNIPPET_CHARS,
  sqlIdentifier,
  type CardColumn,
  type CardLayout,
  type ResolveOptions,
  type TableShape,
} from "../core/table-shape.js";
import { joinGate, joinRefusal, tablesNamed, withoutGraphCalls, type PlatformJoin } from "../core/join-gate.js";
import { expandAcrossGraph, newExpansionMemory, type GraphExpansion, type Searched } from "../core/graph-expand.js";
import { DataPlane, type HydrateToolSource } from "./data.js";
import { topKAggregateRefusal } from "../core/topk-aggregate.js";
import {
  indexRepoStaged,
  syncRepo,
  syncInProgress,
  type IndexOptions,
  type SyncOutcome,
  type IndexStats,
  type StagedIndexRun,
} from "../core/indexer.js";
import { otherHolder, tryLockIndex, type IndexLock, type LockAttempt } from "../core/index-lock.js";
import { createEmbedder, createIndexingEmbedder, embedderInfo, platformEmbedderInfo, type Embedder } from "../core/embedder.js";
import { RepoRegistry, type RepoCtx } from "./repos.js";
import { ensureIndexed, type EnsureResult } from "./ensure.js";
import { ARITHMETIC_SENTENCE, READING_HABITS, SEARCH_RULE_SENTENCE, TASK_CHECKLIST_SENTENCE } from "./wording.js";

export { ARITHMETIC_SENTENCE, READING_HABITS, SEARCH_RULE_SENTENCE, TASK_CHECKLIST_SENTENCE } from "./wording.js";

/** The `sql` tool's description, named because every clause of it is there
 * for a reason an edit that reads better can undo. Five of its clauses are
 * load-bearing in that sense and `test/tool-text.test.ts` asserts each one,
 * each assertion shown to fail when its clause is rewritten: hybrid named
 * before bm25 (a function named second is rarely the one a model uses); the
 * placeholder marked as the caller's to fill (otherwise a model copies it
 * literally); the total named `ranked_lines` and reported as ranked, since
 * fusion unions the keyword and meaning arms so a row can place in the top k
 * without holding the terms; the pair that says a path filter narrows a
 * search but is never the topic - otherwise an aggregation tends to be a
 * directory guess measuring file lengths; and the scan clause naming every
 * predicate rather than ILIKE alone. */
/** The card tier folded into the `sql` description on a platform database:
 * the enriched card by default (DEFAULT_CARD_TIER), the lean one where a
 * table has no enriched card, and with it the sibling tables' meanings
 * beside their columns (`siblingsNote`). CX_CARD_TIER=lean folds in the lean
 * card alone.
 *
 * Measured on the demo, 2026-10-01: Sonnet as the caller on the Berka
 * tables, the same questions with the text folding in either tier. The
 * Infino arm answered 7 of 7 right on the enriched card against 31 of 36 on
 * the lean one, at 30.9 s and $0.050 a question against 34.3 s and $0.061
 * on the same host that hour. Three of the five lean misses were facts only
 * the semantic layer states: how a client's birth number encodes their sex
 * (two), and what loan statuses A to D mean (one). The longer text - Berka's
 * from 5,952 to 16,388 characters - cost nothing measurable. The owner:
 * "lean card for inner loop and enriched card for outer loop".
 *
 * The lean card had been the default since 2026-09-11, when 16 questions on
 * the engine repo, with the whole card's JSON in the system prompt rather
 * than folded into this text, put the enriched card at +32% wall clock on
 * six comprehension questions against lean's +14%, level on quality and
 * within 3% on cost. That was the other mechanism on a code corpus; the code
 * corpora have not been measured on this one. */
const CARD_TIER = configuredCardTier((line) => console.error(line));
/** A keyword search called in a statement: its terms are words the
 * platform's graph searches its facts by, whatever table the rows are of. */
const KEYWORD_SEARCH_CALL = /\b(?:hybrid|bm25)_search\s*\(/i;
/** The playbook this server was started with (CX_PLAYBOOK, `cx mcp
 * --playbook`), or null: its outer bullets join the instructions. Read
 * once; a file that does not load stops the server before it serves a tool,
 * since a server with half a playbook would be something it was not
 * configured to be. */
const PLAYBOOK = configuredPlaybook((line) => console.error(line));
/** Whether the text carries the semantic layer: on the enriched tier only, so
 * the lean text stays what it was measured as. */
const WITH_SEMANTICS = CARD_TIER !== LEAN_CARD_TIER;

/** Every tool here reads the index; none writes. Said out loud because a
 * caller that runs a message's tool calls concurrently only when each one is
 * read-only - Claude Code does exactly that - otherwise runs them one at a
 * time. Without this, platform calls issued together run one after another
 * - the wait is the sum rather than the slowest - so every sentence below
 * that asks for calls side by side would be a promise the client cannot
 * keep. */
const READ_ONLY = { readOnlyHint: true } as const;

/** The largest `read` result, in bytes as sent, that Claude Code shows the
 * model inline. Past its limit it writes the result to a file and the model
 * sees only a preview (`<persisted-output>`): a read of 60,000 characters,
 * escaped and encoded, goes out as some 64 KB and lands in a file, while
 * one just under 50,000 comes back whole. */
export const READ_INLINE_MAX_BYTES = 49_000;

/** The largest result, in characters, the `page` tool declares to Claude
 * Code (`anthropic/maxResultSizeChars`, whose ceiling this is). A page's
 * image travels as base64, and most scanned pages pass the default 50,000
 * characters, where Claude Code would write the result to a file the model
 * never sees; at this size nearly all go through whole. */
export const PAGE_RESULT_MAX_CHARS = 500_000;

/** The bytes a `read` result's numbered lines may take as sent, JSON-escaped
 * and UTF-8 encoded, before each path's share (`readBudget`):
 * READ_INLINE_MAX_BYTES less room for what every result carries besides -
 * `index`, `took_ms`, the usage line. Counted as sent rather than as text,
 * since escaping inflates it. */
export const READ_BUDGET_BYTES = 45_000;

/** What one file of a `read` result carries besides its lines and its path,
 * as sent: its span and total, its `more`, the note on a file the budget
 * left out, and its entry in `next` - about 300 bytes of pretty JSON, with
 * room over. */
const READ_FILE_FIELDS_BYTES = 320;

/** The bytes the numbered lines of a read of `paths` may take: the budget
 * less each path's share - its fields, and the path itself twice, in its file
 * and in `next` - so a read naming sixteen long paths stays under
 * READ_INLINE_MAX_BYTES as one naming two does. */
export function readBudget(paths: readonly string[]): number {
  return paths.reduce((left, path) => left - READ_FILE_FIELDS_BYTES - 2 * Buffer.byteLength(JSON.stringify(path)), READ_BUDGET_BYTES);
}

/** A value sent as the JSON text of itself, read as the value: `"[559, 592]"`
 * as the list, `"12"` as the number. Anything else passes through for the
 * schema to judge. */
function jsonOrAsIs(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** A line number or a list of them, for read's from and to. A list sent as
 * its JSON text - `from: "[559, 592, 623]"`, which smaller models send - is
 * read as the list: a schema that refused it would cost the call a turn. */
export const lineOrLines = z.preprocess(jsonOrAsIs, z.union([z.number().int().positive(), z.array(z.number().int().positive()).min(1)]));

/** How long `sql` waits for the platform's verdict on its rows before
 * returning them without one. Short on purpose: the rows are the answer and
 * the verdict is advice about them, so a platform that is slow or down must
 * cost the caller a few seconds at most, never the answer.
 *
 * Measured the other way first. The verdict went through the client's normal
 * path, which reads a 503 as a cold start and retries for its whole budget
 * (two minutes by default). On 2026-09-11 the worker's S3 credential expired
 * mid-demo, every hosted call went 503, and a LOCAL `sql` - rows already in
 * hand - sat for 116 s waiting on a best-effort check. That is a regression
 * against the tool as it was, and a platform outage must not become one. */
const VERDICT_TIMEOUT_MS = 3_000;
/** The budget one graph expansion has: it adds to a result already in
 * hand, so it never holds that result longer than this. */
const GRAPH_TIMEOUT_MS = 5_000;
/** How long expansion pauses after a failure that may pass (a timeout, a
 * 429, a 5xx) before it is tried again. */
const GRAPH_BACKOFF_MS = 60_000;
/** The answers that say the graph is not there for this account or
 * deployment, and will not be within a session. */
const GRAPH_LASTING_STATUSES = new Set([401, 403, 404, 501]);
/** What a result carries from the graph - `connected`, or `graph` saying
 * why there is none - and the metered call behind it, for the receipt. */
type GraphResult = { section: { connected: GraphExpansion } | { graph: string } | Record<string, never>; call?: CallTelemetry };
const NO_GRAPH_RESULT: GraphResult = { section: {} };
/** How long the startup waits on the account's features before reading it
 * as an account without the agent routes. */
const ACCOUNT_FEATURES_TIMEOUT_MS = 3_000;

/** How long a server's start-up waits on the database's tables other than
 * its own, from the moment the server starts, before the handshake goes
 * ahead without the ones it has not described. Claude Code gives an MCP
 * server 30 s to start and then runs the session without any of its tools.
 * The other tables are a help to the sql text, not a precondition of any
 * tool, so they get a third of that; the process's own start and its own
 * table's reads, which decide what the tools are, fit in the rest. The table
 * the server is for is never cut by it.
 *
 * On a database of a few hundred tables behind the platform's per-account
 * rate limit, describing every other table before the handshake can take
 * over a minute and thousands of requests, most of them refused for rate,
 * with a few cards answering nothing for their whole timeout; a database of
 * a few dozen tables takes a few seconds. A table not described within the
 * budget is named in the text as one that could not be (`siblingsNote`). */
const STARTUP_BUDGET_MS = 10_000;

/** What `sql` says about its verdict when a platform is there to give one.
 * It names the parameter and the field, and says what the verdict is NOT,
 * because the one misreading that costs an answer is taking "valid" for
 * "correct". Absent without a platform: there is then no 'validation' field,
 * and a description promising one would be wrong.
 *
 * `sql` ONLY. It rode on search and find too and was measured worse: blind
 * pairwise over 16 questions (lean-0559 against validate-1305, 2026-09-11),
 * the arm with the verdict lost 8-6-2 overall, and the split was exactly the
 * tool split - every aggregation question used sql alone and won 6-3-1,
 * every comprehension question used search/find alone and lost 0-5-1, with
 * unsupported claims rising 10 to 29 on that half. The anchor check is a
 * poor judge of a ranked search: a conceptual question's anchors are
 * capitalized words and identifiers that often do not appear literally in
 * rows that are genuinely relevant, so it refused good retrievals and sent
 * the model querying again (calls 37 to 48, tokens +25%) for longer answers
 * carrying more unsupported claims. The checks that CAN fire on a search are
 * the ones it does not need: a search result is never an aggregate, and no
 * rows is already plain. Keep it where the statement's shape is real. */
const VALIDATION_NOTE =
  " Pass the question you are answering as 'question' and the result carries 'validation': " +
  "whether these rows would be accepted as answering it - no rows, an aggregate of zeros, or rows " +
  "naming nothing the question named are refused, with the reason. A refusal names the question's " +
  "terms that occur nowhere in the index ('absent': no query will find them, so do not search for " +
  "them again) and the ones that do (query for those), and carries a 'suggestion' statement when " +
  "the one that ran should be rewritten. Query again on a refusal rather than answering from it. " +
  "Valid means the result answers the question's terms, not that it is correct. " +
  // The two columns the platform adds to a ranked aggregate's rows, named
  // here so the model expects them and reads them as what they are. The
  // measured failure they answer is in core/facts.ts.
  "On a ranking grouped by path, every row also carries file_lines, the file's whole length, and " +
  "term_lines, how many of its lines hold each search term: a ranked total is a share of file_lines, " +
  "never the file's size, and a file whose term_lines are all zero was ranked by meaning alone, so " +
  "say so or leave it out rather than renumber the rest.";

/** What introduces the cards in the `sql` description. Stated as each
 * table's own shape, because that is what it is: the optimizer
 * computed it from the table after optimizing it, so the distinct counts and
 * ranges are the table's, not an estimate. A wide table's card is laid out
 * within the budget the platform's own loop lays it out within (core/
 * table-shape.ts, `cardLayouts`): its densest columns whole and the rest as
 * a map, whose entries the preamble explains once. */
const CARD_PREAMBLE =
  ` Each table's own measured shape, computed from it - use it to choose columns and write the ` +
  `statement without discovering the shape first. A wide table's card lists its columns whole only as far ` +
  "as its budget reaches: a `<head>_*` entry stands for a family of columns named by that prefix, " +
  "`(other columns)` for the rest, and `(empty columns)` for the columns with no value in any row; " +
  "describe_columns lists what an entry stands for, whole:\n";

/** What introduces the one card of a table none of whose columns the card
 * maps - every column listed whole, no sibling beside it: the words the text
 * carried before wide tables were laid out. The wide-table sentences, the
 * table's name in front of its card and the describe_columns tool are for a
 * card that maps columns; on a narrow table they are text about nothing the
 * model can see, and they make its answers worse. */
const NARROW_CARD_PREAMBLE =
  ` The table's own measured shape, computed from it - use it to choose columns and write the ` +
  `statement without discovering the shape first:\n`;

/** Whether a card lays out any column as a map entry (`<head>_*`,
 * `(other columns)`, `(empty columns)`) rather than listing it whole. */
export function cardMapsColumns(card: RowRecord | undefined): boolean {
  const schema = card?.schema;
  return Array.isArray(schema) && schema.some((c) => typeof (c as RowRecord)?.name === "string" && isMapEntry(c as { name: string }));
}

/** The tables the platform says it knows where the documents their rows
 * were made from lie (`pages` beside their cards, from the platform's
 * `gateway_settings.pages`), in the order given: the tables the page tool
 * reads a row's page for. */
export function pagedTables(tables: ReadonlyArray<{ table: string; pages?: boolean }>): string[] {
  return tables.filter((t) => t.pages === true).map((t) => t.table);
}

/** Whether a card names the table's kind column (`kind_column`): the
 * column saying what kind of record each row is, by which the platform
 * counts every sparse column's rows (an entry's `kinds`). The laid-out card
 * leaves the counts out and describe_columns serves them, so the tool is
 * offered for such a table however narrow its card. */
export function cardNamesKinds(card: RowRecord | undefined): boolean {
  return typeof card?.kind_column === "string" && card.kind_column !== "";
}

/** What a text over several tables says about choosing among them: the
 * loop's words, word for word. Shown
 * two tables of events, a model took the one named first and the column
 * named like the question's words and told the reader the data held no tool
 * calls, while the other table's card said where they were. */
export const SEVERAL_TABLES_SENTENCE =
  " The question may be about any of the tables described: read every table's description before " +
  "choosing, and take the table whose columns hold what the question asks about by what their " +
  "descriptions and values say, never by a column named like the question's words; the notes under " +
  "the question say which table holds what. A column described as holding no value, or whose rows " +
  "come back empty, is not the one: go to the other table.";

/** Text columns a tool's text names before counting the rest - the loop's
 * TEXT_COLUMNS_LISTED, the same figure: a table of events carries hundreds
 * of indexed text columns, and naming every one in every tool put tens of
 * thousands of characters into each. */
export const TEXT_COLUMNS_LISTED = 24;

/** How the lookup is told to be called with the question, in the platform
 * loop's words: the question first, the table when the caller knows it. */
export const DESCRIBE_COLUMNS_QUESTION_RULE =
  " Pass the question you are answering as `question`: without `table` it returns the cards of the " +
  "tables that question needs, best first, with the columns it needs listed whole; with `table`, that " +
  "table's columns the question needs first. A `pattern` narrows the columns to names you already know.";

/** The `describe_columns` tool's text, in the words of the platform loop's
 * own tool: the model outside the loop reads a wide table's laid-out card as
 * the loop does and reaches a mapped column the same way. */
export const DESCRIBE_COLUMNS_DESCRIPTION =
  "List a table's column entries from its card, whole: type, index role, rows with a value, distinct " +
  "count, range, most frequent values, and, where the card names a `kind_column`, `kinds`: which kinds " +
  "of record hold a value in the column and how many of each. The sql tool's text lists a wide table's " +
  "columns only as far as its budget reaches and stands in for the rest with one `<head>_*` entry per " +
  "name family, and lists no column's kinds; call this with the family's prefix (`property_*`) or a " +
  "column's name before a statement names one of them, and before counting a column of a table with a " +
  "`kind_column`. Returns how many columns matched and the first 40 by rows with a value, or `limit` " +
  "of them." +
  DESCRIBE_COLUMNS_QUESTION_RULE;

/** The `question` a search or a find takes: with it the platform's grader
 * orders the hits for the question before they come back - the triage pass
 * the platform's own retrieval loop ranks its results by - over a hosted table. */
export const RERANK_QUESTION_PARAM =
  "The question you are answering, in the words it was asked. With it, over a hosted table, the " +
  "platform's grader orders the hits for that question - a search takes a wider pool and returns the " +
  "k it puts first - before they come back.";

/** What introduces the start-up overview in the `sql` description: every
 * table in a line, no card, when the cards do not fit as they are. */
const OVERVIEW_PREAMBLE =
  " The database's tables, one line each - no card is shown until a question needs one: call " +
  "describe_columns with your question for the cards of the tables it needs, then with a table for its " +
  "columns:\n";

/** The lookup's `question` parameter, in the platform loop's words: one
 * ranking for a lookup inside the loop and out. */
export const DESCRIBE_COLUMNS_QUESTION_PARAM =
  "What you need the columns for, in a sentence: the matching columns that question needs come first, " +
  "best first, the rest after by rows with a value.";

/** Whether the platform's rendering of the cards (`PromptCards`) leaves
 * anything to describe_columns: a table it lists without its card, or a
 * map entry (`<head>_*`, `(other columns)`, `(empty columns)`) standing in
 * for columns it does not list whole. */
export function promptCardsMap(rendered: PromptCards): boolean {
  return (
    rendered.listed.length > 0 ||
    /"name": "(?:[^"]*_\*|\((?:other|empty) columns\))"/.test(rendered.cards)
  );
}

/** Three rules the platform's retrieval loop writes its statements under,
 * given to the caller too, because both write statements over the same
 * tables. The first two are the loop's words, word for word.
 *
 * A question about some of the rows is answered over those rows alone:
 * "which centuries come up in village articles" was once answered by a
 * count over every article. */
export const KEEP_CONDITIONS_SENTENCE =
  "Keep every condition the question names in the statement: a question about some of the rows (the village " +
  "articles, one project's files) is answered over those rows alone, never over the whole table. ";
/** "Related to" in a question is a join or a question of meaning (the owner,
 * 2026-09-30), so the statement ranks by meaning. Said only where the table
 * has a vector to rank by. */
export const RELATED_TO_SENTENCE =
  "A question asking what is related to something is a join or a question of meaning: include hybrid_search or " +
  "vector_search in the statement or the search. ";
/** A question about a kind of language is one of meaning, whatever words it
 * lists: asked for rage in free-text answers, a caller lists "rage",
 * "angry", "furious" and matches them as words, and misses the complaints
 * that use none of them ("stop polling me"). Said beside
 * `RELATED_TO_SENTENCE` in the rows' sql text, where a table has a vector;
 * the loop carries the same sentence. */
export const LANGUAGE_KIND_SENTENCE =
  "A question about a kind of language - angry, frustrated, praising, confused - is a question of meaning however " +
  "many example words it names: rank with hybrid_search or vector_search, the examples as its terms, never a keyword " +
  "match alone. ";
/** A question asking how many is answered with the counts: asked which
 * threats to species come up most, the Infino arm's answer had no numbers,
 * where the index-only and Snowflake arms gave a count per threat
 * (2026-09-30). The loop's sentence is about its statement; this one is
 * about the caller's statement and its answer. */
export const COUNTS_IN_THE_ANSWER =
  "A question that asks how many (a count, a total, which have the most) is answered with the aggregated values " +
  "themselves: a statement that returns each count beside the column naming its group, and an answer that states them.";

/** The instructions with `TASK_CHECKLIST_SENTENCE` after them, whatever the
 * table: a habit of finishing a task, not of reading any one shape. */
export function withTaskChecklist(instructions: string): string {
  return `${instructions}\n${TASK_CHECKLIST_SENTENCE}`;
}

/** The whole question in one statement. Asked which sources a set of
 * articles cites most and which subjects cite them, a caller left alone
 * writes a statement per source, slowly, and gets the counts wrong; one
 * statement - a UNION ALL of one token_match per source, grouped by subject
 * and ranked per source with ROW_NUMBER() - answers both parts at once.
 * Worded with no search function's name, since a table with no full-text
 * column is told none. The platform's own loop carries the same sentence. */
export const ONE_STATEMENT_SENTENCE =
  "Put as much of the question as you can into one statement: WITH, UNION ALL, joins, CASE, GROUP BY and window " +
  "functions such as ROW_NUMBER() OVER (PARTITION BY ...) compose in one, so a question in several parts - several " +
  "things each counted, the top rows of each group, a count beside the rows it counts - is one statement, never a " +
  "query per part. ";
/** Several terms counted in one statement, over a table that can match
 * words: one token_match per term, so a row holding two counts for both. The
 * run above grouped by regexp_match over a pattern of alternatives, which
 * reads the first match alone (ROWS_REGEX_SENTENCE), and counted each article
 * for the first outlet it named: 13,216 for the New York Times where one
 * count per outlet gives 23,719. Run on the platform before it was written
 * here. The platform's own loop carries the same sentence. */
export function severalTermsSentence(table: string, column: string): string {
  return (
    `Several terms counted at once are one token_match per term, side by side in a UNION ALL - SELECT 'a' AS term, ` +
    `COUNT(*) AS n FROM token_match('${table}','${column}','a','and') UNION ALL SELECT 'b', COUNT(*) FROM ` +
    `token_match('${table}','${column}','b','and') - so a row holding two of them counts for both. `
  );
}
/** The regex functions of the platform's dialect, for a table of rows; the
 * loop's dialect note carries
 * the same sentence. Models write regexp_extract, which Snowflake, Spark and
 * BigQuery have and DataFusion does not: it appeared in the demo's Wikipedia
 * statements on every host since 2026-09-25, and on 2026-10-01 a caller lost
 * a turn to "Invalid function 'regexp_extract'". regexp_match(...)[1] gives
 * the same rows, NULL where nothing matches, and a table of rows shows the
 * list regexp_match returns - each run on the platform before it was written
 * here. The chunks table's text says the same for its own renderer. */
export const ROWS_REGEX_SENTENCE =
  "The dialect is Apache DataFusion, which has no regexp_extract: regexp_match(text, 'pattern')[1] is the first " +
  "capture group of the first match alone (NULL where nothing matches), so a pattern of alternatives yields one of " +
  "them per row and never counts several, regexp_like(text, 'pattern') tests and regexp_replace rewrites. ";
/** A row's `_id` in a statement, for a table of rows; the loop's dialect note
 * carries the same sentence,
 * word for word. The id is 32 digits, a DECIMAL(38, 0): written bare, the
 * engine reads it as a float and the statement fails with "Cannot cast to
 * Decimal128(38, 15). Overflowing" - a caller writing `WHERE _id = 3299...`
 * to reread a row it found loses the turn. Quoted, it compares exactly. */
export const ROWS_ID_SENTENCE =
  "A row id is too wide for a number: compare it as a string, _id = '32995980872922260363525666898294', or the " +
  "query fails on overflow. ";

/** A `card` TOOL was built and measured first and is deliberately not here.
 * Registered, offered and working, it was simply not called: asked a real
 * aggregation question the model went straight to `sql` (2026-09-11), which
 * is the failure the note on `SQL_DESCRIPTION` below already records for a
 * tool named second. The reason is visible in that description - it already
 * names every column, so from the model's side a card tool adds nothing it
 * can see it needs, while what the card actually adds is the statistics. A
 * fact that cannot be declined has to be in the text, not behind a call. */
/** The first sentence of the sql text: what the statement runs over. Kept
 * apart so the sibling tables, when a deployment names some, are said right
 * after it and not at the tail. Measured on the demo's 64-project corpus
 * (2026-09-24, host 71): with the siblings appended after some 1,450
 * tokens of recipes and the card, Opus wrote four statements over the code
 * table alone, looked for logs among its files, and answered that the
 * corpus had no issues and no test runs; on the host before, with a shorter
 * text, it had joined the logs table at once. What the model must know to
 * choose a table has to come before what it must know to write the query. */
export const SQL_DESCRIPTION_OPENING =
  "Read-only SQL, one SELECT or WITH, over " +
  `${TABLE}(path, start_line, end_line, lang, symbol, content[, embedding]) - lang is the ` +
  "file extension, e.g. 'rs' - for counts, rankings, and GROUP BY across the whole repo. ";

export const SQL_DESCRIPTION =
  SQL_DESCRIPTION_OPENING +
  "The search functions are table-valued: a ranked search is a relation, so WHERE, GROUP BY, " +
  "ORDER BY and joins compose with it in one pass, and one query replaces the several round " +
  "trips of searching, then filtering, then counting. Rank through a search relation rather " +
  "than scanning the whole table - with ILIKE, LIKE, regexp_like, or a bare filter on path " +
  "or lang: a scan has no relevance ranking, reads every chunk, and answers 'contains this " +
  "substring' when the question asked which code is about something. " +
  `Rank with hybrid_search('${TABLE}','content','terms','embedding', {{q}}, k) - 'terms' and ` +
  "{{q}} are yours to fill in, not literals to copy - unless you have " +
  "a reason not to: it fuses exact terms with meaning, so it reaches the code whether or not " +
  "the question's words are the code's words, and they rarely are. That covers a concept, a " +
  "subsystem, 'code about X', 'files that do Y' - the shape of almost every ranking question. " +
  RELATED_TO_SENTENCE +
  KEEP_CONDITIONS_SENTENCE +
  ONE_STATEMENT_SENTENCE +
  SEARCH_RULE_SENTENCE +
  `bm25_search('${TABLE}','content','terms', k) is keyword only: reach for it when the topic ` +
  "is itself a literal string you know appears in the source and you want counts a reader can " +
  `check as occurrences. vector_search('${TABLE}','embedding', {{q}}, k) is meaning alone - for a ` +
  "question whose words will not be the code's words: SELECT path, start_line, content FROM " +
  `vector_search('${TABLE}','embedding', {{q}}, 20). token_match('${TABLE}','content','the terms','and') is ` +
  "every row holding every WORD given, unranked and complete - a count a reader can check: " +
  `SELECT count(*) FROM token_match('${TABLE}','content','<the words>','and'). Its unit is the word: ` +
  "in_bulk is the two words in and bulk, and 122 Django files hold both where 30 hold the identifier. " +
  "An identifier, an error text, an exact phrase is find's, never token_match's. " +
  severalTermsSentence(TABLE, CONTENT_COLUMN) +
  `exact_match('${TABLE}','content','value') is the rows whose whole value equals the string - a lookup on ` +
  "a short indexed column, never on content. " +
  "The {{name}} placeholders are filled server-side from the embed " +
  "map, so they cost you nothing but the name. " +
  // The whole question as one statement, each clause one job - count,
  // group, join, filter, keyword search, semantic search - in place of a
  // ranking example that showed the aggregate alone. Run on the platform
  // before it was written here; the platform's own loop carries the same
  // shape in its table's names.
  "The whole question as one statement, each clause one job - filter, keyword and meaning search, " +
  "group, count - with your own words in place of the example's: SELECT path, SUM(end_line - start_line + 1) " +
  `AS ranked_lines, COUNT(*) AS chunks FROM hybrid_search('${TABLE}','content','merge small superfiles','embedding', {{q}}, 300) WHERE ` +
  "path LIKE 'src/%' AND lang = 'rs' GROUP BY path ORDER BY ranked_lines DESC LIMIT 15, with embed " +
  '{"q":"how small superfiles are merged into larger ones"}: the terms are the keyword job and the {{q}} ' +
  "text the meaning job, the WHERE the filter, the GROUP BY with its aggregates the which and the how many; " +
  `a second table joins into the same statement (FROM ... AS ${TABLE} JOIN <other> ON <its keys>) where the ` +
  "database has one - one call, not a search, then a filter, then a count. Where the topic is a literal " +
  "string you want counted as occurrences, the same shape over " +
  `bm25_search('${TABLE}','content','compaction', 300) instead - every row then holds the word, ` +
  "so a reader can check it. " +
  "What such a total means: a search relation holds only the top k chunks of that query, so a " +
  "SUM or COUNT over it is the lines or chunks that ranked within the top k - a share of the " +
  "file about the topic - and never the file's length or the repository's count; report it as " +
  "'lines ranked in the top 300 for <topic>', and expect files outside the top k, including " +
  "large ones, to be missing from it. A question with no topic in it - a file's length, the " +
  `largest files, a count over the whole repository - comes from ${TABLE} with no search ` +
  `function: SELECT path, MAX(end_line) AS lines FROM ${TABLE} WHERE lang IN ('rs','ts','py') ` +
  "GROUP BY path ORDER BY lines DESC. Name the languages you mean, as that example does, on " +
  "any question about code: an unfiltered ranking over a real repository comes back topped by " +
  "generated data - benchmark result JSON, fixtures, vendored blobs - which genuinely are the " +
  "longest files and are never the answer. `lang` is the file extension, so the filter is the " +
  "cheapest way to say 'code, not data', and it works the same inside a ranked search's " +
  "aggregate. A path prefix is not a topic: filtering on WHERE path LIKE 'src/thing/%' and " +
  "measuring lengths answers how big those files are, not which code is about the thing, and " +
  "it guesses the answer from a directory name instead of retrieving it. " +
  // Reading is sql's too, and it has to be said with the statements written
  // out: on the demo's 64-project corpus (2026-09-24) the model ranked the
  // longest test logs with sql and then read them with the shell - wc, grep,
  // awk, cut | sort | uniq -c - because nothing here said how a file or a
  // log is read and shaped in sql. The owner: "we should be more explicit
  // maybe with better examples." Each statement below was run on the
  // platform before it was written here.
  "sql is also how you READ here, and never the shell, Grep or Read - with the search functions doing " +
  `the finding: the lines of a file, SELECT start_line, content FROM ${TABLE} WHERE path = 'src/x.rs' ORDER BY ` +
  "start_line (a stretch: AND start_line BETWEEN 380 AND 440), and whole files the index named with read, " +
  "several in one call; every place a phrase occurs, complete and " +
  `unranked, token_match('${TABLE}', 'content', 'the terms', 'and') - how often, SELECT count(*) FROM ` +
  `token_match('${TABLE}', 'content', 'the terms', 'and') WHERE path LIKE 'x/%'; the lines about something, ` +
  "ranked, bm25_search or hybrid_search as above; what a long file or log is made of, the shell's " +
  "cut | sort | uniq -c, SELECT substr(line, 1, 50) AS head, count(*) AS n FROM (SELECT " +
  `unnest(string_to_array(content, chr(10))) AS line FROM ${TABLE} WHERE path = '...') GROUP BY head ORDER BY n ` +
  "DESC LIMIT 20; the kinds of error in a log, the same unnest over " +
  `bm25_search('${TABLE}', 'content', 'Error Exception', 200) WHERE path = '...', then regexp_replace(line, ` +
  "'^.*?([A-Za-z.]+(Error|Exception)).*$', '\\1') AS kind, count(*) ... GROUP BY kind - the search function " +
  "finds the windows, string functions only shape their lines, and a LIKE or regexp_like scan over the whole " +
  "table is the one form to avoid. Rows are windows that overlap by a few lines, so a per-line count runs a " +
  "little high and the ranking is right; log lines may carry colour codes, so match inside an unnested line " +
  "(LIKE '%FAILED%'), never at its start. " +
  // The dialect, where the model wrote functions it does not have: on the
  // demo (2026-09-24) regexp_extract failed as unknown, regexp_match came
  // back as a list this side cannot render, and the third try was a scan
  // of whole windows past the result budget - then the shell.
  "The dialect is Apache DataFusion: regexp_like, regexp_replace, substr, position, split_part, " +
  "string_to_array with unnest, CASE WHEN; regexp_match returns a list this side cannot show, so shape " +
  "with regexp_replace instead, and there is no regexp_extract. A result past the tool's budget keeps " +
  "every row's keys and places and cuts the text, so select the lines you mean rather than whole windows. " +
  "Select start_line beside content whenever you mean to read or cite the code: a row's text " +
  "comes back with each line's own number in the file when the row carries its start line, and " +
  "unnumbered when it does not, since nothing then places the text. " +
  "The result includes a 'usage' field, a one-line receipt of tokens returned and rows.";

// --- the tool text for a hosted table of another shape ---------------------------
//
// With CX_REMOTE_SEARCH the hosted table is the index, and when CX_TABLE
// names a table that is not the chunks table (a hydrated data set - job
// postings, tickets) the doors run over its rows, driven by its TableShape.
// The text below describes them for that table: the same doors said for
// rows, with the table's own column names where the chunks text has its
// constants. None of it has been through the bench. What it keeps are the
// chunks descriptions' measured clauses, transposed: hybrid named before
// bm25, the placeholder marked as the caller's to fill, a total over a
// search relation reported as ranked and never as the table's count, the
// scan discouraged by every predicate that reaches for it. Measure before
// polishing, as with the text above.

/** The card's entries when the card was laid out within a budget (fewer
 * entries than the table has columns): the columns it names whole, and the
 * entries standing for the rest. Null when there is no card or the card
 * lists every column, where the schema is the list. */
function cardEntries(shape: TableShape): CardColumn[] | null {
  const schema = shape.card?.schema;
  if (!Array.isArray(schema) || schema.length === 0 || schema.length >= shape.columns.length) return null;
  return (schema as CardColumn[]).filter((c) => typeof c?.name === "string");
}

/** The columns of a shape as `name type` pairs - of a card laid out within
 * a budget, the columns it names whole and each map entry with what it
 * says, so a wide table's text is as long as its budget, not its width. */
export function columnList(shape: TableShape): string {
  const entries = cardEntries(shape);
  if (!entries) return shape.columns.map((c) => `${c.name} ${c.type}`).join(", ");
  const types = new Map(shape.columns.map((c) => [c.name, c.type]));
  return entries
    .map((c) => (isMapEntry(c) ? `${c.name}: ${c.description ?? ""}`.trimEnd() : `${c.name} ${types.get(c.name) ?? c.type ?? ""}`.trimEnd()))
    .join(", ");
}

/** How many columns the sql text names of another table whose card does not
 * lay its columns out. With every column of every such table in whole, newly
 * loaded tables with no card yet and a few thousand columns each can make the
 * sql text larger than the 16 MB Claude Code takes in one message from a
 * server, and every session then starts with no tools at all. */
export const SIBLING_COLUMNS_SHOWN = 100;

/** A sibling table's columns for the sql text: `columnList`, but a table
 * the card does not lay out names its first `max` columns and counts the
 * rest. */
export function siblingColumnList(shape: TableShape, max: number = SIBLING_COLUMNS_SHOWN): string {
  if (cardEntries(shape) || shape.columns.length <= max) return columnList(shape);
  const shown = shape.columns.slice(0, max).map((c) => `${c.name} ${c.type}`).join(", ");
  return `${shown}, and ${shape.columns.length - max} more columns not listed here (SELECT * FROM ${shape.table} LIMIT 1 names them)`;
}

/** The scalar columns a tool's text names: of a card laid out within a
 * budget, the ones it names whole. */
function scalarsShown(shape: TableShape): string[] {
  const entries = cardEntries(shape);
  if (!entries) return shape.scalarColumns;
  const named = new Set(entries.filter((c) => !isMapEntry(c)).map((c) => c.name));
  return shape.scalarColumns.filter((name) => named.has(name));
}

/** The list columns the sql text names: of a card laid out within a budget,
 * the ones it names whole - a list column with no value in any row sits in
 * the card's empty entry, and naming it as a list to unnest drew a question
 * about tools to it. */
function listColumnsShown(shape: TableShape): string[] {
  const entries = cardEntries(shape);
  if (!entries) return shape.listColumns;
  const named = new Set(entries.filter((c) => !isMapEntry(c)).map((c) => c.name));
  return shape.listColumns.filter((name) => named.has(name));
}

/** The full-text columns a tool's text names: the first TEXT_COLUMNS_LISTED
 * in the table's order, and how many more describe_columns lists. */
export function textColumnsPhrase(shape: TableShape): string {
  const ordered = shape.textColumns;
  if (ordered.length === 0) return "none";
  const named = ordered.slice(0, TEXT_COLUMNS_LISTED);
  const more = ordered.length - named.length;
  return more > 0 ? `${named.join(", ")} and ${more} more (describe_columns("${shape.table}", "*") lists them)` : named.join(", ");
}

/** A scalar column to write the examples with - not the key, so a filter or
 * GROUP BY on it reads as one would on any table; the key when the table
 * has nothing else. */
function exampleScalar(shape: TableShape): string {
  return shape.scalarColumns.find((name) => name !== shape.keyColumn) ?? shape.keyColumn;
}

/** Two sentences every model that reads these instructions is told, word for
 * word the ones the hosted retrieval loop's own answer writer is told, so the
 * outer model and the loop cite under one instruction and reach for tools the
 * same way. They ride in the server's instructions, which Claude Code adds to
 * its own system prompt beside the user's; nothing of the user's prompt is
 * replaced. The first is what a citation is: a place copied from a tool
 * result, never remembered. The second is what a sweep is: one call to a
 * tool built for it, not a walk through files by hand. */
export const CITE_EXACTLY =
  "Cite the places your tool results gave you exactly as they gave them - the path and line numbers " +
  "copied, never recalled or adjusted.";
/** Where the place to copy is: every hit carries its own citation as
 * `cite` (`citeOf` in core/searcher.ts). Said beside CITE_EXACTLY wherever
 * hits are described, because a caller told only to copy composed a
 * citation of its own from the hit's fields, and one model's own was a
 * class name with a line that nothing reads as a citation. */
export const CITE_FROM_HIT =
  " Each hit's cite is its place in that form: keep its path exactly as it is there, and narrow " +
  "the numbers to the lines the content numbers.";
export const SWEEP_TO_A_TOOL =
  "Be efficient: prefer few, well-chosen tool calls, and hand a sweep across many files to a tool " +
  "built for it rather than searching by hand.";

/** The most queries one find, search or sql call carries. */
export const BATCH_MAX = 16;

/** Independent calls in one reply. Measured 2026-09-26 on the live demo: a
 * caller issued 25 index calls one per turn, each turn re-sending the whole
 * transcript, where one call with `queries` or several calls side by side
 * would have run them at the same time. The reads it makes after the index
 * has named the files are the same shape. One sentence, shared by the
 * instructions and the three tools' own text. */
export const CALLS_TOGETHER =
  "Independent calls go in one reply, never one per turn: several finds, searches or statements as one " +
  "call with queries, or side by side; and once the index has named the files, read them with read, " +
  "every path in one call, never one Read per file.";

/** The tools' names as a client lists them, not as these instructions write
 * them. The instructions and every tool text say "search", "sql", "find" - the
 * bare names - and Claude Code registers each tool as `mcp__code-context__<name>`;
 * a model that copies the bare name is refused ("No such tool available:
 * sql"), spends the turn, and calls again under the full name. Measured on
 * the demo's Wikipedia runs, 2026-10-03: 4 of some 60 Infino arms in ninety
 * minutes, up to three refusals in one run (the owner: "it should say
 * infino:sql why is it just saying sql"). One sentence at the end of every
 * variant of the instructions (`withListedNames`), since the instructions are
 * fixed before the client has named itself. */
export const CALL_BY_LISTED_NAME =
  "Call each tool by the name your client lists for it - in Claude Code that is mcp__code-context__search, " +
  "mcp__code-context__sql, mcp__code-context__find and so on - never by the bare name written here, which " +
  "the client refuses as no such tool.";

/** The instructions with `CALL_BY_LISTED_NAME` as their last line. */
export function withListedNames(instructions: string): string {
  return `${instructions}\n${CALL_BY_LISTED_NAME}`;
}

/** The order among the tools a model holds beside this server's: the index
 * first. Claude Code's own prompt prefers dedicated file and search tools
 * over shell commands, and Grep and Glob are as dedicated as ours, so
 * nothing the model read ranked them - a code question still went to Bash
 * again and again beside its index calls. One sentence sets the order and names
 * the tools this server actually registers; Read keeps its place, the tool
 * for a hit marked truncated. A rows table has no files behind it and does
 * not carry the sentence. */
/** How a definition is found with an exact-text tool: by the bare name with
 * `defines`, never by a signature the model has composed. Told in find's
 * description, and again in the result when a find for a phrase or a
 * signature comes back empty (`findHint`) - the moment the model would
 * otherwise reach for a regex grep. */
export const FIND_BY_BARE_NAME =
  "Find a definition by its bare name with defines - `refresh(` lists every refresh declared - never by " +
  "a signature you have composed: find matches characters, so a guessed line matches nothing.";

/** The count per project (the first path segment) or per file, as one sql
 * statement over the unranked complete match: what a model otherwise writes
 * as `rg | awk | sort | uniq -c` in the shell (the demo, 2026-09-27: "how
 * does each project cache..." went to a five-stage pipeline for exactly this
 * table). Told in find's description and again on a flood. */
export const PER_PROJECT_COUNT =
  "SELECT split_part(path,'/',1) AS project, count(*) AS lines FROM token_match('chunks','content','<the " +
  "term>','and') GROUP BY 1 ORDER BY 2 DESC (GROUP BY path for the count per file).";

/** The form a find carries its matches in, from what the caller set. Given
 * neither chunks nor context, each match comes in its block trimmed to
 * AUTO_CHUNK_CONTEXT lines around it - the comment above it and the lines
 * below - rather than as the matching line alone: a question about what each
 * match does or relies on is answered by those lines, and a caller handed
 * the bare lines reads a window per match to find them. Tool text saying
 * when to set chunks is not followed by every model; a default applies to
 * all of them. Either option set is the caller's choice and stands: chunks false is the
 * matching line alone (with context, grep's -B/-A lines), chunks true the
 * whole block. `aroundByDefault` is set when the default applied, so the
 * result can say so and name the other forms. */
export function findForm(
  chunks: boolean | undefined,
  context: number | undefined,
): { chunks?: boolean; context?: number; aroundByDefault?: number } {
  if (chunks === undefined && context === undefined) {
    return { chunks: true, context: AUTO_CHUNK_CONTEXT, aroundByDefault: AUTO_CHUNK_CONTEXT };
  }
  return { chunks, context };
}

/** The hint on an empty find, or null when the result needs none: a query
 * with spaces is a phrase or a signature, which one exact line may never
 * hold; with `defines` on and nothing found, the name itself is in doubt.
 * A bare identifier that is simply absent gets no hint - zero is the answer. */
export function findHint(
  query: string,
  total: number,
  defines: boolean,
  withText = total,
  listed = total,
  blocks = false,
  pages?: number[],
  skip = 0,
): string | null {
  // Pages: the result names where each following page starts, so the rest
  // is one reply of finds with skip - not one find per file, and never a
  // read per line.
  if (pages && pages.length > 0) {
    const tail = pages.length >= MAX_FIND_PAGES ? " The last of them names where the next pages start." : "";
    return (
      `This result carried ${withText} of the ${total} matching lines${blocks ? " with their blocks" : " with their text"}. ` +
      `For the rest, find again with the same query and options and skip set to each of ${pages.join(", ")} - all ` +
      `of them in the same reply, one call each; together they carry every remaining match, so no find per file ` +
      `is needed.${tail} A saved result is not for the shell to read.`
    );
  }
  // A flood: the counts are complete, every place within the limit is
  // listed, and the text of the rest is one sql away - never the shell over
  // a saved result (the demo, 2026-09-24: a 58,000-character find went to a
  // file and Bash read it).
  // A page from `skip` answers for the matches from there on: the last page
  // carries all of those, and the ones before it came on earlier pages, so
  // it needs no hint sending the caller back for them.
  const from = Math.min(Math.max(0, skip), total);
  if (total - from > withText) {
    const beyond =
      total - from > listed ? ` ${total - from - listed} more are in the total and the per-file counts but not listed.` : "";
    // A chunks find past its budget: the rest's blocks are one more chunks
    // find away, not a read per line.
    if (blocks) {
      return (
        `${withText} of ${total} matching lines came with their block; the rest are listed by path and line after ` +
        `them.${beyond} For their blocks, find again with chunks and skip. A saved result is not for the shell to read.`
      );
    }
    return (
      `${withText} of ${total} lines carry their text; the rest are listed by path and line after them.${beyond} ` +
      "For a line's text, sql: SELECT start_line, content FROM the table WHERE path = '...' AND start_line <= " +
      "<line> AND end_line >= <line>. To see less, narrow the terms or add under; to count per file or per " +
      "project, sql: " +
      PER_PROJECT_COUNT +
      " A saved result is not for the shell to read."
    );
  }
  if (total > 0) return null;
  const words = query.trim().split(/\s+/);
  if (words.length > 1) {
    const name = /[A-Za-z_][A-Za-z0-9_]*\s*\(/.exec(query)?.[0].replace(/\s+/g, "") ?? null;
    return (
      "No line holds this exact text. " +
      (name
        ? `For the declaration, find the bare name with defines: query "${name}", defines: true. `
        : "For a definition, find the bare name with defines. ") +
      "For words that may not sit on one line, use search."
    );
  }
  if (defines) return `Nothing declares "${query}". Check the name: find it without defines to see where it is used, or search for what it does.`;
  return null;
}

/** What `sql` says about itself when the card and the verdict are tools
 * rather than parts of it (CX_API_TOOLS). */
const API_TOOLS_SQL_NOTE =
  " The result is the rows alone: read the table's measured shape with table_card before your first " +
  "statement, and check a result against the question with validate.";

/** The routing lines for the platform's routes offered as tools: the card,
 * the retrieval check, and - over a code table - the citation pass. */
export function apiToolsInstruction(rows: boolean): string {
  return (
    "\n- table_card - what a model needs to know about the table before its first query: its columns with " +
    "their index roles, per-column statistics and sample rows, as the platform measured them. Call it once, first.\n" +
    "- join_keys - the keys two or more tables join on, found on their values: name the tables, get each join's " +
    "ON clause ready to paste. Call it before writing a statement across tables; never guess a key from a column name.\n" +
    "- validate - did this result answer this question? The same check the platform's own retrieval loop " +
    "gates itself on: pass the question, the statement that ran and the rows it returned; a refusal names " +
    "the question's terms the index does not hold (do not search for those again) and a statement to run instead.\n" +
    (rows
      ? ""
      : "- cite - check the citations of the answer you drafted against the index: each path:line is " +
        "repaired where the index says it belongs and each cited sentence is graded against its lines. " +
        "Run it on your draft before you reply, and reply with the answer it returns.\n")
  );
}

/** Whether an index is an index of logs: more of its chunks are log windows
 * than anything else. The chunker tags `.log`, `.out` and `.err` files
 * `log`. */
export function isLogIndex(manifest: { languages?: Record<string, number>; chunks?: number } | undefined): boolean {
  const logs = manifest?.languages?.log ?? 0;
  const total = manifest?.chunks ?? Object.values(manifest?.languages ?? {}).reduce((n, c) => n + c, 0);
  return logs > 0 && logs * 2 > total;
}

/** What the instructions say for one shape of index - a code checkout, a
 * directory of logs, a hosted table of another shape, a table the platform
 * could not describe: the opening frame, the tool lines in the order the
 * shape wants them read, what comes before the sweep sentence, what a hit
 * is and how it is cited, and the closing clauses. One builder,
 * `instructionsFor`, lays every shape out the same way, so a sentence every
 * shape needs - the sweep, the counts, the choosing among several tables,
 * the describe_columns line - is added once and reaches them all. Four
 * separate texts, each edited where a failure showed, drift apart. Each
 * shape's own sentences are kept as they were; what the shapes share is said
 * once. */
export interface InstructionSurface {
  /** The opening, ending in a period: what code-context is an index of and
   * what the first move is. The builder follows it with the choosing
   * sentence when the index spans several tables, then the tool lines. */
  frame: string;
  /** The tool lines, each `- name - ...` ending in a newline, in the order
   * the shape wants them read; empty for a shape with nothing to route. */
  doors: string[];
  /** What is said between the tool lines and the sweep sentence: the
   * index-first sentence of a checkout, the start-with paragraph of the
   * logs; ends in a newline, or is empty. */
  beforeSweep: string;
  /** What a hit is and how a place is cited, ending in a period; empty for
   * a shape with no hits. */
  hits: string;
  /** The closing sentences, each ending in a period. */
  tail: string[];
  /** Said after the sweep sentence, on its line: how independent calls are
   * made together (`CALLS_TOGETHER`), where the shape's tools batch. */
  afterSweep?: string;
}

/** What a surface is built with beyond its shape: whether describe_columns
 * is registered. */
export interface SurfaceOptions {
  describeColumns?: boolean;
}

/** The instructions for `surface`, the one layout every shape takes: the
 * frame, the choosing sentence when the index spans several tables, "Which
 * tool for which question", the tool lines, what comes before the sweep,
 * the sweep sentence, the hits sentence and the closing clauses. A surface
 * with no tool lines is its frame alone. */
export function instructionsFor(surface: InstructionSurface, siblings: readonly string[] = [], hostFiles = true): string {
  // A server that reads no files on its host (`hostFiles`, false over
  // HTTP) offers no 'path', so its text names none.
  const offersPath = (sentence: string): boolean => sentence === PATH_OPTION_CODE || sentence === PATH_OPTION_ROWS;
  const frame = hostFiles ? surface.frame : surface.frame.replace(` ${PATH_OPTION_ROWS}`, "");
  if (surface.doors.length === 0) return frame;
  const several = siblings.length > 0 ? SEVERAL_TABLES_SENTENCE : "";
  const closing = [surface.hits, ...surface.tail.filter((sentence) => hostFiles || !offersPath(sentence))]
    .filter((sentence) => sentence !== "")
    .join(" ");
  return (
    `${frame}${several} Which tool for which question:\n` +
    surface.doors.join("") +
    surface.beforeSweep +
    `${SWEEP_TO_A_TOOL}${surface.afterSweep ? ` ${surface.afterSweep}` : ""}\n` +
    closing
  );
}

/** The optional root every tool takes, as a checkout's text says it. */
const PATH_OPTION_CODE = "Every tool takes an optional 'path' (an absolute repo root) to target another repository.";
/** The same option as a hosted table's text says it: a repository's local
 * index stands in for the table. */
const PATH_OPTION_ROWS =
  "Every tool takes an optional 'path' (an absolute repo root) to target a repository instead, whose local " +
  "code index it then reads.";
/** What a `partial` marker on a result means, over an index with a file cap. */
const PARTIAL_MARKER_SENTENCE =
  "A 'partial' marker means files over the index cap were left out, so a missing match is not proof of absence.";
/** The describe_columns line, one wording over every shape whose sql text
 * folds a laid-out card in. */
export const DESCRIBE_COLUMNS_LINE =
  "- describe_columns - the entries of a wide table's columns the sql text maps rather than lists, whole, " +
  "and on a table whose card names a `kind_column` which kinds of record hold a value in each column: by a " +
  "family's prefix (`property_*`), a column's name, or `*`; call it before a statement names a mapped " +
  "column, and before counting a column of a table with a `kind_column`.\n";

/** The surface of a code checkout. Told nothing, the model's first move is
 * ls and cat CLAUDE.md, before any of these tools: it looks around a
 * checkout it knows nothing about. It has been told: the table's columns, what is in it and how to read it are in the
 * sql tool's text, so the looking around is named as not needed. */
export function codeSurface(table: string, siblings: readonly string[], options: SurfaceOptions = {}): InstructionSurface {
  const { describeColumns = false } = options;
  return {
    frame:
      "code-context is a local index of this repository: every file's lines are in it" +
      (siblings.length > 0
        ? `, and beside it in the same database the tables ${siblings.join(", ")}, which one sql statement joins with it`
        : "") +
      ", and what the repository holds is in the sql tool's text, so begin with these tools, not with ls, " +
      "cat or a look at CLAUDE.md.",
    doors: [
      "- find - every line containing an exact string, where you would grep.\n",
      "- search - how does X work, where is Y handled, code by meaning.\n",
      "- sql - counts, rankings, and aggregates across the repo, " +
        "Ranking files by how much of them is about a topic goes through hybrid_search, not bm25, when the " +
        "topic is a concept; a total over a search relation is the top k's matched lines, never a file's " +
        "length - sizes and whole-repo counts come from the chunks table with no search function.\n",
      "- read - the numbered lines of the files the index named, several paths in one call; a range with from and to.\n",
      ...(describeColumns ? [DESCRIBE_COLUMNS_LINE] : []),
    ],
    beforeSweep: `${indexFirst(table)}\n`,
    hits:
      "Hits carry the code: when a hit answers the question, answer from it. A hit's content shows " +
      "each line with its own number in the file, so cite a place as path:line or path:start-end " +
      "from those numbers and only where the thing you name sits - never the hit's whole line " +
      "range, which spans the chunk.",
    tail: [
      CITE_EXACTLY,
      CITE_FROM_HIT.trim(),
      COUNTS_IN_THE_ANSWER,
      "Read the files the index named with read, every path in one call; Claude's own Read only for a hit marked truncated.",
      PATH_OPTION_CODE,
      PARTIAL_MARKER_SENTENCE,
    ],
    afterSweep: CALLS_TOGETHER,
  };
}

/** The instructions of a code checkout (`codeSurface`). */
export function codeInstructions(table: string, siblings: readonly string[], options: SurfaceOptions = {}): string {
  return instructionsFor(codeSurface(table, siblings, options), siblings);
}

/** The surface of an index of log files, in the words of the thing
 * indexed. The code instructions say "this repository" and "code", and on
 * the demo's CI-logs corpus (2026-09-23) Opus read a folder of `.log` files
 * as not that: three arms, three Bash-only runs, zero calls to find,
 * search or sql, with "Look with the index first" in front of it. So: the
 * tools named for logs, find and sql first, and the one thing not to do
 * said plainly. */
export function logSurface(files: number, chunks: number): InstructionSurface {
  return {
    frame:
      `code-context is an index of the ${files} log files in this directory - every line of every log, in ` +
      // Told nothing, the first move is `ls -S` of the directory and then a
      // run of Bash calls with none of these tools; it is told the looking
      // around is not needed.
      `${chunks} windows. Begin with these tools, not with ls or a look at the directory: what the logs hold ` +
      "is here.",
    doors: [
      "- find - every line in every log containing an exact string (an error text, a test name, a step name), " +
        "with the count per log, and with context the lines around each - what grep -B/-A shows. Where you would " +
        "grep, use this.\n",
      "- search - which log windows are about X: exact terms and meaning in one ranked pass over every log.\n",
      "- sql - counts and rankings across the logs in one statement: which logs mention X and how many lines " +
        "each (rank through bm25_search or hybrid_search over the chunks table and GROUP BY path) - and the lines " +
        "themselves: what fills a log, how often a pattern occurs, the kinds of error. The statements are in the " +
        "sql tool's text; they replace the shell's grep, cut, sort and uniq.\n",
    ],
    beforeSweep:
      "Start with find or sql - a literal, a count, a ranking across the logs. " +
      "Do not open, read or grep the log files with Bash, Grep or Read: the index holds every line of every log " +
      "and answers in one call, and a single log here can run to tens of thousands of lines. A hit marked " +
      "truncated is its window, one sql statement away. A find that lists places without their text is a flood: every place is " +
      "listed, the text of any line is one sql statement away, and the next move is narrower terms, under, " +
      "or a count with sql - never the shell.\n",
    hits:
      "Hits carry the lines: when a hit answers the question, answer from it. A hit's content shows each line " +
      "with its own number in the file, so cite a place as path:line or path:start-end from those numbers and " +
      "only where the thing you name sits - never the hit's whole line range, which spans the window.",
    tail: [CITE_EXACTLY, CITE_FROM_HIT.trim(), COUNTS_IN_THE_ANSWER, PARTIAL_MARKER_SENTENCE],
  };
}

/** The instructions of an index of logs (`logSurface`). */
export function logIndexInstructions(files: number, chunks: number): string {
  return instructionsFor(logSurface(files, chunks));
}

/** What `sql` says about the sibling tables: each one's columns as the
 * platform describes them, its indexed text and vector columns, that a
 * statement across them is one call, where the keys come from, and the
 * deployment's own words beyond those. No key is written here: from this
 * morning until 2026-09-24 afternoon the text carried the corpus's real
 * keys, first typed by hand, then computed at startup, and the model never
 * had to find one (the owner: "you doctored the demo?"). The keys are the
 * join_keys tool's to return when the model calls it. */
/** The one rule a model with sibling tables is held to, as the owner wrote
 * it (2026-09-24). Stated as a rule, in the sql text and the instructions,
 * because the softer "call join_keys first" was measured skipped. */
export const JOIN_KEYS_RULE = "YOU MUST CALL join_keys BEFORE ANY sql CALL IF THE QUERY INVOLVES MORE THAN ONE TABLE.";

/** The graph the platform keeps over these tables - every row linked to
 * the rows it shares a verified key value with, and to what its text names
 * - and the two functions that walk it, said in the sibling text as rules
 * for WHEN each is the move, with the seed statement written out. A
 * wording that only described the functions went unused: the model wrote
 * the same joins it would write without the graph. The platform's own loop
 * carries the same text. */
export const GRAPH_WALK_SENTENCE =
  " The platform also keeps a graph over these tables: each row is linked to the rows it shares a " +
  "key value with and, where a text column was read, to the names its text mentions (a test, a " +
  "module, an error type), so rows that mention the same thing are linked through it. USE " +
  "graph_walk, NOT A JOIN, WHEN THE QUESTION STARTS FROM PARTICULAR ROWS AND ASKS WHAT IS " +
  "CONNECTED TO THEM across more than one table or more than one link: the log of an issue and " +
  "the code that log names, the issues that mention the same failing test or module as these, " +
  "the code behind these failures. First get the seeds - SELECT _id, ... FROM <table> WHERE ... - " +
  "then SELECT * FROM graph_walk('<table to return>', '<table of the seeds>', [<_id>, ...], hops, " +
  "k): the rows of that table within `hops` links of the seeds, with their columns and a score, " +
  "the hop count; two hops is one shared key or one shared mention, four is two. USE graph_rank " +
  "WITH THE SAME ARGUMENTS WHEN THE QUESTION ASKS WHICH ROWS MATTER MOST FOR THOSE SEEDS - the " +
  "files or tests behind the most of these issues: the same rows ordered by how strongly the " +
  "seeds point at them. Neither needs a join_keys call, and WHERE, GROUP BY and a JOIN compose " +
  "with both like with a search.";

/** Whether a statement over `primary` and its siblings can have a search in
 * it: some table among them has a full-text column, or could not be
 * described and may. `primary` is null for the chunks table, which always
 * has one, and for a primary that could not be described, which may. Without
 * any, the JOIN the sibling texts write is over the tables
 * themselves - the Berka tables (2026-10-01), eight of numbers and codes
 * hydrated with no full-text index, would have been shown a hybrid_search
 * over a column none of them has. */
export function siblingsSearchable(primary: TableShape | null, siblings: TableShape[], unresolved: string[]): boolean {
  return !primary || primary.primaryText !== "" || unresolved.length > 0 || siblings.some((s) => s.primaryText !== "");
}

/** What a card says a table and its columns mean, in a line: the dataset's
 * context from the semantic layer, then each column its card describes or
 * decodes - its synonyms, its description, and what its codes stand for.
 * Empty for a card that says none of these. Written for a sibling table,
 * whose whole card would not fit beside the primary's: the measured
 * statistics and sample rows stay with the primary. */
export function cardMeanings(card: RowRecord | undefined): string {
  if (!card) return "";
  const source = card.data_source as { context?: unknown } | undefined;
  const context = typeof source?.context === "string" ? source.context.trim() : "";
  const columns = (Array.isArray(card.schema) ? card.schema : [])
    .map((col: Record<string, unknown>) => {
      const synonyms = Array.isArray(col.synonyms) ? col.synonyms.filter((s) => typeof s === "string") : [];
      const description = typeof col.description === "string" ? col.description : "";
      // A text column's sections and the markers that begin them, when the
      // card has them: what a value is made of, which its description alone
      // does not say.
      const structure = typeof col.structure === "string" ? col.structure : "";
      const values = col.values && typeof col.values === "object" ? Object.entries(col.values as Record<string, unknown>) : [];
      const codes = values.map(([code, meaning]) => `${JSON.stringify(code)} = ${String(meaning)}`).join("; ");
      const said = [description, structure ? `structure: ${structure}` : "", codes ? `codes: ${codes}` : ""]
        .filter(Boolean)
        .join(", ");
      return said ? `${String(col.name)}${synonyms.length ? ` (${synonyms.join(", ")})` : ""}: ${said}` : "";
    })
    .filter(Boolean);
  return [context, columns.length ? `Columns - ${columns.join("; ")}.` : ""].filter(Boolean).join(" ");
}

/** Whether a card carries the model-written semantic layer - the dataset's
 * description, or a column's. The lean card a missing enriched one falls
 * back to carries neither. */
export function carriesSemantics(card: RowRecord | undefined): boolean {
  if (!card) return false;
  if (card.data_source && typeof card.data_source === "object") return true;
  const schema = Array.isArray(card.schema) ? card.schema : [];
  return schema.some((col: Record<string, unknown>) => typeof col?.description === "string" && col.description !== "");
}

export function siblingsNote(table: string, siblings: TableShape[], unresolved: string[], searchable = true, semantics = false): string {
  const described = siblings.map(
    (s) =>
      `${s.table}(${siblingColumnList(s)})` +
      (s.textColumns.length ? `, full-text indexed on ${s.textColumns.join(", ")}` : "") +
      (s.vectorColumn ? `, vector column ${s.vectorColumn}` : ""),
  );
  // With the semantic layer folded in, each sibling's meanings follow the
  // list - the primary's ride in its card at the end of the text.
  const meanings = semantics
    ? siblings
        .map((s) => [s.table, cardMeanings(s.card)] as const)
        .filter(([, said]) => said !== "")
        .map(([name, said]) => `${name}: ${said}`)
    : [];
  const partner = siblings[0]?.table ?? table;
  return (
    // The rule first, in the owner's words (2026-09-24, after Opus was
    // measured twice writing a cross-table statement with no join_keys
    // call: "it's not forceful enough").
    ` ${JOIN_KEYS_RULE}` +
    ` Also in this database, and joinable with ${table} in one statement: ${described.join("; ")}.` +
    // The same sentence the loop reads over several tables: a question may
    // be about any one of them, and a statement over that table alone is
    // the answer when it is.
    SEVERAL_TABLES_SENTENCE +
    (unresolved.length ? ` (${unresolved.join(", ")} could not be described when this server started; name them by their columns as you know them.)` : "") +
    ` Every statement here runs on the platform, so a JOIN, a subquery or a UNION across these tables is one call, ` +
    (searchable
      ? `and the search functions take any of them as their first argument and their rows join like a table's: `
      : `and none of these tables has a full-text column, so the JOIN is over the tables themselves: `) +
    // The join is the move, written out as a shape: a model that had the
    // tables still answered one table at a time and read the rest from
    // files (the owner, 2026-09-24: "i don't think opus or the models are
    // using joins. that's the key advantage we have we have to be explicit").
    `write the JOIN - FROM ${searchable ? `hybrid_search('${partner}', '<text column>', '<terms>', 'embedding', {{q}}, 50) AS ${partner}` : partner} ` +
    `JOIN ${table} ON <the predicate join_keys returned> WHERE ... - and not one query per table. ` +
    // The semantic layer names the keys in its descriptions (the owner,
    // 2026-10-01: "everything, keys included"), so with it folded in the
    // text no longer says they are absent; the predicate is still
    // join_keys's to return.
    (semantics
      ? "Call join_keys with the tables first and paste its predicate into ON."
      : "The keys are not written here: call join_keys with the tables first and paste its predicate into ON.") +
    GRAPH_WALK_SENTENCE +
    CONNECTED_SENTENCE +
    (meanings.length ? ` What the other tables hold, from their cards: ${meanings.join(" ")}` : "")
  );
}

/** The routing line for a server with sibling tables. `searchable` is
 * `siblingsSearchable`'s answer: without a full-text column among the
 * tables, the JOIN has no search functions to hold. */
export function siblingsInstruction(table: string, siblings: string[], searchable = true): string {
  const names = siblings.join(", ");
  // The keys are join_keys's to return, never written here or in the sql
  // text, so a statement across tables never guesses a key from a column
  // name and never reads one we typed.
  // "Sees every one of them": it said "all three", the count of the corpus
  // it was written on, and the Berka corpus has eight tables.
  // A question about one of the tables alone is a statement over that table
  // alone, whichever it is: the text describes every one of them, and a
  // reader who asks about the second table is not sent through the first.
  const anyOne =
    ` A question about one of these tables alone is answered over that table alone, whichever of ${table}, ${names} ` +
    "it is: every one of them is described in the sql tool's text, and a wide one's mapped columns are one " +
    "describe_columns away.";
  return (
    `\n- ${JOIN_KEYS_RULE} sql also joins ${table} with ${names} in one statement - a question that touches two of these tables ` +
        `is one JOIN, ${searchable ? "with the search functions inside it, " : ""}not one query per table and not a walk through ` +
        "files: call join_keys with the tables for the keys, then write the JOIN; their columns and the " +
        `statement's shape are in the sql tool's text.${anyOne}${GRAPH_ROUTING_LINE}\n`
  );
}

/** What a result carries that the model never asked for: the graph's
 * addition (core/graph-expand.ts), named so the model reads it before
 * writing another statement to reach the same rows. */
export const CONNECTED_SENTENCE =
  " A search's or a statement's result over one of these tables also carries `connected`: the rows of the " +
  "other tables the platform's graph links to the result's rows, strongest first, each named by its table. " +
  "Read them before writing another statement to reach them.";

/** The routing form of `GRAPH_WALK_SENTENCE`, beside the join rule in the
 * instructions as that rule is: which questions are a walk or a rank in
 * sql rather than a chain of joins. The sql tool's text has the how. */
export const GRAPH_ROUTING_LINE =
  " A question that starts from particular rows and asks what is connected to them across these tables - " +
  "the log of an issue and the code it names, the rows that mention the same thing - is graph_walk in sql, " +
  "not a chain of joins; which rows matter most for those rows is graph_rank. The sql tool's text says how.";

export function indexFirst(table = "chunks"): string {
  const tools = "find, search and sql";
  // "only for what the index could not give you" left the model the judge
  // of what the index gives, and it judged reading a file's lines as not
  // that: a run ranks the longest test logs with one sql JOIN and then reads
  // the logs with Bash - wc, grep, tail and sed - when their lines are one
  // statement away. So the statement is written out, and the file tools are
  // named as not the way to read.
  return (
    `Look with the index first: ${tools} cover every file in one call and return the lines themselves, ` +
    "the files they name are one read away, every path in one call, " +
    `and the lines of any file or row are one sql statement away (SELECT start_line, content FROM ${table} ` +
    "WHERE path = '...' ORDER BY start_line), and ranked when you want the lines about something rather " +
    `than all of them - hybrid_search, bm25_search or vector_search inside the statement (SELECT path, ` +
    `start_line, content FROM hybrid_search('${table}', 'content', '<terms>', 'embedding', {{q}}, 50) ` +
    "WHERE ...). Do not open the checkout with Grep, Glob, Bash or Read for what they can answer."
  );
}

/** What an answer cites a row of a table by, by the owner's rule
 * (2026-10-01: "either have those ids be links or not show them on non-code
 * corpora"): a table with a link column (`linkColumn`) cites a row as a
 * markdown link to it, the row's name as the text; a table without one cites
 * no row by an id. Until then every rows text said "cite a row by its <key>",
 * and on the Wikipedia table, keyed by the engine's `_id`, the answer printed
 * 32-digit ids in parentheses as inline code, which name nothing a reader can
 * open. The key stays the lookup - the whole of a row is one sql away by it
 * (`citeRows`) - and is never the citation. A code table cites path:line and
 * never reads this. */
export function rowCitation(shape: TableShape): string {
  const { keyColumn: key, linkColumn: link, titleColumn: title } = shape;
  const ids = key === ENGINE_ID_COLUMN ? `its ${ENGINE_ID_COLUMN}` : `its ${key} or ${ENGINE_ID_COLUMN}`;
  if (link) {
    const text = title ? `its ${title} as the text - [<${title}>](<${link}>) -` : `words naming the row as the text - [<the row>](<${link}>) -`;
    // A row held without its link - an aggregate's, or a statement's that
    // selected other columns - is named, never linked: a link the rows did
    // not carry is one the model made up from the row's name.
  return (
      `Cite a row as a markdown link to its ${link}, with ${text} never by an id such as ${ids}. ` +
      `A row that came without its ${link} is named by ${title ? `its ${title}` : "its own values"}, never given a link it did not carry.`
    );
  }
  return `Cite no row by an id: ${ids} looks a row up and never goes in the answer as a reference - answer with the rows' own values.`;
}

/** The `projection` the platform's loop is asked for over a table of rows:
 * the columns every search and find fact it returns carries in place of the
 * table's own keys (the platform's worker sets them as the keys). The
 * table's key, so a fact can be looked up by it; and where the table has a
 * link column, the link and the row's name, so a fact can be cited as its
 * link (`rowCitation`). Without them the loop's search and find facts on the
 * Wikipedia table came back as the engine's `_id`, the searched text and a
 * score (2026-10-01): the caller was told to cite a row as its url and held
 * none. The engine's `_id` is never named - it is no column of the table's,
 * and the platform refuses a projection naming none of a table's columns -
 * so a table with no key of its own and no link sends none, and the loop
 * gives each fact the row id itself. */
export function rowsProjection(shape: TableShape): string[] {
  const { keyColumn: key, linkColumn: link, titleColumn: title } = shape;
  const named = [key === ENGINE_ID_COLUMN ? null : key, link, link ? title : null];
  return [...new Set(named.filter((name): name is string => name !== null))];
}

/** How an answer names a row and where the rest of the row is: the sentence
 * the instructions and the search text share. `from` is what the
 * caller holds - a search's hits, or the rows of a table that has none. */
function citeRows(shape: TableShape, from = "hits"): string {
  return (
    `Answer from the ${from}. ${rowCitation(shape)} The whole of a row is one sql away ` +
    `(SELECT * FROM ${shape.table} WHERE ${shape.keyColumn} = '...').`
  );
}

/** What stands in for find, search and the search functions on a table with
 * no full-text column, said in the routing where they would have been named:
 * neither door is offered there (the engine refuses a token match or a BM25
 * search over a column with no index), and a statement filters, groups and
 * joins the columns - or ranks by meaning alone, when the platform embeds
 * one. The Berka tables (2026-10-01) are eight of numbers and codes,
 * hydrated with no full-text index and no vector. */
function noFullTextSentence(shape: TableShape): string {
  const { table, vectorColumn } = shape;
  return (
    `No column of ${table} is full-text indexed, so there is no find or search over it` +
    (vectorColumn
      ? `; vector_search('${table}','${vectorColumn}', {{q:"..."}}, k) ranks its rows by meaning alone, and the rest is ` +
        "filtering, grouping and joining its columns."
      : " and no search function in a statement: filter, group and join its columns.")
  );
}

/** The surface of a hosted table of another shape, built from the shape:
 * the doors named with the table's own columns. */
export function rowsSurface(shape: TableShape, siblings: readonly string[], options: SurfaceOptions = {}): InstructionSurface {
  const { describeColumns = false } = options;
  const { table, keyColumn: key, primaryText: text, vectorColumn } = shape;
  const rowIs = shape.chunking ? `one row per passage of a record's ${shape.chunking.column}` : "one row per record";
  // With tables beside it the index is of all of them, said so: an index
  // "of the X table" with the others as its joinable siblings sent every
  // question through X, and a question about the table beside it was
  // answered from X's empty columns. The sentence on choosing among them
  // is the builder's, after the frame.
  const indexOf =
    siblings.length > 0
      ? `code-context is an index of the tables ${[table, ...siblings].join(", ")}, one database, ${rowIs} in each.`
      : `code-context is an index of the ${table} table, ${rowIs}.`;
  return {
    frame: indexOf,
    doors: [
      // A table with no full-text column is offered neither door (see
      // `searchDoors` in serveMcp), so the routing names neither.
      ...(text
        ? [
            `- find - every row whose ${text} holds every word of an exact phrase, where you would grep: complete ` +
              "and unranked, with the table-wide count.\n",
            `- search - which rows are about X: exact terms and meaning in one ranked pass over ${text}.\n`,
          ]
        : []),
      "- sql - one statement you already know: a count, a filter, a lookup by " +
        `${key}, a ranking in one SELECT. ` +
        // The rule for hybrid against keyword, where there is a vector to rank
        // by; the terms-only wording stands where there is not.
        (text && vectorColumn
          ? `${SEARCH_RULE_SENTENCE.trimEnd()}\n`
          : text
          ? "Ranking rows by how much they are about a topic goes through " +
            "hybrid_search, not bm25, when the topic is a concept; a total over a search relation counts the top " +
            `k, never the table - a complete count comes from token_match, a WHERE, or the ${table} table with no ` +
            "search function.\n"
          : `${noFullTextSentence(shape)}\n`),
      ...(shape.document ? [`- read - ${readDocumentsSentence(shape).trimEnd()}\n`] : []),
      ...(describeColumns ? [DESCRIBE_COLUMNS_LINE] : []),
    ],
    beforeSweep: "",
    hits: text
      ? `Hits are rows: a score, the row's ${key}, its scalar columns, and its text columns cut to a snippet of ` +
        `${SNIPPET_CHARS} characters. ${citeRows(shape)}`
      : `Rows come back with the columns their statement selected. ${citeRows(shape, "rows")}`,
    tail: [COUNTS_IN_THE_ANSWER, READING_HABITS, ARITHMETIC_SENTENCE, PATH_OPTION_ROWS],
  };
}

/** The instructions of a hosted table of another shape (`rowsSurface`). */
export function rowsInstructions(shape: TableShape, siblings: readonly string[] = []): string {
  return instructionsFor(rowsSurface(shape, siblings), siblings);
}

export function rowsSearchDescription(shape: TableShape): string {
  const { table, keyColumn: key, primaryText: text, vectorColumn, vectorSource } = shape;
  const ranking = vectorColumn
    ? `fusing exact keyword matching over ${text} with semantic similarity over ${vectorColumn} (the platform's ` +
      `embedding of ${vectorSource.join(", ") || text}), so it works whether or not you know the words`
    : `ranked by exact keyword matching (BM25) over ${text} - the table has no embedding column, so use the ` +
      "words the rows use";
  return (
    `Ranked search over the rows of ${table}, ${ranking}. Use it for which rows are about X, rows like ` +
    `this one, the best matches for a description. Each hit is a row: score, ${key}, the scalar columns ` +
    `(${scalarsShown(shape).join(", ")}), and ${textColumnsPhrase(shape)} as snippets of at most ` +
    `${SNIPPET_CHARS} characters. ${citeRows(shape)} When one search is not enough, refine the query and ` +
    "search again. For every row holding an exact phrase use find; for counts, rankings and filters use " +
    `sql. ${readDocumentsSentence(shape)}The result includes a 'usage' field, a one-line receipt of tokens returned and rows.`
  );
}

export function rowsFindDescription(shape: TableShape): string {
  const { table, keyColumn: key, primaryText: text } = shape;
  return (
    `Every row of ${table} whose ${text} holds every word of an exact string, like grep over a table: ` +
    "complete and unranked, with the table-wide total. Matching is by the index's words - case-insensitive, " +
    "whole words, punctuation ignored - so a match holds the words, not necessarily the phrase in that order; " +
    "the literal is not checked character by character as it is over a code index. Use it where you would " +
    `grep: a name, a product, a phrase that must appear. Each match is a row: ${key}, the scalar columns, and ` +
    "the text columns as snippets. ignoreCase, defines and under describe a code index and do nothing here. " +
    `For meaning or 'which rows are about X' use search; for counts and rankings use sql. ${readDocumentsSentence(shape)}` +
    "The result includes a 'usage' field, a one-line receipt of tokens returned and rows."
  );
}

/** Where a whole document is read, said in every rows text of a table of
 * documents (`TableShape.document`); empty for a table of records. Without
 * it a caller pages each document through sql, `chunk BETWEEN 1 AND 10` a
 * statement, many calls a document. */
export function readDocumentsSentence(shape: TableShape): string {
  const document = shape.document;
  if (!document) return "";
  const { pathColumn: path, orderColumn: order } = document;
  return (
    `A whole document - every row sharing a ${path}${order ? `, in ${order} order` : ""} - is one read away, several ` +
    `documents in one call: once a search, find or sql has named the documents, read them with read, never page ` +
    `one through sql${order ? ` by ${order}` : ""}. `
  );
}

/** The `read` tool's description: the numbered lines of the files of a code
 * index, or - over a table of documents - of its documents, each the rows
 * sharing a path joined in order. */
export function readDescription(shape: TableShape | null): string {
  const document = shape?.document;
  const [one, many] = document ? ["document", "documents"] : ["file", "files"];
  const what = document
    ? `The whole text of the documents named - several in one call: a document of ${shape!.table} is every row sharing ` +
      `its ${document.pathColumn}${document.orderColumn ? `, put in ${document.orderColumn} order` : ""} and joined, ` +
      "each row starting a line, and comes back numbered by line, each line as path:line. Use it after find, search " +
      `or sql have named the documents you want, by their ${document.pathColumn}, for every document at once, in ` +
      `place of paging one through sql${document.orderColumn ? ` by ${document.orderColumn}` : ""}. `
    : "The numbered lines of the files named - several files in one call, from the index, each line " +
      "as path:line. Use it after find, search or sql have named the files you want, for every " +
      "file at once, in place of one Read per file. ";
  return (
    what +
    `from and to cut every ${one} to a line range; lists in both name several ranges in one call, paired in order ` +
    "(from [559, 1938], to [610, 1975] reads 559-610 and 1938-1975), for the windows around several places in a " +
    `${one} - never one read per range. A ${one} over ${READ_LINES_CAP} lines, or past the result's budget, comes ` +
    `back a page at a time, with more saying where its next page starts, and the result's next lists the read ` +
    `calls that fetch the rest of every ${one} cut short - make them, all in one reply. A path the ${document ? "table" : "index"} ` +
    `does not hold comes back as a miss beside the others. The result includes a 'usage' field, a one-line receipt ` +
    `of tokens returned and ${many}.`
  );
}

/** The `sql` description for a hosted table of another shape: the table's
 * columns with their types, which are indexed for text (said to be inferred
 * from the schema when no card named them - the type then stands in for the
 * role, and can name a column the platform embeds but does not index) and
 * which the platform embeds, and the search functions with the table's real
 * names - hybrid_search(table, text, terms, vector, {{q:"..."}}, k),
 * bm25_search, vector_search, token_match - each of which returns _id, the
 * table's scalar columns and score. */
export function rowsSqlDescription(shape: TableShape): string {
  const { table, keyColumn: key, primaryText: text, vectorColumn, vectorSource } = shape;
  const scalar = exampleScalar(shape);
  // A card that names no full-text column is a table with no full-text
  // index (the optimizer probed every text column), so the search functions
  // are left out of the text rather than shown with an empty column name.
  const textColumns = textColumnsPhrase(shape);
  const ranked = vectorColumn
    ? `hybrid_search('${table}','${text}','terms','${vectorColumn}', {{q:"..."}}, 300)`
    : `bm25_search('${table}','${text}','terms', 300)`;
  const searchGuide = text
    ? "The search functions are table-valued: a ranked search is a relation, so WHERE, GROUP BY, ORDER BY and " +
    "joins compose with it in one pass, and one query replaces the several round trips of searching, then " +
    "filtering, then counting. Rank through a search relation rather than scanning the whole table - with " +
    `ILIKE, LIKE, regexp_like, or a bare filter on ${scalar}: a scan has no relevance ranking, reads every ` +
    "row, and answers 'contains this substring' when the question asked which rows are about something. " +
    (vectorColumn
      ? `Rank with hybrid_search('${table}','${text}','terms','${vectorColumn}', {{q:"..."}}, k) - 'terms' and ` +
        'the text inside {{q:"..."}} are yours to fill in, not literals to copy - unless you have a reason not ' +
        "to: it fuses exact terms with meaning, so it reaches the rows whether or not the question's words are " +
        "the rows' words, and they rarely are. That covers a concept, a subject, 'rows about X' - the shape of " +
        "almost every ranking question. " +
        RELATED_TO_SENTENCE +
        LANGUAGE_KIND_SENTENCE
      : "") +
    // The one rule for hybrid against keyword (`SEARCH_RULE_SENTENCE`); the
    // sentences after it describe the keyword functions as what the rule
    // leaves them: counting.
    (vectorColumn ? SEARCH_RULE_SENTENCE : "") +
    `bm25_search('${table}','${text}','terms', k) is keyword only: use it only when the user gives an exact ` +
    `phrase and asks how often it occurs in ${text}. ` +
    (vectorColumn ? `vector_search('${table}','${vectorColumn}', {{q:"..."}}, k) is meaning alone. ` : "") +
    `token_match('${table}','${text}','terms','and') is for counting exact words, never for finding rows: ` +
    "every row holding every term, unranked, with no k, so a COUNT over it is the table's count. " +
    severalTermsSentence(table, text) +
    // One sentence, no more: on 2026-09-11 a caller wrote ILIKE '%...%' over
    // the jobs table's 6.7 GB description column three times at 38-45 s each.
    // A longer version of this warning made the caller write many small
    // statements instead. The engine pushes a LIKE on an indexed column
    // into the index, so the fault is not the cost: a letter match finds
    // "eventcoverage" for "rage" and ranks nothing.
    `Never find rows by filtering ${textColumns} with LIKE '%word%' or regexp_like: it matches letters, not ` +
    "meaning, and ranks nothing. " +
    (vectorColumn
      ? 'The {{q:"..."}} placeholder is embedded on the platform with the table\'s own model, so it costs you ' +
        "nothing but the text (a bare {{q}} with the embed map is folded into it). "
      : "") +
    "Every search function returns _id, the table's scalar columns and score, so select and filter them " +
    `directly: SELECT ${key}, ${scalar}, score FROM ${ranked} WHERE ${scalar} = '...' ORDER BY score DESC ` +
    // The whole question as one statement, each clause one job, in the
    // table's own names (the owner, 2026-10-04: "do it"; the code index's
    // text and the inner loop's carry the same shape).
    `LIMIT 20. The whole question as one statement, each clause one job - filter, ${vectorColumn ? "keyword and meaning search (the terms, then the {{q:\"...\"}} text)" : "keyword search"}, ` +
    `group, count - with your own words in place of the example's: SELECT ${scalar}, COUNT(*) AS ranked_rows FROM ` +
    `${ranked} AS ${table} WHERE ${table}.<another scalar column> = '...' GROUP BY ${scalar} ORDER BY ranked_rows DESC LIMIT 15; ` +
    `a second table joins into the same statement (JOIN <other> ON <the predicate join_keys returned>) where the ` +
    "database has one - one call, not a search, then a filter, then a count. When you COUNT over a search: " +
    "the relation holds the top k rows, so the count is the rows that ranked within the top k - report it as " +
    "'rows ranked in the top 300 for <topic>', never the table's count. That limits counting only; finding the " +
    "rows that hold a figure or are about a topic is still the ranked search. A question with no topic in " +
    "it - how many rows, the largest values, a count over the whole " +
    `table - comes from ${table} with no search function: SELECT ${scalar}, COUNT(*) AS rows FROM ${table} ` +
    `GROUP BY ${scalar} ORDER BY rows DESC LIMIT 15. `
    : // With no full-text column the functions that need one - bm25_search,
      // hybrid_search, token_match - are refused by the engine, so none is
      // named; vector_search needs only the embedding, and is named alone
      // where the platform embeds a column.
      (vectorColumn
        ? `No column here is full-text indexed, so of the search functions only vector_search('${table}',` +
          `'${vectorColumn}', {{q:"..."}}, k) applies, ranking rows by meaning alone (the {{q:"..."}} text is ` +
          "embedded on the platform with the table's own model); the rest is plain SQL over the columns above - "
    : "No column here is full-text indexed, so the search functions do not apply to this table: answer from " +
          "plain SQL over the columns above - ") +
      `SELECT ${scalar}, COUNT(*) AS rows FROM ${table} GROUP BY ${scalar} ORDER BY rows DESC LIMIT 15. `;
  // The columns a row is selected with to be cited: its link and its name
  // where the table has a link (`rowCitation`), else the key it is looked
  // up by - which the answer never cites.
  const { linkColumn: link, titleColumn: title } = shape;
  const textGuide = text
    ? `${textColumns} hold long text${/html/i.test(textColumns) ? " (HTML where the name says so)" : ""}: select ` +
      `substr(${text}, 1, 300) rather than the column unless you mean to quote it, and select ` +
      (link ? `${link}${title ? ` and ${title}` : ""} beside it so a row can be cited as its link. ` : `${key} beside it so the row can be looked up. `)
    : "";
  return (
    `Read-only SQL, one SELECT or WITH, over ${table}(${columnList(shape)}) - for counts, rankings, filters ` +
    `and GROUP BY across the whole table. Full-text indexed: ${textColumns}` +
    // Said only of a list there is: with no LargeUtf8 column and no card,
    // there is nothing to have inferred.
    (shape.textColumnsInferred && shape.textColumns.length > 0
      ? " (inferred from the schema - the table has no card naming its indexes yet, so its long-text columns " +
        "are taken as the indexed ones; one the platform only embeds may be among them)"
      : "") +
    ". " +
    chunkingNote(shape.chunking) +
    KEEP_CONDITIONS_SENTENCE +
    ONE_STATEMENT_SENTENCE +
    (vectorColumn
      ? `Vector column: ${vectorColumn}, the platform's embedding of ${vectorSource.join(", ") || text}. `
      : text
      ? "No vector column: rank by terms alone. "
      : "No vector column. ") +
    searchGuide +
    ROWS_REGEX_SENTENCE +
    ROWS_ID_SENTENCE +
    `${ARITHMETIC_SENTENCE} ` +
    (listColumnsShown(shape).length > 0
      ? `A list column (${listColumnsShown(shape).join(", ")}) holds several values per row: filter it with ` +
        `array_has(${listColumnsShown(shape)[0]}, '...') or unnest it, not with equality. `
      : "") +
    readDocumentsSentence(shape) +
    textGuide +
    "The result includes a 'usage' field, a one-line receipt of tokens returned and rows."
  );
}

/** What the default root's doors run against, decided once at startup and
 * never re-asked on a call.
 *
 * - `chunks`: the chunks table this client builds. Every path and constant
 *   as before: find and plain sql on the local index, search on the hosted
 *   index under CX_REMOTE_SEARCH, and a sql statement that embeds a query
 *   on the platform whenever there is one (see the sql tool). The mode of
 *   the default table always, without a probe - it is the table this client
 *   builds, so there is nothing to ask - and the mode without
 *   CX_REMOTE_SEARCH.
 * - `rows`: a hosted table of another shape, whose rows the doors run over
 *   with its own columns; nothing touches the local index.
 * - `unresolved`: CX_TABLE names a table that is not the default and the
 *   platform could not describe it at startup. The rows tools are registered
 *   - the chunks text would name columns the table does not have - and every
 *   call reports the cause, because the alternative, the local path, BUILDS
 *   an index and the build drops and recreates the platform table.
 *
 * One decision for the process rather than a lookup per call: a call that
 * asked the platform first made every local tool wait out a platform outage
 * (the cold-start budget is two minutes), and a startup probe that could miss
 * left the chunks text registered over calls that ran rows. */
export type TableMode = { kind: "chunks" } | { kind: "rows"; shape: TableShape } | { kind: "unresolved"; cause: string };

/** The tool text when the table could not be described (TableMode
 * `unresolved`): the doors are registered for its rows, say what the table
 * is, and say that every call reports the cause - so a model reading the
 * text is not sent to write chunks-shaped SQL against it. */
/** The surface of a table the platform could not describe at startup: the
 * notice alone, no tool lines - every door reports the cause. */
export function unresolvedSurface(table: string, cause: string): InstructionSurface {
  return {
    frame:
      `code-context is an index of the ${table} table on the platform, one row per record. The table could not be ` +
      `described from the platform when this server started (${cause}), so ` +
      "find, search and sql each return that error until the server is restarted with the platform reachable; nothing runs against a " +
      `local index in its place. ${PATH_OPTION_ROWS}`,
    doors: [],
    beforeSweep: "",
    hits: "",
    tail: [],
  };
}

/** The instructions of a table the platform could not describe (`unresolvedSurface`). */
export function unresolvedInstructions(table: string, cause: string): string {
  return instructionsFor(unresolvedSurface(table, cause));
}

export function unresolvedDescription(door: string, table: string): string {
  return (
    `${door} over the rows of the ${table} table on the platform. The table could not be described from the ` +
    "platform when this server started, so every call returns that error (with the cause) until the server is " +
    "restarted with the platform reachable; nothing runs against a local index in its place."
  );
}

/** What a test injects: a transport in place of stdio, the platform
 * client's options (a scripted fetch) for every client the server builds,
 * and a shorter wait on the database's other tables (`STARTUP_BUDGET_MS`). */
export interface ServeOptions {
  transport?: Transport;
  hostedOptions?: HostedOptions;
  /** Offer no tool that writes (`readOnlyEnabled` when absent). */
  readOnly?: boolean;
  /** How much of the account the server reaches (`accountDataScope` when
   * absent). */
  accountData?: AccountDataScope;
  /** The key this session's platform calls carry instead of the configured
   * one (the server over HTTP with sign-in). The repository the server was
   * started for is then not served at all (see `signedIn`). */
  apiKey?: string;
  /** Whether the tools may read files on the machine this server runs on:
   * hydrate's kinds path and ssh, and a query tool's `path` naming any
   * directory but the one the server was started for. False over HTTP,
   * where that machine is not the caller's: its files are the server's own. */
  hostFiles?: boolean;
  startupBudgetMs?: number;
}

/** What a signed-in caller is told when a tool would read the repository
 * the server was started for: the server's own, which the account the
 * caller signed in with holds no copy of. */
const SIGNED_IN_ROOT =
  "this server's own repository is not served to a signed-in account; name a database of your account (tables lists them)";

/** The version the server reports to a client: the package's own, read from
 * the package.json npm ships beside dist/ (src/mcp and dist/mcp are both two
 * levels down), so a release never leaves it behind. */
const PACKAGE_VERSION: string = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;

export async function serveMcp(rootPath?: string, serveOptions: ServeOptions = {}): Promise<void> {
  const { hostedOptions } = serveOptions;
  const readOnly = serveOptions.readOnly ?? readOnlyEnabled();
  const accountScope = serveOptions.accountData ?? accountDataScope();
  const hostFiles = serveOptions.hostFiles ?? true;
  // When the start-up stops waiting on the database's other tables: counted
  // from here, the server's start, as the client counts its own wait.
  const othersDeadline = Date.now() + (serveOptions.startupBudgetMs ?? STARTUP_BUDGET_MS);
  const defaultRoot = resolveRoot(rootPath);
  // With sign-in, every call runs on the caller's account, which holds no
  // copy of this server's repository: the default root carries no platform
  // client, nothing builds or syncs it, and every tool that would read it
  // says so (SIGNED_IN_ROOT). A build would otherwise write this server's
  // chunks into whatever database of the caller's account `--db` names.
  const signedIn = serveOptions.apiKey !== undefined;

  // The platform database (--db <url>), when one is configured: the default
  // root's chunks table also lives there, written by every build and sync
  // beside the local index and read by `search`.
  // Resolved once here - a bad URL or a missing key fails the server at
  // startup, not on the first tool call. The key stays inside the target;
  // only `hostedLabel` ever reaches a log line.
  const configured = hostedTarget();
  const hosted = configured !== null && serveOptions.apiKey !== undefined ? { ...configured, apiKey: serveOptions.apiKey } : configured;
  // The account the target came from, when no --db named a database: then
  // every repository a session opens gets its own database on it (see
  // RepoRegistry), registered here before its first build.
  const account = serveOptions.apiKey !== undefined ? null : hostedAccount();
  // With an account every search runs on the platform's copy, and a hosted
  // table of another shape is read there too: the local index is always
  // lexical (no local vectors), so there is no local search to choose.
  const remoteSearch = hosted !== null;
  // Whether the account may use the agent routes - graph expansion, pages,
  // web fetch, memory recall - read once from the account plane. An account
  // without them answers each of those 403, so none of them is offered or
  // called unless the account says it has them (`accountFeatures`: a
  // refusal, a timeout or a platform without the route all read as no).
  const agentApis =
    hosted !== null
      ? await accountFeatures(
          { baseUrl: hosted.baseUrl, apiKey: hosted.apiKey },
          { ...(hostedOptions?.fetch ? { fetch: hostedOptions.fetch } : {}), timeoutMs: ACCOUNT_FEATURES_TIMEOUT_MS },
        )
          .then((f) => f.agentApis)
          .catch((err) => {
            console.error(`account features unavailable, agent tools off: ${(err as Error).message}`);
            return false;
          })
      : false;

  const noEmbed = Boolean(process.env.CX_NO_EMBED);
  // The local model exists for exactly one job now: `--embed-provider local`
  // computes the vectors the PLATFORM table's embedding column carries.
  // Locally is always lexical (owner, 2026-09-09: "all vector search happens
  // on the cloud"), so nothing here ever runs without an account, and never
  // when the provider is the platform's own model.
  const wantsLocalEmbed = hosted !== null && !noEmbed && embedProvider() === "local";
  let embedder: Embedder | null = null;
  const getEmbedder = (): Embedder | null => (wantsLocalEmbed ? (embedder ??= createEmbedder()) : null);

  // --- per-repo state ---------------------------------------------------------
  // One server serves every repo a session touches: the optional `path` tool
  // arg targets one, defaulting to the startup root. Each repo keeps its own
  // connection, auto-sync clock, and mutation lock, held in a small LRU so a
  // session that roams across many repos doesn't accumulate connections. Only
  // the default root's context carries the platform client (see RepoRegistry),
  // and not under sign-in. Without host files, the default root is the only
  // one served.
  const registry = new RepoRegistry(defaultRoot, {
    connect,
    ...(hosted && !signedIn ? { hosted: { target: hosted, ...(hostedOptions ? { options: hostedOptions } : {}) } } : {}),
    ...(account ? { account } : {}),
    ...(hostFiles ? {} : { defaultOnly: true }),
  });
  const repoFor = (requested?: string): RepoCtx => registry.get(requested);

  // The manifest is re-read per call so staged vector readiness is noticed
  // the moment it lands. A local index built under another analyzer than
  // this engine's (an earlier version's `ascii_lower`, which the engine no
  // longer opens) reads as no index, so the first query rebuilds it the way
  // it builds a missing one, rather than refusing until the next sync.
  const builtByEarlierVersion = (manifest: Manifest): boolean =>
    manifest.origin !== "hosted" && analyzerOf(manifest) !== ENGINE_DEFAULT_ANALYZER;
  const getHandle = (ctx: RepoCtx): IndexHandle | null => {
    if (!existsSync(ctx.dir)) return null;
    const manifest = readManifest(ctx.dir);
    if (!manifest) return null;
    if (builtByEarlierVersion(manifest)) return null;
    return { root: ctx.root, dir: ctx.dir, target: ctx.target, db: ctx.db, manifest };
  };

  /** Whether a root's local index holds `table`. The chunks mode runs find,
   * read and a plain sql on the local index under the table's name, so a
   * table it does not hold is served from the platform's rows instead (see
   * the mode below). A root with no index dir holds nothing. A listing that
   * fails is said on stderr and read as holding the table: the path a built
   * index always took, rather than a mode decided by a passing fault. */
  const localIndexHolds = (ctx: RepoCtx, table: string): boolean => {
    if (!existsSync(ctx.dir)) return false;
    try {
      return ctx.db.listTables().includes(table);
    } catch (err) {
      console.error(`could not list the local index at ${ctx.dir}: ${(err as Error).message}`);
      return true;
    }
  };

  /** The indexer options a build or sync of `ctx` shares: the local index
   * always, and the platform table when the context carries the client - the
   * two are written together, so no path here ever writes one without the
   * other. CX_NO_EMBED means keyword-only in both places, as --no-embed does
   * on the CLI: with no local embedder, the `local` provider gives the
   * platform table no embedding column either. The analyzer is passed only
   * when a flag named one; otherwise a build keeps the table's own. */
  const analyzer = hostedAnalyzer();
  const indexTargets = (ctx: RepoCtx): Pick<IndexOptions, "root" | "db" | "hosted" | "indexDirPath" | "embedProvider" | "analyzer" | "caps"> => ({
    root: ctx.root,
    db: localDb(ctx),
    indexDirPath: ctx.dir,
    caps: DEFAULT_CAPS,
    ...(ctx.hosted
      ? { hosted: ctx.hosted, embedProvider: noEmbed ? "local" : embedProvider(), ...(analyzer !== undefined ? { analyzer } : {}) }
      : {}),
  });

  // --- freshness: one index mutation at a time per repo, auto-sync on queries -
  // Queries are not queued behind syncs; they run against the current index and
  // the next query sees the fresh one. CX_AUTO_SYNC=0 disables; the debounce
  // keeps the stat walk off the hot path (~20ms to ~2s depending on repo size).
  // A sync writes the platform table too, so the two never drift.
  const autoSyncEnabled = !signedIn && autoSyncSetting();
  const syncIntervalMs = Number(process.env.CX_SYNC_INTERVAL_SECS ?? 30) * 1000;
  // A search/sql on a never-indexed repo builds the index inline, then answers
  // on the same call (staged: keyword search live in seconds). Off restores the
  // strict "index it first" error.
  const autoIndexEnabled = !signedIn && autoIndexSetting();

  // A terse, local, factual receipt appended to each query result (tokens
  // returned, files touched, whole-file size it stood in for, session running
  // total). Default on - the trust signal only works when it's there; silence
  // it with CX_NO_RECEIPT. One accumulator per session (this long-lived process).
  const receiptOn = receiptEnabled();
  const session = newSession();
  /** Run an index mutation on a repo exclusively; null if one is in flight,
   * here or in another process (a `cx index` beside this server holds the
   * index's lock file, core/index-lock.ts). `fn` gets the lock, for a build
   * whose completion holds it past this call (`backfill`). */
  const exclusive = <T,>(ctx: RepoCtx, fn: (lock: IndexLock) => Promise<T>): Promise<T> | null => {
    if (ctx.mutation) return null;
    let attempt: LockAttempt;
    try {
      attempt = tryLockIndex(ctx.dir);
    } catch (err) {
      return Promise.reject(err); // an index dir that cannot be written: the caller reports it
    }
    if (!("lock" in attempt)) return null;
    const { lock } = attempt;
    const p = fn(lock).finally(() => {
      ctx.mutation = null;
      lock.release();
    });
    ctx.mutation = p.catch(() => undefined); // guard must not reject
    return p;
  };

  /** Fresh build-scoped embedder: full builds embed in a child process so the
   * bulk pipeline's memory leaves with it (issue #9). Query and sync
   * embedding keep the warm in-process singleton via getEmbedder(). */
  const buildEmbedder = (): Embedder | null => (wantsLocalEmbed ? createIndexingEmbedder() : null);

  /** Let the build finish in-process - vectors backfill (the manifest flips
   * to "ready"), then the platform table loads when one is configured - and
   * release the build's embedder. The rest of the build is held on
   * `ctx.completion` so no sync starts under it and the platform tools can say
   * the table is being loaded. `completion` never rejects by contract, but
   * nothing on this chain may take that on faith - an unhandled rejection
   * here would kill the whole server. A failed platform load is logged: the
   * next sync asks for a build, which retries it. */
  const backfill = (ctx: RepoCtx, run: StagedIndexRun, emb: Embedder | null, lock: IndexLock) => {
    lock.retain();
    const held = run.completion
      .then((stats) => {
        if (stats.hostedError) console.error(`platform load failed for ${ctx.root}: ${stats.hostedError} (the next sync reloads it)`);
      })
      .catch(() => undefined)
      .finally(() => {
        if (ctx.completion === held) ctx.completion = null;
        lock.release();
        void emb?.dispose?.()?.catch(() => undefined);
      });
    ctx.completion = held;
  };

  /** On the stored account, the repository's database has to exist before
   * its table can: registered here once per repository for the server's
   * life, as `cx install` registers it - a name the account already holds is
   * the outcome wanted, not a failure. Nothing to do when `--db` named the
   * database: it was registered by whoever named it. A refusal (a key the
   * platform will not take, an account that cannot spend) fails the build
   * with the platform's words and the fix, and the next query tries again. */
  const registered = new Set<string>();
  const ensureDatabase = async (ctx: RepoCtx): Promise<void> => {
    if (!account || !ctx.hosted || registered.has(ctx.root)) return;
    const database = ctx.hosted.target.database;
    try {
      await createDatabase(account, database, { fetch: hostedOptions?.fetch });
    } catch (err) {
      throw new Error(`could not register the database ${database} on ${account.baseUrl} for ${ctx.root}: ${(err as Error).message}${refusalHint(err)}`);
    }
    registered.add(ctx.root);
  };

  /** Acquire the repo's mutation lock and run a staged build; resolves at
   * keyword-live with stage-1 stats, or null if a build is already in flight.
   * The build's completion (vectors, then the platform table when one is
   * configured) runs on in the background, held on `ctx.completion`. */
  const buildIndex = (ctx: RepoCtx): Promise<IndexStats> | null =>
    exclusive(ctx, async (lock) => {
      await ensureDatabase(ctx);
      const emb = buildEmbedder();
      const run = await indexRepoStaged({ ...indexTargets(ctx), embedder: emb });
      backfill(ctx, run, emb, lock);
      return run.text;
    });

  const doSync = async (ctx: RepoCtx, lock: IndexLock): Promise<SyncOutcome> => {
    await ensureDatabase(ctx);
    const outcome = await syncRepo({ ...indexTargets(ctx), embedder: getEmbedder() });
    // A rebuild for every reason, "a build is already in flight" (the vector
    // stage, or the platform load) among them: this runs under the index's
    // lock, which every writer holds until its build's completion settles,
    // and never under this context's own completion (maybeAutoSync), so a
    // manifest still marked in flight here was left by a build that stopped
    // before it finished (a server killed mid-backfill). Left alone, it
    // would refuse every sync until someone rebuilt it by hand.
    if (outcome.action === "rebuild-required") {
      if (syncInProgress(outcome)) console.error(`${ctx.root}: rebuilding an index whose last build did not finish (${outcome.reason})`);
      const emb = buildEmbedder();
      const run = await indexRepoStaged({ ...indexTargets(ctx), embedder: emb });
      backfill(ctx, run, emb, lock);
    }
    return outcome;
  };

  /** Whether this process may write the platform table a build or sync of
   * `ctx` would write: the context carries no platform client (a repo named
   * by `path` writes its local index alone), or the table is the default one
   * this client builds. A CX_TABLE override names a table something else
   * loaded - a hydrated corpus - and a build DROPS and recreates it, a sync
   * appends this repository's chunks to it; neither may happen because a
   * query found no index or a stale one. Ownership, not the table's columns:
   * a hydrated table that happens to carry path and start_line is no more
   * this process's than one that does not. `cx index` is the explicit path
   * and is not gated here. */
  const ownsTable = (ctx: RepoCtx): boolean => !ctx.hosted || TABLE === DEFAULT_TABLE;

  const maybeAutoSync = (ctx: RepoCtx) => {
    // Never under a build's completion: a diff or a second build would race
    // the vector stage or the platform load. The clock is not advanced, so
    // the first query after the build lands syncs. And never against a
    // table this process does not own (ownsTable).
    if (!autoSyncEnabled || !ownsTable(ctx) || ctx.completion || performance.now() - ctx.lastSyncCheck < syncIntervalMs) return;
    ctx.lastSyncCheck = performance.now();
    // Deferred so the triggering query's engine call runs first; the sync's
    // stat walk still shares the process, so on very large repos a
    // concurrent query can feel it. Queries are never queued behind syncs.
    setImmediate(() => {
      const p = exclusive(ctx, (lock) => doSync(ctx, lock));
      p?.catch((err) => console.error(`auto-sync failed: ${(err as Error).message}`));
    });
  };

  /** The client the verdict is asked through: the same database, a few
   * seconds' budget, and NO cold-start retries (`coldStartSecs: 0`). The
   * repo's own client (`ctx.hosted`) is tuned for calls whose answer IS the
   * result and therefore worth waiting a cold start out for; the verdict is
   * not one of those, and sharing that client made a platform outage into
   * a minute-long stall on a local query (see VERDICT_TIMEOUT_MS). */
  const verdictDb = hosted ? hostedDbFor(hosted, { ...hostedOptions, coldStartSecs: 0, timeoutMs: VERDICT_TIMEOUT_MS }) : null;

  /** The client memory is recalled through (core/memory.ts), when memory is
   * on (`memoryEnabled`): no cold-start retries and a short budget
   * (`MEMORY_RECALL_TIMEOUT_MS`), like the verdict's, since a platform search
   * answering in milliseconds must not wait seconds on it. */
  const memoryDb =
    hosted && agentApis && memoryEnabled() ? hostedDbFor(hosted, { ...hostedOptions, coldStartSecs: 0, timeoutMs: MEMORY_RECALL_TIMEOUT_MS }) : null;

  /** The memory nearest a question, with the call it made for the ledger:
   * started beside a platform call and awaited after it. Only the tools that
   * already wait on the platform recall - the platform's searches -
   * since a local tool never waits on it. */
  const recallFor = (question: string): Promise<Recalled> =>
    memoryDb ? recallMemory(memoryDb, question) : Promise.resolve({ block: null, call: null });

  /** `call`'s result with the telemetry of the platform call that answered
   * it, read the moment it resolves: a tool that then waits on a recall or a
   * verdict must not read the client's last call afterwards, by when a
   * concurrent tool call may have replaced it. */
  const answeredBy = <T>(call: Promise<T>, ctx: RepoCtx): Promise<{ value: T; own: CallTelemetry | undefined }> =>
    call.then((value) => ({ value, own: hostedTelemetry(ctx) }));

  /** The platform's verdict on a `sql` result as the model reads it.
   * `anchors` and `rows` are the check's own working, not news to the
   * caller, and on a valid result the whole verdict is one word; the reason
   * is the part worth prompt space - with the terms the corpus does not hold
   * and the rewrite to run, when the platform found them. A ranked
   * aggregate's verdict also carries the facts about its groups (each
   * file's whole length, its lines holding each search term) and the note
   * saying what they measure; the caller folds the facts into the rows
   * (foldValidationFacts) and shows the note. One shaping for a verdict the
   * platform gave in the query's own answer (`validate` on `query_sql`) and
   * one it gave on rows posted back (`platformVerdict`). */
  const verdictForModel = (verdict: Record<string, unknown>): Record<string, unknown> => {
    const facts = {
      ...(typeof verdict.group_column === "string" && Array.isArray(verdict.groups) && verdict.groups.length > 0
        ? { group_column: verdict.group_column, groups: verdict.groups }
        : {}),
      // The note travels on its own: a ranking whose groups the table does
      // not name still has totals that read as sizes.
      ...(typeof verdict.note === "string" ? { note: verdict.note } : {}),
    };
    if (verdict.valid === true) return { valid: true, check: verdict.check, ...facts };
    const absent = Array.isArray(verdict.absent) && verdict.absent.length > 0 ? { absent: verdict.absent } : {};
    const suggestion = typeof verdict.suggestion === "string" ? { suggestion: verdict.suggestion } : {};
    return { valid: false, check: verdict.check, reason: verdict.reason, ...absent, ...suggestion };
  };

  /** The platform's verdict on a `sql` result, or undefined when there is no
   * platform to ask or it could not answer within VERDICT_TIMEOUT_MS.
   *
   * The platform's answering loop gates every query it runs on this check;
   * a caller driving retrieval itself has the same problem and could not
   * ask. It is attached to the result rather than offered as a tool because
   * a check the model may call is a check the model declines - measured on
   * the card tool the same day (2026-09-11). `statement` is the statement the
   * caller wrote, read only to tell an aggregate from rows; `question` is the
   * caller's question, not the query: the query's own words count for
   * nothing, which is the defect the check exists to catch. Without a
   * question the empty and aggregate halves still apply.
   *
   * `sql` alone calls this; see VALIDATION_NOTE for the measurement that took
   * it off `search` and `find`.
   *
   * Best-effort throughout: the rows are the answer and a check that failed
   * must not take them with it. A caller without a platform database (the
   * local-only server) gets no verdict at all rather than a second
   * implementation of the rules here, which would drift from the loop's.
   *
   * `column` is the text column the refusal is diagnosed against - the
   * chunks table's content unless the statement ran over a hosted table of
   * another shape, whose own text column it then is. `on` names another
   * table to judge against, through the client tuned for its database
   * (`DataPlane.verdict`), when the statement ran over a database named on
   * the call. */
  const platformVerdict = async (
    ctx: RepoCtx,
    statement: string,
    rows: readonly object[],
    question?: string,
    column: string = CONTENT_COLUMN,
    on?: { db: HostedDb; table: string },
  ): Promise<{ verdict?: Record<string, unknown>; telemetry?: { rttMs: number; readTokens?: number; resultBytes?: number } }> => {
    // Under the API tools the verdict is the model's to ask for (`validate`),
    // not attached to every statement.
    if (apiTools) return {};
    const judge = on ? on.db : ctx.hosted ? verdictDb : null;
    if (!judge) return {};
    try {
      const verdict = await judge.validate({
        table: on ? on.table : TABLE,
        column,
        statement,
        rows,
        ...(question ? { question } : {}),
      });
      // The validate call is a metered platform read (a floor Read Token),
      // so its cost belongs in the ledger like a search's - otherwise the
      // gateway bills it and the demo's "our charge" never shows it. Captured
      // here, right after the await, so a concurrent verdict cannot overwrite
      // `lastCall` before the caller reads it. It goes through its own client,
      // which is why `withPlatform(entry, ctx)` (reading ctx.hosted) would
      // miss it.
      // `judge`, not `verdictDb`: a statement over a database named on the
      // call was judged through that database's own client.
      const telemetry = callTelemetry(judge.lastCall());
      return { verdict: verdictForModel(verdict), telemetry };
    } catch (err) {
      console.error(`validation unavailable: ${(err as Error).message}`);
      return {};
    }
  };

  // The value behind an ok result, kept beside it so a batch can put the
  // results of its queries into one object without parsing its own output,
  // and the text a tool wrote in place of the JSON (find writes grep's
  // shape), so a batch of such results is written the same way.
  const values = new WeakMap<object, unknown>();
  const texts = new WeakMap<object, string>();
  const ok = (value: unknown, text?: string) => {
    const result = { content: [{ type: "text" as const, text: text ?? jsonify(value, true) }] };
    values.set(result, value);
    if (text !== undefined) texts.set(result, text);
    return result;
  };
  const fail = (message: string) => ({
    content: [{ type: "text" as const, text: message }],
    isError: true,
  });
  type ToolResult = ReturnType<typeof ok> | ReturnType<typeof fail>;

  /** One call, several queries. With `queries`, each runs through `single`
   * at the same time and the results come back in the same order, each
   * under its query, a failed one as its message beside the others rather
   * than in place of them; every query files its own receipt. Without it,
   * `query` runs alone as it always did. Neither is a refusal that says so.
   * The cap on `queries` is the schema's (BATCH_MAX), enforced before the
   * call reaches here. */
  const batched = async <A extends { query?: string; queries?: string[] }>(
    tool: string,
    args: A,
    single: (args: A & { query: string; share?: number }) => Promise<ToolResult>,
  ): Promise<ToolResult> => {
    const { queries, query, ...rest } = args;
    if (queries && queries.length > 0) {
      const t0 = performance.now();
      // `share` is how many queries the call carries, so a tool with a text
      // budget can divide it: a batch is one result and gets one budget.
      const results = await Promise.all(queries.map((q) => single({ ...(rest as A), query: q, share: queries.length })));
      const each = results.map((r, i) =>
        "isError" in r ? { query: queries[i], error: r.content[0]?.text ?? "failed" } : { query: queries[i], ...(values.get(r) as object) },
      );
      const tookMs = Math.round((performance.now() - t0) * 1000) / 1000;
      // A tool that writes text writes its batch as text too: each query's
      // result under a heading naming it, a failed one as its message.
      const written = results.every((r) => "isError" in r || texts.has(r));
      const text = written
        ? results
            .map((r, i) => `== ${tool} "${queries[i]}"\n${"isError" in r ? `error: ${r.content[0]?.text ?? "failed"}` : texts.get(r)}`)
            .join("\n\n") + `\n\ntook ${tookMs} ms`
        : undefined;
      return ok({ results: each, took_ms: tookMs }, text);
    }
    if (typeof query !== "string" || query.length === 0) return fail(`${tool}: give query, or queries for several at once`);
    return single({ ...(rest as A), query });
  };
  const noIndex = (ctx: RepoCtx) => {
    const other = otherHolder(ctx.dir);
    return other
      ? fail(`no index for ${ctx.root} yet - another process (pid ${other.pid}) is indexing it now; retry when it finishes.`)
      : fail(`no index for ${ctx.root} yet - run \`cx index\` there once (keyword search is live in seconds).`);
  };

  /** The refusal when a query would build the index but the process does
   * not own the platform table a build writes (ownsTable): CX_AUTO_INDEX is
   * not consulted, because no setting makes dropping another loader's table
   * the right answer to "no index yet". */
  const foreignTable = (ctx: RepoCtx) =>
    fail(
      `no index for ${ctx.root} yet, and this server will not build one: CX_TABLE=${TABLE} names a table this ` +
        `process does not own at ${platformLabel(ctx.hosted!)} (a build drops and recreates it) - build it with ` +
        "`cx index` explicitly if that is what you mean",
    );

  /** The local index a door runs over: the one there is, or the one this
   * call builds when auto-index is on and the process owns the table its
   * build would write. Every local door goes through here, so the ownership
   * rule cannot be missed by one of them. */
  const localIndex = async (ctx: RepoCtx): Promise<{ handle: IndexHandle; autoIndexed?: IndexStats } | { failed: ReturnType<typeof fail> }> => {
    if (signedIn) return { failed: fail(SIGNED_IN_ROOT) };
    const before = existsSync(ctx.dir) ? readManifest(ctx.dir) : null;
    let ensured: EnsureResult;
    try {
      ensured = await ensureIndexed(ctx, { autoIndexEnabled: autoIndexEnabled && ownsTable(ctx), getHandle, build: buildIndex });
    } catch (err) {
      return { failed: fail(`indexing failed: ${(err as Error).message}`) };
    }
    if ("needsIndex" in ensured) return { failed: ownsTable(ctx) ? noIndex(ctx) : foreignTable(ctx) };
    if (ensured.autoIndexed && before && builtByEarlierVersion(before)) replacedBuilds.add(ensured.autoIndexed);
    return ensured;
  };

  /** The builds that replaced an index an earlier version built, so the call
   * that made one says so rather than that no index existed. */
  const replacedBuilds = new WeakSet<IndexStats>();

  /** Marker attached to a query result when this call built the index. */
  const autoIndexNote = (stats: IndexStats) => ({
    files: stats.files,
    chunks: stats.chunks,
    note:
      (replacedBuilds.has(stats)
        ? "rebuilt the index an earlier version of code-context built, which this version cannot read, on this call"
        : "no index existed - built one on this call") +
      "; keyword search is live now" +
      (stats.vectors === "building" ? " and vectors are backfilling in the background" : ""),
  });

  /** The platform tools' first precondition, checked before any build: the
   * context carries the platform client. A repo other than the default root
   * never does - the database holds one chunks table - and building its local
   * index for a tool that will not serve it would be waste. Null when it does. */
  const noPlatform = (tool: string, ctx: RepoCtx): ReturnType<typeof fail> | null =>
    ctx.hosted
      ? null
      : signedIn
        ? fail(`${tool}: ${SIGNED_IN_ROOT}`)
        : fail(`${tool} works on the repository the server was started for, whose index is also on the platform database; ${ctx.root} is served by find, search and sql only`);

  /** The platform tools' second precondition, after the index exists: the
   * platform's chunks table does too. A table not there yet is either being
   * loaded by the build in flight (its completion, or a sync's rebuild) or was
   * never loaded. Null when ready. */
  const platformNotReady = async (tool: string, ctx: RepoCtx): Promise<ReturnType<typeof fail> | null> => {
    const missing = noPlatform(tool, ctx);
    if (missing) return missing;
    // This probe is a network call, so it fails the same ways the tool itself
    // does - a refused key and an empty balance among them. It runs before the
    // tool's own try/catch, so without this one an authentication or billing
    // refusal escaped as a raw thrown HostedError and the model saw a stack
    // trace instead of what to do about it.
    let ready: boolean;
    try {
      ready = await platformTableReady(ctx.hosted!, (ctx.hostedMemo ??= newHostedMemo()));
    } catch (err) {
      return fail(`${tool} failed: ${(err as Error).message}${refusalHint(err)}`);
    }
    if (ready) return null;
    const label = platformLabel(ctx.hosted!);
    return fail(
      ctx.mutation || ctx.completion
        ? `the ${TABLE} table at ${label} is being loaded by the index build in progress - retry when it finishes`
        : `no ${TABLE} table at ${label} yet - run \`cx index --db ${label}\` to load it`,
    );
  };

  // The platform tool (`search`) is registered whenever a platform database
  // is configured. A tool's routing line joins the instructions only when
  // the tool is registered: the instructions are prompt text on every turn,
  // and a line for a tool that is not there costs tokens and steers toward
  // nothing - a client that hides a tool still sends its line here, and the
  // caller spends a turn calling into the refusal. `platformTools`
  // also keeps what belongs to the database: the sql text's card and
  // validation note.
  const platformTools = hosted !== null;
  // The platform's own routes as tools the model calls (CX_API_TOOLS):
  // table_card, validate, cite. With them on, sql carries no card and no
  // verdict - the model asks for both - see apiToolsEnabled.
  const apiTools = platformTools && apiToolsEnabled();
  // The account's data (mcp/data.ts): every database the key may see,
  // reached per call by the `database` argument, and the `tables` and
  // `hydrate` tools over it. The key is an account's whichever way the
  // platform was configured - a `--db` naming one database or the stored
  // account - so this is there whenever a platform is. Nothing is asked of
  // it at startup. Upload sessions are opened for the platform's own origin:
  // a deployment lists the origins it takes uploads from, and a client of
  // its API is of that origin as far as a listing can name one.
  // Only in the `account` scope (CX_ACCOUNT_DATA, accountDataScope): in the
  // others the server reaches its own database, or its own table, alone.
  const data =
    hosted !== null && accountScope === "account"
      ? new DataPlane({
          account: { baseUrl: hosted.baseUrl, apiKey: hosted.apiKey },
          clientOptions: hostedOptions ?? {},
          cardTier: CARD_TIER,
          onNote: (line) => console.error(line),
          origin: new URL(hosted.baseUrl).origin,
          verdictTimeoutMs: VERDICT_TIMEOUT_MS,
        })
      : null;
  /** The refusal of a `database` argument on a server with no account, or
   * with the account's data switched off. */
  const noDataPlane = (tool: string) =>
    hosted !== null
      ? fail(`${tool}: this server serves only its own data, not the account's other databases; leave database out`)
      : fail(`${tool}: database names a database of an Infino account, and this server has none - ${noAccountSteps()}`);
  /** What each query tool's text says of the account's data, where there is
   * an account: one sentence, since the routing line below carries the rest
   * and every sentence here is prompt text on every turn. */
  const DATA_NOTE = data ? " With database (and table), it runs over that table of a database of the Infino account instead; tables lists them." : "";
  /** The routing line for the account's data: where the databases are
   * listed, how each query tool reaches one, and how data gets in. */
  const DATA_INSTRUCTION = data
    ? "\n- tables - the databases of this Infino account and their tables; with database and table, a table's columns, " +
      "indexes, key and card: call it before the first query over data. Every query tool takes database to run over " +
      "a database of the account instead of this repository: sql one statement over its tables (join_keys with " +
      "database before a JOIN), search and find with table.\n" +
      (readOnly
        ? ""
        : "- hydrate - load a dataset into a database of the account, from a bucket" +
          (hostFiles ? ", from files on this machine (path) or on a machine reached by ssh" : "") +
          "; hydrate_status follows the load, hydrate_cancel stops it. Only when asked.\n")
    : "";

  // What the default root's doors run against (TableMode), decided here and
  // once. With a platform database and a CX_TABLE that is not the default,
  // the table's schema says whether it is the chunks table or another shape,
  // and the tool text below is registered to match - so
  // the text and the calls cannot disagree, whichever way the probe went.
  // Resolved through the default root's own client, with its normal
  // cold-start budget: for that table the answer decides the mode, so a
  // database still coming up is waited for here, at startup, the one place
  // a wait costs no query. (The probe's reads - schema, card, the load's
  // record, and the search by meaning that checks a vector column - are
  // per-spawn overhead and go to no ledger: they are the price of knowing
  // what the tools are, not of any answer.) On a failure the table goes
  // `unresolved`, because the chunks text over a table of another shape
  // sends the model to write SQL naming columns it does not have, and the
  // local path would build.
  //
  // The DEFAULT table is not probed. It is the chunks table this client
  // builds, so the probe's only possible outcome is `chunks` - the fallback
  // too - and the wait would buy nothing. It would cost a great deal: this
  // runs before `server.connect`, so a platform that is cold or answering
  // 503 at spawn would hold the MCP handshake for the whole cold-start
  // budget (two minutes), past the client's startup timeout (Claude Code
  // gives a server 30 s), and the session would lose find, search and sql -
  // three local tools - to a probe whose answer was known. The default
  // table keeps the startup it always had: the card alone, with no
  // cold-start retries, below.
  //
  // The card comes with the shape (resolving it read the card's roles), so
  // this is the one card read at startup when the probe runs; otherwise the
  // card is fetched on its own below, as it always was.
  let mode: TableMode = { kind: "chunks" };
  let card: RowRecord | undefined;
  /** Whether the platform answers the primary table's rows' pages. */
  let primaryPages = false;
  const noCard = (err: unknown) => console.error(`no table card in the sql description: ${(err as Error).message}`);
  // The platform asked about its tables at startup with no cold-start wait:
  // an embedding server that is starting takes longer than the handshake
  // can wait (see above).
  // Within the startup cache's window (CX_STARTUP_CACHE_SECS, off unless set)
  // the description below is read from the file the last cold start wrote
  // (core/startup-cache.ts); a read the deadline cut is an error, and never
  // kept.
  const cacheSecs = startupCacheSecs();
  const startupCache =
    hosted && cacheSecs > 0 ? new StartupCache(startupCachePath(`${hostedLabel(hosted)}#${TABLE}`), cacheSecs) : null;
  const cached = (db: HostedDb | null): HostedDb | null => (db && startupCache ? startupCache.wrap(db) : db);
  if (startupCache) console.error(`startup description ${startupCache.hit ? "from the cache" : "read from the platform"}`);
  // None of it under sign-in: the default root's table is this server's
  // own, and the caller's account holds no copy of it.
  const describer = cached(hosted && !signedIn ? hostedDbFor(hosted, { ...hostedOptions, coldStartSecs: 0 }) : null);
  // The database's other tables - their listing, schemas and cards - are
  // read through a client that stops at the start-up's deadline
  // (STARTUP_BUDGET_MS): a read not answered by then is abandoned and one not
  // yet made is not made, so a database of hundreds of tables, or one card
  // that does not answer, cannot hold the handshake. The primary's own reads
  // keep the clients they always had.
  const othersDb = cached(hosted && !signedIn ? hostedDbFor(hosted, { ...hostedOptions, coldStartSecs: 0, deadlineMs: othersDeadline }) : null);
  // The other tables of the database, as the platform lists them (`databaseTables`):
  // what a statement may join with the primary. Every card is asked for
  // alone: asked beside its siblings it would come back carrying the
  // platform's joins, and no key reaches the tool text - the model calls
  // join_keys.
  // In the `table` scope there are none: the server reaches its own table
  // alone, so no other is listed, described or offered to a JOIN.
  const siblingNames = othersDb && accountScope !== "table" ? await databaseTables(othersDb, TABLE) : [];
  // Every hosted table of another shape this server describes - the primary
  // when it is one, and the siblings - has its card asked for within the
  // budget the platform's own loop lays the cards of one prompt out within
  // (core/table-shape.ts, cardLayouts): the tables' schemas first, for
  // their widths, then each card at its share. Read once, here; a table
  // whose schema was not read is described below as it always was, from
  // that one attempt. The chunks table this client builds is narrow and
  // its card is folded in whole, as before. Sized per table, the UI events
  // table's card alone put 2.4 million characters into the sql text.
  const laidOutTables = [...(hosted && !signedIn && remoteSearch && TABLE !== DEFAULT_TABLE ? [TABLE] : []), ...siblingNames];
  // The primary's schema through `describer`, the others' through
  // `othersDb`: one the deadline cut is a failure like any other, and the
  // shares are laid out over the schemas read.
  const schemaOf: Pick<HostedDb, "schema"> | null =
    describer && othersDb ? { schema: (table) => (table === TABLE ? describer : othersDb).schema(table) } : null;
  const laidOut =
    schemaOf && laidOutTables.length > 0
      ? await cardLayouts(schemaOf, laidOutTables)
      : { layouts: new Map<string, CardLayout>(), failures: new Map<string, Error>() };
  const layoutOf = (table: string): Pick<ResolveOptions, "fields" | "card"> => {
    const layout = laidOut.layouts.get(table);
    return layout ? { fields: layout.fields, card: { whole: layout.whole, families: layout.families } } : {};
  };
  /** The error the one schema read of `table` raised, if it did: thrown
   * where the table is described, so it is reported as before and the
   * schema is not asked for twice. */
  const notLaidOut = (table: string): void => {
    const failed = laidOut.failures.get(table);
    if (failed) throw failed;
  };
  if (hosted && !signedIn && remoteSearch && TABLE !== DEFAULT_TABLE) {
    try {
      // With the load's record: a table cut into passages says so in the
      // tool text (`chunkingNote`), and a `vector` column the load embedded
      // is a candidate for search by meaning (`vectorCandidate`), and is
      // searched by meaning once the platform has embedded a query for it -
      // the platform's check that the model it embeds with is the one that
      // filled the column (`platformEmbedsQueriesFor`). That check is one
      // attempt, with no cold-start retries: an embedding server that is
      // starting takes longer than the handshake can wait (see above), and
      // the column is then not offered for the session. A column the shape
      // passed over is said on stderr, so a search that runs by keyword
      // alone on a table with vectors is visible in the log.
      const onNote = (line: string) => console.error(`${TABLE}: ${line}`);
      notLaidOut(TABLE);
      const shape = await resolveTableShape(registry.get().hosted!, TABLE, CARD_TIER, noCard, true, {
        onNote,
        checkWith: describer!,
        ...layoutOf(TABLE),
      });
      card = shape.card;
      primaryPages = shape.pages === true;
      // The chunks shape alone does not make a table this client's. A table
      // of passages something else loaded has the same columns - one hosted
      // table per collection, named by CX_TABLE - and the chunks mode would
      // run find, read and a plain sql on the LOCAL index under that name,
      // which holds the table this process built and no other: every such
      // call fails "table not found", and search asks the hosted index for
      // the local vector column's name (`embedding`, where the table has
      // `emb`). So the chunks mode is kept for a table the local index holds, and any other runs
      // over its rows on the platform, driven by its own shape, exactly as a
      // table of another shape does.
      if (!shape.isChunks) mode = { kind: "rows", shape };
      else if (!localIndexHolds(registry.get(), TABLE)) {
        onNote("a table of passages this process did not build: the local index does not hold it, so its rows are read on the platform");
        mode = { kind: "rows", shape };
      }
    } catch (err) {
      const cause = `${(err as Error).message}${refusalHint(err)}`;
      console.error(`the ${TABLE} table could not be described (${cause}); every tool call will say so`);
      mode = { kind: "unresolved", cause };
    }
  } else if (platformTools && !signedIn) {
    // The table's card, folded into the `sql` description once at startup so
    // every statement is written knowing the table's shape. Measured worth:
    // 37% off the wall clock of aggregation questions, with quality level and
    // cost flat (see CARD_TIER). It is fetched here rather than offered as a
    // tool because a tool was measured and not called.
    //
    // Best-effort, and deliberately so: a card is a help, not a precondition.
    // A platform that cannot serve one (no card computed for this table yet -
    // the optimizer writes it after it first optimizes the table - a refused
    // key, a database still coming up) leaves `sql` with the description it
    // always had. Failing the server here would make a help into a
    // dependency, and the one thing worse than a slower first statement is no
    // server at all. No cold-start retries (`coldStartSecs: 0`), for the
    // reason above: one attempt, and the handshake goes ahead.
    try {
      const record = await fetchCard(describer!, TABLE, CARD_TIER, (line) => console.error(line), layoutOf(TABLE).card ?? {});
      card = (record.card ?? record) as RowRecord;
    } catch (err) {
      noCard(err);
    }
  }

  // The database's other tables: what a statement may join with the
  // primary. Each is described once here, best-effort as the card is - one
  // that cannot be described is named in the text as such rather than
  // dropped, since the join is still the model's to write. Each is asked for
  // alone (see above). Their vector columns are not checked here
  // (`checkVector: false`): a check is a search by meaning, which loads the
  // table's vector index on the worker, and one per table of a database of
  // dozens of tables at startup can fill the worker's memory and stall every
  // query on it; the platform embeds the query when a statement first
  // searches one. They are described at once, not one after another: read
  // in turn, a few dozen tables' schemas alone can take past half the time a
  // client gives a server to start.
  // What the start-up's deadline cut is counted and said in one line, not a
  // line a table: on a database of hundreds of tables that is most of them.
  const siblings: TableShape[] = [];
  const siblingsUnresolved: string[] = [];
  /** The other tables described without their cards because the deadline
   * came first: each card is still the platform's to serve, a call away. */
  let cardsCut = 0;
  if (siblingNames.length > 0 && othersDb) {
    let tablesCut = 0;
    const described = await Promise.all(
      siblingNames.map(async (name) => {
        try {
          notLaidOut(name);
          const onNoCard = (err: unknown) => (pastDeadline(err) ? cardsCut++ : noCard(err));
          return await resolveTableShape(othersDb, name, CARD_TIER, onNoCard, false, { ...layoutOf(name), checkVector: false });
        } catch (err) {
          if (pastDeadline(err)) tablesCut++;
          else console.error(`sibling table ${name} could not be described: ${(err as Error).message}${refusalHint(err)}`);
          return null;
        }
      }),
    );
    described.forEach((shape, i) => {
      if (shape) siblings.push(shape);
      else siblingsUnresolved.push(siblingNames[i]);
    });
    if (cardsCut + tablesCut > 0) {
      console.error(
        `the database's other tables were read for ${(serveOptions.startupBudgetMs ?? STARTUP_BUDGET_MS) / 1000} s of this ` +
          `server's start-up: of ${siblingNames.length}, ${cardsCut} are described without their cards and ${tablesCut} ` +
          "not at all (the sql text names them as tables that could not be described)",
      );
    }
  }
  startupCache?.save();

  // The cards of every described table as the platform's loop renders
  // them for its prompt - one call for all of them, the same layout,
  // ranking and character budget the loop reads by (core/hosted.ts,
  // `promptCards`). Without a question at start-up there is nothing to
  // rank for: the cards are laid out by the budget alone, and
  // describe_columns with a question ranks a table's columns later. A
  // platform that predates the form, or one that does not answer within
  // the start-up's deadline, leaves the cards as read.
  let promptCards: PromptCards | null = null;
  const cardTables = [
    ...(card ? [TABLE] : []),
    ...siblings.flatMap((s) => (s.card ? [s.table] : [])),
  ];
  if (platformTools && !apiTools && describer && cardTables.length > 0) {
    try {
      const reader = othersDb ?? describer;
      promptCards = await reader.promptCards(cardTables, CARD_TIER);
      // Cards that do not fit as they are would be ranked for a question
      // the start-up does not have: the text names every table in a line
      // instead, and describe_columns with the model's question returns the
      // cards it needs.
      if (promptCards.ranked) promptCards = await reader.promptCards(cardTables, CARD_TIER, undefined, true);
    } catch (err) {
      console.error(
        `the platform did not render the cards (${(err as Error).message}); folding in the cards as read`,
      );
    }
  }

  /** The platform's keys among a set of hosted tables, asked for once per
   * set for the server's life: what the join gate holds a statement across
   * tables to (core/join-gate.ts). A platform that cannot answer leaves the
   * statement ungated rather than unrun - the gate is a check, not a
   * precondition - and says so on stderr. */
  const platformKeys = new Map<string, Promise<PlatformJoin[]>>();
  const keysAmong = (tables: string[], through?: HostedDb): Promise<PlatformJoin[]> => {
    // Keyed by the database too: the same table names in two databases of
    // the account are two tables.
    const set = `${through ? through.target.database : ""}|${[...tables].sort().join(",")}`;
    let pending = platformKeys.get(set);
    if (!pending) {
      pending = (through ?? hostedDbFor(hosted!, { ...hostedOptions, coldStartSecs: 0 }))
        .joinKeys(tables)
        .then((record) => ((record.joins as PlatformJoin[] | undefined) ?? []).filter((j) => typeof j?.predicate === "string"))
        .catch((err) => {
          console.error(`join_keys for ${set} failed; the statement runs ungated: ${(err as Error).message}`);
          platformKeys.delete(set);
          return [] as PlatformJoin[];
        });
      platformKeys.set(set, pending);
    }
    return pending;
  };

  /** The rows a call on `ctx` runs over, read off the startup decision - no
   * platform call, no await: the shape when the context carries the platform
   * client (the default root) and the table is of another shape; `failed`
   * when it could not be described; null for every other case, where the
   * call takes the path it always took. */
  const rowsOver = (tool: string, ctx: RepoCtx): { shape: TableShape } | { failed: ReturnType<typeof fail> } | null => {
    if (!ctx.hosted || mode.kind === "chunks") return null;
    if (mode.kind === "rows") return { shape: mode.shape };
    return {
      failed: fail(
        `${tool} failed: table ${TABLE} could not be described from the platform at ${platformLabel(ctx.hosted)} when ` +
          `this server started: ${mode.cause}; nothing runs against a local index in its place - restart the server ` +
          "with the platform reachable",
      ),
    };
  };

  // --- the graph, applied by this server to every hosted retrieval ----------
  //
  // With sibling tables the platform keeps a graph over them (what its
  // extraction read from the texts, what the code defines and uses) and
  // the joins it verified, and the rows a search or a statement returns
  // are handed to it: the platform walks from them and the rows of the
  // other tables it reaches come back beside the result as `connected`,
  // named by table. Never the model's to ask for: a model offered the graph
  // functions does not call them (core/graph-expand.ts).

  /** The hosted tables the expansion may start from: the primary, alone or
   * with each described sibling - a one-table corpus has a graph of its own
   * rows, the documents linked by what they mention. Which of them the
   * graph covers is the platform's to say; a table it does not cover is not
   * asked about again this session (`graphUncovered`). */
  const graphTables = new Set<string>([TABLE, ...siblingNames]);
  // Off for the session when the account has no agent routes, or when the
  // platform answers that the graph is not there for it (403, 404, 501):
  // those answers do not change within a session. Any other failure - a
  // timeout, a 429, a 5xx - pauses expansion for GRAPH_BACKOFF_MS and then
  // it is tried again. Either way the result the walk was to add to stands
  // without it.
  let graphOff = !agentApis;
  let graphPausedUntil = 0;
  // The client one expansion goes through: the repository's own database,
  // with a short budget of its own and no cold-start wait, so a cold or slow
  // graph never holds the result it was to add to. A client per expansion,
  // so the call it reports is this expansion's own request - or none, when
  // it made none - and never another call's.
  const graphClientFor = (ctx: RepoCtx): HostedDb =>
    hostedDbFor(ctx.hosted!.target, { ...hostedOptions, coldStartSecs: 0, timeoutMs: GRAPH_TIMEOUT_MS });
  // The tables the platform said its graph does not cover (or that it
  // builds no graph): each answered once, then not asked about again.
  const graphUncovered = new Set<string>();
  // What this session's expansions carried already: a seed is walked once
  // and a row shown once (core/graph-expand.ts, ExpansionMemory).
  const graphMemory = newExpansionMemory();
  /** The expansion of `rows` of `source` as the result carries it: the
   * `connected` section, or `graph`, one line saying why there is none
   * (no seeds on the rows, nothing reached, the walk failed) - in the
   * result rather than on stderr so a drive's records show whether the
   * graph was reached on every call. A failure ends expansion for the
   * session. `searched` - the search's words, or the statement - brings
   * back the facts matching them from every document too. */
  const connectAcrossGraph = async (
    ctx: RepoCtx,
    source: string,
    rows: readonly RowRecord[],
    searched?: Searched,
  ): Promise<GraphResult> => {
    if (graphOff || Date.now() < graphPausedUntil || !ctx.hosted || !graphTables.has(source) || graphUncovered.has(source)) return NO_GRAPH_RESULT;
    const trace: string[] = [];
    const client = graphClientFor(ctx);
    // Undefined when the expansion made no request (no seeds, every seed
    // walked already): nothing to bill.
    const metered = () => callTelemetry(client.lastCall());
    try {
      const connected = await expandAcrossGraph(client, source, rows, {
        trace: (line) => trace.push(line),
        memory: graphMemory,
        onUncovered: () => graphUncovered.add(source),
        searched,
      });
      if (!connected) return { section: { graph: trace.join("; ") || "nothing reached" }, call: metered() };
      return { section: { connected }, call: metered() };
    } catch (err) {
      const lasting = err instanceof HostedError && GRAPH_LASTING_STATUSES.has(err.status);
      if (lasting) graphOff = true;
      else graphPausedUntil = Date.now() + GRAPH_BACKOFF_MS;
      const why = `${lasting ? "graph expansion off for this session" : `graph expansion paused for ${GRAPH_BACKOFF_MS / 1000} s`}: ${(err as Error).message}`;
      console.error(why);
      return { section: { graph: why }, call: metered() };
    }
  };
  /** The one hosted table a statement is over, or null when it names none,
   * several (a JOIN already crossed them) or a graph function of its own. */
  const statementSource = (code: string): string | null => {
    if (/\bgraph_(?:walk|rank)\s*\(/i.test(code)) return null;
    const named = tablesNamed(withoutGraphCalls(code), [TABLE, ...siblingNames]);
    return named.length === 1 ? named[0] : null;
  };

  /** In the `table` scope, the other tables of a context's database: the
   * names a statement may not reach. Listed at most once a minute, since a
   * statement may name a table created a moment ago. A listing that fails
   * throws, so the statement is refused rather than run unchecked. */
  const OUTSIDE_TTL_MS = 60_000;
  const outsideListed = new Map<string, { at: number; names: string[] }>();
  const tablesOutside = async (ctx: RepoCtx): Promise<string[]> => {
    if (!ctx.hosted) return [];
    const kept = outsideListed.get(ctx.root);
    if (kept && Date.now() - kept.at < OUTSIDE_TTL_MS) return kept.names;
    const names = (await ctx.hosted.listTables()).filter((name) => name !== TABLE);
    outsideListed.set(ctx.root, { at: Date.now(), names });
    return names;
  };

  /** A `sql` statement run on the platform, whichever table it is over: the
   * statement with its `{{name}}` placeholders folded into the platform's
   * own `{{q:"..."}}`, which it embeds with the table's model - no local
   * index and no local embedder come into it - then the platform's verdict
   * on the rows, and one ledger line carrying both metered reads. `column`
   * is the text column the verdict is diagnosed against (the chunks table's
   * content unless the table is of another shape); `numbered` says whether
   * the rows are chunks, whose multi-line text is numbered from the row's
   * start_line as the local path numbers it - a table of rows has no lines
   * to number. `over` is a database named on the call: the statement runs
   * through its client, the verdict is asked through its verdict client
   * against the table the statement named - none named, no verdict - and
   * the rows are recorded under that table. */
  const sqlOnPlatform = async (
    ctx: RepoCtx,
    query: string,
    embeds: Record<string, string> | undefined,
    question: string | undefined,
    opts: { column?: string; numbered: boolean; key?: string; over?: { database: string; db: HostedDb; verdict: HostedDb; table?: string } },
  ) => {
    try {
      const t0 = performance.now();
      // The graph's addition comes from the rows of the one table the
      // statement is over; an aggregate's rows seed nothing, and its words
      // searched - the keyword terms in the statement, the texts it embeds -
      // still find the facts holding them.
      // A database named on the call (`over`) is read through its own
      // client, its rows recorded under the table the statement named, and
      // it has no graph of this database's tables to expand across.
      const db = opts.over?.db ?? ctx.hosted!;
      const source = opts.over ? null : statementSource(withoutComments(query));
      // The checks ride on the query itself: the verdict and the grader's
      // order come back with the rows, where before the rows went back up
      // to /validate in a second call. Validation is asked for wherever the
      // verdict is attached (not under the API tools, where the model asks
      // for it); the rerank when there is a question to rank for.
      const asked = question?.trim() ? question.trim() : undefined;
      const checks: ReadChecks = {
        ...(!apiTools && (opts.over ? opts.over.table !== undefined : verdictDb)
          ? { validate: { table_name: opts.over?.table ?? TABLE, field_name: opts.column ?? CONTENT_COLUMN, ...(asked ? { question: asked } : {}) } }
          : {}),
        ...(asked ? { rerank: { question: asked } } : {}),
      };
      const checked = await runSqlRows(db, query, embeds, checks);
      const own = opts.over ? callTelemetry(db.lastCall()) : hostedTelemetry(ctx);
      const fromPlatform = checked.rows;
      const reranked = checked.rerank !== undefined && checked.rerank.skipped === undefined;
      const embedded = Object.values(embeds ?? {}).join(" ");
      const searched: Searched = { statement: query, ...(embedded.trim() ? { query: embedded } : {}) };
      const searchesWords = embedded.trim() !== "" || KEYWORD_SEARCH_CALL.test(query);
      const graph = opts.over
        ? NO_GRAPH_RESULT
        : source
          ? await connectAcrossGraph(ctx, source, fromPlatform, searched)
          : searchesWords
            ? await connectAcrossGraph(ctx, TABLE, [], searched)
            : NO_GRAPH_RESULT;
      const placed = opts.numbered ? fromPlatform.map(numberRowLines) : fromPlatform;
      // A check asked for and not answered - the checked read failed and the
      // rows came back plain - is asked of the verdict client on its own,
      // under its short cap with no cold-start wait, as the rows are posted
      // back; it never holds or fails the rows. A deployment that has said it
      // does not validate on a read is not asked again.
      const postedBack =
        checks.validate && !checked.validation && db.validatesOnRead
          ? await platformVerdict(ctx, query, placed, asked, opts.column ?? CONTENT_COLUMN, opts.over && opts.over.table !== undefined ? { db: opts.over.verdict, table: opts.over.table } : undefined)
          : {};
      const judged = checked.validation ? verdictForModel(checked.validation) : postedBack.verdict;
      // A ranked aggregate's rows gain the platform's facts about their
      // groups - `file_lines`, `term_lines` - so a top-k total sits beside
      // the file's whole length in the row the model reads, and an ordered
      // result's rows carry their place in its order (core/facts.ts).
      const { rows: folded, verdict } = foldValidationFacts(placed, judged);
      // Ordered by what the statement's code says, not its comments - unless
      // the platform's grader ordered them, whose order they keep.
      const rowsOut = reranked ? folded : rankRows(folded, withoutComments(query));
      let usage: string | undefined;
      if (receiptOn) {
        // The statement, its verdict and its rerank are metered on the one
        // call - and a verdict posted back on its own is a second read.
        const entry = withCalls(sqlEntry(query, rowsOut), own, postedBack.telemetry, graph.call);
        recordUsage(ctx.dir, entry);
        usage = formatReceipt(entry, session);
      }
      const held = budgetSqlRows(rowsOut, (row) => jsonify(row).length);
      const hint = sqlBudgetHint(rowsOut.length, held.budget);
      return ok({
        rows: held.rows,
        ...(hint ? { hint } : {}),
        ...graph.section,
        ...(verdict ? { validation: verdict } : {}),
        index: "platform",
        ...(opts.over ? { database: opts.over.database } : {}),
        took_ms: Math.round((performance.now() - t0) * 1000) / 1000,
        ...(usage ? { usage } : {}),
      });
    } catch (err) {
      return fail(`sql failed: ${(err as Error).message}${refusalHint(err)}`);
    }
  };

  /** A `sql` statement over a database named on the call: its tables are
   * read once (DataPlane), the statement is held to the platform's keys
   * when it spans two of them (the join gate, as for the sibling tables),
   * and it runs on the platform with the verdict judged against the table
   * it named - `table` when the caller said which, else the first of the
   * database's tables the statement names. The table's shape is read for
   * the verdict's text column and the rows' key, best-effort: a table the
   * platform cannot describe still runs, without a verdict. */
  const sqlOnDatabase = async (
    ctx: RepoCtx,
    database: string,
    table: string | undefined,
    query: string,
    code: string,
    embeds: Record<string, string> | undefined,
    question: string | undefined,
  ) => {
    if (!data) return noDataPlane("sql");
    const unlisted = (err: unknown) => fail(`sql failed: the tables of ${database} could not be listed: ${(err as Error).message}${refusalHint(err)}`);
    let names: string[];
    try {
      names = await data.tableNames(database);
    } catch (err) {
      return unlisted(err);
    }
    // A table the kept list lacks may have been made since it was read - by
    // a load nobody followed with hydrate_status, or one started elsewhere -
    // so the list is read once more before the table is refused.
    if (table !== undefined && !names.includes(table)) {
      try {
        names = await data.tableNames(database, true);
      } catch (err) {
        return unlisted(err);
      }
      if (!names.includes(table)) return fail(`sql: ${database} has no table ${table}; its tables are ${names.join(", ")}`);
    }
    const verdict = await joinGate(code, names, (spanned) => keysAmong(spanned, data.quick(database)));
    if (verdict.kind === "refuse") return fail(joinRefusal("sql", verdict));
    const named = table ?? tablesNamed(code, names)[0];
    let shape: TableShape | undefined;
    if (named !== undefined) {
      try {
        shape = await data.shape(database, named);
      } catch (err) {
        console.error(`${database}.${named} could not be described; the statement runs without a verdict: ${(err as Error).message}`);
      }
    }
    return sqlOnPlatform(ctx, query, embeds, question, {
      column: shape?.primaryText ?? "",
      numbered: false,
      ...(shape ? { key: shape.keyColumn } : {}),
      over: { database, db: data.client(database), verdict: data.verdict(database), ...(shape ? { table: named } : {}) },
    });
  };

  /** The shape of a table named with its database on a search or find:
   * both run over one table's text column, so the table must be named. */
  const dataTable = async (
    tool: string,
    database: string,
    table: string | undefined,
  ): Promise<{ shape: TableShape; client: HostedDb } | { failed: ReturnType<typeof fail> }> => {
    if (!data) return { failed: noDataPlane(tool) };
    if (table === undefined) return { failed: fail(`${tool}: name the table of ${database} to run over (tables lists them)`) };
    try {
      return { shape: await data.shape(database, table), client: data.client(database) };
    } catch (err) {
      return { failed: fail(`${tool} failed: ${database}.${table} could not be described: ${(err as Error).message}${refusalHint(err)}`) };
    }
  };

  /** How a table of the account is named on the query tools: the database
   * on every one, the table on the two that run over a text column. */
  const DATABASE_ARG = z
    .string()
    .min(1)
    .optional()
    .describe("A database of the Infino account to run over instead of a repository: the names are what `tables` lists. With it, `path` is not read.");
  const TABLE_ARG = z.string().min(1).optional().describe("With `database`: the table to run over; its text column is the one searched.");

  const rows = mode.kind === "rows" ? mode.shape : null;
  // Whether find and search are offered: always over the chunks table, and
  // over a table of rows only when it has a full-text column. Over one with
  // none the engine refuses every token match and BM25 search, and a tool
  // that cannot run is a tool the model calls and a turn it loses (the Berka
  // tables, 2026-10-01, hydrated with no full-text index and no vector). An
  // unresolved table keeps both: their calls report the cause.
  const searchDoors = !rows || rows.primaryText !== "";
  // Whether a statement across the tables can hold a search at all.
  const joinSearchable = siblingsSearchable(rows, siblings, siblingsUnresolved);
  // The sibling tables come second, right after what the statement runs
  // over, on the code text; the other texts take them at the end.
  // No key reaches the tool text: the model calls join_keys for them.
  // The semantic layer's wording only where a card that carries it was
  // served: a table with no enriched card falls back to its lean one, and
  // the lean text stays what it was measured as.
  const semanticsServed = WITH_SEMANTICS && [card, ...siblings.map((s) => s.card)].some(carriesSemantics);
  const siblingText =
    siblingNames.length > 0 ? siblingsNote(TABLE, siblings, siblingsUnresolved, joinSearchable, semanticsServed) : "";
  let sqlDescription = rows
    ? rowsSqlDescription(rows) + siblingText
    : mode.kind === "unresolved"
    ? unresolvedDescription("Read-only SQL", TABLE) + siblingText
    : SQL_DESCRIPTION_OPENING + (siblingText ? `${siblingText.trimStart()} ` : "") + SQL_DESCRIPTION.slice(SQL_DESCRIPTION_OPENING.length);
  if (platformTools && !apiTools) {
    sqlDescription += VALIDATION_NOTE;
    // jsonify, not JSON.stringify: a card's statistics over a 64-bit column
    // (a log table's nanosecond timestamps) are bigints, and a refusal here
    // stops the server before it serves a single tool.
    // Every described table's card, the primary's first: the tables beside
    // it are described the same way, so a question about one of them is
    // written over its own columns and not the primary's.
    const cards = [
      ...(card ? [{ table: TABLE, card }] : []),
      ...siblings.flatMap((s) => (s.card ? [{ table: s.table, card: s.card }] : [])),
    ];
    // The platform's own rendering when it serves one (`promptCards`):
    // what its loop's prompt carries, folded in unchanged, so the model
    // here reads the cards the model inside the loop reads. The cards as
    // read, laid out here, only for a platform that predates the form.
    if (promptCards && promptCards.shown.length === 0) {
      // The overview: no card until a question needs one.
      sqlDescription += OVERVIEW_PREAMBLE + promptCards.cards;
    } else if (promptCards) {
      const narrow = cards.length === 1 && !promptCardsMap(promptCards);
      sqlDescription +=
        (narrow ? NARROW_CARD_PREAMBLE : CARD_PREAMBLE) +
        promptCards.cards +
        (promptCards.vocabulary ? `\n\n${promptCards.vocabulary}` : "");
    } else if (cards.length === 1 && !cardMapsColumns(cards[0].card)) sqlDescription += NARROW_CARD_PREAMBLE + jsonify(cards[0].card);
    else if (cards.length > 0) sqlDescription += CARD_PREAMBLE + cards.map((c) => `${c.table}: ${jsonify(c.card)}`).join("\n");
  }
  if (apiTools) sqlDescription += API_TOOLS_SQL_NOTE;

  // What the local index holds, read once here: an index of logs gets its
  // instructions in log words (`logSurface`), a code index the code
  // surface's.
  const startManifest = readManifest(indexDir(defaultRoot));
  const logIndex = mode.kind === "chunks" && isLogIndex(startManifest);

  // The columns a laid-out card maps rather than lists are one
  // describe_columns away wherever a card folded into the text maps any,
  // and every column's rows by kind wherever a card names a kind column
  // (the tool is registered below under the same condition); a table whose
  // card lists every column whole and names no kinds has nothing for it to
  // describe. A table the start-up's budget described without its card
  // (`cardsCut`) has all of its entries one describe_columns away.
  const describeColumnsOffered = Boolean(
    describer &&
      (cardsCut > 0 ||
        (promptCards !== null && promptCardsMap(promptCards)) ||
        [card, ...siblings.map((s) => s.card as RowRecord | undefined)].some((c) => cardMapsColumns(c) || cardNamesKinds(c))),
  );
  // What every shape's surface is built with beyond the shape: whether
  // describe_columns is offered.
  const surfaceOptions: SurfaceOptions = { describeColumns: describeColumnsOffered };

  const server = new McpServer(
    { name: "code-context", version: PACKAGE_VERSION },
    {
      // The playbook's outer block comes after the instructions and before
      // the checklist line, and with no playbook nothing is added: the
      // server a measurement runs without one sends exactly this text. One
      // surface per shape of index, one builder for all of them
      // (`instructionsFor`), so what the shapes share is said once.
      instructions: withListedNames(withTaskChecklist(withPlaybook(
        instructionsFor(
          rows
            ? rowsSurface(rows, siblingNames, surfaceOptions)
            : mode.kind === "unresolved"
            ? unresolvedSurface(TABLE, mode.cause)
            : logIndex
            ? logSurface(startManifest?.files ?? 0, startManifest?.chunks ?? 0)
            : codeSurface(TABLE, siblingNames, surfaceOptions),
          siblingNames,
          hostFiles,
        ), PLAYBOOK?.outerBlock ?? "")) +
        // Without an account the platform tools are not registered, and a
        // model that finds them missing needs to know why and what the
        // person can do - once, from a terminal - rather than conclude the
        // server is broken or go looking for a key.
        (platformTools || rows || mode.kind === "unresolved" ? "" : ` ${noAccountSteps()}.`) +
        (apiTools ? apiToolsInstruction(Boolean(rows)) : "") +
        (siblingNames.length > 0 ? siblingsInstruction(TABLE, siblingNames, joinSearchable) : "") +
        DATA_INSTRUCTION),
    },
  );

  // The columns a laid-out card maps rather than lists, whole, by name or
  // family prefix - the loop's own describe_columns, served by the platform
  // from the stored card, for the model outside the loop. Offered wherever
  // a hosted table's card is folded into the text.
  if (describer && describeColumnsOffered) {
    const tablesHere = [TABLE, ...siblingNames];
    server.registerTool(
      "describe_columns",
      {
        title: "A table's column entries, whole, by name or family",
        annotations: READ_ONLY,
        description: DESCRIBE_COLUMNS_DESCRIPTION,
        inputSchema: {
          question: z.string().optional().describe(DESCRIBE_COLUMNS_QUESTION_PARAM),
          table: z
            .string()
            .optional()
            .describe(
              `The table (one of: ${tablesHere.join(", ")}). Absent with a question: the cards of the tables the question needs; absent without one: ${TABLE}.`,
            ),
          pattern: z.string().min(1).optional().describe("A column name, matched whole; `*` matches any run of characters, for a prefix (`property_report*`) or a word anywhere in the name (`*monthly*`); or `*` for every column. Case does not matter. Every column when a question is given and this is absent."),
          limit: z.number().int().positive().optional().describe("Entries to list, most rows with a value first (default 40)."),
        },
      },
      async ({ table, pattern, limit, question }: { table?: string; pattern?: string; limit?: number; question?: string }) => {
        const asked = question?.trim() ? question.trim() : undefined;
        // A question and no table: the cards of the tables it needs, ranked
        // and laid out by the platform as its loop's prompt carries them.
        if (asked && table === undefined && tablesHere.length > 1) {
          try {
            const rendered = await describer.promptCards(tablesHere, CARD_TIER, asked);
            let cards: unknown = rendered.cards;
            try {
              cards = JSON.parse(rendered.cards);
            } catch {
              // Not JSON: hand the text over as it came.
            }
            // The note the loop puts under the question, when the platform
            // ranked the cards for it: the tables in order and the columns
            // judged to hold what the question asks.
            return ok({ question: asked, cards, ...(rendered.note ? { note: rendered.note } : {}) } as Record<string, unknown>);
          } catch (err) {
            return fail(`describe_columns failed: ${(err as Error).message}${refusalHint(err)}`);
          }
        }
        const name = table ?? TABLE;
        if (!tablesHere.includes(name)) return fail(`describe_columns: unknown table ${name}; the tables here: ${tablesHere.join(", ")}`);
        if (!pattern && !asked) return fail("describe_columns needs `question` (what you need the columns for) or `pattern`");
        try {
          const record = await fetchCard(describer, name, CARD_TIER, undefined, {
            pattern: pattern ?? "*",
            ...(limit ? { limit } : {}),
            ...(asked ? { question: asked } : {}),
          });
          const found = (record.card ?? record) as RowRecord;
          const columns = Array.isArray(found.schema) ? found.schema : [];
          const matched = typeof record.matched === "number" ? record.matched : columns.length;
          const note = typeof record.note === "string" ? { note: record.note } : {};
          return ok({ table: name, pattern: pattern ?? "*", matched, listed: columns.length, columns, ...note } as Record<string, unknown>);
        } catch (err) {
          return fail(`describe_columns failed: ${(err as Error).message}${refusalHint(err)}`);
        }
      },
    );
  }

  // find and search over a table with no full-text column are not offered
  // at all (see searchDoors): the routing and the other tools' text name
  // neither there.
  if (searchDoors) {
    // search is registered only with an account: the local index holds no
    // vectors (see wantsLocalEmbed above), so a local "search" would just be
    // a thinner bm25_search under a misleading name. Without an account, reach for sql's bm25_search/token_match instead.
    if (platformTools) {
      server.registerTool(
        "search",
        {
          title: "Code search (exact terms + meaning)",
          annotations: READ_ONLY,
          description: (rows
            ? rowsSearchDescription(rows)
            : mode.kind === "unresolved"
            ? unresolvedDescription("Ranked search", TABLE)
            : "Ranked code search fusing exact keyword matching with semantic similarity, so it works " +
            "whether or not you know the words. " +
            "Use it for 'how does X work', 'where is Y handled', code by meaning, context before a " +
            "change, similar implementations. " +
            "Each hit carries path, line " +
            "range, and the chunk content: answer from the hits. The content shows each line with its " +
            "own number in the file, so cite from those numbers - the hit's line range spans the whole " +
            "chunk and is not the line a quoted or named thing sits on. Quote only text a hit shows, " +
            "from the lines you cite it to." +
            CITE_FROM_HIT +
            " When one " +
            "search is not enough, refine the query and search again. " +
            // Over long logs, the matching lines keep more of what matters
            // than whole chunks do for the same number of lines returned;
            // see focusLines.
            "Set lines to get each hit as only the lines carrying your query's words, with two lines " +
            "of context, in place of the whole chunk - for logs, test output and other long records, " +
            "where the matching lines are the answer; put the words you expect on those lines in the " +
            "query. For every occurrence of an exact " +
            "string use find; for counts and rankings use sql; for the whole files the hits name, read, " +
            "several in one call. Several searches at once: pass queries. The result includes a 'usage' field, a " +
            "one-line receipt of tokens returned, chunks and files.") + DATA_NOTE,
          inputSchema: {
            query: z.string().optional().describe("What you're looking for - terms, a phrase, or a description."),
            queries: z
              .array(z.string().min(1))
              .max(BATCH_MAX)
              .optional()
              .describe(
                "Several queries in one call, run at the same time; the results come back in the same order, " +
                  "each under its query. Use it in place of one call per query.",
              ),
            k: z.number().int().positive().max(50).default(DEFAULT_SEARCH_K).describe("Maximum hits."),
            question: z.string().optional().describe(RERANK_QUESTION_PARAM),
            lines: z
              .boolean()
              .optional()
              .describe(
                "Return each hit as only the lines of its chunk that carry one of the query's words, with " +
                  "two lines of context, each numbered with its line in the file - not the whole chunk. A " +
                  "hit reporting matchedLines 0 ranked on meaning alone and comes back whole.",
              ),
            path: z
              .string()
              .optional()
              .describe(
                "Absolute path to the repository root to search. Defaults to the server's configured root; " +
                  "set it to target a specific repo when a session spans more than one.",
              ),
            database: DATABASE_ARG,
            table: TABLE_ARG,
          },
        },
        async (args) => batched("search", args, async ({ query, k, lines, path, question, database, table }) => {
          let ctx: RepoCtx;
          try {
            ctx = repoFor(database !== undefined ? undefined : path);
          } catch (err) {
            return fail((err as Error).message);
          }
          // Over a table of a database named on the call: the table's own text
          // and embedding columns, through its database's client; the record
          // and the ledger are the default root's.
          if (database !== undefined) {
            const settled = await dataTable("search", database, table);
            if ("failed" in settled) return settled.failed;
            const { shape, client } = settled;
            if (shape.primaryText === "") {
              return fail(`search: no column of ${database}.${table} is full-text indexed, so there is no search over it; sql filters its columns${shape.vectorColumn ? `, and vector_search('${table}','${shape.vectorColumn}', {{q:"..."}}, k) ranks them by meaning` : ""}`);
            }
            try {
              const t0 = performance.now();
              const result = await searchRows(client, shape, query, k, question);
              let usage: string | undefined;
              if (receiptOn) {
                const entry = withPlatform(rowSearchEntry(result), { hosted: client });
                recordUsage(ctx.dir, entry);
                usage = formatReceipt(entry, session);
              }
              return ok({ ...result, index: "platform", database, took_ms: Math.round((performance.now() - t0) * 1000) / 1000, ...(usage ? { usage } : {}) });
            } catch (err) {
              return fail(`search failed: ${(err as Error).message}${refusalHint(err)}`);
            }
          }
          // Over the rows of a hosted table of another shape: the platform
          // fuses the table's own text and embedding columns. No local index, no
          // readiness probe - the startup decision already said the table is
          // there and what it is (rowsOver). A row has no lines to cut to, so
          // `lines` has no meaning here and is left out.
          const over = rowsOver("search", ctx);
          if (over && "failed" in over) return over.failed;
          if (over) {
            try {
              const t0 = performance.now();
              const [{ value: result, own }, recalled] = await Promise.all([answeredBy(searchRows(ctx.hosted!, over.shape, query, k, question), ctx), recallFor(query)]);
              const graph = await connectAcrossGraph(ctx, TABLE, result.hits, { query });
              let usage: string | undefined;
              if (receiptOn) {
                const entry = withMemoryTokens(withCalls(rowSearchEntry(result), own, callTelemetry(recalled.call), graph.call), recalled.block);
                recordUsage(ctx.dir, entry);
                usage = formatReceipt(entry, session);
              }
              return ok({
                ...result,
                ...graph.section,
                index: "platform",
                ...(recalled.block ? { memory: recalled.block } : {}),
                took_ms: Math.round((performance.now() - t0) * 1000) / 1000,
                ...(usage ? { usage } : {}),
              });
            } catch (err) {
              return fail(`search failed: ${(err as Error).message}${refusalHint(err)}`);
            }
          }
          // Reading the hosted index needs no local index at all, so this comes
          // before ensureIndexed: requiring a local build first would make the
          // hosted path depend on the very thing it exists to do without.
          // ctx.hosted is set for the default root whenever this tool is
          // registered at all; it is unset only when `path` names a different,
          // local-only repository (RepoRegistry carries the platform client for
          // the default root alone) - there is no local vector fallback to fall
          // back to any more, so that case is a clear refusal, not a degraded run.
          if (!ctx.hosted) {
            if (signedIn) return fail(`search: ${SIGNED_IN_ROOT}`);
            return fail(
              "search needs an account; the default repository has one but " +
                `'${path}' does not. Use sql's bm25_search/token_match for keyword ranking there instead.`,
            );
          }
          const notReady = await platformNotReady("search", ctx);
          if (notReady) return notReady;
          try {
            const t0 = performance.now();
            // The hosted table's analyzer decides which lines carry a term
            // (`lines`): the platform manifest this machine wrote when it loaded
            // the table records it; a table loaded some other way is read with
            // the platform's default for a bare column, as analyzerOf says.
            const hostedAnalyzer = analyzerOf(readPlatformManifest(ctx.dir) ?? { origin: "hosted" });
            const [{ value: result, own }, recalled] = await Promise.all([
              answeredBy(searchHosted(ctx.hosted, query, k, { lines, analyzer: hostedAnalyzer, question }), ctx),
              recallFor(query),
            ]);
            // The hits seed the graph by their place: a chunk's path and
            // start line name its row.
            const graph = await connectAcrossGraph(
              ctx,
              TABLE,
              result.hits.map((hit) => ({ path: hit.path, start_line: hit.startLine })),
              { query },
            );
            let usage: string | undefined;
            if (receiptOn) {
              // withPlatform, as the rows path does: the platform
              // returns the tokens it metered for this call, and without this
              // a remote search is the one hosted path whose read tokens never
              // reach the ledger. Estimating them at a fixed rate per search
              // would be a made-up number standing in for one the response
              // already carries. The recall's read rides on
              // the same line.
              const entry = withMemoryTokens(withCalls(searchEntry(result, ctx.root), own, callTelemetry(recalled.call), graph.call), recalled.block);
              recordUsage(ctx.dir, entry);
              usage = formatReceipt(entry, session);
            }
            return ok({
              ...result,
              ...graph.section,
              index: "platform",
              ...(recalled.block ? { memory: recalled.block } : {}),
              took_ms: Math.round((performance.now() - t0) * 1000) / 1000,
              ...(usage ? { usage } : {}),
            });
          } catch (err) {
            return fail(`search failed: ${(err as Error).message}${refusalHint(err)}`);
          }
        }),
      );
    }

    server.registerTool(
      "find",
      {
        title: "Find exact text (every occurrence, like grep -n)",
        annotations: READ_ONLY,
        description: (rows
          ? rowsFindDescription(rows)
          : mode.kind === "unresolved"
          ? unresolvedDescription("Every row holding every word of an exact string", TABLE)
          : "Every line in the repository containing an exact string, like grep -n: complete and " +
          "unranked, written as grep writes it (path:line:text, one line per match, the enclosing " +
          "definition in brackets when known), with the repo-wide total and the per-file counts after " +
          "the matches (the grep -c answer). " +
          "Literal text within one line, case-sensitive unless ignoreCase. Use it where you would " +
          "grep: every use or definition of an identifier, an error message, a config key. Set defines " +
          "to get only where a name is defined rather than everywhere it appears. " +
          // A find for a guessed signature returns nothing and sends the model
          // to a regex Grep; the bare name with defines lists the declarations
          // on the first call.
          FIND_BY_BARE_NAME +
          // A flood keeps every place: the lines past the text budget come as
          // path and line numbers (`more`), and a line's text is a sql read.
          // A question about what each match does or relies on is answered
          // by the lines around it, so they come by default (findForm), and
          // the pages of a wide result are named so they come in one reply.
          ` Each match comes in the block of code it sits in, with the ${AUTO_CHUNK_CONTEXT} lines around it - the ` +
          "comment above it, the lines below - numbered as a file read is and merged where they meet, so what each " +
          "match does or relies on is in the result and no file need be opened. chunks: true carries whole blocks; " +
          "chunks: false the matching line alone, as grep -n does, and with context the lines before and after it " +
          "(grep -B/-A). When a result names further pages, ask for every one of them in the same reply with skip. " +
          "Never follow a find with a read per match. " +
          "A wide result lists every matching place: the first lines with their text, the rest by path and " +
          "line after them; a line's text is one sql statement away, and the per-file counts count them all. " +
          "A count per project or per file - which projects use X, how many times each - is one sql statement, " +
          "never a shell pipeline: " +
          PER_PROJECT_COUNT +
          " Not for a file you already know - read it, with every other file you need, in one read call, or its lines are " +
          `one sql statement away (SELECT start_line, content FROM ${TABLE} WHERE path = '...' ORDER BY start_line). ` +
          "For meaning or 'how does X work' use search; for rankings use sql. " +
          "Several finds at once: pass queries. " +
          "The result includes a 'usage' field, a one-line receipt of tokens returned, matches and files.") + DATA_NOTE,
        inputSchema: {
          query: z
            .string()
            .min(1)
            .optional()
            .describe(
              "The exact text to find, as it appears in the code - an identifier, a string, a key. Never a " +
                "signature or a line you have not read: one character off and nothing matches.",
            ),
          queries: z
            .array(z.string().min(1))
            .max(BATCH_MAX)
            .optional()
            .describe(
              "Several exact strings in one call, found at the same time; the results come back in the " +
                "same order, each under its query. Use it in place of one call per string.",
            ),
          ignoreCase: z
            .boolean()
            .optional()
            .describe("Match regardless of letter case. Default false: case-sensitive, like grep."),
          defines: z
            .boolean()
            .optional()
            .describe(
              "Keep only lines inside a definition of the query - where the name is declared, not every " +
                "place it is used. Answers 'where is X defined' in one call instead of reading use sites " +
                "until one turns out to be the declaration. The result reports definedFrom, how many " +
                "matching lines there were before the filter.",
            ),
          under: z
            .string()
            .optional()
            .describe(
              "Repo-relative path prefix to scope to - one repository of a workspace, one subtree of a " +
                "monorepo, one directory. The total and the per-file counts then describe that subtree, " +
                "and the result echoes `under` so the numbers are not mistaken for the whole repository. " +
                "Reach for it when a common name would return thousands of lines across everything: " +
                "scoping is exact here, because find retrieves every match and cuts afterwards.",
            ),
          limit: z
            .number()
            .int()
            .positive()
            .max(MAX_FIND_LIMIT)
            .default(DEFAULT_FIND_LIMIT)
            .describe(
              "Matching lines one result carries at most: a page, not a cap on the find. With more than this, the " +
                "result names the skip of each following page; the result reports the total either way.",
            ),
          question: z.string().optional().describe(RERANK_QUESTION_PARAM),
          context: z
            .number()
            .int()
            .min(0)
            .max(MAX_FIND_CONTEXT)
            .optional()
            .describe(
              `Lines around each match to carry. Unset, each match comes in its block with ${AUTO_CHUNK_CONTEXT} lines ` +
                "around it. With chunks true, each block keeps this many lines around its matches; given alone or " +
                "with chunks false, the matching line comes with this many lines before and after it, as grep -B/-A " +
                "shows. Up to 20; more than a few matches with context is a wide result.",
            ),
          chunks: z
            .boolean()
            .optional()
            .describe(
              `Unset, each match comes in the block of code it sits in, trimmed to ${AUTO_CHUNK_CONTEXT} lines around ` +
                "it, its lines numbered. true: the whole block - the chunk the index holds it in - for the body " +
                "around a match; past two pages of whole blocks they are trimmed too, and the result says so. " +
                "false: the matching line alone, as grep -n writes it - for a list of places or a count. A block " +
                "holding several matches comes once, and overlapping blocks are not repeated. The text budget " +
                "still applies; the matches of blocks past it are listed by path and line.",
            ),
          skip: z
            .number()
            .int()
            .min(0)
            .optional()
            .describe(
              "Matching lines to pass over before this result starts: the next page of a find its budget cut. A " +
                "result that could not carry every match names the skip of each following page; ask for all of " +
                "them in one reply, one call each, rather than one find per file.",
            ),
          path: z
            .string()
            .optional()
            .describe(
              "Absolute path to the repository root to search. Defaults to the server's configured root; " +
                "set it to target a specific repo when a session spans more than one. This is a different " +
                "index; `under` narrows within one.",
            ),
          database: DATABASE_ARG,
          table: TABLE_ARG,
        },
      },
      async (args) => batched("find", args, async ({ query, ignoreCase, defines, under, limit, context, chunks, skip, path, question, share, database, table }) => {
        let ctx: RepoCtx;
        try {
          ctx = repoFor(database !== undefined ? undefined : path);
        } catch (err) {
          return fail((err as Error).message);
        }
        // Over a table of a database named on the call, as search runs: the
        // rows whose text column holds every word, by the index's words.
        if (database !== undefined) {
          const settled = await dataTable("find", database, table);
          if ("failed" in settled) return settled.failed;
          const { shape, client } = settled;
          if (shape.primaryText === "") return fail(`find: no column of ${database}.${table} is full-text indexed, so there is no find over it; sql filters its columns`);
          try {
            const t0 = performance.now();
            const result = await findRows(client, shape, query, { limit, question });
            let usage: string | undefined;
            if (receiptOn) {
              const entry = withPlatform(rowFindEntry(result), { hosted: client });
              recordUsage(ctx.dir, entry);
              usage = formatReceipt(entry, session);
            }
            return ok({ ...result, index: "platform", database, took_ms: Math.round((performance.now() - t0) * 1000) / 1000, ...(usage ? { usage } : {}) });
          } catch (err) {
            return fail(`find failed: ${(err as Error).message}${refusalHint(err)}`);
          }
        }
        // Over the rows of a hosted table of another shape the find needs no
        // local index, so this comes before the local index - which would be
        // built, and with it drop the platform table (see ownsTable). The
        // code-index options (ignoreCase, defines, under) have no meaning for a
        // row and are left out, as the tool text says. Read off the startup
        // decision: in chunks mode this is the local tool it always was, and
        // nothing here waits on the platform.
        const over = rowsOver("find", ctx);
        if (over && "failed" in over) return over.failed;
        if (over) {
          try {
            const t0 = performance.now();
            const result = await findRows(ctx.hosted!, over.shape, query, { limit, question });
            let usage: string | undefined;
            if (receiptOn) {
              const entry = withPlatform(rowFindEntry(result), ctx);
              recordUsage(ctx.dir, entry);
              usage = formatReceipt(entry, session);
            }
            return ok({
              ...result,
              index: "platform",
              took_ms: Math.round((performance.now() - t0) * 1000) / 1000,
              ...(usage ? { usage } : {}),
            });
          } catch (err) {
            return fail(`find failed: ${(err as Error).message}${refusalHint(err)}`);
          }
        }
        const ensured = await localIndex(ctx);
        if ("failed" in ensured) return ensured.failed;
        const { handle, autoIndexed } = ensured;
        if (!autoIndexed) maybeAutoSync(ctx); // a fresh build is already current
        try {
          const t0 = performance.now();
          // A batch shares the one text budget between its queries; the
          // pages a result names are worked out for calls of their own.
          const form = findForm(chunks, context);
          const result = await find(handle, query, { ignoreCase, defines, under, limit, context: form.context, chunks: form.chunks, skip, share });
          const listed = result.matches.length + (result.more ?? []).reduce((n, m) => n + m.lines.length, 0);
          const hint =
            findHint(query, result.total, Boolean(defines), result.matches.length, listed, Boolean(result.blocks), result.pages, result.skip) ??
            undefined;
          const noted = autoIndexed ? autoIndexNote(autoIndexed) : undefined;
          const tookMs = Math.round((performance.now() - t0) * 1000) / 1000;
          const aroundByDefault = form.aroundByDefault;
          // Written as grep writes it (`renderFind`); the receipt prices that
          // text, since it is what was returned, and rides on its last line.
          let usage: string | undefined;
          if (receiptOn) {
            const entry = findEntry(result, false, renderFind(result, { hint, autoIndexed: noted?.note, tookMs, aroundByDefault }));
            recordUsage(ctx.dir, entry);
            usage = formatReceipt(entry, session);
          }
          return ok(
            {
              ...result,
              ...(hint ? { hint } : {}),
              ...(noted ? { auto_indexed: noted } : {}),
              took_ms: tookMs,
              ...(usage ? { usage } : {}),
            },
            renderFind(result, { hint, autoIndexed: noted?.note, tookMs, usage, aroundByDefault }),
          );
        } catch (err) {
          return fail(`find failed: ${(err as Error).message}`);
        }
      }),
    );
  }

  server.registerTool(
    "sql",
    {
      title: "SQL over the code index",
      annotations: READ_ONLY,
      description: sqlDescription + DATA_NOTE,
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe("A single read-only SELECT or WITH statement. May use search table functions and {{name}} vector placeholders."),
        queries: z
          .array(z.string().min(1))
          .max(BATCH_MAX)
          .optional()
          .describe(
            "Several statements in one call, run at the same time and sharing embed and question; the " +
              "results come back in the same order, each under its statement. Use it in place of one " +
              "call per statement.",
          ),
        embed: z
          .record(z.string(), z.string())
          .optional()
          .describe('Map of placeholder name → query text, embedded server-side. E.g. {"q":"vector indexing"} fills {{q}}.'),
        question: z
          .string()
          .optional()
          .describe(
            "The question these rows are meant to answer, in the words it was asked. Used only to check " +
              "the rows against it - the result's 'validation' then says whether they answer it and what " +
              "is missing if not.",
          ),
        path: z
          .string()
          .optional()
          .describe(
            "Absolute path to the repository root to query. Defaults to the server's configured root; " +
              "set it to target a specific repo when a session spans more than one.",
          ),
        database: DATABASE_ARG,
        table: z.string().min(1).optional().describe("With `database`: the table the statement is about, for the verdict on its rows; absent, the first table of the database the statement names."),
      },
    },
    async (args) => batched("sql", args, async ({ query: written, embed, question, path, database, table }) => {
      let ctx: RepoCtx;
      try {
        ctx = repoFor(database !== undefined ? undefined : path);
      } catch (err) {
        return fail((err as Error).message);
      }
      const embeds = embed as Record<string, string> | undefined;
      // A query placeholder spelled close to the platform's `{{q:"..."}}` is
      // read as it, before anything else reads the statement: the checks
      // below, the routing, the platform and the verdict all see the one
      // statement that runs (core/searcher.ts). Only where a platform is
      // behind the context: the platform's form is the platform's alone, so
      // a statement for the local index stays as written, and the engine's
      // error, if it fails, names what the caller wrote.
      const query = ctx.hosted || database !== undefined ? normalizeQueryPlaceholders(written) : written;
      // What the checks on the statement's text read: the statement without
      // its comments, since a table, a search call or an ORDER BY named in
      // one would read to the join gate, the top-k check and the row
      // ranking as if the statement wrote it. The statement itself runs
      // with them - the engine reads its own comments.
      const code = withoutComments(query);
      // The read-only guard first, before any check reads the statement or
      // the platform is asked anything about it; runSql and runSqlRows hold
      // it again where the statement runs.
      try {
        guardSql(query);
      } catch (err) {
        return fail(`sql failed: ${(err as Error).message}`);
      }
      // A GROUP BY over a ranked search's small top k ranks a share of those
      // rows, not the corpus; refused with the shapes that do, on every path
      // (core/topk-aggregate.ts). The one shape behind every ranking the
      // Infino arm lost on the 2026-09-24 panel, warned against in the text
      // above and written anyway by every caller family.
      const topK = topKAggregateRefusal("sql", code);
      if (topK) return fail(topK);
      // Over a database named on the call: the statement runs there, on the
      // platform, held to the keys among that database's tables.
      if (database !== undefined) return sqlOnDatabase(ctx, database, table, query, code, embeds, question);
      // In the `table` scope a statement reaches the server's own table
      // alone: one naming another table of the database - as an identifier,
      // or as a search or graph function's argument - is refused before it
      // runs. A name matched inside a string literal is refused too; the
      // check errs toward refusing.
      if (accountScope === "table" && ctx.hosted) {
        let outside: string[];
        try {
          outside = tablesNamed(code, await tablesOutside(ctx));
        } catch (err) {
          return fail(`sql failed: the database's tables could not be listed to check the statement: ${(err as Error).message}`);
        }
        if (outside.length > 0) {
          return fail(`sql: this server reads the ${TABLE} table alone, and the statement names ${outside.join(", ")}, another table of its database`);
        }
      }
      // A statement across two or more of the hosted tables is held to the
      // keys the platform found on their values: one written without any of
      // them is refused with the keys, and the model rewrites it. The model
      // was measured not to call join_keys on its own and to match columns
      // by name instead (2026-09-24); the owner: "either the model calls it
      // or we force a rewrite internally".
      if (ctx.hosted && siblingNames.length > 0) {
        const verdict = await joinGate(code, [TABLE, ...siblingNames], keysAmong);
        if (verdict.kind === "refuse") return fail(joinRefusal("sql", verdict));
      }
      // Over the rows of a hosted table of another shape the statement runs
      // on the platform - and this comes before the local index for the
      // reason find's does. The rows come back as the platform gave them: a
      // table of rows has no lines to number. The verdict is diagnosed
      // against the table's own text column.
      const over = rowsOver("sql", ctx);
      if (over && "failed" in over) return over.failed;
      if (over) return sqlOnPlatform(ctx, query, embeds, question, { column: over.shape.primaryText, numbered: false, key: over.shape.keyColumn });
      // With sibling tables named, every statement runs on the platform: a
      // JOIN across them has nowhere else to run, and a plain statement over
      // the primary alone gives the same rows there as here.
      if (ctx.hosted && siblingNames.length > 0) {
        const notReady = await platformNotReady("sql", ctx);
        if (notReady) return notReady;
        return sqlOnPlatform(ctx, query, embeds, question, { numbered: true });
      }
      // The chunks table's statement runs on the platform when it embeds a
      // query, whatever else is configured: a `{{q}}` is a vector function's,
      // the platform embeds it with the table's own model, and the local side
      // is lexical - a plain statement stays local (owner, 2026-09-09: "all
      // vector search happens on the cloud ... only pure sql runs locally").
      // Until 2026-09-12 every such statement ran on the local index. On the
      // engine corpus that ranked against the old local vectors while the
      // tool read as hosted; on a corpus whose local index was built
      // keyword-only (OpenSearch, in the side-by-side demo) it failed every
      // hybrid_search the model wrote, and the arm was graded on the keyword
      // fallback. Same readiness probe as search: the table has to be there.
      if (ctx.hosted && embedsAQuery(query)) {
        const notReady = await platformNotReady("sql", ctx);
        if (notReady) return notReady;
        return sqlOnPlatform(ctx, query, embeds, question, { numbered: true });
      }
      // No account, and the statement embeds a query: there is nowhere for
      // it to run. The local index carries no vector column at all - only
      // the platform's copy ever does (see wantsLocalEmbed above) - so
      // refuse plainly rather than let the engine fail on a missing column.
      if (!ctx.hosted && embedsAQuery(query)) {
        if (signedIn) return fail(`sql: ${SIGNED_IN_ROOT}`);
        return fail(
          "this statement embeds a query (hybrid_search/vector_search), which needs an account - " +
            "there is no local vector index. Use bm25_search or token_match for keyword ranking instead. " +
            `${noAccountSteps()}.`,
        );
      }
      const ensured = await localIndex(ctx);
      if ("failed" in ensured) return ensured.failed;
      const { handle, autoIndexed } = ensured;
      if (!autoIndexed) maybeAutoSync(ctx); // a fresh build is already current
      try {
        const t0 = performance.now();
        // Numbered where the projection places the text, so a line cited out
        // of a SQL row is read off the row rather than counted. Numbered
        // before the receipt, not after: a receipt is only worth having if it
        // is the thing that was returned, and these rows are what the caller
        // gets.
        // Ranked the same way the platform path's rows are: an ordered
        // result carries each row's place in its order (core/facts.ts).
        const raw = await runSql(handle, getEmbedder(), query, embed as Record<string, string> | undefined);
        const rows = rankRows(raw.map(numberRowLines), code);
        const partial = partialIndex(handle.manifest);
        // The platform's own retrieval contract, applied to these rows before
        // they go back. The answering loop gates every query it runs on this
        // check; a caller writing its own SQL has the same problem and could
        // not ask. Attached to the result rather than offered as a tool
        // because a check the model may call is a check the model declines -
        // measured on the card tool the same day (2026-09-11).
        //
        // `question` is not the SQL: the statement's own text counts for
        // nothing here, which is the defect the check exists to catch. With
        // no question the aggregate half still applies, and that is the half
        // that matters for a ranking or a count - the case where a statement
        // runs, returns a row of zeros, and reads as an answer.
        const { verdict, telemetry } = await platformVerdict(ctx, query, rows, question);
        let usage: string | undefined;
        if (receiptOn) {
          const entry = sqlEntry(query, rows);
          // The validate call's metered Read Tokens: filed so "our charge"
          // reflects what the platform actually billed for this sql.
          if (telemetry) entry.platform = telemetry;
          recordUsage(ctx.dir, entry);
          usage = formatReceipt(entry, session);
        }
        const held = budgetSqlRows(rows, (row) => jsonify(row).length);
        const hint = sqlBudgetHint(rows.length, held.budget);
        return ok({
          rows: held.rows,
          ...(hint ? { hint } : {}),
          ...(verdict ? { validation: verdict } : {}),
          ...(partial ? { partial } : {}),
          ...(autoIndexed ? { auto_indexed: autoIndexNote(autoIndexed) } : {}),
          took_ms: Math.round((performance.now() - t0) * 1000) / 1000,
          ...(usage ? { usage } : {}),
        });
      } catch (err) {
        return fail(`sql failed: ${(err as Error).message}`);
      }
    }),
  );

  // The files the index named, read whole: several in one call. Without it,
  // once the index has named the files, the caller reads them with its own
  // Read one per turn, each turn re-sending the transcript. Over a table of
  // documents (`TableShape.document`) a document is the rows sharing a path;
  // without a door for it a caller pages each one through sql, many calls a
  // document. A table of records has no document to read, and the rows of one that could
  // not be described none either: neither registers it.
  if (mode.kind === "chunks" || rows?.document) {
    server.registerTool(
      "read",
      {
        title: rows ? "Read documents the index named (several at once)" : "Read files the index named (several at once)",
        annotations: READ_ONLY,
        description: readDescription(rows),
        inputSchema: {
          paths: z
            .array(z.string().min(1))
            .min(1)
            .max(READ_PATHS_MAX)
            .describe(
              rows?.document
                ? `The documents' ${rows.document.pathColumn} values, as find, search and sql return them - every document you want, in one call.`
                : "Repo-relative paths, as find, search and sql cite them - every file you want, in one call.",
            ),
          from: lineOrLines
            .optional()
            .describe("First line to return, in every file named - or a list, one per range, paired with to. Default 1."),
          to: lineOrLines
            .optional()
            .describe("Last line to return, in every file named - or a list, one per range, paired with from. Default the end."),
          path: z
            .string()
            .optional()
            .describe(
              "Absolute path to the repository root to read from. Defaults to the server's configured root; " +
                "set it to target a specific repo when a session spans more than one.",
            ),
        },
      },
      async ({ paths, from, to, path }) => {
        let ctx: RepoCtx;
        try {
          ctx = repoFor(path);
        } catch (err) {
          return fail((err as Error).message);
        }
        let ranges: ReturnType<typeof readRanges>;
        try {
          ranges = readRanges(from, to);
        } catch (err) {
          return fail(`read failed: ${(err as Error).message}`);
        }
        // Over a hosted table of documents the read is one statement on the
        // platform, before the local index for the reason find's is: a build
        // would drop the table (see ownsTable).
        const over = rowsOver("read", ctx);
        if (over && "failed" in over) return over.failed;
        if (over) {
          const document = over.shape.document;
          try {
            const t0 = performance.now();
            const { value: files, own } = await answeredBy(readRows(ctx.hosted!, over.shape, paths, { ranges, budget: readBudget(paths) }), ctx);
            const got = readHits(files).filter((f) => f.lines !== "");
            let usage: string | undefined;
            if (receiptOn) {
              const entry = withCalls(readEntry(got, TABLE), own);
              recordUsage(ctx.dir, entry);
              usage = formatReceipt(entry, session);
            }
            const next = readNextCalls(files);
            return ok({
              files,
              ...(next.length > 0 ? { next } : {}),
              index: "platform",
              took_ms: Math.round((performance.now() - t0) * 1000) / 1000,
              ...(usage ? { usage } : {}),
            });
          } catch (err) {
            return fail(`read failed: ${(err as Error).message}${refusalHint(err)}`);
          }
        }
        const ensured = await localIndex(ctx);
        if ("failed" in ensured) return ensured.failed;
        const { handle, autoIndexed } = ensured;
        if (!autoIndexed) maybeAutoSync(ctx); // a fresh build is already current
        try {
          const t0 = performance.now();
          const files = await readFiles(handle, paths, { ranges, budget: readBudget(paths) });
          const got = readHits(files).filter((f) => f.lines !== "");
          let usage: string | undefined;
          if (receiptOn) {
            const entry = readEntry(got);
            recordUsage(ctx.dir, entry);
            usage = formatReceipt(entry, session);
          }
          const next = readNextCalls(files);
          return ok({
            files,
            ...(next.length > 0 ? { next } : {}),
            ...(autoIndexed ? { auto_indexed: autoIndexNote(autoIndexed) } : {}),
            took_ms: Math.round((performance.now() - t0) * 1000) / 1000,
            ...(usage ? { usage } : {}),
          });
        } catch (err) {
          return fail(`read failed: ${(err as Error).message}`);
        }
      },
    );
  }

  if (hosted && accountScope !== "table") {
    // The call before a JOIN, on every hosted server and not only under
    // CX_API_TOOLS: a model that knows which tables its question spans has
    // no other way to the keys (the owner, 2026-09-24: "the outer model
    // knows the tables it wants to search across. what does it do then?").
    // Not in the `table` scope, where there is one table and nothing to join.
    const keysDb = hostedDbFor(hosted, { ...hostedOptions, coldStartSecs: 0 });
    server.registerTool(
      "join_keys",
      {
        title: "The keys two or more tables join on, found on their values",
        annotations: READ_ONLY,
        description:
          "The keys the named tables join on, found by the platform on the tables' values - which columns hold " +
          "each other's values, and through which expression where they meet only through one - never by " +
          "matching column names. Each join comes back with its two sides, the share of the referencing side's " +
          "values found on the other, whether a statement counted it, and 'predicate', the ON clause ready to " +
          // A table with no full-text column has no search to alias.
          (searchDoors
            ? `paste: alias a search's rows as the table (FROM hybrid_search('${TABLE}', ...) AS ${TABLE} JOIN other ON ` +
              "<predicate>) and it reads as written. "
            : `paste: FROM ${TABLE} JOIN other ON <predicate> reads as written. `) +
          "Call it before writing a statement across tables.",
        inputSchema: {
          tables: z.array(z.string().min(1)).min(2).max(8).describe(`The tables the statement will span, ${TABLE} among them when it is one of them.`),
          database: DATABASE_ARG,
        },
      },
      async ({ tables, database }: { tables: string[]; database?: string }) => {
        const through = database !== undefined ? data?.quick(database) : keysDb;
        if (!through) return noDataPlane("join_keys");
        try {
          return ok((await through.joinKeys(tables)) as Record<string, unknown>);
        } catch (err) {
          return fail(`join_keys failed: ${(err as Error).message}${refusalHint(err)}`);
        }
      },
    );

    // The page a row came from, for the tables whose card says the
    // deployment knows where their documents lie (`pages`, from the
    // platform's `gateway_settings.pages`). The text a row holds is a parse
    // of the page; what the parse loses - a chart's shading, a misread
    // figure - is still on the page, and the platform hands back its scanned
    // image. With one such table the tool names none; with several, the
    // model says which table the row is in.
    const pageTables = agentApis ? pagedTables([{ table: TABLE, pages: primaryPages }, ...siblings]) : [];
    if (pageTables.length > 0) {
      const rowInput = {
        document: z.string().min(1).describe("The row's `document`, as the table holds it."),
        page: z.number().int().min(1).describe("The row's `page`, counted from 1."),
      };
      const inputSchema: Record<string, z.ZodTypeAny> =
        pageTables.length > 1
          ? { table: z.enum(pageTables as [string, ...string[]]).describe("The table the row is in."), ...rowInput }
          : rowInput;
      server.registerTool(
        "page",
        {
          title: "A row's page as it was printed",
          annotations: READ_ONLY,
          _meta: { "anthropic/maxResultSizeChars": PAGE_RESULT_MAX_CHARS },
          description:
            "The page a row came from, as its scanned image: pass the row's `document` and `page`. Use it when the " +
            "row's text cannot settle the question - a chart or a shading the text only describes ('[figure: ...]'), " +
            "a figure that looks misread (digits that do not add up to the printed total), columns the text has run " +
            "together. The image is the page as printed: read the figures off it.",
          inputSchema,
        },
        async (args: Record<string, unknown>) => {
          // The schema above is checked before this runs: `table` only where
          // several tables have pages, one of them.
          const { table, document, page } = args as { table?: string; document: string; page: number };
          try {
            const image = await keysDb.page(table ?? pageTables[0], document, page);
            return {
              content: [
                { type: "image" as const, data: String(image.data), mimeType: String(image.media_type) },
                { type: "text" as const, text: `${document}, page ${page} (${image.width} x ${image.height} px)` },
              ],
            };
          } catch (err) {
            return fail(`page failed: ${(err as Error).message}${refusalHint(err)}`);
          }
        },
      );
    }

    // A web page, where the deployment gives the run the web (CX_WEB_FETCH).
    // A search answers with snippets, so a series the database does not hold
    // - a price index's monthly values - was taken from memory instead; this
    // reads the page the search named. The platform reads it, as it reads a
    // row's page: nothing is fetched from this machine, and the platform
    // refuses any address not on the public internet.
    if (agentApis && webFetchEnabled()) {
      server.registerTool(
        "web_fetch",
        {
          title: "A web page's text",
          annotations: { ...READ_ONLY, openWorldHint: true },
          description:
            "The text of a web page, read by the platform: pass its `url` (http or https), such as a page a web " +
            "search named. A markup page comes back as its words, a table's cells kept apart; a CSV, JSON or plain " +
            "text page as sent. A long page comes a stretch at a time: pass the answer's `next_offset` as `offset` " +
            "to read on. Use it for figures the database does not hold - a published series, an index's values - " +
            "and take them from the page, never from memory.",
          inputSchema: {
            url: z.string().min(1).describe("The page's address, http or https."),
            offset: z
              .number()
              .int()
              .min(0)
              .optional()
              .describe("The character to start from: a previous answer's `next_offset`. 0 when absent."),
          },
        },
        async ({ url, offset }: { url: string; offset?: number }) => {
          try {
            const page = await keysDb.webFetch(url, offset ?? 0);
            const text = String(page.text ?? "");
            const from = Number(page.offset ?? 0);
            const next = page.next_offset == null ? "" : `; read on with offset ${page.next_offset}`;
            const header =
              `${page.url} (${page.content_type || "no stated type"}): characters ${from}-${from + Array.from(text).length} ` +
              `of ${page.total_chars}${next}`;
            return { content: [{ type: "text" as const, text: `${header}\n\n${text}` }] };
          } catch (err) {
            return fail(`web_fetch failed: ${(err as Error).message}${refusalHint(err)}`);
          }
        },
      );
    }
  }

  if (data) {
    const plane = data;
    server.registerTool(
      "tables",
      {
        title: "The account's databases and tables, and a table's shape",
        annotations: READ_ONLY,
        description:
          "What the Infino account holds, before the first query over its data: with no argument, every " +
          "database of the account with its tables (a database holding a chunks table is a repository's " +
          "index; the others are data); with database, that database's tables; with database and table, the " +
          "table's columns with their types, which columns are full-text indexed and which the platform embeds, " +
          "the column that names a row, and the table's card - its statistics, sample rows and, when the " +
          "optimizer wrote one, what each column means. Call it once before writing a statement over a table; " +
          "then sql, search and find take database (and table) to run over it.",
        inputSchema: {
          database: z.string().min(1).optional().describe("A database of the account: its tables. With table, that table's shape."),
          table: z.string().min(1).optional().describe("With database: the table whose columns, indexes, key and card to return."),
        },
      },
      async ({ database, table }: { database?: string; table?: string }) => {
        try {
          if (database === undefined) {
            const databases = await plane.databases();
            // Every database's tables at once, through the clients that
            // never wait a cold start out: one that is starting is said to be.
            const listed = await Promise.all(
              databases.map(async (d) => {
                try {
                  const names = await plane.tableNames(d.name);
                  return { name: d.name, state: d.state, kind: names.includes(DEFAULT_TABLE) ? "code" : "data", tables: names };
                } catch (err) {
                  return { name: d.name, state: d.state, tables: `not listed: ${(err as Error).message}` };
                }
              }),
            );
            return ok({ platform: plane.baseUrl, databases: listed, next: "tables with database and table gives a table's columns, text and vector columns, key and card" });
          }
          if (table === undefined) return ok({ database, tables: await plane.tableNames(database) });
          const shape = await plane.shape(database, table);
          return ok({
            database,
            table,
            columns: shape.columns,
            text_columns: shape.textColumns,
            ...(shape.textColumnsInferred && shape.textColumns.length > 0 ? { text_columns_inferred: true } : {}),
            primary_text: shape.primaryText === "" ? null : shape.primaryText,
            vector_column: shape.vectorColumn,
            ...(shape.vectorColumn ? { vector_source: shape.vectorSource } : {}),
            key_column: shape.keyColumn,
            link_column: shape.linkColumn,
            title_column: shape.titleColumn,
            list_columns: shape.listColumns,
            ...(shape.chunking ? { chunking: shape.chunking } : {}),
            ...(shape.card ? { card: shape.card } : {}),
            how:
              `sql with database "${database}" runs one statement over ${table}` +
              (shape.primaryText !== ""
                ? `; search and find with table "${table}" run over its ${shape.primaryText}`
                : "; no column is full-text indexed, so there is no search or find over it") +
              ".",
          });
        } catch (err) {
          return fail(`tables failed: ${(err as Error).message}${refusalHint(err)}`);
        }
      },
    );

    // The tools that write - a load, its cancel - and the status read that
    // only makes sense beside them: not on a read-only server (a shared
    // URL with no sign-in), where `tables` and the query tools are the
    // whole surface.
    if (!readOnly) {
      /** The sources `hydrate` takes, flat so a model fills one shape: the
       * kind, and the fields the kind reads. */
      const SOURCE_KINDS = ["bucket", "prefix", "path", "ssh"] as const;
      const OFFERED_KINDS = hostFiles ? SOURCE_KINDS : (["bucket", "prefix"] as const);
      const sourceOf = (given: { kind: (typeof SOURCE_KINDS)[number]; bucket?: string; prefix?: string; path?: string; host?: string }): HydrateToolSource => {
        if (!(OFFERED_KINDS as readonly string[]).includes(given.kind)) throw new Error(`kind ${given.kind} reads this server's own machine, which is not yours; load from a bucket`);
        switch (given.kind) {
          case "bucket":
            if (!given.bucket) throw new Error("a bucket source names the bucket");
            return { kind: "bucket", bucket: given.bucket, prefix: given.prefix ?? "" };
          case "prefix":
            if (!given.prefix) throw new Error("a prefix source names the prefix under the database's root");
            return { kind: "prefix", prefix: given.prefix };
          case "path":
            if (!given.path) throw new Error("a path source names a file or directory on this machine");
            return { kind: "path", path: given.path };
          case "ssh":
            if (!given.host || !given.path) throw new Error("an ssh source names the host and the path on it");
            return { kind: "ssh", host: given.host, path: given.path };
        }
      };

      server.registerTool(
        "hydrate",
        {
          title: "Load a dataset into a database of the account",
          annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
          description:
            "Load a dataset into a table of a database of the Infino account, from wherever it is: a bucket " +
            "prefix in object storage the platform reads itself (kind bucket, the platform's identity granted " +
            "read on it)" +
            (hostFiles
              ? ", a prefix already under the database's own storage (kind prefix), a file or directory " +
                "on this machine (kind path), or one on a machine this machine reaches with ssh (kind ssh, host as " +
                "ssh resolves it) - the files are then put into the database's storage first and loaded from there. "
              : " or a prefix already under the database's own storage (kind prefix). ") +
            "Parquet, CSV, NDJSON and Iceberg are read by their extension (format auto); documents (PDF, text) " +
            "with format documents. fts names the columns to index for search and find, embed the column to " +
            "embed and the text columns it embeds; left out, the platform picks from the data. The database is " +
            "registered on the account if it does not exist. The load runs on the platform and this returns at " +
            "once with the job: hydrate_status follows it. dry_run checks the load and writes nothing. Never " +
            "call it unasked: it spends the account's storage and credit.",
          inputSchema: {
            database: z.string().min(1).describe("The database to load into; registered on the account if new."),
            table: z.string().min(1).optional().describe("The table to load. Absent, one table per folder of the source, each named after its folder."),
            kind: z.enum(OFFERED_KINDS).describe(hostFiles ? "Where the data is: bucket, prefix (under the database's storage), path (this machine), ssh (a machine reached by ssh)." : "Where the data is: bucket, or prefix (under the database's storage)."),
            bucket: z.string().optional().describe("kind bucket: the bucket's name."),
            prefix: z.string().optional().describe("kind bucket: the key prefix inside it (empty for the whole bucket); kind prefix: the prefix under the database's root."),
            path: z.string().optional().describe("kind path or ssh: the file or directory."),
            host: z.string().optional().describe("kind ssh: the host, as the person's own ssh names it (an ssh config name, or user@machine)."),
            format: z.enum(["auto", "parquet", "csv", "ndjson", "iceberg", "documents"]).optional().describe("How the files are read; auto by their extension (the default here)."),
            fts: z.array(z.string().min(1)).optional().describe("The text columns to index for search and find."),
            embed: z.object({ column: z.string().min(1), source: z.array(z.string().min(1)).min(1) }).optional().describe("The vector column to add and the text columns it embeds."),
            no_embed: z.boolean().optional().describe("Load with no vector column."),
            chunk: z.record(z.string(), z.unknown()).optional().describe("How a long text column is cut into passages, in the platform's own fields (column, max_tokens, overlap_tokens, ...)."),
            if_exists: z.enum(["refuse", "append"]).optional().describe("When the table exists: refuse (the default) or append."),
            dry_run: z.boolean().optional().describe("Check the load without writing anything."),
            notify_email: z.string().optional().describe("An address the platform mails when the load ends."),
            options: z.record(z.string(), z.unknown()).optional().describe("Any other field of the platform's hydrate request, as the platform spells it."),
          },
        },
        async ({ database, table, kind, bucket, prefix, path, host, format, fts, embed, no_embed, chunk, if_exists, dry_run, notify_email, options }) => {
          try {
            const source = sourceOf({ kind, bucket, prefix, path, host });
            const t0 = performance.now();
            const result = await plane.hydrate({
              database,
              ...(table !== undefined ? { table } : {}),
              source,
              ...(format !== undefined ? { format } : {}),
              ...(fts !== undefined ? { fts } : {}),
              ...(embed !== undefined ? { embed } : {}),
              ...(no_embed !== undefined ? { no_embed } : {}),
              ...(chunk !== undefined ? { chunk: chunk as RowRecord } : {}),
              ...(if_exists !== undefined ? { if_exists } : {}),
              ...(dry_run !== undefined ? { dry_run } : {}),
              ...(notify_email !== undefined ? { notify_email } : {}),
              ...(options !== undefined ? { options: options as RowRecord } : {}),
            });
            return ok({ ...result, took_ms: Math.round((performance.now() - t0) * 1000) / 1000 });
          } catch (err) {
            return fail(`hydrate failed: ${(err as Error).message}${refusalHint(err)}`);
          }
        },
      );

      server.registerTool(
        "hydrate_status",
        {
          title: "Where a load stands",
          annotations: READ_ONLY,
          description:
            "The record of the hydrate job that loads (or loaded) a table: its state - pending, running, " +
            "cancelling, stopped, succeeded, failed - the request it runs, its progress and the schema it " +
            "found, the usage billed so far, and the error when it failed. Ask it after hydrate, and again " +
            "until the state is succeeded; the table answers queries then.",
          inputSchema: {
            database: z.string().min(1).describe("The database the table is in."),
            table: z.string().min(1).describe("The table the job loads."),
          },
        },
        async ({ database, table }: { database: string; table: string }) => {
          try {
            return ok((await plane.hydrateStatus(database, table)) as Record<string, unknown>);
          } catch (err) {
            return fail(`hydrate_status failed: ${(err as Error).message}${refusalHint(err)}`);
          }
        },
      );

      server.registerTool(
        "hydrate_cancel",
        {
          title: "Stop a load, or clear an ended one",
          annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
          description:
            "Cancel a running hydrate job (it stops at its next commit and keeps or drops the table as its " +
            "request's on_failure says), or clear the record of one that has ended so the table can be loaded " +
            "again. Only when the person asked for it.",
          inputSchema: {
            database: z.string().min(1).describe("The database the table is in."),
            table: z.string().min(1).describe("The table the job loads."),
          },
        },
        async ({ database, table }: { database: string; table: string }) => {
          try {
            const answer = await plane.quick(database).hydrateCancel(table);
            plane.forget(database);
            return ok(answer === null ? { database, table, cleared: true } : { database, table, cancelling: answer });
          } catch (err) {
            return fail(`hydrate_cancel failed: ${(err as Error).message}${refusalHint(err)}`);
          }
        },
      );
    }
  }

  if (apiTools && hosted) {
    // The platform's routes as tools (CX_API_TOOLS). One client for the
    // three, no cold-start retries: a model asking for a card or a check
    // waits on the answer, not on a database coming up.
    const apiDb = hostedDbFor(hosted, { ...hostedOptions, coldStartSecs: 0 });
    // The text column a check or a citation is read against: the chunks
    // table's content, or a rows table's own primary text.
    const apiColumn = rows ? rows.primaryText : CONTENT_COLUMN;

    server.registerTool(
      "table_card",
      {
        title: "The table's measured shape, before the first query",
        annotations: READ_ONLY,
        description:
          `What a model needs to know about ${TABLE} before its first query: its columns with their index ` +
          "roles, per-column statistics (min, max, distinct counts) and sample rows, as the platform's " +
          "optimizer last measured them from the table itself. Use it to choose columns and write a statement " +
          "without discovering the shape by trial. Call it once, before sql or search.",
        inputSchema: {
          tier: z.enum(["lean", "enriched"]).optional().describe("The card's depth: lean (the measured shape, the default) or enriched (adds column descriptions and synonyms)."),
        },
      },
      async ({ tier }: { tier?: "lean" | "enriched" }) => {
        try {
          const record = await apiDb.tableCard(TABLE, tier);
          return ok((record.card ?? record) as Record<string, unknown>);
        } catch (err) {
          return fail(`table_card failed: ${(err as Error).message}${refusalHint(err)}`);
        }
      },
    );

    server.registerTool(
      "validate",
      {
        title: "Did this result answer this question?",
        annotations: READ_ONLY,
        description:
          "Did this result answer this question? The same check the platform's own retrieval loop gates " +
          "itself on, for a caller driving its own retrieval: pass the question you are answering, the " +
          "statement that ran and the rows it returned. 'valid' means the rows would be accepted as answering " +
          "the question's terms - no rows, an aggregate of zeros, or rows naming nothing the question named " +
          "are refused with the reason - not that they are correct. A refusal names the question's terms that " +
          "occur nowhere in the index ('absent': no query will find them, so do not search for them again) and " +
          "carries a 'suggestion' statement when the one that ran should be rewritten. Sent with no rows, it " +
          "is the diagnosis alone: which of the question's terms the index holds, to check before a query.",
        inputSchema: {
          question: z.string().min(1).describe("The question the rows are meant to answer, as the user asked it."),
          statement: z.string().min(1).describe("The statement that produced the rows, as it ran - a SQL statement, or the search or find call."),
          rows: z.array(z.record(z.string(), z.unknown())).describe("The rows it returned, as objects; an empty array checks the question's terms against the index alone."),
        },
      },
      async ({ question, statement, rows: given }: { question: string; statement: string; rows: Record<string, unknown>[] }) => {
        try {
          const verdict = await apiDb.validate({ table: TABLE, column: apiColumn, statement, rows: given, question });
          return ok(verdict as Record<string, unknown>);
        } catch (err) {
          return fail(`validate failed: ${(err as Error).message}${refusalHint(err)}`);
        }
      },
    );

    // Citations are path:line over a code table; a rows table's row is cited
    // by its link or not at all (`rowCitation`), and the pass has nothing to
    // check there.
    if (!rows) {
      server.registerTool(
        "cite",
        {
          title: "Check and repair an answer's citations, grade each cited sentence",
          annotations: READ_ONLY,
          description:
            "Check an answer's citations against the index: every path:line and path:start-end in your draft " +
            "is checked against the rows of the cited file, repaired where the index says it belongs, and each " +
            "cited sentence is graded against the lines it cites. Returns the answer as it stands after the " +
            "pass, how many citations held, what was repaired or could not be placed, and the grades. Run it " +
            "on your draft before you reply, and reply with the answer it returns.",
          inputSchema: {
            answer: z.string().min(1).describe("The answer you drafted, with its citations as you wrote them."),
            question: z.string().optional().describe("The question the answer answers, shown to the grader beside each claim."),
          },
        },
        async ({ answer, question }: { answer: string; question?: string }) => {
          try {
            const result = await apiDb.cite({ table: TABLE, column: CONTENT_COLUMN, answer, ...(question ? { question } : {}) });
            return ok(result as Record<string, unknown>);
          } catch (err) {
            return fail(`cite failed: ${(err as Error).message}${refusalHint(err)}`);
          }
        },
      );
    }
  }

  const transport = serveOptions.transport ?? new StdioServerTransport();
  await server.connect(transport);
  const manifest: Manifest | undefined = readManifest(indexDir(defaultRoot));
  // The platform's host and its embedder, never the key. The table's
  // readiness is not probed here: a cold database can take a while to answer,
  // and the first platform tool call reports "no chunks table" itself. When
  // the doors run over the rows of a table of another shape, say so and by
  // what a row is named.
  const platform = hosted
    ? `, ${TABLE} table also at ${hostedLabel(hosted)} (embedder there: ${platformEmbedderInfo()})` +
      (rows ? `; ${searchDoors ? "find, search and sql run" : "sql runs (no full-text column: no find, no search)"} over its rows, keyed by ${rows.keyColumn}` : "") +
      (mode.kind === "unresolved" ? "; the table could not be described, so every tool call says so" : "")
    : "";
  console.error(
    `code-context MCP server ready on ${serveOptions.transport ? "its transport" : "stdio"} (default root: ${defaultRoot}, index: ${
      manifest ? `${manifest.chunks} chunks, vectors ${manifest.vectors}` : "none yet"
    }, embedder: ${embedderInfo()}${platform}; tools accept an optional 'path' to target other repos)`,
  );
}
