// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The Claude Code hooks `cx install` writes, run by Claude Code with the
// event as JSON on stdin.
//
// `cx hook answer-figures` - Stop. When the model retrieved through this
// server and its final answer holds a figure that no tool result of the turn
// holds, it is sent back once to compute that figure with `sql` (see
// core/answer-figures.ts for the measured case: an average computed by hand,
// six cents off).
//
// `cx hook memory` - Stop. Writes the turn to the database's memory (see
// core/memory.ts): the person's question with the final answer, and the text
// of each file the model wrote in the project (CLAUDE_PROJECT_DIR) that an
// index of the project would upload. It prints nothing, hands the write to a detached
// sender (`memory-send`) so the turn never waits on the platform, and writes
// a turn stopped more than once only once.
//
// Neither ever fails the turn: no transcript, or nothing to say, prints
// nothing and exits 0.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { figuresReason, namesUncomputedReading, toolValues, UNCOMPUTED_READING_REASON, unbackedFigures } from "../core/answer-figures.js";
import { shouldIndexFile } from "../core/chunker.js";
import { DEFAULT_CAPS, hostedTarget, indexDir } from "../core/config.js";
import { hostedDbFor } from "../core/context.js";
import type { HostedDb } from "../core/hosted.js";
import { MEMORY_KIND_ANSWER, MEMORY_KIND_FILE, type MemoryRow, rememberRows } from "../core/memory.js";
import { walkAdmits } from "../core/walker.js";
import { RETRIEVAL_TOOLS } from "../mcp/wording.js";

export interface HookCmdOptions {
  /** `memory-send`: the rows file to send. */
  rowsFile?: string;
  /** The server a Stop entry belongs to (`--server`): `answer-figures`
   * acts only on a turn that retrieved through it, and
   * `cx install` tells its own entries from another server's by it. */
  server?: string;
}

/** The hook events this command serves. */
export const HOOK_ANSWER_FIGURES = "answer-figures";
export const HOOK_MEMORY = "memory";
/** The memory hook's sender, started by it detached (`rememberTurn`); no
 * hook entry runs it. */
export const HOOK_MEMORY_SEND = "memory-send";
/** The sender's flag naming the rows file it sends. */
const ROWS_FILE_FLAG = "--rows-file";
/** What the memory hook's files in the temp directory are named from: the
 * per-session state and each rows file's directory. */
const MEMORY_FILE_PREFIX = "cx-memory-";
/** The rows file's name in its directory. */
const MEMORY_ROWS_NAME = "rows.json";
/** Where the sender's failures are appended, in the index directory. */
const MEMORY_LOG = "memory.log";
/** Owner read and write only: the rows hold the person's questions and the
 * files the model wrote. */
const PRIVATE_FILE_MODE = 0o600;

/** Claude Code's file-writing tools, each with the input naming the file it
 * wrote: what the memory hook reads a turn's written files from. */
const FILE_WRITE_TOOLS: Record<string, string> = {
  Write: "file_path",
  Edit: "file_path",
  MultiEdit: "file_path",
  NotebookEdit: "notebook_path",
};

/** The tool names, as Claude Code spells an MCP tool, whose use in a turn
 * means the model retrieved through this server. The server name is the
 * install's; the suffixes are the tools'. */
const RETRIEVAL_TOOL_SUFFIXES = RETRIEVAL_TOOLS.map((tool) => `__${tool}`);

/** One line of a Claude Code session transcript. The format is Claude
 * Code's own and undocumented, so every field is read as optional. */
interface TranscriptEntry {
  type?: string;
  isSidechain?: boolean;
  /** Set on entries Claude Code adds itself rather than the person typed. */
  isMeta?: boolean;
  /** Set on the summary Claude Code writes when it compacts the context
   * mid-turn: it quotes everything before it, never the person's question. */
  isCompactSummary?: boolean;
  /** Set on entries shown in the transcript and never sent as a prompt. */
  isVisibleInTranscriptOnly?: boolean;
  /** The entry's own id, when the transcript carries one. */
  uuid?: string;
  timestamp?: string;
  message?: { content?: unknown };
}

/** How a Stop hook's block reason may come back into the transcript as a
 * user message: it is the hook speaking, never the person's question. */
