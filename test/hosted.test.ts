// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The platform REST client against a scripted fake fetch: request shapes as
// the platform's request structs spell them, auth and content negotiation
// headers, the cold-start retry loop, error decoding, telemetry, and the Arrow
// IPC an append carries. No network is ever touched.

import * as arrow from "apache-arrow";
import { describe, expect, it } from "vitest";
import {
  HostedDb,
  HostedError,
  isHostedUrl,
  parseHostedUrl,
  retryAfterMs,
  rowsToIpc,
  serverMessage,
  type HostedCallInfo,
  type JsonColumn,
} from "../src/core/hosted.js";

// --- the fake fetch ---------------------------------------------------------------

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | Uint8Array | undefined;
  signal: AbortSignal | undefined;
}

interface Scripted {
  status: number;
  body?: string;
  headers?: Record<string, string>;
}

/** A fetch that records every request and answers from a script, in order. */
function fakeFetch(script: Scripted[]) {
  const calls: Recorded[] = [];
  const impl: typeof fetch = async (input, init) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body: init?.body as string | Uint8Array | undefined,
      signal: init?.signal ?? undefined,
    });
    const next = script.shift();
    if (!next) throw new Error(`fake fetch: no scripted response for call ${calls.length}`);
    return new Response(next.body ?? "", { status: next.status, headers: next.headers ?? {} });
  };
  return { fetch: impl, calls };
}

const KEY = "inf_test_key_do_not_log";
const target = { baseUrl: "https://api.example.test", database: "cx" };

function client(
  script: Scripted[],
  extra: { coldStartSecs?: number; timeoutMs?: number; deadlineMs?: number; onCall?: (i: HostedCallInfo) => void } = {},
) {
  const fake = fakeFetch(script);
  const db = new HostedDb({ ...target, apiKey: KEY }, { fetch: fake.fetch, ...extra });
  return { db, calls: fake.calls };
}

const json = (body: unknown, headers: Record<string, string> = {}): Scripted => ({
  status: 200,
  body: JSON.stringify(body),
  headers: { "content-type": "application/json", ...headers },
});

const bodyJson = (call: Recorded): Record<string, unknown> => JSON.parse(call.body as string) as Record<string, unknown>;

describe("joinKeys", () => {
  it("posts the tables and returns the platform's keys", async () => {
    const answer = { joins: [{ from_table: "logs", from_column: "instance_id", to_table: "issues", to_column: "instance_id", predicate: "logs.instance_id = issues.instance_id", inclusion: 1, coverage: 0.6, verified: true }], pairs: 1, counted: 1, model_tokens: 0 };
    const { db, calls } = client([json(answer)]);
    const keys = await db.joinKeys(["logs", "issues"]);
    expect(keys).toEqual(answer);
    expect(calls[0].method).toBe("POST");
    expect(new URL(calls[0].url).pathname).toBe("/v1/join_keys/cx");
    expect(bodyJson(calls[0])).toEqual({ tables: ["logs", "issues"] });
  });
});

describe("graphExpand", () => {
  it("sends what was searched beside the rows, and nothing for it when nothing was", async () => {
    const { db, calls } = client([json({ connected: [], seeds: 0 }), json({ connected: [], seeds: 0 })]);
    await db.graphExpand("docs", [{ _id: "1" }], { query: "change of control", statement: "SELECT 1" });
    expect(new URL(calls[0].url).pathname).toBe("/v1/graph_expand/cx");
    expect(bodyJson(calls[0])).toEqual({ table_name: "docs", rows: [{ _id: "1" }], query: "change of control", statement: "SELECT 1" });
    await db.graphExpand("docs", [{ _id: "1" }]);
    expect(bodyJson(calls[1])).toEqual({ table_name: "docs", rows: [{ _id: "1" }] });
  });
});

describe("graphFacts", () => {
  it("posts the statement and returns the facts' rows", async () => {
    const answer = { rows: [{ subject: "Acme Corp", relation: "must repay", object: "$50,000" }] };
    const { db, calls } = client([json(answer)]);
    const sql = "SELECT subject, relation, object FROM facts WHERE subject_node = 'acme'";
    expect(await db.graphFacts(sql)).toEqual(answer);
    expect(calls[0].method).toBe("POST");
    expect(new URL(calls[0].url).pathname).toBe("/v1/graph_facts/cx");
    expect(bodyJson(calls[0])).toEqual({ sql });
  });
});

describe("page", () => {
  it("posts the row's table, document and page and returns the platform's image", async () => {
    const answer = { media_type: "image/jpeg", data: "/9j/2Q==", width: 1350, height: 1803 };
    const { db, calls } = client([json(answer)]);
    const image = await db.page("officeqa", "cs-1991", 17);
    expect(image).toEqual(answer);
    expect(calls[0].method).toBe("POST");
    expect(new URL(calls[0].url).pathname).toBe("/v1/page/cx");
    expect(bodyJson(calls[0])).toEqual({ table: "officeqa", document: "cs-1991", page: 17 });
  });

  it("surfaces the platform's refusal of a drawn page as an error", async () => {
    const { db } = client([{ status: 422, body: "page: a.pdf: page 2 holds no scanned image" }]);
    await expect(db.page("officeqa", "a", 2)).rejects.toThrow(/holds no scanned image/);
  });
});

