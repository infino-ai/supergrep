// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// `cx hook memory`: the rows a finished turn writes to the database's memory,
// read from a Claude Code session transcript at Stop, and what keeps the hook
// from sending anything an index of the folder would not.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  hookFiguresOutput,
  memoryAdmits,
  memoryRows,
  memorySend,
  memorySendArgv,
  sendRememberedRows,
  transcriptToolUses,
  unwrittenRows,
  type MemoryTurn,
} from "../src/commands/hook-cmd.js";
import { DEFAULT_CAPS } from "../src/core/config.js";
import { HostedDb } from "../src/core/hosted.js";
import { MEMORY_KIND_ANSWER, MEMORY_KIND_FILE, type MemoryRow } from "../src/core/memory.js";

/** One transcript line as Claude Code writes it. */
const line = (entry: Record<string, unknown>) => JSON.stringify(entry);
const user = (text: string, extra: Record<string, unknown> = {}) => line({ type: "user", message: { role: "user", content: [{ type: "text", text }] }, ...extra });
const toolResult = (text: string, id = "t1") => line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text }] } });
const assistant = (blocks: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) =>
  line({ type: "assistant", message: { role: "assistant", content: blocks }, ...extra });
const toolUse = (name: string, input: Record<string, unknown>, id = "t1") => ({ type: "tool_use", id, name, input });
/** A search through this server, and its result: what makes a turn one the
 * memory hook keeps. */
const SEARCHED = [assistant([toolUse("mcp__code-context__search", { query: "q" }, "r0")]), toolResult("[]", "r0")];

const TRANSCRIPT_PATH = "/s/t.jsonl";
const CWD = "/repo";
/** Where the answer tool writes, under the default index directory. */
const NOW = 1_791_400_000_000;
const now = () => NOW;
/** Every written file passes, for the cases about which files a turn names;
 * what the index would admit is tested on a real folder below. */
const admitAll = () => true;

const stopEvent = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ session_id: "sess-1", transcript_path: TRANSCRIPT_PATH, cwd: CWD, hook_event_name: "Stop", stop_hook_active: false, ...extra });
const reader = (transcript: string, files: Record<string, string> = {}) => (p: string) =>
  p === TRANSCRIPT_PATH ? transcript : (files[p] ?? null);
/** The turn's rows, judged against the project at `CWD` (what Claude Code
 * names in CLAUDE_PROJECT_DIR). */
const rowsOf = (input: string, read: (p: string) => string | null, admits = admitAll, root: string | null = CWD) =>
  memoryRows(input, read, now, admits, root)?.rows ?? null;

