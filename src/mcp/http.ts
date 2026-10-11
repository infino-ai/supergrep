// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The same MCP server over Streamable HTTP: one URL that claude.ai, Claude
// Desktop, Claude Code and any other MCP client add as a remote connector,
// instead of a process each of them starts. Behind a TLS proxy (Caddy on
// the demo host), bound to loopback.
//
// Sessions, as the transport defines them: a POST carrying an `initialize`
// request and no session header opens one - a server of its own, built by
// `serveMcp` exactly as the stdio server is, with its own caches - and the
// transport answers with the session's id, which the client sends on every
// later request. A session that goes quiet is closed after SESSION_IDLE_MS;
// a client's DELETE closes it at once. One session's work never reaches
// another's: the registry, the data plane and the receipts are the
// session's.

import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { serveMcp, type ServeOptions } from "./server.js";

/** Where the server listens when nothing says otherwise: loopback, since a
 * TLS proxy in front of it is the deployment, never this process on a
 * public port. */
export const DEFAULT_HTTP_HOST = "127.0.0.1";
/** The path MCP requests go to, the convention a connector URL ends in. */
export const DEFAULT_HTTP_PATH = "/mcp";
/** A plain liveness answer for the proxy and for a deploy's check. */
const HEALTH_PATH = "/healthz";
/** The header a session's id travels in, as the transport specifies. */
const SESSION_HEADER = "mcp-session-id";
/** How long a session may be silent before it is closed: a chat that went
 * idle for half an hour starts a new session on its next call, which costs
 * one initialize and one card read. */
const SESSION_IDLE_MS = 30 * 60 * 1000;
/** How often idle sessions are looked for. */
const SWEEP_MS = 60 * 1000;
/** The most of a request body read before a session exists: an
 * `initialize` request is a few hundred bytes. */
const MAX_INITIALIZE_BYTES = 64 * 1024;
const JSON_CONTENT_TYPE = "application/json";
/** JSON-RPC's own codes for the two refusals answered here. */
const JSONRPC_SESSION_NOT_FOUND = -32001;
const JSONRPC_INVALID_REQUEST = -32600;

export interface HttpServeOptions extends Pick<ServeOptions, "hostedOptions" | "readOnly"> {
  /** The port to listen on; 0 takes a free one (tests). */
  port: number;
  host?: string;
  path?: string;
  /** Idle time before a session is closed (SESSION_IDLE_MS). */
  idleMs?: number;
}

/** What `serveHttp` hands back: where it listens, and how to stop it. */
export interface HttpServed {
  port: number;
  host: string;
  path: string;
  /** How many sessions are open. */
  sessions(): number;
  close(): Promise<void>;
}

interface Session {
  transport: StreamableHTTPServerTransport;
  lastSeen: number;
}

/** A JSON-RPC error answer with no request id, for a request that reached
 * no session. */
function refuse(res: ServerResponse, status: number, code: number, message: string): void {
  res.writeHead(status, { "content-type": JSON_CONTENT_TYPE });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

/** The request's body as JSON, read up to MAX_INITIALIZE_BYTES; undefined
 * when it is larger, or not JSON. */
async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_INITIALIZE_BYTES) return undefined;
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
}

/** Serve the MCP tools over Streamable HTTP for the repository at
 * `rootPath` (the stdio server's root, with the same platform settings).
 * Resolves once the socket listens. */
export async function serveHttp(rootPath: string | undefined, opts: HttpServeOptions): Promise<HttpServed> {
  const host = opts.host ?? DEFAULT_HTTP_HOST;
  const path = opts.path ?? DEFAULT_HTTP_PATH;
  const idleMs = opts.idleMs ?? SESSION_IDLE_MS;
  const sessions = new Map<string, Session>();
  const serveOptions: Omit<ServeOptions, "transport"> = {
    ...(opts.hostedOptions ? { hostedOptions: opts.hostedOptions } : {}),
    ...(opts.readOnly !== undefined ? { readOnly: opts.readOnly } : {}),
  };

  /** A session's server and transport, registered once the transport has
   * answered the initialize request with the session's id. */
  const open = async (): Promise<StreamableHTTPServerTransport> => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, lastSeen: Date.now() });
      },
      onsessionclosed: (id) => {
        sessions.delete(id);
      },
    });
    await serveMcp(rootPath, { ...serveOptions, transport });
    return transport;
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", `http://${host}`);
    if (url.pathname === HEALTH_PATH) {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok\n");
      return;
    }
    if (url.pathname !== path) {
      res.writeHead(404);
      res.end();
      return;
    }
    const given = req.headers[SESSION_HEADER];
    const id = typeof given === "string" ? given : undefined;
    if (id !== undefined) {
      const session = sessions.get(id);
      if (!session) {
        refuse(res, 404, JSONRPC_SESSION_NOT_FOUND, "session not found; start a new one with an initialize request");
        return;
      }
      session.lastSeen = Date.now();
      await session.transport.handleRequest(req, res);
      return;
    }
    // No session named: only an initialize request opens one. The body is
    // read here so no server is built for a request that is not one.
    if (req.method !== "POST") {
      refuse(res, 400, JSONRPC_INVALID_REQUEST, "no session: send an initialize request first");
      return;
    }
    const body = await readJson(req);
    if (!isInitializeRequest(body)) {
      refuse(res, 400, JSONRPC_INVALID_REQUEST, "no session: send an initialize request first");
      return;
    }
    const transport = await open();
    await transport.handleRequest(req, res, body);
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      console.error(`mcp over http: ${(err as Error).message}`);
      if (!res.headersSent) refuse(res, 500, JSONRPC_INVALID_REQUEST, "the request failed; see the server's log");
      else res.end();
    });
  });

  const sweep = setInterval(() => {
    const cutoff = Date.now() - idleMs;
    for (const [id, session] of sessions) {
      if (session.lastSeen < cutoff) {
        sessions.delete(id);
        void session.transport.close().catch(() => undefined);
      }
    }
  }, SWEEP_MS);
  sweep.unref();

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : opts.port;
  console.error(`code-context MCP server listening on http://${host}:${port}${path} (sessions idle out after ${Math.round(idleMs / 60000)} min)`);

  return {
    port,
    host,
    path,
    sessions: () => sessions.size,
    close: async () => {
      clearInterval(sweep);
      for (const [id, session] of sessions) {
        sessions.delete(id);
        await session.transport.close().catch(() => undefined);
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
