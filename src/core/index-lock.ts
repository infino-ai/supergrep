// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// One writer per index across processes. The MCP server's mutation lock is in
// its own process, so a `cx index` beside it - run by hand, or by an agent
// host's session-start hook - could sync or build the same index at the same
// time. Two syncs that overlap each delete a changed file's rows and append
// its new ones, and the second delete can land before the first append, which
// leaves the file's chunks in the table twice; a build drops and recreates
// the table under the other writer. So every writer of an index takes this
// lock first: a file in the index dir naming the process that holds it.
//
// The file is written whole and then linked into place, so a reader never
// sees it half-written and two creators cannot both succeed. A holder that
// died without releasing it (killed, crashed) leaves the file behind; a
// later writer on the same host finds its process gone and takes the lock
// over. A holder on another host (an index dir on a shared filesystem) cannot
// be checked and counts as alive. A dead holder's process id reused by an
// unrelated process also counts as alive, until that process exits.

import { linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

export const INDEX_LOCK_NAME = "index.lock";

/** The exit status of a `cx index` that found another process indexing
 * (EX_TEMPFAIL): nothing was written, and a later run will go ahead. */
export const EXIT_INDEX_BUSY = 75;

export interface LockHolder {
  pid: number;
  host: string;
  /** ISO time the lock was taken. With `pid` and `host`, what tells one
   * acquisition from another. */
  since: string;
}

export interface IndexLock {
  readonly path: string;
  readonly holder: LockHolder;
  /** Another owner of this acquisition: a build's background completion holds
   * the lock past the call that took it. Each retain needs its own release. */
  retain(): void;
  /** Drop one owner; the last removes the file. Idempotent past zero. */
  release(): void;
}

export type LockAttempt = { lock: IndexLock } | { heldBy: LockHolder | null };

/** Thrown by a writer that found the index locked by another process. */
export class IndexBusyError extends Error {
  constructor(
    readonly indexDirPath: string,
    readonly heldBy: LockHolder | null,
  ) {
    super(
      heldBy
        ? `another process is indexing this repository (pid ${heldBy.pid} on ${heldBy.host}, since ${heldBy.since}); nothing was written - run again when it finishes`
        : `another process is indexing this repository (${join(indexDirPath, INDEX_LOCK_NAME)}); nothing was written - run again when it finishes`,
    );
    this.name = "IndexBusyError";
  }
}

export function lockPath(indexDirPath: string): string {
  return join(indexDirPath, INDEX_LOCK_NAME);
}

function readHolder(path: string): LockHolder | null | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined; // no file
  }
  try {
    const h = JSON.parse(raw) as LockHolder;
    if (typeof h.pid === "number" && typeof h.host === "string" && typeof h.since === "string") return h;
  } catch {
    /* garbled */
  }
  return null; // a file that names no holder
}

const sameHolder = (a: LockHolder, b: LockHolder): boolean => a.pid === b.pid && a.host === b.host && a.since === b.since;

/** Whether a holder may still be running. Only a process on this host can be
 * checked; signal 0 tests for it without touching it, and EPERM means it
 * exists under another user. */
export function holderAlive(h: LockHolder): boolean {
  if (h.host !== hostname()) return true;
  if (h.pid === process.pid) return true;
  try {
    process.kill(h.pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

let tmpSeq = 0;

/** Create `path` naming `holder`, or report it exists. Written to a private
 * file first and hard-linked into place: the link fails if `path` exists, and
 * the content is complete before anyone can read it. */
function createExclusive(path: string, holder: LockHolder): boolean {
  const tmp = `${path}.${process.pid}.${++tmpSeq}.tmp`;
  writeFileSync(tmp, JSON.stringify(holder) + "\n");
  try {
    linkSync(tmp, path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** Replace a dead holder's lock with ours. One process at a time does this,
 * under a second lock beside the first, so two writers that find the same
 * dead holder cannot each remove the other's fresh lock. A takeover lock
 * left by a process that died inside this function is removed and this
 * attempt gives up; the next one goes ahead. */
function takeOver(path: string, dead: LockHolder, me: LockHolder): boolean {
  const guard = `${path}.takeover`;
  if (!createExclusive(guard, me)) {
    const g = readHolder(guard);
    if (g === null || (g && !holderAlive(g))) rmSync(guard, { force: true });
    return false;
  }
  try {
    const now = readHolder(path);
    if (now === undefined || (now && sameHolder(now, dead)) || (now === null && dead.pid === -1)) {
      rmSync(path, { force: true });
    }
    return createExclusive(path, me);
  } finally {
    rmSync(guard, { force: true });
  }
}

/** Take the index's lock, or say who holds it. Never waits. */
export function tryLockIndex(indexDirPath: string): LockAttempt {
  mkdirSync(indexDirPath, { recursive: true });
  const path = lockPath(indexDirPath);
  const me: LockHolder = { pid: process.pid, host: hostname(), since: new Date().toISOString() };
  let acquired = createExclusive(path, me);
  if (!acquired) {
    const held = readHolder(path);
    if (held === undefined) {
      // Released between our link and our read.
      acquired = createExclusive(path, me);
      if (!acquired) return { heldBy: readHolder(path) ?? null };
    } else if (held === null) {
      // Nothing written there names a holder; a writer of this module never
      // leaves such a file, so it is debris.
      acquired = takeOver(path, { pid: -1, host: "", since: "" }, me);
      if (!acquired) return { heldBy: null };
    } else if (holderAlive(held)) {
      return { heldBy: held };
    } else {
      acquired = takeOver(path, held, me);
      if (!acquired) return { heldBy: readHolder(path) ?? null };
    }
  }

  let owners = 1;
  return {
    lock: {
      path,
      holder: me,
      retain() {
        if (owners > 0) owners++;
      },
      release() {
        if (owners === 0) return;
        if (--owners > 0) return;
        const now = readHolder(path);
        if (now && sameHolder(now, me)) rmSync(path, { force: true });
      },
    },
  };
}

/** The live holder of the index's lock, when another process has it. */
export function otherHolder(indexDirPath: string): LockHolder | null {
  const h = readHolder(lockPath(indexDirPath));
  return h && h.pid !== process.pid && holderAlive(h) ? h : null;
}

/** Take the index's lock, or throw IndexBusyError naming the holder. */
export function lockIndex(indexDirPath: string): IndexLock {
  const attempt = tryLockIndex(indexDirPath);
  if ("lock" in attempt) return attempt.lock;
  throw new IndexBusyError(indexDirPath, attempt.heldBy);
}