describe("the memory a turn writes", () => {
  it("keeps nothing of a turn that never retrieved through the server, whatever it wrote", () => {
    const untouched = [
      user("Fix the failing test. The token is sk-test-123."),
      assistant([toolUse("Write", { file_path: "/repo/notes.md" }, "w1")]),
      toolResult("ok", "w1"),
      assistant([{ type: "text", text: "Fixed." }]),
    ].join("\n");
    expect(rowsOf(stopEvent(), reader(untouched, { "/repo/notes.md": "notes" }))).toBeNull();
    expect(rowsOf(stopEvent({ stop_hook_active: true }), reader(untouched, { "/repo/notes.md": "notes" }))).toBeNull();
  });

  it("is the last question with the final reply, stamped with the session and the clock", () => {
    const transcript = [
      user("What did the Q3 memo conclude?"),
      assistant([{ type: "text", text: "An earlier answer." }]),
      user("Draft the indemnity clause for the Acme deal."),
      ...SEARCHED,
      assistant([{ type: "thinking", thinking: "never read" }, { type: "text", text: "Here is the clause: ..." }]),
    ].join("\n");
    expect(rowsOf(stopEvent(), reader(transcript))).toEqual([
      { kind: MEMORY_KIND_ANSWER, question: "Draft the indemnity clause for the Acme deal.", content: "Here is the clause: ...", path: null, session_id: "sess-1", created_at: NOW },
    ]);
  });

  it("keeps each file the model wrote under the folder as it stands now, by its relative path, once", () => {
    const transcript = [
      user("Write the memo and the redline."),
      ...SEARCHED,
      assistant([toolUse("Write", { file_path: "/repo/out/memo.md", content: "first draft" })]),
      toolResult("ok"),
      assistant([toolUse("Edit", { file_path: "/repo/out/memo.md", old_string: "first", new_string: "final" })]),
      toolResult("ok"),
      assistant([toolUse("NotebookEdit", { notebook_path: "/repo/analysis.ipynb", new_source: "x" })]),
      toolResult("ok"),
      assistant([{ type: "text", text: "Both are written." }]),
    ].join("\n");
    const rows = rowsOf(stopEvent(), reader(transcript, { "/repo/out/memo.md": "final draft", "/repo/analysis.ipynb": "{\"cells\":[]}" }));
    expect(rows?.map((r) => [r.kind, r.path, r.content])).toEqual([
      [MEMORY_KIND_ANSWER, null, "Both are written."],
      [MEMORY_KIND_FILE, "out/memo.md", "final draft"],
      [MEMORY_KIND_FILE, "analysis.ipynb", "{\"cells\":[]}"],
    ]);
    expect(rows?.every((r) => r.question === "Write the memo and the redline." && r.session_id === "sess-1")).toBe(true);
  });

  it("never keeps a file outside the folder, in a dot-named folder or file, written by a subagent, gone, over the cap, or one the index would not admit", () => {
    const big = "x".repeat(DEFAULT_CAPS.maxFileBytes + 1);
    const transcript = [
      user("Set it up."),
      ...SEARCHED,
      assistant([toolUse("Write", { file_path: "/etc/hosts", content: "x" })]),
      assistant([toolUse("Write", { file_path: "/repo/.env", content: "SECRET=1" })]),
      assistant([toolUse("Write", { file_path: "/repo/.git/config", content: "x" })]),
      assistant([toolUse("Write", { file_path: "/repo/big.txt", content: "x" })]),
      assistant([toolUse("Write", { file_path: "/repo/gone.txt", content: "x" })]),
      assistant([toolUse("Write", { file_path: "/repo/sub.txt", content: "x" })], { isSidechain: true }),
      assistant([toolUse("Write", { file_path: "/repo/config/secrets.yaml", content: "x" })]),
      assistant([{ type: "text", text: "Done." }]),
    ].join("\n");
    const files = {
      "/etc/hosts": "x",
      "/repo/.env": "SECRET=1",
      "/repo/.git/config": "x",
      "/repo/big.txt": big,
      "/repo/sub.txt": "x",
      "/repo/config/secrets.yaml": "db_password: x",
    };
    const refuses = (_cwd: string, rel: string) => rel !== "config/secrets.yaml";
    expect(rowsOf(stopEvent(), reader(transcript, files), refuses)?.map((r) => r.kind)).toEqual([MEMORY_KIND_ANSWER]);
  });

  it("takes the person's typed question: not an entry Claude Code added, not a Stop hook's fed-back reason, not attached editor context", () => {
    const transcript = [
      user("Why does the deploy fail?\n"),
      line({
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "text", text: "<ide_selection>AWS_SECRET_ACCESS_KEY=abc</ide_selection>" },
            { type: "text", text: "Why does the staging deploy fail?" },
          ],
        },
      }),
      ...SEARCHED,
      assistant([{ type: "text", text: "The role is missing." }]),
      user("Caveat: the messages below were generated by the user while running local commands.", { isMeta: true }),
      user("Stop hook feedback:\n[cx hook answer-figures]: compute it"),
      assistant([{ type: "text", text: "The deploy role is missing s3:PutObject." }]),
    ].join("\n");
    const rows = rowsOf(stopEvent({ stop_hook_active: true }), reader(transcript));
    expect(rows?.map((r) => r.question)).toEqual(["Why does the staging deploy fail?"]);
    expect(rows?.map((r) => r.content)).toEqual(["The deploy role is missing s3:PutObject."]);
  });

  it("judges every path against the project, not the folder the model last cd'd into", () => {
    // The event's cwd follows the shell.
    const transcript = [
      user("Summarise the covenants."),
      ...SEARCHED,
      assistant([toolUse("Bash", { command: "cd client && npm test" }, "b1")]),
      toolResult("ok", "b1"),
      assistant([toolUse("Write", { file_path: "/repo/client/notes.md" }, "f1")]),
      toolResult("ok", "f1"),
      assistant([{ type: "text", text: "Three covenants." }]),
    ].join("\n");
    const files = { "/repo/client/notes.md": "notes" };
    const judged: string[] = [];
    const admits = (root: string, rel: string) => (judged.push(`${root} ${rel}`), true);
    const rows = rowsOf(stopEvent({ cwd: "/repo/client", stop_hook_active: true }), reader(transcript, files), admits);
    expect(rows?.map((r) => [r.kind, r.path, r.content])).toEqual([
      [MEMORY_KIND_ANSWER, null, "Three covenants."],
      [MEMORY_KIND_FILE, "client/notes.md", "notes"],
    ]);
    expect(judged).toEqual(["/repo client/notes.md"]);
  });

  it("keeps only the reply when Claude Code did not name the project", () => {
    const transcript = [
      user("Write the memo."),
      ...SEARCHED,
      assistant([toolUse("Write", { file_path: "/repo/notes/memo.md" }, "f1")]),
      toolResult("ok", "f1"),
      assistant([{ type: "text", text: "Written." }]),
    ].join("\n");
    expect(rowsOf(stopEvent(), reader(transcript, { "/repo/notes/memo.md": "memo" }), admitAll, null)?.map((r) => r.kind)).toEqual([MEMORY_KIND_ANSWER]);
  });

  it("takes the question from before a mid-turn compaction, and keeps the files written before it", () => {
    const transcript = [
      user("Fix the deploy script."),
      ...SEARCHED,
      assistant([toolUse("Edit", { file_path: "/repo/deploy/run.sh" }, "e1")]),
      toolResult("ok", "e1"),
      line({ type: "system", subtype: "compact_boundary" }),
      user("This session is being continued from a previous conversation. Summary: the person asked ... SECRET=1 ...", { isCompactSummary: true, isVisibleInTranscriptOnly: true }),
      assistant([{ type: "text", text: "Fixed." }]),
    ].join("\n");
    const rows = rowsOf(stopEvent(), reader(transcript, { "/repo/deploy/run.sh": "#!/bin/sh" }));
    expect(rows?.map((r) => r.question)).toEqual(["Fix the deploy script.", "Fix the deploy script."]);
    expect(rows?.map((r) => r.path)).toEqual([null, "deploy/run.sh"]);
  });

  it("makes nothing for a transcript with no question, a malformed event, or a transcript it cannot read", () => {
    const orphan = assistant([{ type: "text", text: "orphan" }]);
    expect(memoryRows(stopEvent(), reader(orphan), now, admitAll, CWD)).toBeNull();
    expect(memoryRows("not json", reader(orphan), now, admitAll, CWD)).toBeNull();
    expect(memoryRows(JSON.stringify({ session_id: "s" }), reader(orphan), now, admitAll, CWD)).toBeNull();
    expect(memoryRows(stopEvent(), () => null, now, admitAll, CWD)).toBeNull();
  });

  it("waits for the stop that ends the turn when this install's Stop hooks are sending the model back", () => {
    // A figure no tool result holds: the figures hook sends it back, so this
    // stop writes nothing.
    const unbacked = [
      user("What is the average balance?"),
      assistant([toolUse("mcp__code-context__sql", { statement: "SELECT 1" }, "s1")]),
      toolResult("{\"rows\":[{\"n\":12}]}", "s1"),
      assistant([{ type: "text", text: "The average balance is 4,812.37." }]),
    ].join("\n");
    expect(memoryRows(stopEvent(), reader(unbacked), now, admitAll)).toBeNull();
    // The stop after it was sent back is the one that writes.
    expect(rowsOf(stopEvent({ stop_hook_active: true }), reader(unbacked))?.map((r) => r.content)).toEqual([
      "The average balance is 4,812.37.",
    ]);
  });
});

