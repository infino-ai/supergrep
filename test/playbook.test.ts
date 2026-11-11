// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The client's reading of a playbook: a file loads and is checked, the
// outer block renders in id order to the same bytes, a server with no
// playbook configured sends exactly the instructions it sent before, and
// the configured playbook carries the label the loop is told.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BLOCK_HEADER,
  PLAYBOOK_ENV,
  SCOPE_OUTER,
  configuredPlaybook,
  loadPlaybook,
  renderBlock,
  withPlaybook,
} from "../src/core/playbook.js";

const bullet = (id: string, scope: string, extra: Record<string, unknown> = {}) => ({
  id,
  scope,
  status: "active",
  when: "a figure is reported in several editions",
  text: "Take the latest edition's value and say which edition it is from.",
  helpful: 0,
  harmful: 0,
  origin: { label: "officeqa-foldA-e1", uids: ["24"], cause: "edition" },
  ...extra,
});

const sample = () => ({
  label: "officeqa-foldA-e1",
  corpus: "officeqa",
  bullets: [
    bullet("O002", SCOPE_OUTER),
    bullet("O001", SCOPE_OUTER, { when: "always", text: "Run the statement before submitting." }),
    bullet("L001", "loop"),
    bullet("O003", SCOPE_OUTER, { status: "retired" }),
  ],
});

function written(playbook: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "cx-playbook-"));
  const path = join(dir, "playbook.json");
  writeFileSync(path, JSON.stringify(playbook));
  return path;
}

describe("playbook", () => {
  it("loads a file and refuses a hole", () => {
    expect(loadPlaybook(written(sample())).bullets).toHaveLength(4);
    expect(() => loadPlaybook(written({ ...sample(), label: "" }))).toThrow(/label/);
    expect(() => loadPlaybook(written({ ...sample(), bullets: [bullet("O001", SCOPE_OUTER, { text: "" })] }))).toThrow(/text/);
    expect(() => loadPlaybook(written({ ...sample(), bullets: [bullet("O001", SCOPE_OUTER), bullet("O001", SCOPE_OUTER)] }))).toThrow(/twice/);
    expect(() => loadPlaybook(written({ ...sample(), bullets: [bullet("O001", SCOPE_OUTER, { text: "two\nlines" })] }))).toThrow(/one line/);
  });

  it("renders the outer block in id order, active bullets only, byte for byte", () => {
    const block = renderBlock(sample(), SCOPE_OUTER);
    expect(block).toBe(
      [
        BLOCK_HEADER,
        "- [O001] Always: Run the statement before submitting.",
        "- [O002] When a figure is reported in several editions: Take the latest edition's value and say which edition it is from.",
      ].join("\n"),
    );
    expect(renderBlock({ ...sample(), bullets: [...sample().bullets].reverse() }, SCOPE_OUTER)).toBe(block);
    expect(renderBlock(sample(), "table:elsewhere")).toBe("");
    expect(block).not.toContain("O003");
    expect(block).not.toContain("L001");
  });

  it("leaves instructions untouched with no block, and appends one after a blank line", () => {
    const instructions = "Which tool for which question:\n- ask - ...";
    expect(withPlaybook(instructions, "")).toBe(instructions);
    expect(withPlaybook(instructions, "Playbook:\n- [O001] Always: x")).toBe(`${instructions}\n\nPlaybook:\n- [O001] Always: x`);
  });

  it("is configured by CX_PLAYBOOK alone, and says what it read", () => {
    const notes: string[] = [];
    expect(configuredPlaybook((l) => notes.push(l), {})).toBeNull();
    expect(configuredPlaybook((l) => notes.push(l), { [PLAYBOOK_ENV]: "  " })).toBeNull();
    expect(notes).toEqual([]);
    const path = written(sample());
    const configured = configuredPlaybook((l) => notes.push(l), { [PLAYBOOK_ENV]: path });
    expect(configured?.label).toBe("officeqa-foldA-e1");
    expect(configured?.path).toBe(path);
    expect(configured?.outerBlock).toBe(renderBlock(sample(), SCOPE_OUTER));
    expect(notes).toEqual([`playbook officeqa-foldA-e1 from ${path}: 2 outer bullet(s) in the instructions, 1 loop bullet(s) recalled by label`]);
    expect(() => configuredPlaybook(undefined, { [PLAYBOOK_ENV]: join(path, "missing.json") })).toThrow();
  });
});