describe("webFetch", () => {
  it("posts the page's address and offset and returns the platform's text", async () => {
    const answer = {
      url: "https://fred.stlouisfed.org/data/PPIACO",
      content_type: "text/plain",
      text: "1960-01-01 31.7",
      offset: 0,
      total_chars: 15,
      next_offset: null,
    };
    const { db, calls } = client([json(answer)]);
    const page = await db.webFetch("https://fred.stlouisfed.org/data/PPIACO", 0);
    expect(page).toEqual(answer);
    expect(calls[0].method).toBe("POST");
    expect(new URL(calls[0].url).pathname).toBe("/v1/fetch/cx");
    expect(bodyJson(calls[0])).toEqual({ url: "https://fred.stlouisfed.org/data/PPIACO", offset: 0 });
  });

  it("surfaces the platform's refusal of an address inside as an error", async () => {
    const { db } = client([{ status: 403, body: "fetch: 169.254.169.254 is not on the public internet" }]);
    await expect(db.webFetch("http://169.254.169.254/", 0)).rejects.toThrow(/not on the public internet/);
  });
});

describe("querySql", () => {
  it("keeps an engine id exact: a 128-bit integer the platform writes in full comes back as a bigint", async () => {
    // Written by hand, not through JSON.stringify: the point is the digits
    // the platform sends, which no JS number holds.
    const body = '[{"_id":33023604937666786634178324594870,"n":12,"start_line":7,"score":0.5,"big_float":3.3e31}]';
    const { db } = client([{ status: 200, body, headers: { "content-type": "application/json" } }]);
    const [row] = await db.querySql("SELECT _id, n FROM t");
    expect(row._id).toBe(33023604937666786634178324594870n);
    expect(row.n).toBe(12);
    expect(row.start_line).toBe(7);
    expect(row.score).toBe(0.5);
    expect(row.big_float).toBe(3.3e31);
  });
});

describe("tableCard", () => {
  it("asks for the card by table and tier, and nothing else", async () => {
    const { db, calls } = client([json({ card: { table: "logs" } }), json({ card: { table: "logs" } })]);
    await db.tableCard("logs", "lean");
    await db.tableCard("logs");
    const [tiered, plain] = calls.map((c) => new URL(c.url));
    expect(tiered.pathname).toBe("/v1/table_card/cx");
    expect(tiered.searchParams.get("table")).toBe("logs");
    expect(tiered.searchParams.get("tier")).toBe("lean");
    expect([...tiered.searchParams.keys()].sort()).toEqual(["table", "tier"]);
    expect([...plain.searchParams.keys()]).toEqual(["table"]);
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });
});

// --- URLs ---------------------------------------------------------------------------