const STOP_HOOK_FEEDBACK_PREFIX = "Stop hook feedback:";
/** Text blocks of a prompt that are context Claude Code attached, not what
 * the person typed: an IDE's open file or selection, a system reminder. A
 * selection can hold lines of a file the person would never send. */
const ATTACHED_CONTEXT_BLOCK = /^\s*<(ide_[a-z_]+|system-reminder)\b/;

/** The entries of the turn since the person's last question, from a session
 * transcript (JSON lines): every entry after the last user prompt, a
 * subagent's (`isSidechain`) included for the caller to skip; null when the
 * transcript holds no prompt. */
function turnEntries(jsonl: string): TranscriptEntry[] | null {
  return lastTurn(jsonl)?.entries ?? null;
}

/** The person's last question and the turn's entries after it (see
 * `turnEntries`), or null when the transcript holds no prompt. A prompt is a
 * user message with text and no tool result, typed by the person: an entry
 * Claude Code marks as its own (`isMeta`), the summary of a mid-turn
 * compaction, an entry only shown in the transcript, or a Stop hook's
 * fed-back reason is not one, so a turn spans them. A partial last line,
 * still being written, is not an entry. */
function lastTurn(jsonl: string): { prompt: TranscriptEntry; entries: TranscriptEntry[] } | null {
  const entries: TranscriptEntry[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object") entries.push(parsed as TranscriptEntry);
    } catch {
      /* a partial last line while Claude Code is still writing: not an entry */
    }
  }
  const isPrompt = (e: TranscriptEntry) => {
    if (e.type !== "user" || e.isSidechain || e.isMeta === true || e.isCompactSummary === true || e.isVisibleInTranscriptOnly === true) return false;
    const content = e.message?.content;
    if (typeof content === "string") return content.trim().length > 0 && !content.trimStart().startsWith(STOP_HOOK_FEEDBACK_PREFIX);
    if (!Array.isArray(content)) return false;
    const blocks = content as Array<{ type?: string; text?: unknown }>;
    const texts = blocks.filter((b) => b.type === "text" && typeof b.text === "string").map((b) => String(b.text).trimStart());
    return texts.length > 0 && !texts.some((t) => t.startsWith(STOP_HOOK_FEEDBACK_PREFIX)) && !blocks.some((b) => b.type === "tool_result");
  };
  let from = -1;
  for (let i = 0; i < entries.length; i++) if (isPrompt(entries[i])) from = i;
  return from < 0 ? null : { prompt: entries[from], entries: entries.slice(from + 1) };
}

/** What the person typed in a prompt entry: the string, or its text blocks
 * joined, leaving out the context Claude Code attached to it
 * (`ATTACHED_CONTEXT_BLOCK`). */
function promptText(prompt: TranscriptEntry): string {
  const content = prompt.message?.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return (content as Array<{ type?: string; text?: unknown }>)
    .filter((b) => b.type === "text" && typeof b.text === "string" && !ATTACHED_CONTEXT_BLOCK.test(b.text as string))
    .map((b) => (b.text as string).trim())
    .join("\n")
    .trim();
}

/** A `tool_result` block's text: its string content, or its text parts. */
function toolResultTexts(block: { content?: unknown }): string[] {
  if (typeof block.content === "string") return [block.content];
  if (!Array.isArray(block.content)) return [];
  return (block.content as Array<{ text?: unknown }>).filter((p) => typeof p.text === "string").map((p) => p.text as string);
}

/** The tool calls the model made since the person's last question, from a
 * session transcript: every `tool_use` block of its own messages after the
 * last user prompt, in order, with its input; a subagent's are not its own. */
export function transcriptToolUses(jsonl: string): Array<{ name: string; input: Record<string, unknown> }> {
  const turn = turnEntries(jsonl);
  if (turn === null) return [];
  const uses: Array<{ name: string; input: Record<string, unknown> }> = [];
  for (const e of turn) {
    if (e.type !== "assistant" || e.isSidechain) continue;
    const content = e.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content as Array<{ type?: string; name?: string; input?: unknown }>) {
      if (block.type !== "tool_use" || typeof block.name !== "string") continue;
      const input = block.input && typeof block.input === "object" && !Array.isArray(block.input) ? (block.input as Record<string, unknown>) : {};
      uses.push({ name: block.name, input });
    }
  }
  return uses;
}

