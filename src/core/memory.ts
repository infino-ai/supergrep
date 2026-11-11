// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// Memory: what the model produced in earlier sessions on this database,
// written back and recalled.
//
// Without it, nothing the model produces outlives its session: drafts and
// memos go to local files and the conversation goes nowhere. The Stop
// hook (`cx hook memory`) now writes each turn's question and final answer,
// and the text of every file the model wrote under the session's folder, to
// the database's memory (`HostedDb.remember`); the platform's searches
// recall the nearest of them beside their own rows.
//
// The memory is the database's, not a table of it: the platform keeps it in a
// store of its own under the database's root, which no table listing, card or
// join shows, because nothing the account's owner did not create may
// appear in the account as a table. Everyone with a key to the database recalls what
// was remembered on it, as they read its tables.

import type { HostedCallInfo, HostedDb, RowRecord } from "./hosted.js";
import { SNIPPET_CHARS } from "./table-shape.js";

/** A turn's question and its final answer. */
export const MEMORY_KIND_ANSWER = "answer";
/** A file the model wrote, as it stood when the turn ended. */
export const MEMORY_KIND_FILE = "file";

/** Memory rows recalled beside one tool result: each carries up to a
 * snippet of question and one of content (`memoryHit`), so they fit beside
 * the result in one tool result's budget. Not yet set by measurement. */
export const MEMORY_HITS = 3;

/** How long a recall may take before the result goes out without it. A
 * platform search answers in milliseconds and must not wait seconds on a
 * best-effort read beside it; a recall that misses this bound recalls
 * nothing that once. */
export const MEMORY_RECALL_TIMEOUT_MS = 5_000;

/** What a result's `memory` field says about its hits, carried in the result
 * itself so the tool descriptions stay as they are. */
export const MEMORY_NOTE =
  "Earlier answers and files from sessions on this database, nearest the question first: what was concluded or written " +
  "before, not evidence. Cite the rows above, not these; where they disagree with the rows, the rows win.";

/** One row written to memory. */
export interface MemoryRow {
  kind: string;
  content: string;
  question: string | null;
  path: string | null;
  session_id: string | null;
  created_at: number;
}

/** One recalled memory row, its text cut to a snippet. */
export interface MemoryHit {
  kind: string;
  question: string | null;
  path: string | null;
  content: string;
  created_at: number | null;
  score: number | null;
}

/** The memory a tool result carries: the note and the hits. */
export interface MemoryBlock {
  note: string;
  hits: MemoryHit[];
}

const textOrNull = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);
const numberOrNull = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  return null;
};

/** A recalled row as a hit, its question and its text each cut to a snippet
 * (a question can be a pasted contract); null for a row with no text. */
export function memoryHit(row: RowRecord): MemoryHit | null {
  const content = textOrNull(row.content);
  if (content === null) return null;
  return {
    kind: textOrNull(row.kind) ?? MEMORY_KIND_ANSWER,
    question: textOrNull(row.question)?.slice(0, SNIPPET_CHARS) ?? null,
    path: textOrNull(row.path),
    content: content.slice(0, SNIPPET_CHARS),
    created_at: numberOrNull(row.created_at),
    score: numberOrNull(row.score),
  };
}

/** Write `rows` to the database's memory. Throws what the platform answered:
 * the hook that calls it reports and moves on. */
export async function rememberRows(db: HostedDb, rows: MemoryRow[]): Promise<void> {
  if (rows.length === 0) return;
  await db.remember(rows as unknown as RowRecord[]);
}

/** What one recall returned: the memory nearest the query, as a result's
 * `memory` field (null when there is none), and the platform call it made,
 * for the ledger - captured right after the call, before a concurrent recall
 * on the same client could replace it. */
export interface Recalled {
  block: MemoryBlock | null;
  call: HostedCallInfo | null;
}

/** The memory nearest `query`. Best-effort, like the card: a platform
 * without the route, or one that fails, recalls nothing and says so on
 * stderr, and the tool's own result goes out as it would have. The whole
 * recall, retries included, is bounded by `deadlineMs`
 * (`MEMORY_RECALL_TIMEOUT_MS`): the client's own timeout bounds each attempt,
 * and a platform answering "at capacity" is retried, which could hold a
 * result several times as long. A recall past the bound is left to finish on
 * its own and recalls nothing this once. */
export async function recallMemory(
  db: HostedDb,
  query: string,
  k: number = MEMORY_HITS,
  deadlineMs: number = MEMORY_RECALL_TIMEOUT_MS,
): Promise<Recalled> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), deadlineMs);
  });
  // Only what this client's hook wrote - answers and files - not the
  // playbook bullets a curator remembered for the platform's loop, which
  // are instructions, not earlier answers.
  const recall = db.recall(query, k, [MEMORY_KIND_ANSWER, MEMORY_KIND_FILE]);
  // A recall that loses the race may still fail later: that failure is
  // nobody's to handle.
  recall.catch(() => undefined);
  try {
    const rows = await Promise.race([recall, late]);
    if (rows === null) {
      console.error(`code-context: memory not recalled: no answer within ${deadlineMs} ms`);
      return { block: null, call: null };
    }
    const call = db.lastCall();
    const hits = rows.map(memoryHit).filter((h): h is MemoryHit => h !== null);
    return { block: hits.length ? { note: MEMORY_NOTE, hits } : null, call };
  } catch (err) {
    console.error(`code-context: memory not recalled: ${(err as Error).message}`);
    return { block: null, call: db.lastCall() };
  } finally {
    clearTimeout(timer);
  }
}