describe("parseHostedUrl", () => {
  it("splits https://host/db into base URL and database", () => {
    expect(parseHostedUrl("https://api.platform.infino.ws/my-app")).toEqual({
      baseUrl: "https://api.platform.infino.ws",
      database: "my-app",
    });
  });

  it("tolerates a trailing slash on the database segment", () => {
    expect(parseHostedUrl("https://h/db/")).toEqual({ baseUrl: "https://h", database: "db" });
  });

  it("allows http:// only for a loopback host", () => {
    expect(parseHostedUrl("http://127.0.0.1:9110/db")).toEqual({ baseUrl: "http://127.0.0.1:9110", database: "db" });
    expect(parseHostedUrl("http://localhost:8080/db")).toEqual({ baseUrl: "http://localhost:8080", database: "db" });
    expect(() => parseHostedUrl("http://example.com/db")).toThrow(/https:\/\/ for a remote host/);
  });

  it("requires the database segment", () => {
    expect(() => parseHostedUrl("https://h")).toThrow(/missing the database segment/);
    expect(() => parseHostedUrl("https://h/")).toThrow(/missing the database segment/);
  });

  it("refuses a nested path - routes are /v1/<op>/<database>", () => {
    expect(() => parseHostedUrl("https://h/a/b")).toThrow(/single path segment/);
  });

  it("refuses any other scheme", () => {
    expect(() => parseHostedUrl("s3://bucket/db")).toThrow(/must start with https:\/\//);
    expect(() => parseHostedUrl("./data")).toThrow(/must start with https:\/\//);
  });
});

describe("isHostedUrl", () => {
  it("is true for http(s) URLs only", () => {
    expect(isHostedUrl("https://h/db")).toBe(true);
    expect(isHostedUrl("http://127.0.0.1:9110/db")).toBe(true);
    expect(isHostedUrl("s3://bucket/prefix")).toBe(false);
    expect(isHostedUrl("./data")).toBe(false);
    expect(isHostedUrl("memory://")).toBe(false);
  });
});

// --- request shapes -------------------------------------------------------------------

describe("request shapes", () => {
  it("query_sql posts {query} to /v1/query_sql with auth and JSON accept, and decodes the row array", async () => {
    const { db, calls } = client([json([{ _id: 7, n: 3 }], { "x-infino-read-tokens": "0.050" })]);
    const rows = await db.querySql("SELECT COUNT(*) AS n FROM chunks");
    expect(rows).toEqual([{ _id: 7, n: 3 }]);
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.url).toBe("https://api.example.test/v1/query_sql/cx");
    expect(call.method).toBe("POST");
    expect(call.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(call.headers.accept).toBe("application/json");
    expect(call.headers["content-type"]).toBe("application/json");
    expect(bodyJson(call)).toEqual({ query: "SELECT COUNT(*) AS n FROM chunks" });
    // The _id arrives as a JSON integer and stays a number.
    expect(typeof rows[0]._id).toBe("number");
  });

  it("a read with an empty body is an empty result", async () => {
    const { db } = client([{ status: 200, body: "", headers: { "content-type": "application/json" } }]);
    expect(await db.querySql("SELECT 1")).toEqual([]);
  });

  it("a read that came back as an Arrow stream is refused with a clear error", async () => {
    const { db } = client([{ status: 200, body: "ARROW1", headers: { "content-type": "application/vnd.apache.arrow.stream" } }]);
    await expect(db.querySql("SELECT 1")).rejects.toThrow(/expected JSON rows/);
  });

  it("create_table posts the platform's schema descriptors and indexes", async () => {
    const { db, calls } = client([json({})]);
    const columns: JsonColumn[] = [
      { name: "path", type: "large_utf8", nullable: false },
      { name: "start_line", type: "int32" },
      { name: "embedding", type: { type: "vector", dim: 4 } },
      { name: "auto", type: { type: "embedding", source: ["content"] } },
    ];
    await db.createTable("chunks", columns, {
      fts: [{ column: "content", analyzer: "ascii_lower" }, { column: "path" }],
      vector: [{ column: "embedding", metric: "cosine" }],
    });
    expect(calls[0].url).toBe("https://api.example.test/v1/create_table/cx");
    expect(bodyJson(calls[0])).toEqual({
      table_name: "chunks",
      schema: [
        { name: "path", type: "large_utf8", nullable: false },
        { name: "start_line", type: "int32" },
        { name: "embedding", type: "vector", dim: 4 },
        { name: "auto", type: "embedding", source: ["content"] },
      ],
      indexes: {
        fts: [{ column: "content", analyzer: "ascii_lower" }, { column: "path" }],
        vector: [{ column: "embedding", metric: "cosine" }],
      },
    });
  });

  it("create_table leaves the vector index list out when there is none", async () => {
    const { db, calls } = client([json({})]);
    await db.createTable("t", [{ name: "content", type: "large_utf8" }], { fts: [{ column: "content" }] });
    expect(bodyJson(calls[0]).indexes).toEqual({ fts: [{ column: "content" }] });
  });

  it("drop_table posts {table_name, purge}", async () => {
    const { db, calls } = client([json({}), json({})]);
    await db.dropTable("chunks");
    await db.dropTable("chunks", false);
    expect(calls[0].url).toBe("https://api.example.test/v1/drop_table/cx");
    expect(bodyJson(calls[0])).toEqual({ table_name: "chunks", purge: true });
    expect(bodyJson(calls[1])).toEqual({ table_name: "chunks", purge: false });
  });

  it("list_tables posts with no body and returns the name array", async () => {
    const { db, calls } = client([json(["chunks", "other"])]);
    expect(await db.listTables()).toEqual(["chunks", "other"]);
    expect(calls[0].url).toBe("https://api.example.test/v1/list_tables/cx");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].body).toBeUndefined();
    expect(calls[0].headers).not.toHaveProperty("content-type");
  });

  it("schema posts {table_name} and returns the descriptors as they came", async () => {
    const descriptors = [{ name: "path", type: "large_utf8", nullable: false }];
    const { db, calls } = client([json(descriptors)]);
    expect(await db.schema("chunks")).toEqual(descriptors);
    expect(calls[0].url).toBe("https://api.example.test/v1/schema/cx");
    expect(bodyJson(calls[0])).toEqual({ table_name: "chunks" });
  });

  it("appendIpc posts the bytes untouched as an Arrow stream with ?table=", async () => {
    const { db, calls } = client([json({}, { "x-infino-write-tokens": "1.250" })]);
    const ipc = new Uint8Array([65, 82, 82, 79, 87, 49]);
    await db.appendIpc("chunks", ipc);
    const call = calls[0];
    expect(call.url).toBe("https://api.example.test/v1/append/cx?table=chunks");
    expect(call.headers["content-type"]).toBe("application/vnd.apache.arrow.stream");
    expect(call.body).toBe(ipc);
    expect(db.lastCall()).toMatchObject({ op: "append", status: 200, retries: 0, writeTokens: 1.25 });
  });

  it("appendRows posts the JSON {data} envelope", async () => {
    const { db, calls } = client([json({})]);
    await db.appendRows("chunks", [{ path: "a.ts", start_line: 1 }]);
    expect(calls[0].url).toBe("https://api.example.test/v1/append/cx?table=chunks");
    expect(calls[0].headers["content-type"]).toBe("application/json");
    expect(bodyJson(calls[0])).toEqual({ data: [{ path: "a.ts", start_line: 1 }] });
  });

  it("delete rides the query string with no body and returns the mutation counts", async () => {
    const stats = { matched: 2, n_tombstoned: 2, n_not_found: 0 };
    const { db, calls } = client([json(stats)]);
    expect(await db.deleteWhere("chunks", "path IN ('a b.ts','c.ts')")).toEqual(stats);
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe("/v1/delete/cx");
    expect(url.searchParams.get("table")).toBe("chunks");
    expect(url.searchParams.get("predicate")).toBe("path IN ('a b.ts','c.ts')");
    expect(calls[0].body).toBeUndefined();
  });

  it("validate posts the statement, rows and question, and decodes the verdict", async () => {
    const verdict = {
      valid: false,
      reason: "The result does not contain what the question asks for: its rows mention none of write_pointer. Query for what the question names.",
      check: "anchors",
      anchors: ["write_pointer"],
      rows: 1,
    };
    const { db, calls } = client([json(verdict), json(verdict)]);
    const request = {
      table: "chunks",
      column: "content",
      statement: "SELECT path FROM chunks",
      rows: [{ path: "README.md" }],
      question: "Where is `write_pointer` called?",
    };
    expect(await db.validate(request)).toEqual(verdict);
    expect(calls[0].url).toBe("https://api.example.test/v1/validate/cx");
    expect(calls[0].method).toBe("POST");
    // The table and column travel under the data plane's names, like find's.
    expect(bodyJson(calls[0])).toEqual({
      table_name: "chunks",
      field_name: "content",
      statement: "SELECT path FROM chunks",
      rows: [{ path: "README.md" }],
      question: "Where is `write_pointer` called?",
    });
    // Without a question only the statement and rows travel: the platform
    // reads an absent question as "nothing to anchor on", and an explicit
    // null would be refused as a type error.
    await db.validate({ table: "chunks", column: "content", statement: "SELECT COUNT(*) AS n FROM chunks", rows: [{ n: 0 }] });
    expect(bodyJson(calls[1])).toEqual({
      table_name: "chunks",
      field_name: "content",
      statement: "SELECT COUNT(*) AS n FROM chunks",
      rows: [{ n: 0 }],
    });
  });

  it("strips a trailing slash off the base URL", async () => {
    const fake = fakeFetch([json([])]);
    const db = new HostedDb({ baseUrl: "https://h/", database: "d", apiKey: KEY }, { fetch: fake.fetch });
    await db.listTables();
    expect(fake.calls[0].url).toBe("https://h/v1/list_tables/d");
  });
});

