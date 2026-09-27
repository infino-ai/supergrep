// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// `cx login` - store this machine's Infino account once, so nothing after it
// needs a flag. It writes two files into `~/.infino/`: the bearer key, mode
// 600, and the platform's base URL beside it. `cx install` in any repository
// then needs no arguments at all, and no `.mcp.json` ever names a key or a
// path under someone's home directory.
//
// The key never travels through argv, because argv is readable by every
// process on the machine. It comes from a file (`--api-key-file`), or from
// standard input when this command is piped or redirected. There is no flag
// that takes the value.
//
// Before storing anything the key is used once, against the account's own
// database list. That call is the only thing that can tell the difference
// between a key that works, a key the platform refuses, and an account that
// cannot spend - and storing a key that does not work would move the failure
// to the next agent session, where the person who could fix it is not looking.
//
// `cx login --platform https://host` is the sign-in for someone with no
// account: it asks, then gets a free one and stores it. That is the one step
// of the Claude Code plugin's setup that needs a person - it creates an
// account and agrees to file contents leaving the machine - so it lives in a
// command typed in a terminal, and the plugin's server tells the model to
// hand it to the person rather than run it (core/consent.ts has the rule).
// Once stored, and the upload agreed, the server serves every directory a
// session opens on that account, each in a database of its own.

import { readFileSync } from "node:fs";
import { bold, dim, green, yellow } from "../core/output.js";
import { HostedError, isHostedUrl } from "../core/hosted.js";
import { databaseNameFor, listDatabases, requestTrial, type Trial } from "../core/account-api.js";
import { API_KEY_ENV } from "../core/config.js";
import { askUploadConsent, hasUploadConsent, recordUploadConsent, type ConsentDeps } from "../core/consent.js";
import {
  accountFilePath,
  keyFilePath,
  readStoredAccount,
  readStoredKey,
  removeStoredKey,
  writeStoredAccount,
  writeStoredKey,
  type StoredAccount,
} from "../core/keystore.js";

/** Longest plausible key, as a guard on stdin: anything larger is a file that
 * is not a key (a pasted log, a whole config) and reporting that beats writing
 * it and failing on the next call. */
const MAX_KEY_CHARS = 4096;

/** Environment override for the platform a first sign-in asks for an account,
 * the same one `cx install --platform` reads. */
const PLATFORM_URL_ENV = "CX_PLATFORM_URL";

/** This platform does not offer free accounts. Not a fault - a deployment
 * decision, and the command says so rather than reporting an error. */
const HTTP_NOT_IMPLEMENTED = 501;

/** This client's address has already taken its free trial. */
const HTTP_CONFLICT = 409;

export interface LoginCmdOptions {
  /** The platform, `https://host`. A full `https://host/<database>` is
   * accepted too and the database segment ignored: an account holds many. */
  db?: string;
  /** File holding the key. Without it, the key is read from standard input. */
  apiKeyFile?: string;
  /** Where a human manages billing on this platform, stored for the message
   * shown when the account runs out of credit. */
  consoleUrl?: string;
  /** Forget the stored key. */
  logout?: boolean;
  /** Report what is stored and change nothing. */
  show?: boolean;
  /** Get a free account on this platform (`https://host`; `true` for the one
   * CX_PLATFORM_URL names) instead of storing a key you already have. Asks
   * first. */
  platform?: string | true;
  /** Agree to uploads without being asked, for a sign-in whose key arrives on
   * standard input and so has no terminal to answer on; alone, with a key
   * already stored, it records the agreement and nothing else. */
  yes?: boolean;
}

/** A failure the user can act on; the CLI prints `error: <message>`. */
export class LoginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoginError";
  }
}

/** What the command did, returned so a test can assert it without reading the
 * terminal. */
export interface LoginResult {
  action: "stored" | "created" | "declined" | "agreed" | "logged-out" | "shown" | "nothing-to-forget";
  baseUrl?: string;
  keyPath?: string;
  databases?: string[];
  /** Whether the person at this machine has agreed to uploads, after this
   * command: what the plugin's server needs, beside the key, to serve search
   * and ask in any directory. */
  uploadAgreed?: boolean;
}

/** Injected for tests: the platform, standard input, and the person at the
 * terminal. */
export interface LoginDeps {
  stdin?: () => string;
  fetch?: typeof fetch;
  consent?: ConsentDeps;
}

