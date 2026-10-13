// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The MCP server end to end on an in-memory transport against a scripted
// platform: what the server test files (chunks-server, rows-server) share.
// Not a test file itself. `start` imports the server at call time rather
// than at load: the server reads its environment when its module loads
// (CX_TABLE is a constant of config.ts), and a static import here would run
// before the test file's own environment lines, which is also why nothing
// of the client's own code is imported at the top of this file.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

/** One request the platform saw: the op (`/v1/<op>/...`) and its JSON body -
 * or, for a GET, its query parameters, the only body such a request has -
 * with the method and the path after `/v1/` (the database, and `/uploads`
 * under hydrate), which tell a route the same op's requests apart. A
 * request to another host - a file's PUT to its upload session - is
 * recorded under that host as its op, with the body's byte count. */
export interface Sent {
  op: string;
  body: Record<string, unknown> | undefined;
  method: string;
  path: string;
}

/** What a route is told beside the body. */
export interface Request {
  method: string;
  path: string;
}

/** What each route answers, by op: a status and a JSON payload. A GET
 * route sees the request's query parameters where a POST sees its body. */
export type Routes = Record<string, (body: Record<string, unknown> | undefined, request: Request) => [number, unknown]>;

export interface Platform {
  fetch: typeof fetch;
  /** Every request, in order, as it arrived. */
  sent: Sent[];
}

/** The bytes of a request body, whatever it was given as; a stream is
 * drained. */
async function bodyBytes(body: BodyInit | null | undefined): Promise<number> {
  if (body === null || body === undefined) return 0;
  if (typeof body === "string") return Buffer.byteLength(body);
  if (body instanceof Uint8Array) return body.byteLength;
  if (body instanceof ReadableStream) {
    let n = 0;
    for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) n += chunk.byteLength;
    return n;
  }
  return 0;
}

/** A scripted platform. Anything unscripted - a drop, a create, an append -
 * is answered 500, so it also fails the call that made it. Every request is
 * recorded in `sent`. */
export function scriptPlatform(routes: Routes): Platform {
  const sent: Sent[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const afterPrefix = url.split("/v1/")[1];
    // A host other than the platform's: the op is the host, the path the rest.
    const parsed = new URL(url);
    const op = afterPrefix !== undefined ? afterPrefix.split(/[/?]/)[0] : parsed.host;
    const path = afterPrefix !== undefined ? afterPrefix.split("?")[0] : parsed.pathname;
    const body =
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : afterPrefix === undefined
        ? { bytes: await bodyBytes(init?.body as BodyInit | null | undefined) }
        : url.includes("?")
        ? Object.fromEntries(parsed.searchParams)
        : undefined;
    sent.push({ op, body, method, path });
    const [status, payload] = routes[op]?.(body, { method, path }) ?? [500, { error: `unexpected ${op}` }];
    return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json", "x-infino-read-tokens": "0.010" } });
  };
  return { fetch: fetchImpl, sent };
}

export interface Started {
  client: Client;
  /** The repository root the server was started for: a fresh temp dir. */
  root: string;
  sent: Sent[];
  /** What the server asked the platform at startup, before any call. */
  startup: string[];
  /** How long the server took to come up and connect its transport. */
  startupMs: number;
}

/** Start the server for a fresh temp root against `platform`, with a client
 * connected to it. `prefix` names the temp dir. */
export async function start(platform: Platform, prefix: string): Promise<Started> {
  const { serveMcp } = await import("../src/mcp/server.js");
  const root = mkdtempSync(join(tmpdir(), prefix));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const t0 = performance.now();
  await serveMcp(root, { transport: serverSide, hostedOptions: { fetch: platform.fetch } });
  const startupMs = performance.now() - t0;
  const startup = platform.sent.map((s) => s.op);
  const client = new Client({ name: "server-test", version: "0" });
  await client.connect(clientSide);
  return { client, root, sent: platform.sent, startup, startupMs };
}

export async function stop(started: Started): Promise<void> {
  await started.client.close();
  rmSync(started.root, { recursive: true, force: true });
}

/** A tool's JSON result, or the failure text when it errored, and the ops
 * the platform saw during the call alone. */
export async function call(
  started: Started,
  name: string,
  args: Record<string, unknown>,
): Promise<{ ok: boolean; value: Record<string, unknown> | string; ops: string[] }> {
  const before = started.sent.length;
  const result = (await started.client.callTool({ name, arguments: args })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
  const ops = started.sent.slice(before).map((s) => s.op);
  const text = result.content[0].text;
  return result.isError ? { ok: false, value: text, ops } : { ok: true, value: JSON.parse(text) as Record<string, unknown>, ops };
}