// --- retries -----------------------------------------------------------------------

describe("cold-start retries", () => {
  it("retries a 503 after its Retry-After and answers from the 200", async () => {
    const seen: HostedCallInfo[] = [];
    const { db, calls } = client(
      [{ status: 503, body: "no worker is ready to serve this request yet", headers: { "retry-after": "0" } }, json([{ n: 1 }])],
      { onCall: (i) => seen.push(i) },
    );
    expect(await db.querySql("SELECT 1")).toEqual([{ n: 1 }]);
    expect(calls).toHaveLength(2);
    // One logical call, one telemetry record, counting the retry it took.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ op: "query_sql", status: 200, retries: 1 });
    expect(seen[0].rttMs).toBeGreaterThanOrEqual(0);
    expect(db.lastCall()).toBe(seen[0]);
  });

  it("retries a 529 like a 503", async () => {
    const { db, calls } = client([{ status: 529, body: "no capacity to activate this database yet", headers: { "retry-after": "0" } }, json(["t"])]);
    expect(await db.listTables()).toEqual(["t"]);
    expect(calls).toHaveLength(2);
  });

  it("does not wait for a Retry-After that outlives the cold-start budget", async () => {
    const t0 = Date.now();
    const { db, calls } = client([{ status: 529, body: "no capacity to activate this database yet", headers: { "retry-after": "600" } }], { coldStartSecs: 1 });
    const err = await db.listTables().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HostedError);
    expect(err).toMatchObject({ status: 529, retryAfterSecs: 600, op: "list_tables" });
    expect((err as Error).message).toMatch(/no capacity to activate/);
    expect(calls).toHaveLength(1);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("gives up once the cold-start budget is spent and reports the retries", async () => {
    const forever: Scripted[] = [];
    for (let i = 0; i < 1000; i++) forever.push({ status: 503, body: "still spawning", headers: { "retry-after": "0" } });
    const seen: HostedCallInfo[] = [];
    const { db } = client(forever, { coldStartSecs: 0.05, onCall: (i) => seen.push(i) });
    const err = await db.querySql("SELECT 1").catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 503 });
    expect((err as Error).message).toMatch(/still spawning/);
    expect((err as Error).message).toMatch(/gave up after \d+ retr/);
    expect(seen).toHaveLength(1);
    expect(seen[0].retries).toBeGreaterThan(0);
  });

  it("backs off and retries a 429 (the platform at capacity) within the call's own budget, not the cold-start one", async () => {
    // A tiny cold-start budget and the call's own timeout: the capacity
    // retries ride the latter.
    const rows = [{ n: 1 }];
    const seen: HostedCallInfo[] = [];
    const { db, calls } = client(
      [
        { status: 429, body: JSON.stringify({ code: "pool_saturated", message: "no room" }), headers: { "retry-after": "0", "content-type": "application/json" } },
        { status: 429, body: "no room", headers: { "retry-after": "0" } },
        json(rows),
      ],
      { coldStartSecs: 0.001, onCall: (i) => seen.push(i) },
    );
    expect(await db.querySql("SELECT 1 AS n")).toEqual(rows);
    expect(calls).toHaveLength(3);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ op: "query_sql", status: 200, retries: 2 });
  });

  it("gives up on a 429 whose Retry-After outlives the call's budget, naming that budget and the capacity", async () => {
    const { db, calls } = client([{ status: 429, body: "no room", headers: { "retry-after": "600" } }], { timeoutMs: 1000 });
    const err = await db.querySql("SELECT 1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HostedError);
    expect(err).toMatchObject({ status: 429, op: "query_sql", retryAfterSecs: 600 });
    expect((err as HostedError).atCapacity).toBe(true);
    expect((err as Error).message).toMatch(/gave up after 0 retries within the call's 1 s budget/);
    expect(calls).toHaveLength(1);
  });

  it("a 503 still rides the cold-start budget, and is not 'at capacity'", async () => {
    const { db } = client([{ status: 503, body: "spawning", headers: { "retry-after": "600" } }], { coldStartSecs: 1, timeoutMs: 900_000 });
    const err = await db.querySql("SELECT 1").catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 503 });
    expect((err as HostedError).atCapacity).toBe(false);
    expect((err as Error).message).toMatch(/within the 1 s cold-start budget/);
  });

  it("retries an append 409 that carries Retry-After (a lost write race)", async () => {
    const { db, calls } = client([
      { status: 409, body: "another write to the same table was in flight", headers: { "retry-after": "0" } },
      json({}),
    ]);
    await db.appendRows("chunks", [{ path: "a" }]);
    expect(calls).toHaveLength(2);
    expect(db.lastCall()).toMatchObject({ op: "append", status: 200, retries: 1 });
  });

  it("does not retry a 409 without Retry-After (a name collision is terminal)", async () => {
    const { db, calls } = client([{ status: 409, body: "table chunks already exists" }]);
    await expect(db.createTable("chunks", [{ name: "c", type: "large_utf8" }], { fts: [] })).rejects.toMatchObject({ status: 409 });
    expect(calls).toHaveLength(1);
  });

  it("uses the platform's 5 s activation hint when Retry-After is missing or unreadable", () => {
    expect(retryAfterMs(null)).toBe(5000);
    expect(retryAfterMs("garbage")).toBe(5000);
    expect(retryAfterMs("7")).toBe(7000);
    expect(retryAfterMs(" 0 ")).toBe(0);
    const soon = new Date(Date.now() + 30_000).toUTCString();
    const ms = retryAfterMs(soon);
    expect(ms).toBeGreaterThan(20_000);
    expect(ms).toBeLessThanOrEqual(30_000);
    expect(retryAfterMs(new Date(Date.now() - 60_000).toUTCString())).toBe(0);
  });
});