describe("two servers installed in one project", () => {
  // Each server's figures entry acts on a turn that retrieved through that
  // server only, so a turn that used one server is sent back once, not once
  // per installed server.
  const retrievedThroughOne = [
    user("What is the average balance?"),
    assistant([toolUse("mcp__code-context__sql", { query: "SELECT 1" }, "a1")]),
    toolResult("{\"rows\":[{\"n\":12}]}", "a1"),
    assistant([{ type: "text", text: "The average balance is 4,812.37." }]),
  ].join("\n");

  it("sends the model back once, from the server it retrieved through", () => {
    const read = reader(retrievedThroughOne);
    expect(hookFiguresOutput(stopEvent(), read, "code-context")).not.toBeNull();
    expect(hookFiguresOutput(stopEvent(), read, "staging")).toBeNull();
  });

  it("reads a server's tools under the name Claude Code gives them", () => {
    // Claude Code writes `code.context`'s tools as `mcp__code_context__...`.
    const dotted = retrievedThroughOne.replace(/mcp__code-context__/g, "mcp__code_context__");
    expect(hookFiguresOutput(stopEvent(), reader(dotted), "code.context")).not.toBeNull();
  });

  it("writes no memory for a turn that retrieved only through another server, and waits for its own server's block", () => {
    const otherSearch = [
      user("What does the runbook say about failover?"),
      assistant([toolUse("mcp__docs__search", { query: "failover" }, "d1")]),
      toolResult("[]", "d1"),
      assistant([{ type: "text", text: "Fail over by promoting the replica." }]),
    ].join("\n");
    // Not this server's turn: nothing is kept, now or on a later stop.
    expect(memoryRows(stopEvent(), reader(otherSearch), now, admitAll, CWD, "code-context")).toBeNull();
    expect(memoryRows(stopEvent({ stop_hook_active: true }), reader(otherSearch), now, admitAll, CWD, "code-context")).toBeNull();
    // Through its own server, it waits for the block its own entry sends.
    expect(memoryRows(stopEvent(), reader(retrievedThroughOne), now, admitAll, CWD, "code-context")).toBeNull();
  });
});

