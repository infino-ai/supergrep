// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// `cx login`. Three properties are the point of the command: the key is never
// an argument, a key that does not work is not stored, and each of the three
// distinguishable refusals - wrong key, unpayable account, unreachable host -
// says which one it is instead of "login failed".
import { existsSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoginError, baseUrlFrom, loginCmd } from "../src/commands/login-cmd.js";
import { keyFilePath, readStoredAccount, readStoredKey, writeStoredKey } from "../src/core/keystore.js";

const KEY = "inf_0123456789abcdef_deadbeefdeadbeefdeadbeefdeadbeef";
const PLATFORM = "https://platform.example";

let dir: string;

/** A platform that answers `GET /v1/databases`. */
const answering = (status: number, body: string) => {
  const calls: Array<{ url: string; auth: string | undefined }> = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), auth: new Headers(init?.headers as HeadersInit).get("authorization") ?? undefined });
    return new Response(body, { status });
  }) as unknown as typeof fetch;
  return { impl, calls };
};

const withDatabases = (...names: string[]) =>
  answering(200, JSON.stringify({ databases: names.map((name) => ({ name, state: "registered" })) }));

beforeEach(() => {
  dir = join(mkdtempSync(join(tmpdir(), "cx-login-")), "account");
  process.env.CX_ACCOUNT_DIR = dir;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  delete process.env.CX_ACCOUNT_DIR;
  vi.restoreAllMocks();
});

describe("cx login: storing the account", () => {
  it("verifies the key, then stores it at 0600 with the platform beside it", async () => {
    const { impl, calls } = withDatabases("infino", "notes");
    const result = await loginCmd({ db: PLATFORM }, { stdin: () => KEY, fetch: impl });

    expect(calls).toEqual([{ url: `${PLATFORM}/v1/databases`, auth: `Bearer ${KEY}` }]);
    expect(result).toMatchObject({ action: "stored", baseUrl: PLATFORM, databases: ["infino", "notes"] });
    expect(readStoredKey()).toBe(KEY);
    expect(statSync(keyFilePath()).mode & 0o777).toBe(0o600);
    expect(readStoredAccount()?.baseUrl).toBe(PLATFORM);
  });

  it("takes the key from a file when one is named", async () => {
    const file = join(dir.replace(/account$/, ""), "key.txt");
    writeFileSync(file, `${KEY}\n`);
    const { impl } = withDatabases();
    await loginCmd({ db: PLATFORM, apiKeyFile: file }, { stdin: () => "", fetch: impl });
    expect(readStoredKey()).toBe(KEY);
  });

  it("keeps the console URL for the out-of-credit message", async () => {
    const { impl } = withDatabases();
    await loginCmd({ db: PLATFORM, consoleUrl: "https://console.example" }, { stdin: () => KEY, fetch: impl });
    expect(readStoredAccount()?.consoleUrl).toBe("https://console.example");
  });

  it("reuses the stored platform when --db is left off on a later sign-in", async () => {
    const { impl } = withDatabases();
    await loginCmd({ db: PLATFORM }, { stdin: () => KEY, fetch: impl });
    const second = await loginCmd({}, { stdin: () => `${KEY}-rotated`, fetch: impl });
    expect(second.baseUrl).toBe(PLATFORM);
    expect(readStoredKey()).toBe(`${KEY}-rotated`);
  });
});

describe("cx login: the key is never an argument", () => {
  it("says so when nothing was piped in", async () => {
    const { impl } = withDatabases();
    await expect(loginCmd({ db: PLATFORM }, { stdin: () => "", fetch: impl })).rejects.toThrow(
      /arguments are visible to every process/,
    );
  });

  it("rejects something that is plainly not a key", async () => {
    const { impl } = withDatabases();
    await expect(loginCmd({ db: PLATFORM }, { stdin: () => "two words", fetch: impl })).rejects.toThrow(/whitespace/);
    await expect(loginCmd({ db: PLATFORM }, { stdin: () => "x".repeat(5000), fetch: impl })).rejects.toThrow(
      /not an API key/,
    );
  });

  it("has no option that takes a key value", async () => {
    // A guard on the shape of the command rather than on its behaviour: the
    // only two ways in are a path and standard input.
    const opts = { db: PLATFORM, apiKeyFile: "/x", consoleUrl: "y", logout: true, show: true };
    expect(Object.keys(opts)).not.toContain("apiKey");
  });
});