// --- a client's deadline -------------------------------------------------------------

describe("a client's deadline", () => {
  /** A fetch that never answers until its signal aborts it, as undici's does. */
  const hanging: typeof fetch = (_input, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    });

  it("makes no request once the deadline has passed, and records no call", async () => {
    const seen: HostedCallInfo[] = [];
    const { db, calls } = client([json(["t"])], { deadlineMs: Date.now() - 1, onCall: (i) => seen.push(i) });
    const err = await db.listTables().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HostedError);
    expect(err).toMatchObject({ status: 0, op: "list_tables", pastDeadline: true });
    expect((err as Error).message).toBe("list_tables: no answer before this client's deadline");
    expect(calls).toHaveLength(0);
    expect(seen).toHaveLength(0);
    expect(db.lastCall()).toBeNull();
  });

  it("abandons a call in flight at the deadline, long before the call's own timeout", async () => {
    const t0 = Date.now();
    const db = new HostedDb({ ...target, apiKey: KEY }, { fetch: hanging, timeoutMs: 60_000, deadlineMs: t0 + 30 });
    const err = await db.schema("t").catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 0, op: "schema", pastDeadline: true });
    expect((err as Error).message).toMatch(/no answer before this client's deadline/);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(db.lastCall()).toMatchObject({ op: "schema", status: 0 });
    // The same hang on a client with no deadline is the call's own timeout,
    // and says so.
    const plain = new HostedDb({ ...target, apiKey: KEY }, { fetch: hanging, timeoutMs: 20 });
    const own = await plain.schema("t").catch((e: unknown) => e);
    expect(own).toMatchObject({ status: 0, pastDeadline: false });
    expect((own as Error).message).toMatch(/no response within 20 ms/);
  });

  it("does not wait out a 429's Retry-After past the deadline, and names the deadline as the budget", async () => {
    const t0 = Date.now();
    const { db, calls } = client([{ status: 429, body: "rate limited", headers: { "retry-after": "1" } }, json(["t"])], {
      timeoutMs: 60_000,
      deadlineMs: t0 + 200,
    });
    const err = await db.listTables().catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 429, pastDeadline: true, retryAfterSecs: 1 });
    expect((err as HostedError).atCapacity).toBe(true);
    expect((err as Error).message).toMatch(/gave up after 0 retries within this client's deadline/);
    expect(calls).toHaveLength(1);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("ends the cold-start retries at the deadline", async () => {
    const forever: Scripted[] = [];
    for (let i = 0; i < 10_000; i++) forever.push({ status: 503, body: "still spawning", headers: { "retry-after": "0" } });
    const t0 = Date.now();
    const { db, calls } = client(forever, { coldStartSecs: 120, deadlineMs: t0 + 50 });
    const err = await db.querySql("SELECT 1").catch((e: unknown) => e);
    expect(err).toMatchObject({ pastDeadline: true });
    expect(calls.length).toBeGreaterThan(1);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("leaves a call that fails on its own as it was: not past the deadline", async () => {
    const { db } = client([{ status: 404, body: "no such table" }], { deadlineMs: Date.now() + 60_000 });
    const err = await db.schema("gone").catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 404, pastDeadline: false });
    expect((err as Error).message).toBe("schema: server returned 404: no such table");
  });
});

// --- errors -------------------------------------------------------------------------

