// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The server over Streamable HTTP: the shape a remote connector adds by
// URL. One listener, a session per client, each session a server of its
// own; a read-only server offers no tool that writes; a request naming no
// session and carrying no initialize is refused without building anything;
// the health path answers the proxy.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { scriptPlatform, type Platform } from "./mcp-harness.js";

delete process.env.CX_TABLE;
delete process.env.CX_SIBLING_TABLES;
process.env.CX_NO_EMBED = "1";
process.env.CX_AUTO_INDEX = "0";
delete process.env.CX_READ_ONLY;

const { API_KEY_ENV, configureHosted, hostedSettingsFromFlags } = await import("../src/core/config.js");
const { serveHttp } = await import("../src/mcp/http.js");
type HttpServed = Awaited<ReturnType<typeof serveHttp>>;

const DATA_DB = "lab";
const TRANS = "trans";

function platform(): Platform {
  return scriptPlatform({
    databases: () => [200, { databases: [{ name: "cxbench", state: "registered" }, { name: DATA_DB, state: "registered" }] }],
    list_tables: (_body, request) => (request.path.endsWith(`/${DATA_DB}`) ? [200, [TRANS]] : [200, ["chunks"]]),
    schema: () => [200, [{ name: "trans_id", nullable: true, type: "i64" }, { name: "amount", nullable: true, type: "f64" }]],
    table_card: (body) => [404, { error: `no lean card for table ${String(body?.table)}` }],
    hydrate: () => [404, { error: "no job" }],
    query_sql: () => [200, [{ n: 3 }]],
    validate: () => [200, { valid: true, check: "aggregate" }],
  });
}

async function connect(url: string): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const transport = new StreamableHTTPClientTransport(new URL(url));
  const client = new Client({ name: "http-test", version: "0" });
  await client.connect(transport);
  return { client, transport };
}

beforeAll(() => {
  configureHosted(hostedSettingsFromFlags({ db: "http://127.0.0.1:9/cxbench" }, { [API_KEY_ENV]: "inf_test_key_do_not_log" }));
});

afterAll(() => {
  configureHosted(null);
});

describe("the server over Streamable HTTP, read-only", () => {
  let served: HttpServed;
  let scripted: Platform;
  let url: string;
  beforeAll(async () => {
    scripted = platform();
    served = await serveHttp(undefined, { port: 0, hostedOptions: { fetch: scripted.fetch }, readOnly: true });
    url = `http://${served.host}:${served.port}${served.path}`;
  });
  afterAll(async () => {
    await served.close();
  });

  it("answers the health path and refuses other paths", async () => {
    const health = await fetch(`http://${served.host}:${served.port}/healthz`);
    expect(health.status).toBe(200);
    const other = await fetch(`http://${served.host}:${served.port}/other`);
    expect(other.status).toBe(404);
  });

  it("refuses a request naming no session that is not an initialize, before building anything", async () => {
    const sent = scripted.sent.length;
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect(res.status).toBe(400);
    expect(scripted.sent.length).toBe(sent);
    const unknown = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-session-id": "nope" }, body: "{}" });
    expect(unknown.status).toBe(404);
    expect(served.sessions()).toBe(0);
  });

  it("opens a session per client, offers tables and the query tools but nothing that writes, and runs a statement over a database", async () => {
    const one = await connect(url);
    const two = await connect(url);
    expect(served.sessions()).toBe(2);
    expect(one.transport.sessionId).toBeDefined();
    expect(one.transport.sessionId).not.toBe(two.transport.sessionId);

    const { tools } = await one.client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("tables");
    expect(names).toContain("sql");
    expect(names).toContain("ask");
    expect(names).not.toContain("hydrate");
    expect(names).not.toContain("hydrate_status");
    expect(names).not.toContain("hydrate_cancel");
    expect(one.client.getInstructions()).toContain("- tables - the databases of this Infino account");
    expect(one.client.getInstructions()).not.toContain("- hydrate -");

    const result = (await one.client.callTool({ name: "sql", arguments: { database: DATA_DB, query: `SELECT COUNT(*) AS n FROM ${TRANS}` } })) as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0].text)).toMatchObject({ rows: [{ n: 3 }], database: DATA_DB, index: "platform" });

    await one.transport.terminateSession();
    expect(served.sessions()).toBe(1);
    await one.client.close();
    await two.client.close();
  });
});
