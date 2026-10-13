// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The server over Streamable HTTP with sign-in: a call with no key, or one
// the platform refuses, gets the 401 naming the resource metadata; a good
// key opens a session that runs on that account, and is that key's alone.

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { scriptPlatform, type Platform } from "./mcp-harness.js";

delete process.env.CX_TABLE;
delete process.env.CX_SIBLING_TABLES;
process.env.CX_NO_EMBED = "1";
process.env.CX_AUTO_INDEX = "0";
delete process.env.CX_READ_ONLY;

const { API_KEY_ENV, MANIFEST_NAME, configureHosted, hostedSettingsFromFlags, hostedTarget } = await import("../src/core/config.js");
const { serveHttp } = await import("../src/mcp/http.js");
type HttpServed = Awaited<ReturnType<typeof serveHttp>>;

const METADATA_URL = "https://api.example.test/.well-known/oauth-protected-resource/connect/mcp";
const GOOD_KEY = `inf_${"1".repeat(16)}_${"ab".repeat(24)}`;
const UNKNOWN_KEY = `inf_${"2".repeat(16)}_${"cd".repeat(24)}`;
const BROKE_KEY = `inf_${"3".repeat(16)}_${"ef".repeat(24)}`;
/** A second account's key the platform takes, for what one key's sessions
 * do to another's. */
const SECOND_KEY = `inf_${"4".repeat(16)}_${"aa".repeat(24)}`;
const DATA_DB = "mydata";
const TRANS = "data";
/** The database `--db` names: the server's own, never a caller's. */
const SERVER_DB = "cxbench";
/** The JSON-RPC codes the server answers with, a wire contract. */
const SESSION_NOT_FOUND_CODE = -32001;
const UNAUTHORIZED_CODE = -32003;
/** The routes a build or sync of a repository writes through. */
const WRITE_OPS = ["create_table", "drop_table", "append", "delete"];

/** A platform whose account plane accepts two keys, and whose data plane
 * records which key each statement carried. */
function platform(): Platform & { keysSeen: string[] } {
  const keysSeen: string[] = [];
  const bearerOf = (request: { headers: Record<string, string> }) => (request.headers.authorization ?? "").replace(/^Bearer /, "");
  const scripted = scriptPlatform({
    databases: (_body, request) =>
      bearerOf(request) === GOOD_KEY || bearerOf(request) === SECOND_KEY
        ? [200, { databases: [{ name: DATA_DB, state: "registered" }] }]
        : bearerOf(request) === BROKE_KEY
          ? [402, { error: "payment required" }]
          : [401, { error: "unauthenticated" }],
    list_tables: () => [200, [TRANS]],
    schema: () => [200, [{ name: "id", nullable: true, type: "i64" }]],
    table_card: (body) => [404, { error: `no lean card for table ${String(body?.table)}` }],
    hydrate: () => [404, { error: "no job" }],
    query_sql: (_body, request) => {
      keysSeen.push(bearerOf(request));
      return [200, [{ n: 3 }]];
    },
    validate: () => [200, { valid: true, check: "aggregate" }],
  });
  return { ...scripted, keysSeen };
}

const initialize = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
const accept = { "content-type": "application/json", accept: "application/json, text/event-stream" };