describe("errors", () => {
  it("reads a plain-text data-plane body and a JSON control-plane body", () => {
    expect(serverMessage(400, "unknown field `bogus`")).toBe("unknown field `bogus`");
    expect(serverMessage(401, JSON.stringify({ error: "unauthenticated" }))).toBe("unauthenticated");
    expect(serverMessage(400, JSON.stringify({ message: "bad" }))).toBe("bad");
    expect(serverMessage(500, JSON.stringify({ other: 1 }))).toBe('{"other":1}');
    expect(serverMessage(502, "")).toBe("HTTP 502");
  });

  it("throws a HostedError carrying the status and the server's message", async () => {
    const { db } = client([{ status: 400, body: "query_sql is read-only; row mutations use POST /v1/append/{database}?table=..." }]);
    const err = await db.querySql("INSERT INTO t VALUES (1)").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HostedError);
    expect(err).toMatchObject({ status: 400, op: "query_sql" });
    expect((err as Error).message).toBe("query_sql: server returned 400: query_sql is read-only; row mutations use POST /v1/append/{database}?table=...");
    expect(db.lastCall()).toMatchObject({ op: "query_sql", status: 400, retries: 0 });
  });

  it("a 401 surfaces as status 401 and never echoes the key", async () => {
    const { db } = client([{ status: 401, body: JSON.stringify({ error: "unauthenticated" }), headers: { "content-type": "application/json" } }]);
    const err = (await db.listTables().catch((e: unknown) => e)) as Error;
    expect(err).toMatchObject({ status: 401 });
    expect(err.message).toBe("list_tables: server returned 401: unauthenticated");
    expect(err.message).not.toContain(KEY);
    expect(JSON.stringify(err)).not.toContain(KEY);
  });

  it("refuses to build a client without an API key", () => {
    expect(() => new HostedDb({ ...target, apiKey: "" })).toThrow(/API key/);
  });

  it("times out a call that never answers and records status 0", async () => {
    const hanging: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    const seen: HostedCallInfo[] = [];
    const db = new HostedDb({ ...target, apiKey: KEY }, { fetch: hanging, timeoutMs: 20, onCall: (i) => seen.push(i) });
    const err = await db.listTables().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HostedError);
    expect(err).toMatchObject({ status: 0 });
    expect((err as Error).message).toMatch(/no response within 20 ms/);
    expect(seen).toEqual([expect.objectContaining({ op: "list_tables", status: 0, retries: 0 })]);
  });

  it("wraps a transport failure with status 0 and the cause", async () => {
    const failing: typeof fetch = async () => {
      throw new TypeError("fetch failed");
    };
    const db = new HostedDb({ ...target, apiKey: KEY }, { fetch: failing });
    const err = await db.listTables().catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 0 });
    expect((err as Error).message).toMatch(/request failed: fetch failed/);
    expect((err as Error).cause).toBeInstanceOf(TypeError);
  });

  it("a non-JSON success body on a JSON op is an error naming the op", async () => {
    const { db } = client([{ status: 200, body: "<html>", headers: { "content-type": "text/html" } }]);
    await expect(db.listTables()).rejects.toThrow(/list_tables.*not JSON/);
  });
});

// --- telemetry ---------------------------------------------------------------------

describe("telemetry", () => {
  it("parses the token and result-bytes headers when present and leaves them off when absent", async () => {
    const { db } = client([
      json([], { "x-infino-read-tokens": "0.050", "x-infino-result-bytes": "2" }),
      json({}, { "x-infino-write-tokens": "2.000" }),
      json([]),
    ]);
    await db.querySql("SELECT 1");
    expect(db.lastCall()).toMatchObject({ readTokens: 0.05, resultBytes: 2 });
    expect(db.lastCall()).not.toHaveProperty("writeTokens");
    await db.appendRows("t", []);
    expect(db.lastCall()).toMatchObject({ writeTokens: 2 });
    expect(db.lastCall()).not.toHaveProperty("readTokens");
    expect(db.lastCall()).not.toHaveProperty("resultBytes");
    await db.querySql("SELECT 1");
    expect(db.lastCall()).not.toHaveProperty("readTokens");
    expect(db.lastCall()).not.toHaveProperty("writeTokens");
    expect(db.lastCall()).not.toHaveProperty("resultBytes");
  });

  it("starts with no last call", () => {
    const { db } = client([]);
    expect(db.lastCall()).toBeNull();
  });
});

// --- Arrow IPC -----------------------------------------------------------------------

/** The wire facts of an integer type as the IPC reader hands it back. */
const intShape = (t: arrow.DataType): { signed: boolean; bits: number } | null =>
  arrow.DataType.isInt(t) ? { signed: t.isSigned, bits: t.bitWidth } : null;

