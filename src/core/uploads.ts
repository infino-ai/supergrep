// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// Files that are in no bucket yet, on their way into a database: the data
// the `hydrate` tool is pointed at when it is not already in object storage.
// Two places such files live, read the same way:
//
//   path  - a file or directory on the machine this process runs on (the
//           laptop the plugin is installed on);
//   ssh   - a file or directory on a machine this process reaches with the
//           person's own `ssh` (a remote dev box). Nothing of ours is
//           installed there: the listing is one `find`, and each file's bytes
//           are `cat` over the same connection, streamed on to the storage.
//
// Either way the files are listed first - path and size, what the platform's
// upload route needs to open one session per file - and then each file's
// bytes are streamed to the session the platform opened for it. The bytes go
// to the storage the database lives on; neither the gateway nor this process
// keeps them.

import { spawn } from "node:child_process";
import { createReadStream, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";

/** One file to upload: its path under the upload's root, `/`-separated as
 * the platform names it, and its size in bytes. */
export interface UploadFile {
  name: string;
  size: number;
}

/** The most files one upload names: the platform's own cap on one request
 * (`MAX_UPLOAD_FILES` in its uploads route), checked here before a tree is
 * walked to the end for a request that would be refused anyway. */
export const MAX_UPLOAD_FILES = 1_000;

/** How many files are sent at once. A few streams keep a link busy; many
 * more only contend for it, and every one is a connection to the storage. */
export const UPLOAD_CONCURRENCY = 4;

/** `ssh` options: no prompt of any kind - a passphrase or a host-key
 * question would hang a tool call with nobody at the terminal - so a host
 * the person has not reached before is refused with ssh's own words. */
const SSH_ARGS = ["-o", "BatchMode=yes"];

/** The summary line `wc -c` writes after several files. Told from a file
 * named `total` by the path: a file is listed as `./total`. */
const WC_TOTAL_LINE = "total";

/** The most of a failed command's stderr a message quotes. */
const MAX_STDERR_CHARS = 400;

/** A command's result: what it wrote, and its exit status. */
export interface Ran {
  stdout: string;
  stderr: string;
  status: number;
}

/** Runs a command and collects what it wrote; injectable so the remote
 * listing is tested without an ssh host. */
export type Runner = (command: string, args: string[]) => Promise<Ran>;

/** Runs `command` with `args` and collects its output. */
export const runCommand: Runner = (command, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (status) => resolve({ stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), status: status ?? -1 }));
  });

/** `text` as one word for a POSIX shell: single-quoted, with any quote of
 * its own closed, escaped and reopened. ssh hands the remote shell one
 * command line, so every path that crosses it is quoted this way. */
export function shellQuote(text: string): string {
  return `'${text.replace(/'/g, "'\\''")}'`;
}

/** What a listing found: the files, and whether the path was one file
 * rather than a directory - then the one file's name is its basename and
 * its bytes are read from the path itself. */
export interface Listing {
  files: UploadFile[];
  single: boolean;
}

/** The files under `path` on this machine - the file itself, or every file
 * below a directory - with `/`-separated names relative to it (a single
 * file's name is its basename). Hidden files are included: a dataset's
 * files are what the person pointed at. Refused past MAX_UPLOAD_FILES. */
export async function localFiles(path: string): Promise<Listing> {
  const root = resolve(path);
  const stat = statSync(root);
  if (!stat.isDirectory()) return { files: [{ name: basename(root), size: stat.size }], single: true };
  const files: UploadFile[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        if (files.length >= MAX_UPLOAD_FILES) throw new Error(`${root} holds more than ${MAX_UPLOAD_FILES} files; one upload takes at most that many - point hydrate at a subdirectory, or at a bucket`);
        files.push({ name: relative(root, full).split(sep).join("/"), size: statSync(full).size });
      }
    }
  };
  await walk(root);
  if (files.length === 0) throw new Error(`${root} holds no files`);
  return { files, single: false };
}