/** The names of the tool calls the model made since the person's last
 * question (`transcriptToolUses`). */
export function transcriptToolCalls(jsonl: string): string[] {
  return transcriptToolUses(jsonl).map((u) => u.name);
}

/** What Claude Code puts in place of a character of a server's name that
 * may not appear in a tool's name. */
const TOOL_NAME_UNSAFE = /[^A-Za-z0-9_-]/g;

/** A server's name as Claude Code spells it inside its tools' names
 * (`mcp__<server>__<tool>`): every character outside `[A-Za-z0-9_-]` becomes
 * `_`. `cx install` refuses such names, so this matters only for an entry
 * written by hand or by an earlier version. */
export function toolServerName(server: string): string {
  return server.replace(TOOL_NAME_UNSAFE, "_");
}

/** Whether the turn's tool calls retrieved through server `server` - its
 * `mcp__<server>__` search, find or sql - or, with no server named,
 * through any server's. Each installed server's Stop entries name their own
 * (`--server`), so two servers in one project send the model back once for
 * a turn that used one of them, not once per server, and a turn that used
 * only some other server's `search` is not sent back at all. Memory waits on
 * its own server's entries alike (`memoryRows`), so it waits only for a
 * block that will come. */
function retrievedThrough(calls: string[], server?: string): boolean {
  const prefix = server === undefined ? "mcp__" : `mcp__${toolServerName(server)}__`;
  return calls.some((name) => name.startsWith(prefix) && RETRIEVAL_TOOL_SUFFIXES.some((s) => name.endsWith(s)));
}

/** The turn's final reply and every tool result it saw, from a session
 * transcript: the reply is the model's text after the last thing that came
 * back to it - a tool result, or a message Claude Code added such as a Stop
 * hook's reason for sending it back - and the results are each
 * `tool_result` block's text (a string, or its text blocks). A subagent's
 * lines are neither. */
export function transcriptReplyAndResults(jsonl: string): { reply: string; results: string[] } {
  const turn = turnEntries(jsonl) ?? [];
  const results: string[] = [];
  let reply: string[] = [];
  for (const e of turn) {
    if (e.isSidechain) continue;
    const blocks = Array.isArray(e.message?.content) ? (e.message.content as Array<{ type?: string; text?: unknown; content?: unknown }>) : [];
    if (e.type === "user") {
      reply = [];
      for (const b of blocks) if (b.type === "tool_result") results.push(...toolResultTexts(b));
    } else if (e.type === "assistant") {
      for (const b of blocks) if (b.type === "text" && typeof b.text === "string") reply.push(b.text);
    }
  }
  return { reply: reply.join("\n"), results };
}

/** The figures Stop hook's output: when the model retrieved through this
 * server in this turn and its final answer holds figures that none of the
 * turn's tool results hold, or its reply names a reading it did not compute,
 * it is sent back once (`decision: block`) with both reasons that apply;
 * otherwise nothing. `stop_hook_active` set means a Stop hook already sent it
 * back in this turn, and it is let go rather than looped - a figure it
 * cannot compute is still answered. `server` is the entry's own
 * (`retrievedThrough`). */
export function hookFiguresOutput(input: string, readFile: (path: string) => string | null, server?: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return null;
  }
  const event = parsed as { transcript_path?: unknown; stop_hook_active?: unknown } | null;
  if (!event || typeof event !== "object" || typeof event.transcript_path !== "string") return null;
  if (event.stop_hook_active === true) return null;
  const transcript = readFile(event.transcript_path);
  if (transcript === null) return null;
  if (!retrievedThrough(transcriptToolCalls(transcript), server)) return null;
  const { reply, results } = transcriptReplyAndResults(transcript);
  const unbacked = unbackedFigures(reply, results.flatMap(toolValues));
  const reasons = [
    ...(unbacked.length ? [figuresReason(unbacked)] : []),
    ...(namesUncomputedReading(reply) ? [UNCOMPUTED_READING_REASON] : []),
  ];
  if (!reasons.length) return null;
  return JSON.stringify({ decision: "block", reason: reasons.join(" ") });
}

