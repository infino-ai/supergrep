// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The server over Streamable HTTP with sign-in: every call carries a
// bearer token, which is an account's key; a call with none, or with one
// the platform refuses, is answered 401 naming the resource metadata (what
// makes a client start the sign-in); a token that could never be a key
// costs the platform nothing; a session is its token's; and the session a
// good token opens runs on that account - its platform calls carry it.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { scriptPlatform, type Platform } from "./mcp-harness.js";

delete process.env.CX_TABLE;
delete process.env.CX_SIBLING_TABLES;
process.env.CX_NO_EMBED = "1";
process.env.CX_AUTO_INDEX = "0";
delete process.env.CX_READ_ONLY;

const { API_KEY_ENV, configureHosted, hostedSettingsFromFlags, hostedTarget } = await import("../src/core/config.js");
const { serveHttp } = await import("../src/mcp/http.js");
type HttpServed = Awaited<ReturnType<typeof serveHttp>>;

const METADATA_URL = "https://api.example.test/.well-known/oauth-protected-resource/connect/mcp";
const GOOD_KEY = `inf_${"1".repeat(16)}_${"ab".repeat(24)}`;
const UNKNOWN_KEY = `inf_${"2".repeat(16)}_${"cd".repeat(24)}`;
const DATA_DB = "mydata";
const TRANS = "data";

/** A platform whose account plane accepts one key, and whose data plane
 * records which key each statement carried. */
function platform(): Platform & { keysSeen: string[] } {
  const keysSeen: string[] = [];
  const bearerOf = (request: { headers: Record<string, string> }) => (request.headers.authorization ?? "").replace(/^Bearer /, "");
  const scripted = scriptPlatform({
    databases: (_body, request) => (bearerOf(request) === GOOD_KEY ? [200, { databases: [{ name: DATA_DB, state: "registered" }] }] : [401, { error: "unauthenticated" }]),
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

describe("the server over Streamable HTTP with sign-in", () => {
  let served: HttpServed;
  let scripted: ReturnType<typeof platform>;
  let url: string;
  beforeAll(async () => {
    // --sign-in: the process holds no key, even with one in the environment.
    configureHosted(hostedSettingsFromFlags({ db: "http://127.0.0.1:9/cxbench", signIn: METADATA_URL }, { [API_KEY_ENV]: "inf_should_not_be_used" }));
    expect(hostedTarget()?.apiKey).toBe("");
    scripted = platform();
    served = await serveHttp(undefined, { port: 0, hostedOptions: { fetch: scripted.fetch }, signIn: { resourceMetadataUrl: METADATA_URL, platformBaseUrl: "http://127.0.0.1:9", fetch: scripted.fetch } });
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
    expect(served.sessions()).toBe(0);
    const get = await fetch(url, { headers: { accept: "text/event-stream" } });
    expect(get.status).toBe(401);
  });

  it("refuses a token that could never be a key without asking the platform, and one the platform refuses with the same 401", async () => {
    const asked = () => scripted.sent.filter((sent) => sent.op === "databases").length;
    const before = asked();
    const junk = await fetch(url, { method: "POST", headers: { ...accept, authorization: "Bearer not-a-key" }, body: initialize });
    expect(junk.status).toBe(401);
    expect(junk.headers.get("www-authenticate")).toContain("resource_metadata=");
    expect(asked()).toBe(before);
    const unknown = await fetch(url, { method: "POST", headers: { ...accept, authorization: `Bearer ${UNKNOWN_KEY}` }, body: initialize });
    expect(unknown.status).toBe(401);
    expect(asked()).toBe(before + 1);
    expect(served.sessions()).toBe(0);
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
    await transport.terminateSession();
    expect(served.sessions()).toBe(0);
    await client.close();
  });
});
