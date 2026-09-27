// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// Asking whether indexed content may leave the machine.
//
// The three local tools read an index on this disk and send nothing anywhere.
// The two cloud tools need the same index on a platform database, which means
// the repository's content - the code itself, not metadata about it - is
// uploaded. That is a decision for the person at the keyboard, and this is
// where they make it.
//
// Two rules shape the wording and the placement:
//
// The agent must never be the one who agrees. An MCP client already prompts
// the human before it runs a tool, but the model can retry, rephrase and
// answer its own way around a question posed inside a tool result - and it has
// no standing to agree to uploading someone's employer's source. So the
// question is asked by a command a person typed in their own terminal, and if
// nobody is at the terminal the answer is no.
//
// It has to say what actually leaves, not "data". Someone who reads "sends
// data to Infino" hears telemetry; what is sent is the file contents. The gap
// between what a person thinks they agreed to and what happened is the whole
// of the harm here, so the text names it.

import { createInterface } from "node:readline";
import { bold, dim, yellow } from "./output.js";
import { keyFilePath, readStoredAccount, writeStoredAccount } from "./keystore.js";

/** What is disclosed before anything is uploaded. Written to be read once, by
 * someone who did not go looking for it.
 *
 * `newAccount` adds the second thing being agreed to when this machine has no
 * account yet: one will be created. That is a separate fact from the upload
 * and it belongs in the same breath - somebody who would say yes to indexing
 * might still not want an account made for them. */
export function consentNotice(baseUrl: string, database: string, root: string, newAccount = false): string {
  const lines = [
    `${bold("The cloud tools upload this repository's contents.")}`,
    ``,
    `  ask runs on ${baseUrl}, over a copy of the index kept there.`,
    `  Building that copy sends the ${bold("text of the files")} under ${root} - the code`,
    `  itself, not just names or metrics - into the database ${bold(database)}.`,
    `  Every later sync sends what changed.`,
    ``,
  ];
  return noticeTail(lines, newAccount);
}

/** The same disclosure for a sign-in that covers the whole machine rather
 * than one repository (`cx login`): with an account stored and this agreed,
 * the server the Claude Code plugin runs serves every directory a session
 * opens, each on its own database, with nothing written anywhere - so what
 * is agreed to here is the contents of each of those directories, the first
 * time a cloud tool is used in it. Said in those words: a person who agrees
 * to "this repository" has not agreed to the next one. */
export function machineConsentNotice(baseUrl: string, newAccount = false): string {
  const lines = [
    `${bold("The cloud tools upload the contents of the directories you use them in.")}`,
    ``,
    `  search and ask run on ${baseUrl}, over a copy of each directory's index kept there.`,
    `  The first time you use them in a directory, its ${bold("text of the files")} - the code`,
    `  itself, not just names or metrics - goes into a database of its own there,`,
    `  named after the directory. Every later sync sends what changed. No directory`,
    `  is uploaded until you use search or ask in it.`,
    ``,
  ];
  return noticeTail(lines, newAccount);
}

/** The part of the notice both scopes share: the account, when one will be
 * made, and what stays local either way. */
function noticeTail(lines: string[], newAccount: boolean): string {
  if (newAccount) {
    lines.push(
      `  This machine has no Infino account, so one will be ${bold("created for you")} -`,
      `  no email, no password and no card - with free credit to start on. Its`,
      `  key is stored at ${keyFilePath()}, readable only by you.`,
      `  When the credit runs out, ask stops and says so; adding`,
      `  billing details then is a choice, not a renewal you have agreed to.`,
      ``,
    );
  }
  lines.push(
    `  find and plain sql do not upload anything. They read the index on`,
    `  this disk, and they keep working if you say no.`,
    ``,
    dim(`  If this code is not yours to upload, say no. You can enable it later`),
    dim(`  with \`cx install\` or \`cx login\`, or never, and the local tools are unaffected.`),
  );
  return lines.join("\n");
}

/** Whether this machine has already agreed. */
export function hasUploadConsent(): boolean {
  return readStoredAccount()?.uploadConsentAt !== undefined;
}

/** Record the agreement, so it is asked once per machine rather than once per
 * checkout. Returns false when there is no account to record it against. */
export function recordUploadConsent(at: string): boolean {
  const account = readStoredAccount();
  if (!account) return false;
  writeStoredAccount({ ...account, uploadConsentAt: at });
  return true;
}

/** Why consent was not obtained, for a caller that has to explain itself. */
export type ConsentOutcome = "already-given" | "granted" | "declined" | "no-terminal";

export interface ConsentDeps {
  /** Ask the question and return the raw answer. Injected by tests. */
  ask?: (prompt: string) => Promise<string>;
  /** Whether a person is present to answer. */
  interactive?: boolean;
  /** Clock, so a test can assert the recorded timestamp. */
  now?: () => Date;
  /** Whether agreeing also creates an account, which the notice must say. */
  newAccount?: boolean;
  /** Whether the agreement covers every directory the cloud tools are used
   * in on this machine (`cx login`) rather than the one repository being
   * installed; the notice then says so (`machineConsentNotice`). */
  machine?: boolean;
}

/** Obtain consent for uploading `root` to `database` on `baseUrl`, printing
 * the notice first unless it has already been given.
 *
 * With nobody at the terminal the answer is no, not "assume yes": this runs
 * inside `cx install`, which a CI job or a dotfiles script may run
 * unattended, and an unattended default of yes would upload a repository
 * nobody chose to upload. `--yes` is how a script says yes on purpose. */
export async function askUploadConsent(
  baseUrl: string,
  database: string,
  root: string,
  deps: ConsentDeps = {},
): Promise<ConsentOutcome> {
  if (hasUploadConsent()) return "already-given";

  const interactive = deps.interactive ?? (process.stdin.isTTY === true && process.stdout.isTTY === true);
  if (!interactive) return "no-terminal";

  const machine = deps.machine === true;
  console.log(machine ? machineConsentNotice(baseUrl, deps.newAccount === true) : consentNotice(baseUrl, database, root, deps.newAccount === true));
  console.log("");
  const what = machine ? "the contents of the directories you use search and ask in" : "this repository's contents";
  const question = deps.newAccount === true ? `Create a free Infino account and upload ${what}? [y/N] ` : `Upload ${what} to Infino? [y/N] `;
  const answer = (await (deps.ask ?? promptStdin)(question)).trim().toLowerCase();
  if (answer !== "y" && answer !== "yes") {
    console.log(yellow("Not uploading."));
    return "declined";
  }
  // Recorded only when there is an account to record it against. With none
  // yet, the caller records it after provisioning - so a trial that fails
  // does not leave consent on file for an account that never existed.
  recordUploadConsent((deps.now ?? (() => new Date()))().toISOString());
  return "granted";
}

/** Read one line from the terminal. */
function promptStdin(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}