/** `file` relative to `dir`, or null when it is not under it. */
function under(dir: string, file: string): string | null {
  const rel = relative(dir, resolve(dir, file));
  return !rel || rel.startsWith("..") || isAbsolute(rel) ? null : rel;
}

/** The environment variable Claude Code sets for hook commands: the project
 * directory the session started in. `cx install` writes the hooks there and
 * the MCP server runs there, so it is the root the index - and the answers
 * directory - live under. The event's own `cwd` is not: it follows the
 * model's `cd`, and a walk from a subfolder never reads the root's
 * `.gitignore`. */
const PROJECT_DIR_ENV = "CLAUDE_PROJECT_DIR";

/** The project root memory judges paths against (`PROJECT_DIR_ENV`), or
 * null when Claude Code did not say: memory then keeps no file and no answer
 * file, only the reply, rather than guess a root. */
export function projectRoot(env: NodeJS.ProcessEnv = process.env): string | null {
  const dir = env[PROJECT_DIR_ENV];
  return dir ? resolve(dir) : null;
}

/** Whether an index of `root` would upload the file at `rel` ("/"-separated,
 * root-relative): the walk admits it (`.gitignore`, `.cxignore`, the skipped
 * directories, no symlink anywhere on the path) and it is a kind of file the
 * index reads. Memory sends nothing the index of the same folder would not,
 * which is what the install's consent covers. */
export function memoryAdmits(root: string, rel: string): boolean {
  return shouldIndexFile(rel) && walkAdmits(root, rel);
}

/** A file the model wrote, as a "/"-separated `root`-relative path (the
 * index's spelling on every platform), when memory may keep it: under the
 * project, in no dot-named folder or file (`.env`, `.git`, the index's own
 * `.infino`), and admitted by `admits` (by default `memoryAdmits`). Null
 * otherwise. */
function rememberablePath(file: string, root: string, admits: (root: string, rel: string) => boolean): string | null {
  const rel = under(root, file);
  if (rel === null) return null;
  const parts = rel.split(sep);
  if (parts.some((part) => part.startsWith("."))) return null;
  const posix = parts.join("/");
  return admits(root, posix) ? posix : null;
}

/** A turn's memory: the rows it makes, and a key naming the turn (its
 * prompt) so a turn stopped more than once is not written twice
 * (`unwrittenRows`). */
export interface MemoryTurn {
  key: string;
  rows: MemoryRow[];
}

/** A text's SHA-256, hex. */
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** The memory rows a Stop event's turn makes (see core/memory.ts), or null
 * when it makes none. Pure but for `admits`, for the tests: `input` is the
 * stdin JSON text, `readFile` the file reader, `now` the clock, `admits`
 * what decides a written file may be sent (`memoryAdmits`), `root` the
 * project every path is judged against (`projectRoot`), `server` the server
 * the memory entry belongs to (`--server`).
 *
 * A turn this server's own Stop entry is about to send back - a figure it
 * did not compute - is not written now: it is written when the model stops
 * for good (`stop_hook_active`), with the answer it ended on. Only that
 * entry is waited on: it is written with the memory entry, so its block
 * comes, where a turn that used another server's `search` would wait for a
 * block nothing sends. The answer is the model's final reply. Each file the model wrote is
 * kept as it stands now (`rememberablePath`), and neither it nor the answer
 * file past the index's own per-file cap. With no root known, only the
 * reply is kept. Thinking is never read (see the header). */