describe("a turn stopped more than once", () => {
  const row = (content: string, path: string | null = null): MemoryRow => ({
    kind: path ? MEMORY_KIND_FILE : MEMORY_KIND_ANSWER,
    question: "q",
    content,
    path,
    session_id: "s",
    created_at: 1,
  });
  const turn = (key: string, rows: MemoryRow[]): MemoryTurn => ({ key, rows });

  it("writes each row once, a changed one again, and starts over on the next turn", () => {
    const first = unwrittenRows(turn("t1", [row("answer"), row("memo v1", "out/memo.md")]), null);
    expect(first.rows.map((r) => r.content)).toEqual(["answer", "memo v1"]);
    // Another install's Stop hook sent the model back; it stopped again.
    const again = unwrittenRows(turn("t1", [row("answer"), row("memo v1", "out/memo.md")]), first.state);
    expect(again.rows).toEqual([]);
    const fixed = unwrittenRows(turn("t1", [row("answer"), row("memo v2", "out/memo.md")]), again.state);
    expect(fixed.rows.map((r) => r.content)).toEqual(["memo v2"]);
    const next = unwrittenRows(turn("t2", [row("answer")]), fixed.state);
    expect(next.rows.map((r) => r.content)).toEqual(["answer"]);
  });

  it("keys a turn by its prompt, the same across its stops", () => {
    const transcript = [user("Write the memo.", { uuid: "p-1" }), ...SEARCHED, assistant([{ type: "text", text: "Written." }])].join("\n");
    const a = memoryRows(stopEvent(), reader(transcript), now, admitAll);
    const b = memoryRows(stopEvent({ stop_hook_active: true }), reader(`${transcript}\n${assistant([{ type: "text", text: "Fixed." }])}`), now, admitAll);
    expect(a?.key).toBe(b?.key);
    const other = memoryRows(stopEvent(), reader([user("Write the memo.", { uuid: "p-2" }), ...SEARCHED, assistant([{ type: "text", text: "x" }])].join("\n")), now, admitAll);
    expect(other?.key).not.toBe(a?.key);
  });
});

