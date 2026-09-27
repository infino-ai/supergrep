// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The stored account standing in for `--db`: the shape the Claude Code plugin
// runs in, one MCP entry for every project. Three properties are the point:
// nothing changes for a command that names `--db` or has no account; a
// stored key alone is not enough - the person has to have agreed to uploads;
// and on the account every repository gets its own database, named as `cx
// install` would name it.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Connection } from "@infino-ai/infino";
import { API_KEY_ENV, accountTargetFor, hostedSettingsFromFlags } from "../src/core/config.js";
import { writeStoredAccount, writeStoredKey } from "../src/core/keystore.js";
import { RepoRegistry } from "../src/mcp/repos.js";
import { noAccountSteps } from "../src/mcp/server.js";

const KEY = "inf_0123456789abcdef_deadbeefdeadbeefdeadbeefdeadbeef";
const PLATFORM = "https://platform.example";
const ROOT = "/home/dev/my.project";

beforeEach(() => {
  process.env.CX_ACCOUNT_DIR = join(mkdtempSync(join(tmpdir(), "cx-account-")), "account");
  delete process.env[API_KEY_ENV];
  delete process.env.CX_PLATFORM_URL;
});

afterEach(() => {
  delete process.env.CX_ACCOUNT_DIR;
  delete process.env.CX_PLATFORM_URL;
});

/** A machine signed in and agreed, or signed in only. */
function signedIn(agreed: boolean): void {
  writeStoredKey(KEY);
  writeStoredAccount({ baseUrl: PLATFORM, storedAt: "2026-09-27T00:00:00Z", ...(agreed ? { uploadConsentAt: "2026-09-27T00:00:00Z" } : {}) });
}

describe("the platform settings without --db", () => {
  it("are null with no account, as they always were", () => {
    expect(hostedSettingsFromFlags({}, {}, undefined, { accountRoot: ROOT })).toBeNull();
  });

  it("are null when the command names no repository, even on an agreed account", () => {
    signedIn(true);
    expect(hostedSettingsFromFlags({}, {})).toBeNull();
  });

  it("stay null on a stored key the person never agreed uploads for", () => {
    signedIn(false);
    expect(hostedSettingsFromFlags({}, {}, undefined, { accountRoot: ROOT })).toBeNull();
  });

  it("serve the repository's own database on the agreed account, and say the account they came from", () => {
    signedIn(true);
    const settings = hostedSettingsFromFlags({}, {}, undefined, { accountRoot: ROOT });
    expect(settings?.target).toEqual({ baseUrl: PLATFORM, database: "my-project", apiKey: KEY });
    expect(settings?.account).toEqual({ baseUrl: PLATFORM, apiKey: KEY });
    expect(settings?.embedProvider).toBe("platform");
  });

  it("let the environment's key stand in for the stored one, as --db does", () => {
    signedIn(true);
    const settings = hostedSettingsFromFlags({}, { [API_KEY_ENV]: "inf_from_env" }, undefined, { accountRoot: ROOT });
    expect(settings?.target.apiKey).toBe("inf_from_env");
  });

  it("take the platform flags an account-mode server is started with", () => {
    signedIn(true);
    const settings = hostedSettingsFromFlags({ embedProvider: "local", dbTimeoutMs: "5000" }, {}, undefined, { accountRoot: ROOT });
    expect(settings?.embedProvider).toBe("local");
    expect(settings?.timeoutMs).toBe(5000);
  });

  it("still refuse a platform flag with neither --db nor an account", () => {
    expect(() => hostedSettingsFromFlags({ embedProvider: "local" }, {}, undefined, { accountRoot: ROOT })).toThrow(/needs --db/);
  });

  it("are the named database when --db is given, account or not", () => {
    signedIn(true);
    const settings = hostedSettingsFromFlags({ db: `${PLATFORM}/named` }, {}, undefined, { accountRoot: ROOT });
    expect(settings?.target.database).toBe("named");
    expect(settings?.account).toBeUndefined();
  });
});

describe("a repository's database on the account", () => {
  it("is named from its directory as install names it", () => {
    const account = { baseUrl: PLATFORM, apiKey: KEY };
    expect(accountTargetFor(account, "/repos/web app")).toEqual({ baseUrl: PLATFORM, database: "web-app", apiKey: KEY });
    expect(accountTargetFor(account, "/repos/.dotfiles").database).toBe("dotfiles");
  });
});

describe("RepoRegistry on the account", () => {
  const fakeConn = (dir: string) => ({ __dir: dir } as unknown as Connection);
  const A = "/repos/alpha";
  const B = "/repos/beta";
  const never = (async () => {
    throw new Error("the registry must not make requests");
  }) as unknown as typeof fetch;

  function registry(account: boolean) {
    return new RepoRegistry(A, {
      connect: fakeConn,
      stat: () => ({ isDirectory: () => true }),
      hosted: { target: { baseUrl: PLATFORM, database: "alpha", apiKey: KEY }, options: { fetch: never } },
      ...(account ? { account: { baseUrl: PLATFORM, apiKey: KEY } } : {}),
    });
  }

  it("gives every root its own client, on its own database", () => {
    const r = registry(true);
    expect(r.get(A).hosted?.target.database).toBe("alpha");
    expect(r.get(B).hosted?.target.database).toBe("beta");
    expect(r.get(B).hostedMemo).toEqual({ ready: false });
  });

  it("keeps a --db server as it was: the default root alone carries the client", () => {
    const r = registry(false);
    expect(r.get(A).hosted?.target.database).toBe("alpha");
    expect(r.get(B).hosted).toBeUndefined();
  });
});

describe("what a server with no account says", () => {
  it("names the tools that are off and on, and the person's one command", () => {
    const steps = noAccountSteps();
    expect(steps).toMatch(/search and ask are off/);
    expect(steps).toMatch(/find, sql and read run on the local index/);
    expect(steps).toMatch(/npx -y @infino-ai\/code-context login --platform/);
    expect(steps).toMatch(/the person - not you/);
    expect(steps).toMatch(/Do not run that command yourself/);
  });

  it("names the platform the deployment configured, and never a key", () => {
    process.env.CX_PLATFORM_URL = "https://deployed.example";
    expect(noAccountSteps()).toContain("--platform https://deployed.example");
    expect(noAccountSteps()).not.toMatch(/inf_/);
  });
});
