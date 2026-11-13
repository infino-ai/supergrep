// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// One writer per index across processes: the lock file itself, `cx index`
// refusing to write under another process's lock, and the MCP server leaving
// a first build alone while another process holds it.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { IndexBusyError, holderAlive, lockIndex, lockPath, tryLockIndex, type LockHolder } from "../src/core/index-lock.js";
import { indexCmd } from "../src/commands/index-cmd.js";
import { readManifest } from "../src/core/manifest.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cx-lock-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A process id that was this host's and has exited. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", ""]);
  return child.pid!;
}

function plant(path: string, holder: Partial<LockHolder> | string): void {
  writeFileSync(path, typeof holder === "string" ? holder : JSON.stringify({ host: hostname(), since: "2026-01-01T00:00:00.000Z", ...holder }));
}

const held = (): LockHolder => JSON.parse(readFileSync(lockPath(dir), "utf8")) as LockHolder;

describe("the index lock", () => {
  it("names the process that holds it, and is gone once released", () => {
    const lock = lockIndex(dir);
    expect(held()).toMatchObject({ pid: process.pid, host: hostname() });
    lock.release();
    expect(existsSync(lockPath(dir))).toBe(false);
  });

  it("refuses a second taker while it is held, and leaves no temporary file behind", () => {
    const lock = lockIndex(dir);
    const second = tryLockIndex(dir);
    expect("heldBy" in second && second.heldBy?.pid).toBe(process.pid);
    expect(() => lockIndex(dir)).toThrow(IndexBusyError);
    lock.release();
    expect("lock" in tryLockIndex(dir)).toBe(true);
    expect(readdirSync(dir)).toEqual(["index.lock"]);
  });

  it("is kept until the last of its owners releases it", () => {
    const lock = lockIndex(dir);
    lock.retain();
    lock.release();
    expect(existsSync(lockPath(dir))).toBe(true);
    lock.release();
    expect(existsSync(lockPath(dir))).toBe(false);
    lock.release(); // past zero: nothing
  });

  it("is taken over from a holder on this host whose process has exited", () => {
    const pid = deadPid();
    plant(lockPath(dir), { pid });
    expect(holderAlive({ pid, host: hostname(), since: "" })).toBe(false);
    const attempt = tryLockIndex(dir);
    expect("lock" in attempt).toBe(true);
    expect(held().pid).toBe(process.pid);
  });

  it("is taken over from this process's id when this process does not hold it (a restarted container's own stale lock)", () => {
    plant(lockPath(dir), { pid: process.pid, since: "2026-01-01T00:00:00.000Z" });
    const attempt = tryLockIndex(dir);
    expect("lock" in attempt).toBe(true);
    expect(held()).toMatchObject({ pid: process.pid });
    expect(held().since).not.toBe("2026-01-01T00:00:00.000Z");
    // The acquisition this process does hold is still refused to a second taker.
    expect("heldBy" in tryLockIndex(dir)).toBe(true);
    if ("lock" in attempt) attempt.lock.release();
    expect(existsSync(lockPath(dir))).toBe(false);
  });

  it("refuses the lock this process holds to a second spelling of the same index dir (a symlink)", () => {
    const link = join(mkdtempSync(join(tmpdir(), "cx-lock-link-")), "index");
    symlinkSync(dir, link);
    try {
      const lock = lockIndex(dir);
      const second = tryLockIndex(link);
      expect("heldBy" in second && second.heldBy?.pid).toBe(process.pid);
      expect(held().since).toBe(lock.holder.since);
      lock.release();
      expect(existsSync(lockPath(dir))).toBe(false);
      // Released, the other spelling takes it, and the first is then refused it.
      const viaLink = lockIndex(link);
      expect("heldBy" in tryLockIndex(dir)).toBe(true);
      viaLink.release();
    } finally {
      rmSync(join(link, ".."), { recursive: true, force: true });
    }
  });

  it("counts a live process, or one on another host, as holding it", () => {
    plant(lockPath(dir), { pid: process.ppid });
    const live = tryLockIndex(dir);
    expect("heldBy" in live && live.heldBy?.pid).toBe(process.ppid);
    plant(lockPath(dir), { pid: deadPid(), host: `not-${hostname()}` });
    expect("heldBy" in tryLockIndex(dir)).toBe(true);
  });

  it("is taken over from a file that names no holder", () => {
    plant(lockPath(dir), "");
    expect("lock" in tryLockIndex(dir)).toBe(true);
  });

  it("gives up one attempt on a takeover guard left by an exited process, then goes ahead", () => {
    plant(lockPath(dir), { pid: deadPid() });
    plant(`${lockPath(dir)}.takeover`, { pid: deadPid() });
    expect("heldBy" in tryLockIndex(dir)).toBe(true);
    expect(existsSync(`${lockPath(dir)}.takeover`)).toBe(false);
    expect("lock" in tryLockIndex(dir)).toBe(true);
  });

  it("leaves alone a lock that is no longer its own when released", () => {
    const lock = lockIndex(dir);
    plant(lockPath(dir), { pid: process.ppid });
    lock.release();
    expect(held().pid).toBe(process.ppid);
  });
});