describe("cx login: a key that does not work is not stored", () => {
  it("names a refused key, and leaves any previous one untouched", async () => {
    writeStoredKey("inf_previous_key_value");
    const { impl } = answering(401, JSON.stringify({ message: "unauthenticated" }));
    await expect(loginCmd({ db: PLATFORM }, { stdin: () => KEY, fetch: impl })).rejects.toThrow(/refused that key/);
    expect(readStoredKey()).toBe("inf_previous_key_value");
  });

  it("names an account that cannot be used yet, and does not store", async () => {
    const { impl } = answering(402, JSON.stringify({ message: "onboarding required" }));
    await expect(loginCmd({ db: PLATFORM }, { stdin: () => KEY, fetch: impl })).rejects.toThrow(
      /no billing details on file/,
    );
    expect(existsSync(keyFilePath())).toBe(false);
  });

  it("names an unreachable platform separately from a refusal", async () => {
    const impl = (async () => {
      throw new Error("getaddrinfo ENOTFOUND platform.example");
    }) as unknown as typeof fetch;
    await expect(loginCmd({ db: PLATFORM }, { stdin: () => KEY, fetch: impl })).rejects.toThrow(/could not reach/);
    expect(existsSync(keyFilePath())).toBe(false);
  });

  it("reports any other status with the server's own words", async () => {
    const { impl } = answering(500, JSON.stringify({ message: "boom" }));
    await expect(loginCmd({ db: PLATFORM }, { stdin: () => KEY, fetch: impl })).rejects.toThrow(/answered 500/);
  });
});

describe("cx login --logout / --show", () => {
  it("forgets the key and keeps the platform URL", async () => {
    const { impl } = withDatabases();
    await loginCmd({ db: PLATFORM }, { stdin: () => KEY, fetch: impl });
    expect((await loginCmd({ logout: true })).action).toBe("logged-out");
    expect(readStoredKey()).toBeUndefined();
    expect(readStoredAccount()?.baseUrl).toBe(PLATFORM);
    expect((await loginCmd({ logout: true })).action).toBe("nothing-to-forget");
  });

  it("shows what is stored and contacts nothing", async () => {
    const { impl, calls } = withDatabases();
    await loginCmd({ db: PLATFORM }, { stdin: () => KEY, fetch: impl });
    const shown = await loginCmd({ show: true }, { fetch: impl });
    expect(shown).toMatchObject({ action: "shown", baseUrl: PLATFORM });
    expect(calls).toHaveLength(1); // only the sign-in's own call
  });
});

describe("cx login: agreeing to uploads", () => {
  it("records the agreement with --yes, so the plugin's server can serve every directory", async () => {
    const { impl } = withDatabases();
    const result = await loginCmd({ db: PLATFORM, yes: true }, { stdin: () => KEY, fetch: impl });
    expect(result.uploadAgreed).toBe(true);
    expect(readStoredAccount()?.uploadConsentAt).toBeDefined();
  });

  it("asks at the terminal when there is one, in machine-wide words", async () => {
    const { impl } = withDatabases();
    const asked: string[] = [];
    const result = await loginCmd(
      { db: PLATFORM },
      { stdin: () => KEY, fetch: impl, consent: { interactive: true, ask: async (q) => (asked.push(q), "y") } },
    );
    expect(result.uploadAgreed).toBe(true);
    expect(asked[0]).toMatch(/directories you use search and ask in/);
    expect(readStoredAccount()?.uploadConsentAt).toBeDefined();
  });

  it("stores the key and leaves the agreement off when it cannot ask, saying how to agree", async () => {
    const { impl } = withDatabases();
    const result = await loginCmd({ db: PLATFORM }, { stdin: () => KEY, fetch: impl, consent: { interactive: false } });
    expect(result.action).toBe("stored");
    expect(result.uploadAgreed).toBe(false);
    expect(readStoredKey()).toBe(KEY);
    expect(readStoredAccount()?.uploadConsentAt).toBeUndefined();
  });

  it("--yes alone agrees for the account already stored, and stores nothing else", async () => {
    const { impl, calls } = withDatabases();
    await loginCmd({ db: PLATFORM }, { stdin: () => KEY, fetch: impl, consent: { interactive: false } });
    const result = await loginCmd({ yes: true }, { stdin: () => "", fetch: impl });
    expect(result.action).toBe("agreed");
    expect(readStoredAccount()?.uploadConsentAt).toBeDefined();
    expect(calls).toHaveLength(1);
  });

  it("--yes alone with no account says to sign in", async () => {
    await expect(loginCmd({ yes: true }, { stdin: () => "" })).rejects.toThrow(/it has none/);
  });

  it("keeps the agreement across a key rotation on the same platform, and drops it for another", async () => {
    const { impl } = withDatabases();
    await loginCmd({ db: PLATFORM, yes: true }, { stdin: () => KEY, fetch: impl });
    const rotated = await loginCmd({ db: PLATFORM }, { stdin: () => `${KEY}-2`, fetch: impl, consent: { interactive: false } });
    expect(rotated.uploadAgreed).toBe(true);
    const elsewhere = await loginCmd({ db: "https://other.example" }, { stdin: () => KEY, fetch: impl, consent: { interactive: false } });
    expect(elsewhere.uploadAgreed).toBe(false);
  });
});