export function memoryRows(
  input: string,
  readFile: (path: string) => string | null,
  now: () => number = Date.now,
  admits: (root: string, rel: string) => boolean = memoryAdmits,
  root: string | null = projectRoot(),
  server?: string,
): MemoryTurn | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return null;
  }
  const event = parsed as { transcript_path?: unknown; session_id?: unknown; stop_hook_active?: unknown } | null;
  if (!event || typeof event !== "object" || typeof event.transcript_path !== "string") return null;
  if (event.stop_hook_active !== true && hookFiguresOutput(input, readFile, server) !== null) {
    return null;
  }
  const transcript = readFile(event.transcript_path);
  if (transcript === null) return null;
  const turn = lastTurn(transcript);
  if (turn === null) return null;
  const question = promptText(turn.prompt);
  if (!question) return null;
  const at = now();
  const sessionId = typeof event.session_id === "string" ? event.session_id : null;
  const withinCap = (text: string | null) => (text !== null && Buffer.byteLength(text, "utf8") <= DEFAULT_CAPS.maxFileBytes ? text : null);
  const rows: MemoryRow[] = [];
  const answer = transcriptReplyAndResults(transcript).reply.trim();
  if (answer) rows.push({ kind: MEMORY_KIND_ANSWER, question, content: answer, path: null, session_id: sessionId, created_at: at });
  if (root !== null) {
    const written = new Set<string>();
    for (const use of transcriptToolUses(transcript)) {
      const key = FILE_WRITE_TOOLS[use.name];
      const file = key ? use.input[key] : undefined;
      if (typeof file !== "string") continue;
      const rel = rememberablePath(file, root, admits);
      if (rel === null || written.has(rel)) continue;
      written.add(rel);
      const text = withinCap(readFile(resolve(root, rel)));
      if (text === null || !text.trim()) continue;
      rows.push({ kind: MEMORY_KIND_FILE, question, content: text, path: rel, session_id: sessionId, created_at: at });
    }
  }
  if (!rows.length) return null;
  const key = sha256(turn.prompt.uuid ?? `${turn.prompt.timestamp ?? ""}\n${question}`);
  return { key, rows };
}

/** What the hook remembers it wrote for a session: the turn last written
 * and the rows of it already sent, each by its hash. */
export interface MemoryState {
  turn: string;
  written: string[];
}

/** A row's identity for `unwrittenRows`: what it is, where, and its text. */
const rowKey = (row: MemoryRow) => sha256(`${row.kind}\n${row.path ?? ""}\n${row.content}`);

/** The rows of `turn` not already written for it (`state`), and the state
 * after writing them. A turn is stopped more than once when any Stop hook
 * sends the model back - ours wait for the last stop, but another install's
 * may block after ours wrote - and each stop would otherwise write the same
 * answer and files again. A row that changed since (a file the model fixed,
 * a new reply) is new and is written. */
export function unwrittenRows(turn: MemoryTurn, state: MemoryState | null): { rows: MemoryRow[]; state: MemoryState } {
  const seen = new Set(state?.turn === turn.key ? state.written : []);
  const rows = turn.rows.filter((r) => !seen.has(rowKey(r)));
  return { rows, state: { turn: turn.key, written: [...seen, ...rows.map(rowKey)] } };
}

/** The command line that sends a rows file (`memory-send`): this hook's own
 * command line with its event swapped for the sender's and the file named,
 * so the sender reaches the same platform with the same flags. `argv` is
 * `process.argv`; null when it is not a `hook memory` command line. */
export function memorySendArgv(argv: readonly string[], rowsFile: string): string[] | null {
  const hookAt = argv.indexOf("hook");
  if (hookAt < 1 || argv[hookAt + 1] !== HOOK_MEMORY) return null;
  return [...argv.slice(1, hookAt + 1), HOOK_MEMORY_SEND, ...argv.slice(hookAt + 2), ROWS_FILE_FLAG, rowsFile];
}

/** The session's memory state (`MemoryState`), or null when there is none
 * or it cannot be read. */
function readMemoryState(path: string): MemoryState | null {
  try {
    const state = JSON.parse(readFileSync(path, "utf8")) as MemoryState;
    return typeof state.turn === "string" && Array.isArray(state.written) ? state : null;
  } catch {
    return null;
  }
}

/** Write a Stop event's turn to the database's memory (`memoryRows`), on the
 * platform the command's flags name, without holding the stop: the rows not
 * yet written for the turn (`unwrittenRows`) go to a private file, and a
 * detached `cx hook memory-send` sends them. Claude Code waits for every
 * Stop hook before the turn ends - up to ten minutes by default - and the
 * platform embeds what it is sent, so a write the turn waited on would cost
 * the person seconds on every turn and minutes when the platform is slow.
 * The sender's failures go to `MEMORY_LOG` in the project's index directory.
 * Nothing reaches stdout, so nothing here can block a stop either. */
