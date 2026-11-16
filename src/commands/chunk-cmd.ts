// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// `cx chunk`: cut text into the chunks an index of it would hold, with the
// same chunker `cx index` uses (core/chunker.ts), for a program that stores
// text of its own - an agent's messages and tool results - and wants each
// long value kept as chunks rather than cut short.
//
// JSON lines in on stdin, one per text: `{"id": ..., "path": ..., "text": ...}`.
// `path` picks how the text is cut, as a file of that name would be: a source
// file's extension cuts at definitions, `.md` at headings, `.log` at records,
// anything else in line windows. `id` is the caller's own, given back on each
// chunk. JSON lines out on stdout, one per chunk, in order:
// `{"id", "chunk", "start_line", "end_line", "content"}`, with `symbol`,
// `kind` and `scope` where the chunker names the chunk. A text with nothing
// but whitespace gives no chunks.

import { createInterface } from "node:readline";
import { chunkFile } from "../core/chunker.js";

/** One text to cut. */
export interface ChunkRequest {
  id: unknown;
  path: string;
  text: string;
}

/** One chunk of a text, as a line of output. */
export interface ChunkLine {
  id: unknown;
  chunk: number;
  start_line: number;
  end_line: number;
  content: string;
  symbol?: string;
  kind?: string;
  scope?: string;
}

/** The chunks of one text, numbered from 0. */
export async function chunkText(request: ChunkRequest): Promise<ChunkLine[]> {
  const chunks = await chunkFile(request.path, request.text);
  return chunks.map((c, chunk) => ({
    id: request.id,
    chunk,
    start_line: c.startLine,
    end_line: c.endLine,
    content: c.content,
    ...(c.symbol !== undefined ? { symbol: c.symbol } : {}),
    ...(c.kind !== undefined ? { kind: c.kind } : {}),
    ...(c.scope !== undefined ? { scope: c.scope } : {}),
  }));
}

/** Whether a parsed line is a request this command takes. */
function isRequest(value: unknown): value is ChunkRequest {
  const r = value as Partial<ChunkRequest> | null;
  return r !== null && typeof r === "object" && typeof r.path === "string" && typeof r.text === "string";
}

export async function chunkCmd(): Promise<void> {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let n = 0;
  for await (const line of lines) {
    n += 1;
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`line ${n} of stdin is not JSON`);
    }
    if (!isRequest(parsed)) throw new Error(`line ${n} of stdin needs a string "path" and a string "text"`);
    for (const out of await chunkText(parsed)) process.stdout.write(`${JSON.stringify(out)}\n`);
  }
}