describe("rowsToIpc", () => {
  const columns: JsonColumn[] = [
    { name: "path", type: "large_utf8", nullable: false },
    { name: "start_line", type: "int32", nullable: false },
    { name: "symbol", type: "large_utf8" },
    { name: "embedding", type: { type: "vector", dim: 3 }, nullable: false },
  ];

  it("encodes text as LargeUtf8, line numbers as Int32, vectors as FixedSizeList<Float32, dim>, keeping nullability", () => {
    const ipc = rowsToIpc(columns, [
      { path: "a.ts", start_line: 1, symbol: "f", embedding: [0.5, 0.25, -1] },
      { path: "b.ts", start_line: 20, embedding: Float32Array.from([1, 2, 3]) },
    ]);
    expect(ipc).toBeInstanceOf(Uint8Array);
    const table = arrow.tableFromIPC(ipc);
    const fields = table.schema.fields;
    expect(fields.map((f) => f.name)).toEqual(["path", "start_line", "symbol", "embedding"]);
    expect(fields[0].type).toBeInstanceOf(arrow.LargeUtf8);
    // The IPC reader materialises integers as the generic Int with a width,
    // so the check is on the wire facts: signed, 32 bits.
    expect(intShape(fields[1].type)).toEqual({ signed: true, bits: 32 });
    expect(fields[2].type).toBeInstanceOf(arrow.LargeUtf8);
    expect(fields[3].type).toBeInstanceOf(arrow.FixedSizeList);
    expect((fields[3].type as arrow.FixedSizeList).listSize).toBe(3);
    const item = (fields[3].type as arrow.FixedSizeList).children[0].type;
    expect(arrow.DataType.isFloat(item) && (item as arrow.Float).precision).toBe(arrow.Precision.SINGLE);
    // The engine compares an appended batch's nullability to the table's, so
    // the flags must be exactly what the descriptors declared (default true).
    expect(fields.map((f) => f.nullable)).toEqual([false, false, true, false]);
    expect(table.numRows).toBe(2);
    expect(table.getChild("path")!.toArray()).toEqual(["a.ts", "b.ts"]);
    expect(Array.from(table.getChild("start_line")!.toArray() as Int32Array)).toEqual([1, 20]);
    // An omitted key is a null, not an empty string.
    expect(table.getChild("symbol")!.get(0)).toBe("f");
    expect(table.getChild("symbol")!.get(1)).toBeNull();
    const emb = table.getChild("embedding")!;
    expect(Array.from(emb.get(0)!.toArray() as Float32Array)).toEqual([0.5, 0.25, -1]);
    expect(Array.from(emb.get(1)!.toArray() as Float32Array)).toEqual([1, 2, 3]);
  });

  it("leaves embedding columns out - the platform fills them", () => {
    const ipc = rowsToIpc(
      [{ name: "content", type: "large_utf8" }, { name: "auto", type: { type: "embedding", source: ["content"] } }],
      [{ content: "x" }],
    );
    expect(arrow.tableFromIPC(ipc).schema.fields.map((f) => f.name)).toEqual(["content"]);
  });

  it("carries 64-bit integers and the other scalar spellings", () => {
    const ipc = rowsToIpc(
      [
        { name: "a", type: "i64" },
        { name: "b", type: "u64" },
        { name: "c", type: "f64" },
        { name: "d", type: "bool" },
        { name: "e", type: "utf8" },
      ],
      [{ a: 5, b: 7n, c: 1.5, d: true, e: "s" }],
    );
    const table = arrow.tableFromIPC(ipc);
    expect(intShape(table.schema.fields[0].type)).toEqual({ signed: true, bits: 64 });
    expect(intShape(table.schema.fields[1].type)).toEqual({ signed: false, bits: 64 });
    expect(arrow.DataType.isFloat(table.schema.fields[2].type)).toBe(true);
    expect((table.schema.fields[2].type as arrow.Float).precision).toBe(arrow.Precision.DOUBLE);
    expect(table.schema.fields[3].type).toBeInstanceOf(arrow.Bool);
    expect(table.schema.fields[4].type).toBeInstanceOf(arrow.Utf8);
    expect(table.getChild("a")!.get(0)).toBe(5n);
    expect(table.getChild("b")!.get(0)).toBe(7n);
  });

  it("encodes zero rows as a schema-bearing empty stream", () => {
    const table = arrow.tableFromIPC(rowsToIpc(columns, []));
    expect(table.numRows).toBe(0);
    expect(table.schema.fields).toHaveLength(4);
  });

  it("rejects a missing or short vector rather than writing a wrong one", () => {
    expect(() => rowsToIpc(columns, [{ path: "a", start_line: 1, embedding: [1, 2] }])).toThrow(/has 2 values, expected 3/);
    expect(() => rowsToIpc(columns, [{ path: "a", start_line: 1 }])).toThrow(/no vector/);
  });

  it("rejects an unknown column type", () => {
    expect(() => rowsToIpc([{ name: "x", type: "decimal" }], [])).toThrow(/unsupported column type "decimal"/);
  });

  it("round-trips a vector append through the client untouched", async () => {
    const { db, calls } = client([json({})]);
    const ipc = rowsToIpc(columns, [{ path: "a.ts", start_line: 1, embedding: [1, 2, 3] }]);
    await db.appendIpc("chunks", ipc);
    expect(arrow.tableFromIPC(calls[0].body as Uint8Array).numRows).toBe(1);
  });
});

describe("reads that ask for a rerank", () => {
  it("send validate and rerank on the statement and read the platform's envelope", async () => {
    const { db, calls } = client([
      json({ rows: [{ id: 2 }, { id: 1 }], validation: { valid: true, check: "anchors" }, rerank: { model: "typesafe/jev-1.13" } }),
    ]);
    const checked = await db.querySqlChecked("SELECT id FROM t", {
      validate: { table_name: "t", field_name: "body", question: "q" },
      rerank: { question: "q" },
    });
    expect(checked.rows).toEqual([{ id: 2 }, { id: 1 }]);
    expect(checked.validation).toMatchObject({ valid: true });
    expect(checked.rerank).toMatchObject({ model: "typesafe/jev-1.13" });
    expect(bodyJson(calls[0])).toEqual({
      query: "SELECT id FROM t",
      validate: { table_name: "t", field_name: "body", question: "q" },
      rerank: { question: "q" },
    });
  });

  it("fall back to no rerank on a platform that predates it, and stop asking", async () => {
    const refused: Scripted = {
      status: 400,
      body: JSON.stringify({ message: "unknown field `rerank`, expected one of `query`, `validate`" }),
      headers: { "content-type": "application/json" },
    };
    const { db, calls } = client([refused, json([{ id: 1 }]), json([{ id: 3 }])]);
    const first = await db.querySqlChecked("SELECT id FROM t", { rerank: { question: "q" } });
    expect(first.rows).toEqual([{ id: 1 }]);
    expect(bodyJson(calls[0]).rerank).toEqual({ question: "q" });
    expect(bodyJson(calls[1]).rerank).toBeUndefined();
    // Remembered: the next read does not ask again.
    await db.bm25Search("t", "body", "x", 5, [], { question: "q", k: 5 });
    expect(calls).toHaveLength(3);
    expect(bodyJson(calls[2]).rerank).toBeUndefined();
  });

  it("fall back to no rerank on a deployment whose gateway runs no grader (501)", async () => {
    const refused: Scripted = {
      status: 501,
      body: JSON.stringify({ message: "rerank is not available on this deployment; send the query without `rerank`" }),
      headers: { "content-type": "application/json" },
    };
    const { db, calls } = client([refused, json([{ id: 1 }])]);
    const rows = await db.hybridSearch("t", "body", "emb", "x", 5, [], { question: "q", k: 5 });
    expect(rows).toEqual([{ id: 1 }]);
    expect(calls).toHaveLength(2);
    expect(bodyJson(calls[0]).rerank).toEqual({ question: "q", k: 5 });
    expect(bodyJson(calls[1]).rerank).toBeUndefined();
  });

  it("retry a rerank whose k is over the pool without k, and keep reranking later reads", async () => {
    const overPool: Scripted = {
      status: 400,
      body: JSON.stringify({ message: "rerank: 500 rows asked for, and this deployment grades at most 200" }),
      headers: { "content-type": "application/json" },
    };
    const { db, calls } = client([overPool, json([{ id: 2 }, { id: 1 }]), json([{ id: 3 }])]);
    const first = await db.querySqlChecked("SELECT id FROM t", { rerank: { question: "q", k: 500 } });
    expect(first.rows).toEqual([{ id: 2 }, { id: 1 }]);
    expect(calls).toHaveLength(2);
    expect(bodyJson(calls[0]).rerank).toEqual({ question: "q", k: 500 });
    expect(bodyJson(calls[1]).rerank).toEqual({ question: "q" });
    // Not remembered as "no rerank": the next read still asks.
    expect(db.reranksOnRead).toBe(true);
    await db.bm25Search("t", "body", "x", 5, [], { question: "q", k: 5 });
    expect(bodyJson(calls[2]).rerank).toEqual({ question: "q", k: 5 });
  });

  it("turn the rerank off when the retry without k is refused as well", async () => {
    const refused: Scripted = {
      status: 400,
      body: JSON.stringify({ message: "unknown field `rerank`, expected one of `query`, `validate`" }),
      headers: { "content-type": "application/json" },
    };
    const { db, calls } = client([refused, refused, json([{ id: 1 }])]);
    const first = await db.querySqlChecked("SELECT id FROM t", { rerank: { question: "q", k: 5 } });
    expect(first.rows).toEqual([{ id: 1 }]);
    expect(calls.map((c) => bodyJson(c).rerank)).toEqual([{ question: "q", k: 5 }, { question: "q" }, undefined]);
    expect(db.reranksOnRead).toBe(false);
  });

  it("let any other refusal stand", async () => {
    const refused: Scripted = {
      status: 400,
      body: JSON.stringify({ message: "query_sql is read-only" }),
      headers: { "content-type": "application/json" },
    };
    const { db } = client([refused]);
    await expect(db.querySqlChecked("DELETE FROM t", { rerank: { question: "q" } })).rejects.toThrow("read-only");
  });
});