describe("what the index of the folder would admit", () => {
  it("is what memory may send: no gitignored, cxignored, non-indexable or symlinked file", () => {
    const root = mkdtempSync(join(tmpdir(), "memory-admits-"));
    const outside = mkdtempSync(join(tmpdir(), "memory-outside-"));
    mkdirSync(join(root, "config"));
    mkdirSync(join(root, "customer-exports"));
    mkdirSync(join(root, "certs"));
    mkdirSync(join(root, "notes"));
    mkdirSync(join(root, "out"));
    mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(root, ".gitignore"), "config/secrets.yaml\n");
    writeFileSync(join(root, ".cxignore"), "customer-exports/\n");
    writeFileSync(join(root, "config", "secrets.yaml"), "db_password: hunter2\n");
    writeFileSync(join(root, "customer-exports", "q3.md"), "Acme: $1.2M\n");
    writeFileSync(join(root, "certs", "server.key"), "-----BEGIN PRIVATE KEY-----\n");
    writeFileSync(join(root, "node_modules", "pkg", "index.js"), "x\n");
    writeFileSync(join(root, "notes", "memo.md"), "The memo.\n");
    writeFileSync(join(root, "out", "build.md"), "Generated.\n");
    writeFileSync(join(outside, "creds.yml"), "token: OUTSIDE\n");
    symlinkSync(join(outside, "creds.yml"), join(root, "config", "local.yml"));
    symlinkSync(outside, join(root, "linked"));
    expect(memoryAdmits(root, "notes/memo.md")).toBe(true);
    // `out/` is one of the walk's skipped (generated) directories.
    for (const rel of ["config/secrets.yaml", "customer-exports/q3.md", "certs/server.key", "node_modules/pkg/index.js", "out/build.md", "config/local.yml", "linked/creds.yml", "notes/missing.md", "../x.md"]) {
      expect(memoryAdmits(root, rel), rel).toBe(false);
    }
    // A model that cd'd into config/ and wrote the gitignored file: judged
    // from the project, the root .gitignore still keeps it.
    const transcript = [
      user("Change the staging password."),
      ...SEARCHED,
      assistant([toolUse("Bash", { command: "cd config" }, "b1")]),
      toolResult("ok", "b1"),
      assistant([toolUse("Write", { file_path: join(root, "config", "secrets.yaml") }, "w1")]),
      toolResult("ok", "w1"),
      assistant([{ type: "text", text: "Changed." }]),
    ].join("\n");
    const event = JSON.stringify({ session_id: "s", transcript_path: TRANSCRIPT_PATH, cwd: join(root, "config"), stop_hook_active: false });
    const read = (p: string) => (p === TRANSCRIPT_PATH ? transcript : existsSync(p) ? readFileSync(p, "utf8") : null);
    expect(memoryRows(event, read, now, memoryAdmits, root)?.rows.map((r) => r.kind)).toEqual([MEMORY_KIND_ANSWER]);
  });
});