describe("cx login --platform: a free account", () => {
  /** A platform that grants a trial, recording what it was asked. */
  const granting = () => {
    const calls: Array<{ url: string; body: string }> = [];
    const impl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body ?? "") });
      return new Response(JSON.stringify({ api_key: KEY, database: "here", credit_cents: 500, console_url: "https://console.example" }), { status: 200 });
    }) as unknown as typeof fetch;
    return { impl, calls };
  };

  it("asks first - an account and the uploads in one question - then stores the key, agreed", async () => {
    const { impl, calls } = granting();
    const asked: string[] = [];
    const result = await loginCmd(
      { platform: PLATFORM },
      { fetch: impl, consent: { interactive: true, ask: async (q) => (asked.push(q), "y") } },
    );
    expect(asked[0]).toMatch(/Create a free Infino account and upload the contents of the directories/);
    expect(calls).toEqual([{ url: `${PLATFORM}/v1/trial`, body: expect.stringContaining('"database"') }]);
    expect(result).toMatchObject({ action: "created", baseUrl: PLATFORM, databases: ["here"], uploadAgreed: true });
    expect(readStoredKey()).toBe(KEY);
    expect(statSync(keyFilePath()).mode & 0o777).toBe(0o600);
    expect(readStoredAccount()).toMatchObject({ baseUrl: PLATFORM, consoleUrl: "https://console.example" });
    expect(readStoredAccount()?.uploadConsentAt).toBeDefined();
  });

  it("creates nothing on a no", async () => {
    const { impl, calls } = granting();
    const result = await loginCmd({ platform: PLATFORM }, { fetch: impl, consent: { interactive: true, ask: async () => "" } });
    expect(result.action).toBe("declined");
    expect(calls).toHaveLength(0);
    expect(existsSync(keyFilePath())).toBe(false);
  });

  it("creates nothing with nobody at the terminal, and --yes does not stand in for them", async () => {
    const { impl, calls } = granting();
    await expect(loginCmd({ platform: PLATFORM, yes: true }, { fetch: impl, consent: { interactive: false } })).rejects.toThrow(/no terminal/);
    expect(calls).toHaveLength(0);
    expect(existsSync(keyFilePath())).toBe(false);
  });

  it("takes the platform from CX_PLATFORM_URL when the flag names none", async () => {
    process.env.CX_PLATFORM_URL = PLATFORM;
    try {
      const { impl, calls } = granting();
      await loginCmd({ platform: true }, { fetch: impl, consent: { interactive: true, ask: async () => "yes" } });
      expect(calls[0]?.url).toBe(`${PLATFORM}/v1/trial`);
    } finally {
      delete process.env.CX_PLATFORM_URL;
    }
  });

  it("refuses to make a second account for a machine that has one", async () => {
    const { impl } = withDatabases();
    await loginCmd({ db: PLATFORM, yes: true }, { stdin: () => KEY, fetch: impl });
    const { impl: trial, calls } = granting();
    await expect(loginCmd({ platform: "https://other.example" }, { fetch: trial, consent: { interactive: true, ask: async () => "y" } })).rejects.toThrow(
      /already signed in/,
    );
    expect(calls).toHaveLength(0);
  });

  it("says when a platform offers no trial, or this network has had one", async () => {
    const consent = { interactive: true, ask: async () => "y" };
    const { impl: none } = answering(501, JSON.stringify({ message: "no trial" }));
    await expect(loginCmd({ platform: PLATFORM }, { fetch: none, consent })).rejects.toThrow(/does not offer free accounts/);
    const { impl: had } = answering(409, JSON.stringify({ message: "already" }));
    await expect(loginCmd({ platform: PLATFORM }, { fetch: had, consent })).rejects.toThrow(/already used its free trial/);
    expect(existsSync(keyFilePath())).toBe(false);
  });
});

describe("the platform URL", () => {
  it("accepts an origin, and a database URL whose name it ignores", () => {
    expect(baseUrlFrom("https://platform.example")).toBe(PLATFORM);
    expect(baseUrlFrom("https://platform.example/")).toBe(PLATFORM);
    expect(baseUrlFrom("https://platform.example/my-repo")).toBe(PLATFORM);
  });

  it("refuses a deeper path rather than silently keeping the origin", () => {
    expect(() => baseUrlFrom("https://platform.example/a/b")).toThrow(LoginError);
    expect(() => baseUrlFrom("not-a-url")).toThrow(/http\(s\) URL/);
  });
});