describe("a checked read whose check cannot answer", () => {
  const VALIDATE = { validate: { table_name: "t", field_name: "body" } };
  const rows = [{ id: 1 }, { id: 2 }];
  const error = (status: number, message: string): Scripted => ({
    status,
    body: JSON.stringify({ message }),
    headers: { "content-type": "application/json" },
  });

  it("resends without the check where the deployment does not validate, and asks for it no more", async () => {
    const { db, calls } = client([error(400, "validate is not available on this deployment"), json(rows), json(rows)]);
    expect(await db.querySqlChecked("SELECT id FROM t", VALIDATE)).toEqual({ rows });
    expect(calls.map((c) => bodyJson(c).validate === undefined)).toEqual([false, true]);
    expect(db.validatesOnRead).toBe(false);
    // The next read goes out plain at once.
    expect(await db.querySqlChecked("SELECT id FROM t", VALIDATE)).toEqual({ rows });
    expect(calls).toHaveLength(3);
    expect(bodyJson(calls[2]).validate).toBeUndefined();
  });

  it("returns the rows plain when the checked read fails for any other reason, and keeps asking next time", async () => {
    // A 503 on the checked attempt is not waited out: it has the plain read to fall back to.
    const { db, calls } = client([error(503, "the worker is restarting"), json(rows)], { coldStartSecs: 60 });
    expect(await db.querySqlChecked("SELECT id FROM t", VALIDATE)).toEqual({ rows });
    expect(calls).toHaveLength(2);
    expect(bodyJson(calls[1]).validate).toBeUndefined();
    expect(db.validatesOnRead).toBe(true);
  });

  it("returns the rows plain when the platform rejects the check's own arguments", async () => {
    const { db, calls } = client([error(400, "validate: no column named body in t"), json(rows)]);
    expect(await db.querySqlChecked("SELECT id FROM t", VALIDATE)).toEqual({ rows });
    expect(calls).toHaveLength(2);
    expect(bodyJson(calls[1]).validate).toBeUndefined();
    // Not a deployment without validation: the next read still asks.
    expect(db.validatesOnRead).toBe(true);
  });

  it("refuses a statement the platform refuses, in the plain read's words", async () => {
    const { db, calls } = client([error(400, "query_sql is read-only"), error(400, "query_sql is read-only")]);
    await expect(db.querySqlChecked("DELETE FROM t", VALIDATE)).rejects.toThrow("read-only");
    expect(calls).toHaveLength(2);
  });

  it("lets a refusal of the key or the account stand, without a second read", async () => {
    for (const status of [401, 402, 403]) {
      const { db, calls } = client([error(status, "refused")]);
      await expect(db.querySqlChecked("SELECT id FROM t", VALIDATE), String(status)).rejects.toThrow();
      expect(calls, String(status)).toHaveLength(1);
    }
  });

  it("gives the checked attempt a budget of its own, and returns the rows plain past it", async () => {
    // The checked read never answers; the plain one does at once.
    let call = 0;
    const fetchImpl: typeof fetch = (_input, init) => {
      call += 1;
      if (call === 1) {
        return new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
      }
      return Promise.resolve(new Response(JSON.stringify(rows), { status: 200, headers: { "content-type": "application/json" } }));
    };
    const db = new HostedDb({ ...target, apiKey: KEY }, { fetch: fetchImpl, timeoutMs: 60_000, checkedReadTimeoutMs: 50 });
    const t0 = performance.now();
    expect(await db.querySqlChecked("SELECT id FROM t", VALIDATE)).toEqual({ rows });
    expect(call).toBe(2);
    // Bounded by the checked budget, not the client's minute.
    expect(performance.now() - t0).toBeLessThan(5_000);
  });
});