describe("cx index under another process's lock", () => {
  it("throws IndexBusyError and writes no index; goes ahead once the lock is released", async () => {
    const root = mkdtempSync(join(tmpdir(), "cx-lock-repo-"));
    try {
      writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
      const indexDir = join(root, ".infino");
      mkdirSync(indexDir);
      plant(lockPath(indexDir), { pid: process.ppid });
      await expect(indexCmd(root, { json: true })).rejects.toBeInstanceOf(IndexBusyError);
      expect(readManifest(indexDir)).toBeUndefined();
      rmSync(lockPath(indexDir));
      await indexCmd(root, { json: true });
      expect(readManifest(indexDir)?.files).toBe(1);
      expect(existsSync(lockPath(indexDir))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("the MCP server under another process's lock", () => {
  it("does not build a missing index while another process holds the lock, and builds it once released", async () => {
    const root = mkdtempSync(join(tmpdir(), "cx-lock-srv-"));
    try {
      writeFileSync(join(root, "a.ts"), "export function lockedOut() { return 1; }\n");
      const indexDir = join(root, ".infino");
      mkdirSync(indexDir);
      plant(lockPath(indexDir), { pid: process.ppid });
      const { serveMcp } = await import("../src/mcp/server.js");
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await serveMcp(root, { transport: serverSide });
      const client = new Client({ name: "lock-test", version: "0" });
      await client.connect(clientSide);
      try {
        const find = async () =>
          (await client.callTool({ name: "find", arguments: { query: "lockedOut" } })) as { content: Array<{ text: string }>; isError?: boolean };
        const before = await find();
        expect(readManifest(indexDir)).toBeUndefined();
        expect(before.isError).toBe(true);
        expect(before.content[0].text).toContain(`another process (pid ${process.ppid}) is indexing it now`);
        rmSync(lockPath(indexDir));
        const after = await find();
        expect(after.isError ?? false).toBe(false);
        expect(after.content[0].text).toContain("a.ts");
        expect(readManifest(indexDir)?.files).toBe(1);
      } finally {
        await client.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("the MCP server and a build that stopped before it finished", () => {
  it("rebuilds an index whose manifest is still marked building when no process holds its lock", async () => {
    const root = mkdtempSync(join(tmpdir(), "cx-lock-abandoned-"));
    const interval = process.env.CX_SYNC_INTERVAL_SECS;
    process.env.CX_SYNC_INTERVAL_SECS = "0";
    try {
      writeFileSync(join(root, "a.ts"), "export function abandoned() { return 1; }\n");
      const indexDir = join(root, ".infino");
      const { serveMcp } = await import("../src/mcp/server.js");
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await serveMcp(root, { transport: serverSide });
      const client = new Client({ name: "abandoned-test", version: "0" });
      await client.connect(clientSide);
      const until = async (done: () => boolean) => {
        for (let i = 0; i < 200 && !done(); i++) await new Promise((r) => setTimeout(r, 25));
        expect(done()).toBe(true);
      };
      try {
        const find = () => client.callTool({ name: "find", arguments: { query: "abandoned" } });
        await find(); // builds the index
        await until(() => readManifest(indexDir) !== undefined && readManifest(indexDir)!.vectors !== "building" && !existsSync(lockPath(indexDir)));
        // What a server killed mid-backfill leaves: the marker, and no live lock.
        const path = join(indexDir, "codecontext.json");
        const before = { ...readManifest(indexDir)!, vectors: "building" as const, indexedAt: "2026-01-01T00:00:00.000Z" };
        writeFileSync(path, JSON.stringify(before));
        await find(); // the query's auto-sync finds the marker under the lock
        await until(() => readManifest(indexDir)?.indexedAt !== before.indexedAt && !existsSync(lockPath(indexDir)));
        expect(readManifest(indexDir)?.vectors).not.toBe("building");
        expect(readManifest(indexDir)?.files).toBe(1);
      } finally {
        await client.close();
      }
    } finally {
      if (interval === undefined) delete process.env.CX_SYNC_INTERVAL_SECS;
      else process.env.CX_SYNC_INTERVAL_SECS = interval;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