/** A client connected to `url` with `key` as its bearer. */
async function signedIn(url: string, key: string): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${key}` } } });
  const client = new Client({ name: "sign-in-test", version: "0" });
  await client.connect(transport);
  return { client, transport };
}

/** A tool call's text, and whether it failed. */
async function callText(client: Client, name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const result = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
  return { text: result.content[0].text, isError: result.isError === true };
}

describe("the server over Streamable HTTP with sign-in", () => {
  let served: HttpServed;
  let scripted: ReturnType<typeof platform>;
  let url: string;
  beforeAll(async () => {
    // --sign-in: the process holds no key, even with one in the environment.
    configureHosted(hostedSettingsFromFlags({ db: "http://127.0.0.1:9/cxbench", signIn: METADATA_URL }, { [API_KEY_ENV]: "inf_should_not_be_used" }));
    expect(hostedTarget()?.apiKey).toBe("");
    scripted = platform();
    served = await serveHttp(undefined, { port: 0, hostedOptions: { fetch: scripted.fetch }, signIn: METADATA_URL });
    url = `http://${served.host}:${served.port}${served.path}`;
  });
  afterAll(async () => {
    await served.close();
    configureHosted(null);
  });

  it("answers a call with no token 401, naming the resource metadata, before building anything", async () => {
    const res = await fetch(url, { method: "POST", headers: accept, body: initialize });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${METADATA_URL}"`);
    expect(((await res.json()) as { error: { code: number } }).error.code).toBe(UNAUTHORIZED_CODE);
    expect(served.sessions()).toBe(0);
    const get = await fetch(url, { headers: { accept: "text/event-stream" } });
    expect(get.status).toBe(401);
  });

  it("answers a key the platform refuses with the same 401, and an account out of credit with no sign-in, before building a session", async () => {
    const unknown = await fetch(url, { method: "POST", headers: { ...accept, authorization: `Bearer ${UNKNOWN_KEY}` }, body: initialize });
    expect(unknown.status).toBe(401);
    expect(unknown.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${METADATA_URL}"`);
    // A new sign-in would only hand the person another, empty account.
    const broke = await fetch(url, { method: "POST", headers: { ...accept, authorization: `Bearer ${BROKE_KEY}` }, body: initialize });
    expect(broke.status).toBe(403);
    expect(broke.headers.get("www-authenticate")).toBeNull();
    expect(served.sessions()).toBe(0);
  });

  it("needs --db, whatever account the machine has stored", () => {
    expect(() => hostedSettingsFromFlags({ signIn: METADATA_URL }, {}, () => GOOD_KEY, { accountRoot: "/tmp/r", storedAccount: () => ({ baseUrl: "https://p.example", uploadConsentAt: "2026-10-11" }) })).toThrow("--sign-in needs --db");
  });

  it("opens a session on a good token, runs it on that account, and keeps it that token's", async () => {
    const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${GOOD_KEY}` } } });
    const client = new Client({ name: "sign-in-test", version: "0" });
    await client.connect(transport);
    expect(served.sessions()).toBe(1);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("tables");
    expect(names).toContain("sql");
    expect(names).toContain("hydrate");
    // This machine is the server's, not the caller's: hydrate reads none of its files.
    const hydrate = (await client.listTools()).tools.find((t) => t.name === "hydrate")!;
    expect((hydrate.inputSchema.properties as Record<string, { enum?: string[] }>).kind.enum).toEqual(["bucket", "prefix"]);
    const local = (await client.callTool({ name: "hydrate", arguments: { database: DATA_DB, kind: "path", path: "/etc" } })) as { isError?: boolean };
    expect(local.isError).toBe(true);
    expect(scripted.sent.some((sent) => sent.op === "hydrate")).toBe(false);
    const result = (await client.callTool({ name: "sql", arguments: { database: DATA_DB, query: `SELECT COUNT(*) AS n FROM ${TRANS}` } })) as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0].text)).toMatchObject({ rows: [{ n: 3 }], database: DATA_DB });
    expect(scripted.keysSeen).toEqual([GOOD_KEY]);

    // Another token on this session's id is not this session.
    const other = await fetch(url, {
      method: "POST",
      headers: { ...accept, "mcp-session-id": transport.sessionId!, authorization: `Bearer ${UNKNOWN_KEY}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" }),
    });
    expect(other.status).toBe(401);
    expect(((await other.json()) as { error: { code: number } }).error.code).toBe(UNAUTHORIZED_CODE);
    await transport.terminateSession();
    expect(served.sessions()).toBe(0);
    await client.close();
  });
});

