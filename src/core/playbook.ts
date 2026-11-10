// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// A playbook: bullets a model is told beside the instructions it always
// gets, learned from recorded runs rather than written by hand (ACE, Zhang
// et al., arXiv 2510.04618). Whatever writes the file, this is the client's
// reading of it: the block the outer model gets in the server's
// instructions, and a label naming it. The format is one JSON file:
//   {label, corpus?, bullets: [{id, scope, status, when, text, helpful,
//    harmful, origin}]}
// With no playbook configured nothing here renders anything, so a server
// started without one is byte for byte the server there was before.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** The file to read: a path, or unset for no playbook. `cx mcp --playbook`
 * sets it from the flag. */
export const PLAYBOOK_ENV = "CX_PLAYBOOK";

/** The scope of the bullets the outer model reads; the other scopes
 * (`loop`, `table:<name>`) are for the platform's own loop and never reach
 * it through this client. */
export const SCOPE_OUTER = "outer";

/** A bullet read by the models. */
export const STATUS_ACTIVE = "active";

/** The `when` of a bullet that applies to every question. */
export const WHEN_ALWAYS = "always";

/** The line that opens a rendered block. Kept fixed so a model reads the
 * same block whichever program rendered the playbook. */
export const BLOCK_HEADER = "Playbook (learned from recorded runs; each line names when it applies). Before each step, find the bullets whose situation matches this question and follow them; before the final answer, name the ids you followed:";

export interface PlaybookBullet {
  id: string;
  scope: string;
  status: string;
  when: string;
  text: string;
  helpful: number;
  harmful: number;
  origin: unknown;
}

export interface Playbook {
  label: string;
  corpus?: string;
  bullets: PlaybookBullet[];
}

/** What a configured playbook gives the server: where it was read from, the
 * label the loop is told, and the outer model's block (empty when the
 * playbook holds no active outer bullet). */
export interface ConfiguredPlaybook {
  path: string;
  label: string;
  outerBlock: string;
}

/** Read and check a playbook file. A malformed file is an error naming the
 * bullet and the key: a server that silently read half a playbook would
 * behave as something it was not configured to be. */
export function loadPlaybook(path: string): Playbook {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!parsed || typeof parsed !== "object") throw new Error(`${path}: a playbook is a JSON object`);
  const playbook = parsed as Partial<Playbook>;
  if (typeof playbook.label !== "string" || !playbook.label.trim()) throw new Error(`${path}: a playbook names its label`);
  if (!Array.isArray(playbook.bullets)) throw new Error(`${path}: a playbook holds a bullets array`);
  const seen = new Set<string>();
  for (const bullet of playbook.bullets as Partial<PlaybookBullet>[]) {
    const id = typeof bullet.id === "string" ? bullet.id : "?";
    for (const key of ["id", "scope", "status", "when", "text"] as const) {
      if (typeof bullet[key] !== "string" || !(bullet[key] as string).trim()) throw new Error(`${path}: bullet ${id} lacks ${key}`);
    }
    if (seen.has(id)) throw new Error(`${path}: bullet id ${id} appears twice`);
    seen.add(id);
    if (/\n/.test(bullet.text as string) || /\n/.test(bullet.when as string)) throw new Error(`${path}: bullet ${id}: one line each for when and text`);
  }
  return playbook as Playbook;
}

/** One bullet as a line of the block: its id, when it applies, what to do. */
export function bulletLine(bullet: PlaybookBullet): string {
  const when = bullet.when === WHEN_ALWAYS ? "Always" : `When ${bullet.when}`;
  return `- [${bullet.id}] ${when}: ${bullet.text}`;
}

/** The block a model reads for `scope`: the header and one line per active
 * bullet in id order, so the same file renders to the same bytes; the empty
 * string for a scope with no active bullet. */
export function renderBlock(playbook: Playbook, scope: string): string {
  const lines = playbook.bullets
    .filter((b) => b.status === STATUS_ACTIVE && b.scope === scope)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(bulletLine);
  return lines.length ? [BLOCK_HEADER, ...lines].join("\n") : "";
}

/** `instructions` with `block` after them, or unchanged when the block is
 * empty: the server with no playbook sends exactly the text it sent before. */
export function withPlaybook(instructions: string, block: string): string {
  return block ? `${instructions}\n\n${block}` : instructions;
}

/** The playbook CX_PLAYBOOK names, read once; null with none configured. A
 * file that does not load is an error at startup, like a bad flag, never a
 * server quietly running without it. `onNote` hears what was read. */
export function configuredPlaybook(onNote?: (line: string) => void, env: NodeJS.ProcessEnv = process.env): ConfiguredPlaybook | null {
  const named = (env[PLAYBOOK_ENV] ?? "").trim();
  if (named === "") return null;
  const path = resolve(named);
  const playbook = loadPlaybook(path);
  const outerBlock = renderBlock(playbook, SCOPE_OUTER);
  const outer = playbook.bullets.filter((b) => b.status === STATUS_ACTIVE && b.scope === SCOPE_OUTER).length;
  const loop = playbook.bullets.filter((b) => b.status === STATUS_ACTIVE && b.scope !== SCOPE_OUTER).length;
  onNote?.(`playbook ${playbook.label} from ${path}: ${outer} outer bullet(s) in the instructions, ${loop} loop bullet(s) recalled by label`);
  return { path, label: playbook.label, outerBlock };
}