describe("the detached sender", () => {
  it("is this hook's own command line with the event swapped and the rows file named", () => {
    const argv = ["/usr/bin/node", "/opt/cx/dist/cli.js", "hook", "memory", "--server", "code-context", "--db", "https://h/db"];
    expect(memorySendArgv(argv, "/tmp/cx-memory-x/rows.json")).toEqual([
      "/opt/cx/dist/cli.js",
      "hook",
      "memory-send",
      "--server",
      "code-context",
      "--db",
      "https://h/db",
      "--rows-file",
      "/tmp/cx-memory-x/rows.json",
    ]);
    expect(memorySendArgv(["/usr/bin/node", "/opt/cx/dist/cli.js", "hook", "answer-stop"], "f")).toBeNull();
  });

  it("sends the rows and removes their file, and never removes a file the hook did not make", async () => {
    const sent: string[] = [];
    const db = new HostedDb(
      { baseUrl: "https://api.example.test", database: "cx", apiKey: "inf_test_key" },
      {
        coldStartSecs: 0,
        fetch: async (input, init) => {
          sent.push(`${String(input)} ${String(init?.body)}`);
          return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
        },
      },
    );
    const dir = mkdtempSync(join(tmpdir(), "cx-memory-"));
    const rowsFile = join(dir, "rows.json");
    const rows = [{ kind: "answer", question: "q", content: "a", path: null, session_id: "s", created_at: 1 }];
    writeFileSync(rowsFile, JSON.stringify(rows));
    await sendRememberedRows(rowsFile, db);
    expect(sent).toEqual([`https://api.example.test/v1/remember/cx ${JSON.stringify({ data: rows })}`]);
    expect(existsSync(dir)).toBe(false);
    // A path the flag named that is not one of the hook's own rows files.
    const other = mkdtempSync(join(tmpdir(), "not-memory-"));
    const kept = join(other, "rows.json");
    writeFileSync(kept, JSON.stringify(rows));
    await sendRememberedRows(kept, db);
    expect(readFileSync(kept, "utf8")).toBe(JSON.stringify(rows));
  });
});

describe("the memory sender", () => {
  const target = { baseUrl: "https://api.example.test", database: "cx", apiKey: "k" };
  const rows = [{ kind: "answer", question: "q", content: "a", path: null, session_id: "s", created_at: 1 }];
  /** A rows file where the hook leaves one, and its directory. */
  const rowsFile = () => {
    const dir = mkdtempSync(join(tmpdir(), "cx-memory-"));
    const file = join(dir, "rows.json");
    writeFileSync(file, JSON.stringify(rows));
    return { dir, file };
  };
  /** A platform whose features read answers `features`, recording every request. */
  const platform = (features: Response | (() => Promise<Response>)) => {
    const sent: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      sent.push(url.replace("https://api.example.test/v1/", ""));
      if (url.endsWith("/account/features")) return typeof features === "function" ? features() : features.clone();
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    };
    return { sent, fetchImpl };
  };
  const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("sends the rows to an account with the agent routes, then removes the file", async () => {
    const { dir, file } = rowsFile();
    const { sent, fetchImpl } = platform(answer(200, { agent_apis: true }));
    await memorySend(file, target, fetchImpl);
    expect(sent).toEqual(["account/features", "remember/cx"]);
    expect(existsSync(dir)).toBe(false);
  });

  it("sends nothing to an account without them, and removes the file", async () => {
    const { dir, file } = rowsFile();
    const { sent, fetchImpl } = platform(answer(200, { agent_apis: false }));
    await memorySend(file, target, fetchImpl);
    expect(sent).toEqual(["account/features"]);
    expect(existsSync(dir)).toBe(false);
  });

  it("removes the file when the features cannot be read, or there is no platform", async () => {
    for (const features of [answer(404, { error: "no such route" }), answer(503, { error: "starting" }), () => Promise.reject(new Error("network down"))]) {
      const { dir, file } = rowsFile();
      const { sent, fetchImpl } = platform(features);
      await expect(memorySend(file, target, fetchImpl)).rejects.toThrow();
      expect(sent).toEqual(["account/features"]);
      expect(existsSync(dir), String(features)).toBe(false);
    }
    const { dir, file } = rowsFile();
    await memorySend(file, null);
    expect(existsSync(dir)).toBe(false);
  });
});

describe("the tool calls read from a transcript", () => {
  it("carry their inputs, the model's own only", () => {
    const transcript = [
      user("q"),
      assistant([toolUse("Write", { file_path: "/repo/a.md" })]),
      assistant([toolUse("Write", { file_path: "/repo/b.md" })], { isSidechain: true }),
    ].join("\n");
    expect(transcriptToolUses(transcript)).toEqual([{ name: "Write", input: { file_path: "/repo/a.md" } }]);
  });
});