function rememberTurn(input: string, readFile: (path: string) => string | null, server: string | undefined): void {
  const target = hostedTarget();
  if (target === null) return;
  try {
    const turn = memoryRows(input, readFile, Date.now, memoryAdmits, projectRoot(), server);
    if (turn === null) return;
    const event = JSON.parse(input) as { session_id?: unknown; cwd?: unknown };
    // One state per database as well as per session: two servers installed
    // in one project each write the turn to their own database, and neither
    // may take the other's write for its own.
    const statePath =
      typeof event.session_id === "string"
        ? join(tmpdir(), `${MEMORY_FILE_PREFIX}${sha256(`${target.baseUrl}\n${target.database}\n${event.session_id}`)}.json`)
        : null;
    const { rows, state } = unwrittenRows(turn, statePath ? readMemoryState(statePath) : null);
    if (!rows.length) return;
    const rowsFile = join(mkdtempSync(join(tmpdir(), MEMORY_FILE_PREFIX)), MEMORY_ROWS_NAME);
    writeFileSync(rowsFile, JSON.stringify(rows), { mode: PRIVATE_FILE_MODE });
    const argv = memorySendArgv(process.argv, rowsFile);
    if (argv === null) {
      removeRowsFile(rowsFile);
      return;
    }
    const root = projectRoot();
    const cwd = root ?? (typeof event.cwd === "string" ? event.cwd : process.cwd());
    const logDir = root === null ? null : indexDir(root);
    const log = logDir !== null && existsSync(logDir) ? openSync(join(logDir, MEMORY_LOG), "a", PRIVATE_FILE_MODE) : null;
    try {
      spawn(process.execPath, argv, { cwd, detached: true, stdio: ["ignore", "ignore", log ?? "ignore"] }).unref();
    } finally {
      if (log !== null) closeSync(log);
    }
    if (statePath) {
      // Through a temp file and a rename, so a hook reading it never sees
      // half of it.
      const temp = `${statePath}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify(state), { mode: PRIVATE_FILE_MODE });
      renameSync(temp, statePath);
    }
  } catch (err) {
    console.error(`code-context: memory not written: ${(err as Error).message}`);
  }
}

/** Remove a rows file and its directory - only one the memory hook made
 * (`MEMORY_FILE_PREFIX` under the temp directory), whatever path the
 * sender's flag named. */
function removeRowsFile(rowsFile: string): void {
  const dir = dirname(rowsFile);
  if (under(tmpdir(), dir) === null || !basename(dir).startsWith(MEMORY_FILE_PREFIX) || basename(rowsFile) !== MEMORY_ROWS_NAME) return;
  rmSync(dir, { recursive: true, force: true });
}

/** Send the rows a memory hook left in `rowsFile` to `db`, then remove the
 * file. Failures are thrown, for the caller's log. */
export async function sendRememberedRows(rowsFile: string, db: HostedDb): Promise<void> {
  try {
    await rememberRows(db, JSON.parse(readFileSync(rowsFile, "utf8")) as MemoryRow[]);
  } finally {
    removeRowsFile(rowsFile);
  }
}

export async function hookCmd(event: string, opts: HookCmdOptions): Promise<void> {
  if (![HOOK_ANSWER_FIGURES, HOOK_MEMORY, HOOK_MEMORY_SEND].includes(event)) return;
  // The sender is started by the memory hook, detached, with nothing on its
  // stdin: it has a file to send and a platform to send it to. It may wait
  // out a cold embedder, since no turn waits on it.
  if (event === HOOK_MEMORY_SEND) {
    const target = hostedTarget();
    if (target === null || !opts.rowsFile) return;
    try {
      await sendRememberedRows(opts.rowsFile, hostedDbFor(target));
    } catch (err) {
      console.error(`${new Date().toISOString()} code-context: memory not written: ${(err as Error).message}`);
    }
    return;
  }
  let input = "";
  try {
    input = readFileSync(0, "utf8");
  } catch {
    return;
  }
  const readFile = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : null);
  if (event === HOOK_MEMORY) {
    rememberTurn(input, readFile, opts.server);
    return;
  }
  const output = hookFiguresOutput(input, readFile, opts.server);
  if (output !== null) process.stdout.write(output);
}
