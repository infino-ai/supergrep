// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// Every set of instructions the server sends ends its habits with the task
// checklist: list every explicit ask of the task and check the draft against
// it before answering. In a legal-document benchmark's practice-area run (2026-10-08) an
// ask never addressed, or a structure the task named and the deliverable
// lacked, was 36% of the score lost.
import { describe, expect, it } from "vitest";
import { TASK_CHECKLIST_SENTENCE, withListedNames, withTaskChecklist } from "../src/mcp/server.js";

describe("the task checklist", () => {
  it("follows the instructions it is given, before the listed-names line", () => {
    const text = withListedNames(withTaskChecklist("Which tool for which question: ..."));
    const lines = text.split("\n");
    expect(lines[0]).toBe("Which tool for which question: ...");
    expect(lines[1]).toBe(TASK_CHECKLIST_SENTENCE);
    expect(lines).toHaveLength(3);
  });

  it("names the asks a deliverable is graded on", () => {
    for (const ask of ["deliverable", "file name", "addressed to", "section", "rating", "question"]) {
      expect(TASK_CHECKLIST_SENTENCE).toContain(ask);
    }
  });
});
