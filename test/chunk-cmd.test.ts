import { Readable, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { chunkCmd, chunkText } from "../src/commands/chunk-cmd.js";

/** Run `cx chunk` on `input` as stdin; what it wrote to stdout, one parsed
 * line per chunk, and what it threw. */
async function run(input: string): Promise<{ out: Array<Record<string, unknown>>; error?: Error }> {
  let written = "";
  const output = new Writable({
    write(chunk, _encoding, done) {
      written += String(chunk);
      done();
    },
  });
  let error: Error | undefined;
  try {
    await chunkCmd(Readable.from([input]), output);
  } catch (err) {
    error = err as Error;
  }
  const out = written
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  return { out, ...(error ? { error } : {}) };
}

/** Lines of plain text, numbered so a chunk's range can be read off its text. */
function textLines(n: number): string {
  return Array.from({ length: n }, (_, i) => `line ${i + 1} of a long tool result`).join("\n");
}

describe("cx chunk", () => {
  it("cuts a long text into numbered chunks that cover it, each with its line range", async () => {
    const chunks = await chunkText({ id: "row-1", path: "result.txt", text: textLines(200) });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((c) => c.chunk)).toEqual(chunks.map((_, i) => i));
    expect(chunks.every((c) => c.id === "row-1")).toBe(true);
    expect(chunks[0].start_line).toBe(1);
    expect(chunks.at(-1)!.end_line).toBe(200);
    for (const c of chunks) {
      expect(c.content.split("\n")[0]).toBe(`line ${c.start_line} of a long tool result`);
      expect(c.end_line - c.start_line + 1).toBe(c.content.split("\n").length);
    }
  });

  it("keeps a short text as one chunk, whole", async () => {
    const [only, ...rest] = await chunkText({ id: 7, path: "message.txt", text: "the cache warm-up test flakes" });
    expect(rest).toEqual([]);
    expect(only).toEqual({ id: 7, chunk: 0, start_line: 1, end_line: 1, content: "the cache warm-up test flakes" });
  });

  it("cuts a markdown text at its headings, naming each chunk by its heading", async () => {
    const section = (title: string) => `# ${title}\n\n${textLines(50)}\n`;
    const chunks = await chunkText({ id: "md", path: "notes.md", text: section("Cache") + section("Shards") });
    expect(chunks).toHaveLength(2);
    expect(chunks[0].symbol).toContain("Cache");
    expect(chunks[1].symbol).toContain("Shards");
    expect(chunks[1].content.startsWith("# Shards")).toBe(true);
  });

  it("gives no chunks for whitespace", async () => {
    expect(await chunkText({ id: "x", path: "a.txt", text: "  \n\n " })).toEqual([]);
  });

  it("reads JSON lines on stdin and writes each text's chunks in order, skipping blank lines", async () => {
    const lines = [JSON.stringify({ id: "a", path: "a.txt", text: "one" }), "", JSON.stringify({ id: 2, path: "b.txt", text: "two\nthree" })];
    const { out, error } = await run(lines.join("\n") + "\n");
    expect(error).toBeUndefined();
    expect(out).toEqual([
      { id: "a", chunk: 0, start_line: 1, end_line: 1, content: "one" },
      { id: 2, chunk: 0, start_line: 1, end_line: 2, content: "two\nthree" },
    ]);
  });

  it("stops at a line that is not JSON, naming it, after the chunks of the lines before it", async () => {
    const { out, error } = await run(`${JSON.stringify({ id: "a", path: "a.txt", text: "one" })}\n{not json\n`);
    expect(out.map((o) => o.id)).toEqual(["a"]);
    expect(error?.message).toBe("line 2 of stdin is not JSON");
  });

  it("stops at a line without a string path or text, naming it", async () => {
    for (const bad of [{ id: 1, text: "no path" }, { id: 1, path: "a.txt" }, { id: 1, path: "a.txt", text: 3 }, null, ["a.txt", "x"]]) {
      const { out, error } = await run(`${JSON.stringify(bad)}\n`);
      expect(out).toEqual([]);
      expect(error?.message).toBe('line 1 of stdin needs a string "path" and a string "text"');
    }
  });
});
