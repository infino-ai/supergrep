// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// A final answer's figures are checked against the turn's tool results, and a
// figure none of them holds sends the model back once to compute it.

import { describe, expect, it } from "vitest";
import { hookFiguresOutput, transcriptReplyAndResults } from "../src/commands/hook-cmd.js";
import {
  figuresIn,
  figuresReason,
  finalAnswerPart,
  namesUncomputedReading,
  toolValues,
  UNCOMPUTED_READING_REASON,
  unbackedFigures,
} from "../src/core/answer-figures.js";

/** One transcript line as Claude Code writes it. */
const line = (entry: Record<string, unknown>) => JSON.stringify(entry);
const user = (text: string) => line({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });
const toolResult = (text: string) => line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: text }] } });
const assistant = (blocks: Array<Record<string, unknown>>) => line({ type: "assistant", message: { role: "assistant", content: blocks } });
const sqlCall = assistant([{ type: "tool_use", id: "t1", name: "mcp__code-context__sql", input: { query: "SELECT ..." } }]);
const stopEvent = (transcript: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ hook_event_name: "Stop", transcript_path: "/t.jsonl", ...extra, _t: transcript.length });
const reader = (transcript: string) => (path: string) => (path === "/t.jsonl" ? transcript : null);

/** A table question from a public document benchmark: the receipts table read right (cents after a
 * space, as the scan prints them), the average computed by hand. */
const TABLE = "1792 | 3,443,070 85 | $208,942 81 | 1793 | 4,255,306 56 | 337,705 70 | 1799 | 6,610,449 31 | 779,136 44";
const HAND_REPLY = "The final EMA for CY 1799 is about $7,046,002.04.\n\n<FINAL_ANSWER>7046002.04</FINAL_ANSWER>";

describe("the figures of a final answer", () => {
  it("reads numbers as written: grouping, sign, dollars, percent, and a list's items apart", () => {
    expect(figuresIn("[5, 56.30]").map((f) => f.value)).toEqual([5, 56.3]);
    expect(figuresIn("$7,046,001.98").map((f) => [f.value, f.decimals])).toEqual([[7046001.98, 2]]);
    expect(figuresIn("-24.32%").map((f) => [f.value, f.percent])).toEqual([[-24.32, true]]);
    expect(toolValues("3,443,070 85")).toContain(3443070.85);
  });

  it("checks the tagged answer when there is one, else the last line", () => {
    expect(finalAnswerPart(HAND_REPLY)).toBe("7046002.04");
    expect(finalAnswerPart("Working.\nThe total is 12.5.")).toBe("The total is 12.5.");
  });

  it("flags a figure no tool result holds, and backs one a statement returned", () => {
    expect(unbackedFigures(HAND_REPLY, toolValues(TABLE))).toEqual(["7046002.04"]);
    expect(unbackedFigures(HAND_REPLY, toolValues('{"rows":[{"yr":1799,"ema":7046002.04}]}'))).toEqual([]);
    // Read straight from the scanned table, cents after a space.
    expect(unbackedFigures("<FINAL_ANSWER>$3,443,070.85</FINAL_ANSWER>", toolValues(TABLE))).toEqual([]);
  });

  it("backs a rounded figure, a percent stated as its fraction, and either sign", () => {
    expect(unbackedFigures("<FINAL_ANSWER>0.1346</FINAL_ANSWER>", [0.134612])).toEqual([]);
    expect(unbackedFigures("<FINAL_ANSWER>18.67%</FINAL_ANSWER>", [0.186712])).toEqual([]);
    expect(unbackedFigures("<FINAL_ANSWER>-24.32%</FINAL_ANSWER>", [24.32])).toEqual([]);
    expect(unbackedFigures("<FINAL_ANSWER>0.1347</FINAL_ANSWER>", [0.134612])).toEqual(["0.1347"]);
  });

  it("leaves small counts and years alone", () => {
    expect(unbackedFigures("<FINAL_ANSWER>[1865, 13]</FINAL_ANSWER>", [])).toEqual([]);
    expect(unbackedFigures("<FINAL_ANSWER>[1,865]</FINAL_ANSWER>", [])).toEqual(["1,865"]);
  });

  it("names the figures and the way to compute them", () => {
    const reason = figuresReason(["7046002.04"]);
    expect(reason).toContain("7046002.04");
    expect(reason).toContain("CAST(x AS DECIMAL(38,6))");
    expect(reason).toContain("CAST(x AS DOUBLE)");
  });
});

describe("cx hook answer-figures", () => {
  const ranByHand = [user("question"), sqlCall, toolResult(TABLE), assistant([{ type: "text", text: HAND_REPLY }])].join("\n");

  it("reads the final reply after the last tool result, and every result", () => {
    const { reply, results } = transcriptReplyAndResults(ranByHand);
    expect(reply).toBe(HAND_REPLY);
    expect(results).toEqual([TABLE]);
  });

  it("sends the model back once to compute a figure it worked out by hand", () => {
    const output = JSON.parse(hookFiguresOutput(stopEvent(ranByHand), reader(ranByHand))!);
    expect(output.decision).toBe("block");
    expect(output.reason).toBe(figuresReason(["7046002.04"]));
  });

  it("sends the model back to compute a reading it named and did not, as a reply that names a reading and leaves it uncomputed", () => {
    expect(namesUncomputedReading("If you add Panama Canal disbursements to 1909 ... I did not compute that variant.")).toBe(true);
    expect(namesUncomputedReading("If you instead take the literal ratio of receipt change to deficit change")).toBe(true);
    expect(namesUncomputedReading("The total is 12.5, computed with sql.")).toBe(false);
    const flagged = [
      user("question"),
      sqlCall,
      toolResult('{"rows":[{"g":1.0093}]}'),
      assistant([{ type: "text", text: "I did not compute that variant.\n<FINAL_ANSWER>1.0093</FINAL_ANSWER>" }]),
    ].join("\n");
    const output = JSON.parse(hookFiguresOutput(stopEvent(flagged), reader(flagged))!);
    expect(output).toEqual({ decision: "block", reason: UNCOMPUTED_READING_REASON });
    // Both reasons when both apply, in one send-back.
    const both = [user("question"), sqlCall, toolResult(TABLE), assistant([{ type: "text", text: `I did not compute that variant.\n${HAND_REPLY}` }])].join("\n");
    expect(JSON.parse(hookFiguresOutput(stopEvent(both), reader(both))!).reason).toBe(`${figuresReason(["7046002.04"])} ${UNCOMPUTED_READING_REASON}`);
  });

  it("lets the model stop when every figure is backed, after one send-back, or when it never retrieved", () => {
    const computed = [
      user("question"),
      sqlCall,
      toolResult(TABLE),
      sqlCall,
      toolResult('{"rows":[{"yr":1799,"ema":7046001.98}]}'),
      assistant([{ type: "text", text: "<FINAL_ANSWER>7046001.98</FINAL_ANSWER>" }]),
    ].join("\n");
    expect(hookFiguresOutput(stopEvent(computed), reader(computed))).toBeNull();
    expect(hookFiguresOutput(stopEvent(ranByHand, { stop_hook_active: true }), reader(ranByHand))).toBeNull();
    const noRetrieval = [user("question"), assistant([{ type: "text", text: HAND_REPLY }])].join("\n");
    expect(hookFiguresOutput(stopEvent(noRetrieval), reader(noRetrieval))).toBeNull();
    expect(hookFiguresOutput("not json", reader(ranByHand))).toBeNull();
  });
});