/** The shell line that lists `path` on a remote host as `wc -c` writes it:
 * `<size> ./<name>` per file under a directory (with `wc`'s own `total`
 * lines between batches), or `<size> <path>` for a single file. `wc -c` is
 * what every POSIX machine agrees on; `find -printf` and `stat` differ
 * between GNU and BSD. */
export function remoteListCommand(path: string): string {
  const quoted = shellQuote(path);
  return `if [ -d ${quoted} ]; then cd ${quoted} && find . -type f -exec wc -c {} +; else wc -c ${quoted}; fi`;
}

/** The files a `remoteListCommand` listing names: each line's size and
 * name, the `./` prefix dropped, `wc`'s summary lines skipped. A listing
 * of a directory names every file `./...`; one of a single file names the
 * `path` the command was given, and the file is then named by its basename. */
export function parseRemoteListing(stdout: string, path: string): Listing {
  const files: UploadFile[] = [];
  let single = false;
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!match) continue;
    const [, size, name] = match;
    if (name === WC_TOTAL_LINE) continue;
    if (name.startsWith("./")) {
      files.push({ name: name.slice(2), size: Number(size) });
    } else {
      files.push({ name: basename(name), size: Number(size) });
      single = true;
    }
  }
  if (files.length === 0) throw new Error(`${path} holds no files`);
  if (files.length > MAX_UPLOAD_FILES) throw new Error(`${path} holds more than ${MAX_UPLOAD_FILES} files; one upload takes at most that many - point hydrate at a subdirectory, or at a bucket`);
  return { files, single };
}

/** The files under `path` on `host`, listed over ssh. `host` is whatever
 * the person's own `ssh` resolves - a name from their ssh config, or
 * `user@machine`. */
export async function remoteFiles(host: string, path: string, run: Runner = runCommand): Promise<Listing> {
  const ran = await run("ssh", [...SSH_ARGS, host, remoteListCommand(path)]);
  if (ran.status !== 0) throw new Error(`listing ${path} on ${host} failed (ssh exit ${ran.status}): ${ran.stderr.trim().slice(0, MAX_STDERR_CHARS)}`);
  return parseRemoteListing(ran.stdout, path);
}

/** The bytes of one listed file, as a web stream: the file under `path` on
 * this machine, or `cat` of it over ssh from `host`. The file's path is the
 * upload root joined with its name - the name is what the listing gave, so
 * a single file's root is the file itself. */
export function fileBytes(source: { host?: string; path: string }, file: UploadFile, single: boolean): ReadableStream<Uint8Array> {
  const full = single ? source.path : `${source.path.replace(/\/+$/, "")}/${file.name}`;
  if (source.host === undefined) return Readable.toWeb(createReadStream(full)) as ReadableStream<Uint8Array>;
  const child = spawn("ssh", [...SSH_ARGS, source.host, `cat ${shellQuote(full)}`], { stdio: ["ignore", "pipe", "pipe"] });
  const err: Buffer[] = [];
  child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
  // A cat that fails ends the stream with ssh's words rather than short.
  child.on("close", (status) => {
    if (status !== 0) child.stdout.destroy(new Error(`reading ${full} on ${source.host} failed (ssh exit ${status}): ${Buffer.concat(err).toString("utf8").trim().slice(0, MAX_STDERR_CHARS)}`));
  });
  return Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
}

/** Send every file to its session, UPLOAD_CONCURRENCY at a time, in the
 * listing's order. `send` is one file's PUT; the first failure stops the
 * rest and is thrown with the file named. */
export async function uploadAll(
  files: readonly UploadFile[],
  send: (file: UploadFile, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  let failed: Error | null = null;
  const worker = async (): Promise<void> => {
    while (next < files.length && failed === null) {
      const index = next++;
      try {
        await send(files[index], index);
      } catch (err) {
        failed ??= new Error(`uploading ${files[index].name} failed: ${(err as Error).message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, files.length) }, worker));
  if (failed) throw failed;
}