/** The platform's base URL from what the user gave: a bare origin, or a full
 * database URL whose trailing segment is dropped. */
export function baseUrlFrom(raw: string): string {
  if (!isHostedUrl(raw)) {
    throw new LoginError(`--db must be an http(s) URL naming the platform, e.g. https://host (got ${JSON.stringify(raw)})`);
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch (err) {
    throw new LoginError(`--db is not a URL: ${(err as Error).message}`);
  }
  // A database URL is `https://host/<database>`; anything deeper is not one,
  // and silently keeping only the origin would sign in to a platform the user
  // did not name.
  const segments = url.pathname.split("/").filter((s) => s !== "");
  if (segments.length > 1) {
    throw new LoginError(
      `--db names the platform, not a path inside it: got ${url.pathname}. Use ${url.origin}, or ` +
        `${url.origin}/<database> - one repository's database, whose name is ignored here.`,
    );
  }
  return url.origin;
}

/** The key, from a file or from standard input, never from an argument. */
function readKey(opts: LoginCmdOptions, stdin: () => string): string {
  if (opts.apiKeyFile !== undefined) {
    let text: string;
    try {
      text = readFileSync(opts.apiKeyFile, "utf8");
    } catch (err) {
      throw new LoginError(`cannot read ${opts.apiKeyFile}: ${(err as Error).message}`);
    }
    const key = text.trim();
    if (key === "") throw new LoginError(`${opts.apiKeyFile} is empty - it should hold the API key and nothing else`);
    return key;
  }
  const piped = stdin().trim();
  if (piped === "") {
    throw new LoginError(
      `no key given. Pipe it in - \`cx login --db <url> < keyfile\`, or \`pbpaste | cx login --db <url>\` - ` +
        `or pass --api-key-file <path>. There is deliberately no flag that takes the key itself: ` +
        `arguments are visible to every process on this machine.`,
    );
  }
  if (piped.length > MAX_KEY_CHARS) {
    throw new LoginError(`what arrived on standard input is ${piped.length} characters - that is not an API key`);
  }
  if (/\s/.test(piped)) {
    throw new LoginError("what arrived on standard input has whitespace inside it - an API key does not");
  }
  return piped;
}

/** Read all of standard input, or "" when it is a terminal (nothing piped). */
function stdinText(): string {
  if (process.stdin.isTTY) return "";
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

export async function loginCmd(opts: LoginCmdOptions, deps: LoginDeps = {}): Promise<LoginResult> {
  if (opts.platform !== undefined) return signUp(opts, deps);
  // Standard input is read once: a pipe has one key in it, and the second
  // read of a pipe is empty.
  let piped: string | undefined;
  const stdin = () => (piped ??= (deps.stdin ?? stdinText)());
  if (opts.logout) {
    const had = removeStoredKey();
    if (!had) {
      console.log(`${yellow("nothing to forget")} - no key stored at ${keyFilePath()}`);
      return { action: "nothing-to-forget" };
    }
    console.log(`${green("signed out")} - removed ${keyFilePath()}`);
    console.log(dim(`${accountFilePath()} is kept: it holds the platform URL, not a secret.`));
    return { action: "logged-out" };
  }

  if (opts.show) {
    const account = readStoredAccount();
    if (!account) {
      console.log(`${yellow("not signed in")} - no account at ${accountFilePath()}`);
      return { action: "shown" };
    }
    console.log(`${bold("platform")}  ${account.baseUrl}`);
    if (account.consoleUrl) console.log(`${bold("console")}   ${account.consoleUrl}`);
    console.log(`${bold("key")}       ${keyFilePath()}`);
    if (account.storedAt) console.log(dim(`stored ${account.storedAt}`));
    return { action: "shown", baseUrl: account.baseUrl, keyPath: keyFilePath() };
  }

  const stored = readStoredAccount();
  // `--yes` alone, with an account already stored and no key arriving:
  // record the agreement the earlier sign-in could not ask for.
  if (opts.yes && opts.apiKeyFile === undefined && stdin().trim() === "") {
    if (!stored || readStoredKey() === undefined) {
      throw new LoginError(`--yes agrees to uploads for an account this machine has, and it has none: ${signInHint()}`);
    }
    if (!hasUploadConsent()) recordUploadConsent(new Date().toISOString());
    console.log(`${green("agreed")} - search and ask upload the contents of the directories you use them in, to ${bold(stored.baseUrl)}`);
    return { action: "agreed", baseUrl: stored.baseUrl, keyPath: keyFilePath(), uploadAgreed: true };
  }
  const raw = opts.db ?? stored?.baseUrl;
  if (raw === undefined) {
    throw new LoginError(
      "--db <url> names the platform to sign in to, e.g. --db https://host; or, with no account yet, " +
        `--platform https://host gets a free one (or set ${PLATFORM_URL_ENV})`,
    );
  }
  const baseUrl = baseUrlFrom(raw);
  const apiKey = readKey(opts, stdin);

  // Use the key before storing it, so a key that does not work fails here,
  // in front of the person who can fix it.
  let databases: string[];
  try {
    databases = (await listDatabases({ baseUrl, apiKey }, { fetch: deps.fetch })).map((d) => d.name);
  } catch (err) {
    throw new LoginError(explainVerifyFailure(err, baseUrl));
  }

  const keyPath = writeStoredKey(apiKey);
  // A sign-in to the same platform keeps the agreement already on file; one
  // to another platform does not carry it over - it was given for that one.
  const samePlatform = stored !== undefined && stored.baseUrl.replace(/\/+$/, "") === baseUrl;
  const account: StoredAccount = {
    baseUrl,
    ...(opts.consoleUrl ? { consoleUrl: opts.consoleUrl } : stored?.consoleUrl ? { consoleUrl: stored.consoleUrl } : {}),
    storedAt: new Date().toISOString(),
    ...(samePlatform && stored.uploadConsentAt ? { uploadConsentAt: stored.uploadConsentAt } : {}),
  };
  writeStoredAccount(account);

  console.log(`${green("signed in")} to ${bold(baseUrl)}`);
  console.log(`  key   ${keyPath} ${dim("(mode 600)")}`);
  console.log(`  ${databases.length} database${databases.length === 1 ? "" : "s"} on this account${databases.length ? dim(`: ${databases.join(", ")}`) : ""}`);

  // The upload agreement, which is what turns search and ask on everywhere
  // on this machine. Asked here when there is a terminal to ask on; a key
  // piped in on standard input has taken the terminal, so `--yes` says it,
  // and without either the sign-in stands and the way to agree is printed.
  const agreed = await agreeUploads(baseUrl, opts, deps);
  if (agreed) {
    console.log(dim("search and ask are on in every directory you open with the plugin; `cx install` in a repository writes an entry for other clients."));
  } else {
    console.log(dim(`search and ask stay off until you agree to uploads: \`cx login --yes\` (find and plain sql need nothing).`));
  }
  return { action: "stored", baseUrl, keyPath, databases, uploadAgreed: agreed };
}

/** Obtain or confirm the upload agreement after a key was stored: on file
 * already, `--yes`, or asked at the terminal. False when it could not be
 * asked or was declined. */
async function agreeUploads(baseUrl: string, opts: LoginCmdOptions, deps: LoginDeps): Promise<boolean> {
  if (hasUploadConsent()) return true;
  if (opts.yes) {
    recordUploadConsent(new Date().toISOString());
    return true;
  }
  const outcome = await askUploadConsent(baseUrl, "", "", { ...deps.consent, machine: true });
  return outcome === "granted" || outcome === "already-given";
}

/** `cx login --platform https://host`: ask, then get a free account and store
 * it, agreed. The one path here that creates an account, so the question
 * covers both halves - an account will be made, and the contents of the
 * directories the cloud tools are used in will be uploaded - and it is asked
 * of a person at a terminal: with nobody there the answer is no, and nothing
 * is created. The trial registers one database on the way, this directory's,
 * as `cx install --platform` does; every other directory gets its own the
 * first time a cloud tool is used in it. */
async function signUp(opts: LoginCmdOptions, deps: LoginDeps): Promise<LoginResult> {
  const named = (typeof opts.platform === "string" ? opts.platform : (process.env[PLATFORM_URL_ENV] ?? "")).trim();
  if (named === "") throw new LoginError(`--platform <url> names the platform to get an account on, e.g. --platform https://host (or set ${PLATFORM_URL_ENV})`);
  const baseUrl = baseUrlFrom(named);
  const stored = readStoredAccount();
  if (stored && readStoredKey() !== undefined) {
    const storedHost = stored.baseUrl.replace(/\/+$/, "");
    throw new LoginError(
      `this machine is already signed in to ${storedHost}. --platform only gets a NEW account; to use the one you have, ` +
        `there is nothing to do${hasUploadConsent() ? "" : " but agree to uploads: `cx login --yes`"}. To start over, \`cx login --logout\` first.`,
    );
  }
  const database = databaseNameFor(process.cwd());
  // The person's answer, or no: `--yes` is not honoured here on purpose. A
  // script may agree to uploading a repository it was pointed at (`cx install
  // --yes`); creating an account for somebody is a question only they answer.
  const consent = await askUploadConsent(baseUrl, database, process.cwd(), { ...deps.consent, newAccount: true, machine: true });
  if (consent === "declined") {
    console.log(dim("No account was created and nothing left this machine. find and plain sql work without one."));
    return { action: "declined", baseUrl, uploadAgreed: false };
  }
  if (consent === "no-terminal") {
    throw new LoginError(
      `creating an account uploads file contents, and there is no terminal here to ask on. Run \`cx login --platform ${baseUrl}\` from a terminal.`,
    );
  }
  let trial: Trial;
  try {
    trial = await requestTrial(baseUrl, database, { fetch: deps.fetch });
  } catch (err) {
    throw new LoginError(trialRefusal(err, baseUrl));
  }
  const keyPath = writeStoredKey(trial.apiKey);
  const now = new Date().toISOString();
  writeStoredAccount({
    baseUrl,
    ...(trial.consoleUrl ? { consoleUrl: trial.consoleUrl } : {}),
    storedAt: now,
    uploadConsentAt: now,
  });
  console.log(`${green("created")} a free Infino account on ${bold(baseUrl)} with $${(trial.creditCents / 100).toFixed(2)} of credit`);
  console.log(`  key   ${keyPath} ${dim("(mode 600) - no email, no password, no card. Keep it: it is the only way back into this account.")}`);
  console.log(`  db    ${trial.database} ${dim("(this directory's; every other directory gets its own the first time you use search or ask in it)")}`);
  console.log(dim("Restart your Claude Code session: search and ask are on in every directory you open."));
  return { action: "created", baseUrl, keyPath, databases: [trial.database], uploadAgreed: true };
}

/** Why a trial was not granted, as the next step rather than a status code. */
function trialRefusal(err: unknown, baseUrl: string): string {
  if (err instanceof HostedError && err.status === HTTP_NOT_IMPLEMENTED) {
    return `${baseUrl} does not offer free accounts. With a key from its operator, ${signInHint()}`;
  }
  if (err instanceof HostedError && err.status === HTTP_CONFLICT) {
    return `this machine's network has already used its free trial on ${baseUrl}. Sign in to that account instead: ${signInHint()}`;
  }
  return `could not get an account from ${baseUrl}: ${(err as Error).message}. Try again, or ${signInHint()}`;
}

/** Turn a failed check into the sentence that names the fix. The three that
 * matter are distinguishable on the wire and have nothing to do with each
 * other, so they are never collapsed into "login failed". */
function explainVerifyFailure(err: unknown, baseUrl: string): string {
  if (!(err instanceof HostedError)) return `could not reach ${baseUrl}: ${(err as Error).message}`;
  if (err.unauthenticated) {
    return (
      `${baseUrl} refused that key. It may be revoked, rotated out, or issued by a different ` +
      `platform. Nothing was stored - the previous key, if any, is untouched.`
    );
  }
  if (err.paymentRequired) {
    return (
      `${baseUrl} accepted that key, but the account behind it cannot be used yet: it has no ` +
      `billing details on file. Add them and a card in the console, then run this again. ` +
      `Nothing was stored.`
    );
  }
  if (err.status === 0) return `could not reach ${baseUrl}: ${err.message}`;
  return `${baseUrl} answered ${err.status}: ${err.message}. Nothing was stored.`;
}

/** The one-line hint printed where a key would have been needed and none is
 * stored. Lives here so `cx install` and this command word it the same. */
export function signInHint(): string {
  return `run \`cx login --db <platform-url> --yes < keyfile\` once - it stores the key in ${keyFilePath()} (mode 600) and every directory after that needs no flags. Or set ${API_KEY_ENV} in the client's environment.`;
}