describe("a signed-in session and the repository the server was started for", () => {
  /** A word only the server's own repository holds. */
  const TOKEN = "zebracornflower";
  let served: HttpServed;
  let scripted: ReturnType<typeof platform>;
  let url: string;
  let root = "";
  let other = "";
  const saved = { index: process.env.CX_AUTO_INDEX, sync: process.env.CX_AUTO_SYNC };
  beforeAll(async () => {
    configureHosted(hostedSettingsFromFlags({ db: `http://127.0.0.1:9/${SERVER_DB}`, signIn: METADATA_URL }, {}));
    // Building and syncing on, as they are by default: what a deployment
    // that forgot to switch them off would run.
    delete process.env.CX_AUTO_INDEX;
    delete process.env.CX_AUTO_SYNC;
    root = mkdtempSync(join(tmpdir(), "cx-sign-in-root-"));
    writeFileSync(join(root, "notes.txt"), `${TOKEN}\n`);
    other = mkdtempSync(join(tmpdir(), "cx-sign-in-other-"));
    writeFileSync(join(other, "secret.txt"), `${TOKEN}\n`);
    scripted = platform();
    served = await serveHttp(root, { port: 0, hostedOptions: { fetch: scripted.fetch }, signIn: METADATA_URL });
    url = `http://${served.host}:${served.port}${served.path}`;
  });
  afterAll(async () => {
    await served.close();
    configureHosted(null);
    process.env.CX_AUTO_INDEX = saved.index;
    if (saved.sync === undefined) delete process.env.CX_AUTO_SYNC;
    else process.env.CX_AUTO_SYNC = saved.sync;
    rmSync(root, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  });

  it("is served neither the server's repository nor another directory of its machine, and writes nothing to the caller's account for them", async () => {
    const { client } = await signedIn(url, GOOD_KEY);
    const names = (await client.listTools()).tools.map((t) => t.name);
    const doors = [
      { name: "find", args: { query: TOKEN } },
      { name: "sql", args: { query: "SELECT path FROM chunks" } },
      { name: "search", args: { query: TOKEN } },
      ...(names.includes("ask") ? [{ name: "ask", args: { question: `where is ${TOKEN}` } }] : []),
    ];
    for (const { name, args } of doors) {
      const own = await callText(client, name, args);
      expect(own.isError, `${name}: ${own.text}`).toBe(true);
      expect(own.text, name).toContain("not served to a signed-in account");
      expect(own.text, name).not.toContain(TOKEN);
      const elsewhere = await callText(client, name, { ...args, path: other });
      expect(elsewhere.isError, `${name} with path: ${elsewhere.text}`).toBe(true);
      expect(elsewhere.text, name).toContain("which is not yours");
      expect(elsewhere.text, name).not.toContain(TOKEN);
    }
    expect(scripted.sent.filter((s) => WRITE_OPS.includes(s.op))).toEqual([]);
    expect(scripted.sent.filter((s) => s.path.includes(SERVER_DB))).toEqual([]);
    // No index of the server's repository was built (its engine connection
    // is opened, which makes the directory, but nothing is written to it);
    // the other directory was not even looked at.
    expect(existsSync(join(root, ".infino", MANIFEST_NAME))).toBe(false);
    expect(existsSync(join(other, ".infino"))).toBe(false);
    await client.close();
  });
});

describe("sessions per key, with sign-in", () => {
  /** A cap small enough to cross in a test. */
  const CAP = 2;
  let served: HttpServed;
  let url: string;
  beforeAll(async () => {
    configureHosted(hostedSettingsFromFlags({ db: `http://127.0.0.1:9/${SERVER_DB}`, signIn: METADATA_URL }, {}));
    served = await serveHttp(undefined, { port: 0, hostedOptions: { fetch: platform().fetch }, signIn: METADATA_URL, maxSessionsPerKey: CAP });
    url = `http://${served.host}:${served.port}${served.path}`;
  });
  afterAll(async () => {
    await served.close();
    configureHosted(null);
  });

  it("closes a key's least recently used session past the cap, and never another key's", async () => {
    const one = await signedIn(url, GOOD_KEY);
    const two = await signedIn(url, GOOD_KEY);
    const theirs = await signedIn(url, SECOND_KEY);
    // One is used after two, so two is the key's least recently used.
    await one.client.listTools();
    const three = await signedIn(url, GOOD_KEY);
    expect(served.sessions()).toBe(CAP + 1);

    const closed = await fetch(url, {
      method: "POST",
      headers: { ...accept, "mcp-session-id": two.transport.sessionId!, authorization: `Bearer ${GOOD_KEY}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" }),
    });
    expect(closed.status).toBe(404);
    expect(((await closed.json()) as { error: { code: number } }).error.code).toBe(SESSION_NOT_FOUND_CODE);
    for (const live of [one, three, theirs]) expect((await live.client.listTools()).tools.length).toBeGreaterThan(0);

    // The closed client starts over, and the key stays at the cap.
    const again = await signedIn(url, GOOD_KEY);
    expect((await again.client.listTools()).tools.length).toBeGreaterThan(0);
    expect(served.sessions()).toBe(CAP + 1);
    for (const c of [one, two, three, theirs, again]) await c.client.close();
  });
});
