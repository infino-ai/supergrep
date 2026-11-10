// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// What the Stop hooks read from a Claude Code session transcript: the
// model's own tool calls since the person's question.

import { describe, expect, it } from "vitest";
import { transcriptToolCalls } from "../src/commands/hook-cmd.js";

/** One transcript line as Claude Code writes it. */
const line = (entry: Record<string, unknown>) => JSON.stringify(entry);
const user = (text: string, extra: Record<string, unknown> = {}) => line({ type: "user", message: { role: "user", content: [{ type: "text", text }] }, ...extra });
const toolResult = (text: string) => line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: text }] } });
const assistant = (blocks: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) =>
  line({ type: "assistant", message: { role: "assistant", content: blocks }, ...extra });

const TRANSCRIPT = [
  user("How is a bool query scored?"),
  assistant([{ type: "text", text: "Earlier answer about scoring." }]),
  user("How does a refresh differ from a flush?"),
  assistant([
    { type: "text", text: "Let me look at both paths." },
    { type: "tool_use", id: "t1", name: "mcp__code-context__search", input: { query: "refresh" } },
  ]),
  toolResult("{\"hits\":[]}"),
  assistant([{ type: "tool_use", id: "t2", name: "mcp__code-context__find", input: { query: "flush" } }], { isSidechain: true }),
  assistant([{ type: "text", text: "Refresh makes documents visible; flush makes them durable." }]),
  "",
].join("\n");

describe("the tool calls of a turn", () => {
  it("lists the model's own tool calls since the last question, not a subagent's", () => {
    expect(transcriptToolCalls(TRANSCRIPT)).toEqual(["mcp__code-context__search"]);
    expect(transcriptToolCalls("")).toEqual([]);
  });
});
