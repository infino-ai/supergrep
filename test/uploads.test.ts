// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// Listing the files a hydrate uploads - on this machine, and on a machine
// reached over ssh, whose listing is `wc -c` over `find` - and sending them.

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileBytes, localFiles, parseRemoteListing, remoteFiles, remoteListCommand, shellQuote, uploadAll, UPLOAD_CONCURRENCY } from "../src/core/uploads.js";

/** Everything a byte stream yields, as text; rejects with the stream's
 * error when it ends in one. */
async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

describe("local files", () => {
  it("lists a directory's files with /-separated names relative to it, and one file by its basename", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cx-uploads-"));
    try {
      mkdirSync(join(dir, "a", "b"), { recursive: true });
      writeFileSync(join(dir, "a", "b", "deep.ndjson"), "{}\n");
      writeFileSync(join(dir, ".hidden"), "h");
      writeFileSync(join(dir, "top.csv"), "x,y\n");
      const listing = await localFiles(dir);
      expect(listing.single).toBe(false);
      expect([...listing.files].sort((p, q) => p.name.localeCompare(q.name))).toEqual([
        { name: ".hidden", size: 1 },
        { name: "a/b/deep.ndjson", size: 3 },
        { name: "top.csv", size: 4 },
      ]);
      const one = await localFiles(join(dir, "top.csv"));
      expect(one).toEqual({ files: [{ name: "top.csv", size: 4 }], single: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses an empty directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cx-uploads-empty-"));
    try {
      await expect(localFiles(dir)).rejects.toThrow("holds no files");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("remote files", () => {
  it("quotes a path for the remote shell", () => {
    expect(shellQuote("/data/it's here")).toBe(`'/data/it'\\''s here'`);
    expect(remoteListCommand("/srv/x")).toBe("if [ -d '/srv/x' ]; then cd '/srv/x' && find . -type f -exec wc -c {} +; else wc -c '/srv/x'; fi");
  });

  it("reads a directory listing, skipping wc's totals and keeping a file named total", () => {
    const stdout = "     12 ./2024/jan.csv\n      5 ./readme.txt\n     17 total\n      3 ./total\n      3 total\n";
    expect(parseRemoteListing(stdout, "/srv/x")).toEqual({
      files: [
        { name: "2024/jan.csv", size: 12 },
        { name: "readme.txt", size: 5 },
        { name: "total", size: 3 },
      ],
      single: false,
    });
  });

  it("reads a single file's listing by its basename", () => {
    expect(parseRemoteListing("  40 /srv/x/one.parquet\n", "/srv/x/one.parquet")).toEqual({ files: [{ name: "one.parquet", size: 40 }], single: true });
  });

  it("runs ssh in batch mode with the listing command, and reports ssh's own words on a failure", async () => {
    const calls: string[][] = [];
    const ok = await remoteFiles("dev1", "/srv/x", async (command, args) => {
      calls.push([command, ...args]);
      return { stdout: "  7 ./a.csv\n", stderr: "", status: 0 };
    });
    expect(ok).toEqual({ files: [{ name: "a.csv", size: 7 }], single: false });
    expect(calls).toEqual([["ssh", "-o", "BatchMode=yes", "dev1", remoteListCommand("/srv/x")]]);
    await expect(remoteFiles("dev1", "/srv/x", async () => ({ stdout: "", stderr: "Permission denied (publickey).", status: 255 }))).rejects.toThrow(
      "listing /srv/x on dev1 failed (ssh exit 255): Permission denied (publickey).",
    );
  });
});

describe("reading a file over ssh", () => {
  /** A stand-in `ssh` first on PATH. Asked for host `bad`, it writes part of
   * the file, says why on stderr and exits 1, as a cat refused partway
   * does; any other host gets the whole file. */
  const FAKE_SSH = [
    "#!/bin/sh",
    'for arg in "$@"; do',
    '  if [ "$arg" = bad ]; then printf par; echo "cat: /srv/x/a.csv: Permission denied" >&2; exit 1; fi',
    "done",
    "printf whole",
    "",
  ].join("\n");
  /** The file both reads ask for. */
  const FILE = { name: "a.csv", size: 5 };
  let bin = "";
  let path: string | undefined;

  beforeAll(() => {
    bin = mkdtempSync(join(tmpdir(), "cx-fake-ssh-"));
    writeFileSync(join(bin, "ssh"), FAKE_SSH);
    chmodSync(join(bin, "ssh"), 0o755);
    path = process.env.PATH;
    process.env.PATH = `${bin}${delimiter}${path ?? ""}`;
  });

  afterAll(() => {
    process.env.PATH = path;
    rmSync(bin, { recursive: true, force: true });
  });

  it("streams the file and ends when ssh exits clean", async () => {
    expect(await readAll(fileBytes({ host: "dev1", path: "/srv/x" }, FILE, false))).toBe("whole");
  });

  it("ends a failed cat with ssh's own words, never short", async () => {
    await expect(readAll(fileBytes({ host: "bad", path: "/srv/x" }, FILE, false))).rejects.toThrow(
      "reading /srv/x/a.csv on bad failed (ssh exit 1): cat: /srv/x/a.csv: Permission denied",
    );
  });
});

describe("sending", () => {
  it("sends every file, a few at a time, and names the file that failed", async () => {
    const files = Array.from({ length: 10 }, (_, i) => ({ name: `f${i}`, size: 1 }));
    let inFlight = 0;
    let most = 0;
    const sent: number[] = [];
    await uploadAll(files, async (_file, index) => {
      inFlight++;
      most = Math.max(most, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      sent.push(index);
      inFlight--;
    });
    expect(sent.sort((p, q) => p - q)).toEqual(files.map((_, i) => i));
    expect(most).toBeLessThanOrEqual(UPLOAD_CONCURRENCY);
    await expect(
      uploadAll(files, async (file) => {
        if (file.name === "f3") throw new Error("storage answered 403");
      }),
    ).rejects.toThrow("uploading f3 failed: storage answered 403");
  });
});
