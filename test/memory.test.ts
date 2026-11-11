// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The database's memory over the platform's two routes, `remember` and
// `recall`, against a scripted fake fetch: what is sent, what comes back,
// and that a recall that fails costs a result nothing.

import { describe, expect, it } from "vitest";
import { HostedDb } from "../src/core/hosted.js";
import { MEMORY_HITS, MEMORY_KIND_ANSWER, MEMORY_KIND_FILE, MEMORY_NOTE, memoryHit, recallMemory, rememberRows, type MemoryRow } from "../src/core/memory.js";
import { SNIPPET_CHARS } from "../src/core/table-shape.js";

interface Recorded {
  url: string;
  body: string;
}

/** A fetch that records each request and answers from a script, in order. */
function client(script: Array<{ status: number; body?: string }>) {
  const calls: Recorded[] = [];
  const impl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), body: String(init?.body ?? "") });
    const next = script.shift();
    if (!next) throw new Error(`no scripted response for call ${calls.length}`);
    return new Response(next.body ?? "", { status: next.status, headers: { "content-type": "application/json" } });
  };
  const db = new HostedDb({ baseUrl: "https://api.example.test", database: "cx", apiKey: "inf_test_key" }, { fetch: impl, coldStartSecs: 0 });
  return { db, calls };
}

const ROW: MemoryRow = { kind: MEMORY_KIND_ANSWER, question: "q", content: "a", path: null, session_id: "s", created_at: 1 };
/** A short recall deadline, for the test that it holds. */
const DEADLINE_MS = 50;

describe("remembering", () => {
  it("posts the rows to the database's remember route in the data envelope", async () => {
    const { db, calls } = client([{ status: 200, body: "{}" }]);
    await rememberRows(db, [ROW, { ...ROW, kind: MEMORY_KIND_FILE, path: "out/memo.md", content: "memo" }]);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.example.test/v1/remember/cx");
    expect(JSON.parse(calls[0].body)).toEqual({ data: [ROW, { ...ROW, kind: MEMORY_KIND_FILE, path: "out/memo.md", content: "memo" }] });
  });

  it("sends nothing for no rows, and throws what the platform refused", async () => {
    const none = client([]);
    await rememberRows(none.db, []);
    expect(none.calls).toHaveLength(0);
    const refused = client([{ status: 403, body: "{\"error\":\"not admitted\"}" }]);
    await expect(rememberRows(refused.db, [ROW])).rejects.toThrow();
  });
});

describe("recalling", () => {
  it("asks for the nearest few and hands them back with the note", async () => {
    const recalled = [{ kind: "answer", question: "Earlier?", content: "Earlier answer.", path: null, session_id: "s", created_at: 5, score: 0.8 }];
    const { db, calls } = client([{ status: 200, body: JSON.stringify(recalled) }]);
    const { block, call } = await recallMemory(db, "What did we conclude?");
    expect(calls[0].url).toBe("https://api.example.test/v1/recall/cx");
    expect(JSON.parse(calls[0].body)).toEqual({ query: "What did we conclude?", k: MEMORY_HITS, kinds: ["answer", "file"] });
    expect(block).toEqual({
      note: MEMORY_NOTE,
      hits: [{ kind: "answer", question: "Earlier?", path: null, content: "Earlier answer.", created_at: 5, score: 0.8 }],
    });
    // The call itself, for the ledger: a metered platform read.
    expect(call?.op).toBe("recall");
  });

  it("gives up at its deadline, whatever the platform's retries would take", async () => {
    // A platform that never answers: the client's own timeout would wait,
    // and retry; the recall answers nothing at its deadline.
    const calls: string[] = [];
    const db = new HostedDb(
      { baseUrl: "https://api.example.test", database: "cx", apiKey: "inf_test_key" },
      { fetch: async (input) => (calls.push(String(input)), new Promise<Response>(() => undefined)), coldStartSecs: 60, timeoutMs: 60_000 },
    );
    const t0 = performance.now();
    const recalled = await recallMemory(db, "q", MEMORY_HITS, DEADLINE_MS);
    expect(recalled.block).toBeNull();
    expect(performance.now() - t0).toBeLessThan(DEADLINE_MS * 20);
    expect(calls).toHaveLength(1);
  });

  it("is null when nothing was remembered, and when the platform fails or has no such route", async () => {
    expect((await recallMemory(client([{ status: 200, body: "[]" }]).db, "q")).block).toBeNull();
    expect((await recallMemory(client([{ status: 404, body: "{\"error\":\"no route\"}" }]).db, "q")).block).toBeNull();
    expect((await recallMemory(client([{ status: 500, body: "{\"error\":\"boom\"}" }]).db, "q")).block).toBeNull();
  });

  it("cuts a hit's text and its question to a snippet, and drops a row with no text", () => {
    // A question can be a pasted contract: uncut, three of them would crowd
    // the facts out of the result's budget.
    const hit = memoryHit({ kind: "file", path: "out/memo.md", question: "q".repeat(SNIPPET_CHARS * 8), content: "x".repeat(SNIPPET_CHARS + 50), created_at: 9 });
    expect(hit?.content.length).toBe(SNIPPET_CHARS);
    expect(hit?.question?.length).toBe(SNIPPET_CHARS);
    expect(hit?.path).toBe("out/memo.md");
    expect(memoryHit({ kind: "answer", content: "" })).toBeNull();
  });
});
