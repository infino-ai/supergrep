// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The description a server reads at startup - the database's table list and
// each table's schema and card - kept in a file for a few minutes
// (CX_STARTUP_CACHE_SECS), so a server started again within them describes
// the database from the file instead of the platform. Every question starts a
// fresh server, and on a database of seventy tables the description is about
// a hundred and fifty requests at over a second each (a database of over a hundred tables, 2026-11-06):
// most of the seconds before the model can start.
//
// Off unless the variable is set: a measured run starts cold, as it always
// did. The file expires and is not refreshed in the background: the first
// server after it expires describes the database from the platform and writes
// a new one, so a reading is at most the window old and no server adds load
// to the platform while it answers. A call that failed (a table with no card
// yet) is never kept: the next server asks again.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HostedDb } from "./hosted.js";

/** The variable naming the window, in seconds; unset or 0 keeps no cache. */
export const STARTUP_CACHE_ENV = "CX_STARTUP_CACHE_SECS";

/** The calls a startup description makes that the file keeps. */
const CACHED_CALLS = new Set(["listTables", "schema", "tableCard"]);

/** The window `env` names, in whole seconds; 0 for none. */
export function startupCacheSecs(env: NodeJS.ProcessEnv = process.env): number {
  const secs = Number(env[STARTUP_CACHE_ENV]);
  return Number.isFinite(secs) && secs > 0 ? Math.floor(secs) : 0;
}

/** The file one database's description is kept in, under the home the
 * server runs as: one file per platform database and table read from. */
export function startupCachePath(database: string, dir = join(homedir(), ".cache", "cx-startup")): string {
  return join(dir, `${createHash("sha256").update(database).digest("hex").slice(0, 32)}.json`);
}

/** A bigint survives the file as a tagged string: the platform's 64-bit
 * statistics are bigints once parsed, and come back as bigints. */
const BIGINT_TAG = "$bigint";

function encode(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? { [BIGINT_TAG]: value.toString() } : value;
}

function decode(_key: string, value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const keys = Object.keys(value);
    const tagged = (value as Record<string, unknown>)[BIGINT_TAG];
    if (keys.length === 1 && typeof tagged === "string") return BigInt(tagged);
  }
  return value;
}

interface CacheFile {
  savedAt: number;
  entries: Record<string, unknown>;
}

/** One server's startup cache: `wrap` gives a client whose description calls
 * are answered from a fresh file, and `save` writes what this start read from
 * the platform when it found no fresh file. */
export class StartupCache {
  private readonly fresh: Map<string, unknown> | null;
  private readonly read = new Map<string, unknown>();

  constructor(
    private readonly path: string,
    windowSecs: number,
    now: number = Date.now(),
  ) {
    this.fresh = StartupCache.load(path, windowSecs, now);
  }

  /** Whether this start is described from the file. */
  get hit(): boolean {
    return this.fresh !== null;
  }

  private static load(path: string, windowSecs: number, now: number): Map<string, unknown> | null {
    try {
      const file = JSON.parse(readFileSync(path, "utf8"), decode) as CacheFile;
      if (typeof file.savedAt !== "number" || now - file.savedAt >= windowSecs * 1000) return null;
      return new Map(Object.entries(file.entries ?? {}));
    } catch {
      return null;
    }
  }

  /** `db`, with its description calls answered from the file when it holds
   * them and read from the platform otherwise; every other call is `db`'s. */
  wrap(db: HostedDb): HostedDb {
    return new Proxy(db, {
      get: (target, prop, receiver) => {
        const original = Reflect.get(target, prop, receiver);
        if (typeof prop !== "string" || !CACHED_CALLS.has(prop) || typeof original !== "function") {
          return typeof original === "function" ? original.bind(target) : original;
        }
        return async (...args: unknown[]) => {
          const key = `${prop}:${JSON.stringify(args, encode)}`;
          if (this.fresh?.has(key)) return structuredClone(this.fresh.get(key));
          const value = await original.apply(target, args);
          this.read.set(key, value);
          return value;
        };
      },
    });
  }

  /** Keep what this start read, when it found no fresh file. Written to a
   * temporary file and renamed into place, so a server starting at the same
   * moment reads either the old file or the new one, never half of one. A
   * file that cannot be written is said on stderr and changes nothing. */
  save(now: number = Date.now()): void {
    if (this.fresh !== null || this.read.size === 0) return;
    try {
      mkdirSync(join(this.path, ".."), { recursive: true });
      const file: CacheFile = { savedAt: now, entries: Object.fromEntries(this.read) };
      const temp = `${this.path}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify(file, encode));
      renameSync(temp, this.path);
    } catch (err) {
      console.error(`the startup description could not be kept in ${this.path}: ${(err as Error).message}`);
    }
  }
}
