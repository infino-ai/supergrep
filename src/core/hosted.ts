// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The platform REST client: code-context talks to an Infino platform database
// over its `/v1/<op>/<database>` data plane to keep the repository's chunks
// table there beside the local index (every build and sync writes both) and
// to run `search` against it. This file owns the
// wire: request shapes (field names as the platform's request structs spell
// them), auth, the cold-start retry loop, error decoding, and the Arrow IPC
// encoding an append carries. Nothing here knows about chunks or tools - the
// callers put the per-call telemetry (`HostedCallInfo`) in the usage ledger,
// never in what the model sees.

import * as arrow from "apache-arrow";
import { Agent, fetch as undiciFetch } from "undici";

import { jsonify } from "./json.js";
import type { Searched } from "./graph-expand.js";

// --- constants ------------------------------------------------------------------

/** The HTTP agent every platform call goes through. Node's global fetch runs
 * on undici with its own fixed timers - 300 s for the response headers, 300 s
 * of body silence - underneath whatever signal the caller passes, so a call
 * with a longer budget (an exploration queued at the platform's gate can
 * legitimately take longer than that before its headers arrive) would fail as
 * "fetch failed" before the platform answers. Those timers are off here (0
 * disables them): the client's own per-call deadline, `AbortSignal.timeout`
 * in `call`, is the one that applies. */
const PLATFORM_AGENT = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

/** undici's fetch, bound to that agent, in the shape the client is typed
 * against. Tests inject their own fetch instead. */
const platformFetch: typeof fetch = ((input: string | URL | Request, init?: RequestInit) =>
  undiciFetch(input as never, { ...(init as never as object), dispatcher: PLATFORM_AGENT } as never) as never as Promise<Response>) as typeof fetch;

/** Per-call wall clock before a request is abandoned, when the caller sets
 * none: a cold read against a large table can take tens of seconds; a minute
 * leaves room without hiding a hung connection. Exported so the settings
 * layer (config.ts) gives --db-timeout-ms this same default. */
export const DEFAULT_TIMEOUT_MS = 60_000;

/** How long the retry loop keeps re-issuing a retryable "not ready yet"
 * answer before giving up. Two minutes covers a database coming up without
 * stalling a session; a `Retry-After` longer than the budget is refused rather
 * than waited out. Exported for config.ts likewise. */
export const DEFAULT_COLD_START_SECS = 120;

/** Seconds to wait before a retry when the server sent no `Retry-After`. */
const DEFAULT_RETRY_AFTER_SECS = 5;

/** What a call says when its client's deadline (`HostedOptions.deadlineMs`)
 * ended it: never made, or abandoned in flight. */
const PAST_DEADLINE = "no answer before this client's deadline";

/** Milliseconds per second, named so the unit conversions read as such. */
const MS_PER_SEC = 1000;

/** Wall clock for one file's `PUT` to its upload session: an hour, so a
 * multi-gigabyte file on a slow link completes, while a connection that
 * hangs does not hold a hydrate forever. */
const UPLOAD_TIMEOUT_MS = 60 * 60 * MS_PER_SEC;

/** The database is not ready to answer yet; retryable. */
const HTTP_SERVICE_UNAVAILABLE = 503;
/** The platform is declining for now; retryable when it says when. */
const HTTP_OVERWHELMED = 529;
/** The platform is at capacity - its model pool or the provider's quota has
 * no room for this call right now - and says so at once rather than holding
 * the call until it burns its own wall cap. Retryable, with backoff, for as
 * long as the call's own budget allows. */
const HTTP_TOO_MANY_REQUESTS = 429;
/** A write lost a race (retryable when it carries `Retry-After`) or a name
 * already exists (terminal, no `Retry-After`). */
const HTTP_CONFLICT = 409;
/** The key was not accepted: absent, malformed, unknown, or revoked. The
 * platform does not distinguish between those, deliberately. Terminal - a
 * retry with the same key gets the same answer. */
const HTTP_UNAUTHORIZED = 401;
/** The account cannot spend: its balance is gone, or it never had one because
 * billing details were never completed. Terminal, and the one failure whose
 * fix is neither a retry nor a different key - it is a person adding their
 * details and a card - so callers with a user to tell say so specifically. */
const HTTP_PAYMENT_REQUIRED = 402;

/** The API version prefix every route lives under. */
const API_PREFIX = "/v1";

/** Response and request encodings the platform negotiates on. */
const JSON_CONTENT_TYPE = "application/json";
const ARROW_STREAM_CONTENT_TYPE = "application/vnd.apache.arrow.stream";

/** The metering headers the platform returns on every response: decimal
 * tokens (`"0.050"`), one for reads and one for writes, and the response's
 * bytes as its egress meter recorded them (an integer). */
const READ_TOKENS_HEADER = "x-infino-read-tokens";
const WRITE_TOKENS_HEADER = "x-infino-write-tokens";
const RESULT_BYTES_HEADER = "x-infino-result-bytes";

/** The hosts a plaintext `http://` target may name: the request never leaves
 * the machine, so the bearer credential is never on the wire in the clear. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1"]);

/** Every column type spelling the platform's `create_table` accepts, mapped to
 * the Arrow type an appended batch must carry for it. Mirrors the platform's
 * `data_type_from_str` so an IPC append matches the table the same descriptors
 * created. Text defaults to `large_utf8` on the platform side, so that is what a
 * code-context text column declares. */
const SCALAR_TYPES: Record<string, () => arrow.DataType> = {
  utf8: () => new arrow.Utf8(),
  string: () => new arrow.Utf8(),
  large_utf8: () => new arrow.LargeUtf8(),
  large_string: () => new arrow.LargeUtf8(),
  bool: () => new arrow.Bool(),
  boolean: () => new arrow.Bool(),
  i32: () => new arrow.Int32(),
  int32: () => new arrow.Int32(),
  i64: () => new arrow.Int64(),
  int64: () => new arrow.Int64(),
  u32: () => new arrow.Uint32(),
  uint32: () => new arrow.Uint32(),
  u64: () => new arrow.Uint64(),
  uint64: () => new arrow.Uint64(),
  f32: () => new arrow.Float32(),
  float32: () => new arrow.Float32(),
  f64: () => new arrow.Float64(),
  float64: () => new arrow.Float64(),
  double: () => new arrow.Float64(),
};

/** The 64-bit integer spellings, whose values are handed to Arrow as bigint. */
const INT64_TYPES = new Set(["i64", "int64", "u64", "uint64"]);

/** Arrow's IPC streaming format, as `tableToIPC` names it. */
const IPC_STREAM = "stream";

// --- public types ---------------------------------------------------------------

/** A hosted database: where it is, which database, and the key that opens it. */
export interface HostedTarget {
  baseUrl: string;
  database: string;
  apiKey: string;
}

/** What one logical call cost: the final status, the round trip of the
 * attempt that answered, how many retries the cold-start loop took, the
 * tokens the platform billed and the bytes its egress meter recorded for the
 * response (all from its response headers, when present). */
export interface HostedCallInfo {
  op: string;
  status: number;
  rttMs: number;
  retries: number;
  readTokens?: number;
  writeTokens?: number;
  resultBytes?: number;
}

export interface HostedOptions {
  /** Injected for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
  /** The budget of a checked read's checked attempt
   * (CHECKED_READ_TIMEOUT_MS by default). */
  checkedReadTimeoutMs?: number;
  /** Per-call timeout (default 60 s). */
  timeoutMs?: number;
  /** How long retryable failures are re-issued before giving up (default 120 s). */
  coldStartSecs?: number;
  /** An instant (`Date.now()` milliseconds) past which no call through this
   * client runs: one made after it fails at once without reaching the
   * platform, and one in flight then is abandoned, a wait before a retry
   * included. Every other budget of a call ends at it too. Absent, a call has
   * only its own budgets. For reads a server's start-up makes, which a
   * client waits on for a fixed time only (see serveMcp). */
  deadlineMs?: number;
  /** Called once per logical call with its telemetry. */
  onCall?: (info: HostedCallInfo) => void;
}

export type RowRecord = Record<string, unknown>;

/** What a card is asked for beyond its tier (`HostedDb.tableCard`): laid
 * out within a budget - `whole` columns listed whole, most rows with a
 * value first, and a map of at most `families` name families for the rest,
 * the layout the platform's own loop reads a wide table in - or the entries
 * matching a `pattern` (a column name; `*` for any run of characters, as
 * in `name*` or `*word*`; or `*` alone),
 * whole, most rows first, `limit` of them, with `matched` on the record
 * saying how many there were. The two forms do not go together. */
export interface TableCardOptions {
  whole?: number;
  families?: number;
  pattern?: string;
  limit?: number;
  /** With `pattern`: what the caller needs the columns for, so the ones it
   * needs come first - ranked by the pass the platform's loop ranks its
   * own lookups by. */
  question?: string;
}

/** What a read asks the platform to do to its rows before they come back:
 * check them against the question (`validate`, `query_sql` alone) and
 * order them by its grader for the question, keeping the top `k`
 * (`rerank`) - the triage pass the platform's own retrieval loop ranks its
 * results by. A search with `rerank` is fetched wider (the platform's triage pool)
 * and cut to `k` after. */
export interface ReadChecks {
  validate?: { table_name: string; field_name: string; question?: string };
  rerank?: { question: string; k?: number };
}

/** A read's rows with what the platform said of them. */
export interface CheckedRows {
  rows: RowRecord[];
  validation?: RowRecord;
  rerank?: RowRecord;
}

/** A 400 that says the deployment does not offer validation on a read: the
 * statement is fine, the check is not available here. */
export function validationUnavailable(err: unknown): boolean {
  return err instanceof HostedError && err.status === HTTP_BAD_REQUEST && /\bvalidat(e|ion)\b/i.test(err.message) && /not (available|supported|enabled)|unknown field|unsupported/i.test(err.message);
}

/** A refusal that would be the same for the plain statement: the key, the
 * account's balance or its rights (401, 402, 403). Any other failure of a
 * checked read - a 400 about the check's own arguments as much as a timeout
 * or a 5xx - may be the check's, so the statement is resent plain, and a
 * statement the platform refuses outright is refused again there, in its own
 * words. */
function refusedEitherWay(err: unknown): boolean {
  return err instanceof HostedError && (err.unauthenticated || err.paymentRequired || err.status === HTTP_FORBIDDEN);
}

/** The fields `checks` adds to a read's body: none for a check not asked. */
function readChecks(checks: ReadChecks): RowRecord {
  return {
    ...(checks.validate ? { validate: checks.validate } : {}),
    ...(checks.rerank ? { rerank: checks.rerank } : {}),
  };
}

/** The scope's cards as the platform's loop carries them in its prompt
 * (`GET /v1/table_card/{db}?tables=`): one rendering for the model inside
 * the loop and the one outside it. */
export interface PromptCards {
  /** The cards' JSON text, as the loop's prompt carries it. */
  cards: string;
  /** The tables' search vocabulary, as the prompt carries it; "" when none. */
  vocabulary: string;
  /** The tables whose cards `cards` shows, best first. */
  shown: string[];
  /** The tables `cards` names in a line each, without their cards. */
  listed: string[];
  /** The tables asked for that have no card yet. */
  missing: string[];
  tier: string;
  /** Whether the cards were ranked for a question rather than shown as
   * they are, and whether the platform's grader ranked them. */
  ranked: boolean;
  graded: boolean;
  /** The note the loop puts under the question when the cards are ranked
   * for one: the tables in the ranking's order and the columns judged to
   * hold what it asks. Absent otherwise. */
  note?: string;
}

/** One column of a `create_table` schema, in code-context's shape. A scalar is
 * the platform's type spelling (`"large_utf8"`, `"i32"`, ...); a vector column
 * names its width; an embedding column names the text columns the platform
 * embeds for it (the caller never sends its values). */
export interface JsonColumn {
  name: string;
  type: string | { type: "vector"; dim: number } | { type: "embedding"; source: string[] };
  nullable?: boolean;
}

export interface HostedIndexes {
  fts: Array<{ column: string; analyzer?: string }>;
  vector?: Array<{ column: string; metric: "cosine" | "l2sq" | "negdot" }>;
}

/** A failure the platform reported (or a transport failure, `status` 0). The
 * message carries the op, the status, and the server's own words - never the
 * request headers, so a credential cannot leak through an error. */
export class HostedError extends Error {
  /** Whether the platform was at capacity (429) for the whole of the call's
   * budget: the answer may well come on a later try, and a caller that has a
   * user to tell should say so. */
  get atCapacity(): boolean {
    return this.status === HTTP_TOO_MANY_REQUESTS;
  }

  /** Whether the account is out of credit, or never completed the billing
   * details that give it any. No retry and no other key fixes this: someone
   * has to add a payment method to this account, so a caller with a user to
   * tell says that instead of showing them a status code. */
  get paymentRequired(): boolean {
    return this.status === HTTP_PAYMENT_REQUIRED;
  }

  /** Whether the key itself was refused - absent, malformed, unknown or
   * revoked. Distinct from `paymentRequired`: this one is fixed by signing in
   * again, that one by paying. */
  get unauthenticated(): boolean {
    return this.status === HTTP_UNAUTHORIZED;
  }

  readonly status: number;
  readonly op: string;
  /** The server's `Retry-After`, in seconds, when the failure carried one. */
  readonly retryAfterSecs?: number;
  /** Whether the call ran out of its client's deadline (`deadlineMs`) rather
   * than failing on its own: not made at all, or abandoned in flight. The
   * platform said nothing about the table; the caller ran out of time. */
  readonly pastDeadline: boolean;

  constructor(op: string, status: number, message: string, options?: { retryAfterSecs?: number; cause?: unknown; pastDeadline?: boolean }) {
    super(status > 0 ? `${op}: server returned ${status}: ${message}` : `${op}: ${message}`, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "HostedError";
    this.op = op;
    this.status = status;
    if (options?.retryAfterSecs !== undefined) this.retryAfterSecs = options.retryAfterSecs;
    this.pastDeadline = options?.pastDeadline === true;
  }
}

// --- URLs -----------------------------------------------------------------------

/** Whether `s` names a hosted target (an `http(s)://` URL) rather than a local
 * path or object-store URI. */
export function isHostedUrl(s: string): boolean {
  return /^https?:\/\//.test(s);
}

/** Split `https://host/db` into the base URL and the database segment. Mirrors
 * the engine's own URI rule: `http://` is refused for anything but a loopback
 * host (a bearer credential must not travel in the clear), the database segment
 * is required, and it must be a single path segment - the routes are
 * `/v1/<op>/<database>`, so a nested path could not address anything. */
export function parseHostedUrl(url: string): { baseUrl: string; database: string } {
  const match = /^(https?):\/\/([^/?#]*)(.*)$/.exec(url);
  if (!match) {
    throw new Error(`hosted URL must start with https:// (or http:// for a loopback host): ${url}`);
  }
  const [, scheme, host, rest] = match;
  if (host.length === 0) throw new Error(`hosted URL is missing a host: ${url}`);
  if (scheme === "http") {
    const bare = host.split(":")[0];
    if (!LOOPBACK_HOSTS.has(bare)) {
      throw new Error(`http:// is only allowed for localhost; use https:// for a remote host: ${url}`);
    }
  }
  if (/[?#]/.test(rest)) throw new Error(`hosted URL must not carry a query or fragment: ${url}`);
  const database = rest.replace(/^\/+|\/+$/g, "");
  if (database.length === 0) {
    throw new Error(`hosted URL is missing the database segment (expected https://host/<database>): ${url}`);
  }
  if (database.includes("/")) {
    throw new Error(`hosted URL database must be a single path segment, got "${database}": ${url}`);
  }
  return { baseUrl: `${scheme}://${host}`, database };
}

// --- headers --------------------------------------------------------------------

/** The wait a `Retry-After` header asks for, in milliseconds: delta-seconds or
 * an HTTP-date, with the platform's activation hint standing in when the header
 * is absent or unreadable. Never negative - a date already past means "now". */
export function retryAfterMs(value: string | null): number {
  if (value !== null) {
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) return Number(trimmed) * MS_PER_SEC;
    const at = Date.parse(trimmed);
    if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  }
  return DEFAULT_RETRY_AFTER_SECS * MS_PER_SEC;
}

/** A decimal token header (`"0.050"`) as a number, or undefined when absent
 * or not numeric - a missing meter is not a zero bill. */
function tokensHeader(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name);
  if (raw === null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** The server's message out of an error body: plain text, or a JSON
 * `{"error": "..."}`. Both are read, and anything else comes back as the raw
 * text. */
export function serverMessage(status: number, body: string): string {
  const text = body.trim();
  if (text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      if (typeof parsed.error === "string") return parsed.error;
      if (typeof parsed.message === "string") return parsed.message;
    } catch {
      // not JSON after all - fall through to the raw text
    }
  }
  return text.length > 0 ? text : `HTTP ${status}`;
}

// --- the client -------------------------------------------------------------------

/** One HTTP exchange's outcome, before the op-specific decoding. */
interface Exchange {
  status: number;
  headers: Headers;
  text: string;
}

interface CallSpec {
  op: string;
  method: "GET" | "POST" | "DELETE";
  /** A path segment after the database (`/uploads` under `hydrate`), for the
   * few routes that nest one. */
  suffix?: string;
  /** Query-string parameters, appended after the database segment. */
  query?: Record<string, string>;
  body?: string | Uint8Array;
  contentType?: string;
  /** Whether the response is rows/JSON we want as JSON rather than Arrow. */
  acceptJson: boolean;
  timeoutMs: number;
  /** The cold-start budget for this call in place of the client's: 0 for an
   * attempt that has somewhere cheaper to fall back to. */
  coldStartMs?: number;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** An integer the platform wrote in full. */
const WHOLE_DIGITS = /^-?\d+$/;

/** The JSON reviver that keeps a large integer exact. The engine's `_id` is
 * a 128-bit integer, and the platform writes it as a JSON number with every
 * digit (`33023604937666786634178324594870`); JSON.parse alone rounds any
 * integer past 2^53 to the nearest double, and a row's id came back as
 * 3.3023604937666788e+31 - a number no statement can name the row by
 * (measured 2026-10-03: the graph expansion's seed lookups found ids and
 * lost every one). With the source text of the number (Node 21+), an
 * integer past the safe range becomes a bigint; everything else, and a
 * number written with a point or an exponent, parses as before. */
function keepBigIntegers(_key: string, value: unknown, context?: { source?: string }): unknown {
  if (typeof value === "number" && Number.isInteger(value) && !Number.isSafeInteger(value)) {
    const source = context?.source;
    if (typeof source === "string" && WHOLE_DIGITS.test(source)) return BigInt(source);
  }
  return value;
}

/** `PUT` one file's bytes to the upload session `url` an `openUploads`
 * answer gave for it: `size` bytes, as the session was opened for - the
 * storage refuses any other length - streamed from `body`. No bearer key:
 * the session URL is itself the capability, and the key must not reach the
 * storage host. The one request this client makes to a host other than the
 * platform's, so it goes through the same fetch the platform calls do
 * (`fetchImpl`, a test's scripted one) and no other. Fails with the
 * storage's own words. */
export async function uploadBytes(
  url: string,
  body: ReadableStream<Uint8Array>,
  size: number,
  fetchImpl: typeof fetch = platformFetch,
): Promise<void> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "PUT",
      headers: { "content-length": String(size) },
      body,
      // A streamed request body is sent half-duplex: the whole body goes up
      // before the answer is read. fetch requires the mode to be named for
      // any stream body; the DOM typing does not spell the field, hence the
      // cast.
      ...({ duplex: "half" } as Record<string, unknown>),
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    throw new HostedError("upload", 0, timedOut ? `no answer within ${UPLOAD_TIMEOUT_MS} ms` : `request failed: ${(err as Error).message}`, { cause: err });
  }
  if (!response.ok) throw new HostedError("upload", response.status, serverMessage(response.status, await response.text()));
}
/** The status a platform answers a read whose body it does not take. */
const HTTP_BAD_REQUEST = 400;
/** The status of a key the account's rights do not cover. */
const HTTP_FORBIDDEN = 403;
/** The budget a checked read has before its statement is resent plain: the
 * check rides on the statement, so a check that is slow holds the rows, and
 * past this the rows are worth more than the verdict. */
const CHECKED_READ_TIMEOUT_MS = 15_000;

export class HostedDb {
  /** Whether this platform refused a read's `rerank` - one that predates
   * it, whose read requests take no field they do not know. Set by the
   * first refusal; from then on a read goes out without it. */
  private rerankUnsupported = false;
  /** Set once this deployment refuses `validate` on a read: no later read
   * asks for it. */
  private validateUnsupported = false;
  /** Whether this deployment has said it does not validate on a read. */
  get validatesOnRead(): boolean {
    return !this.validateUnsupported;
  }

  readonly target: HostedTarget;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly coldStartMs: number;
  private readonly deadlineMs: number;
  private readonly onCall?: (info: HostedCallInfo) => void;
  private readonly checkedReadTimeoutMs: number;
  private last: HostedCallInfo | null = null;

  constructor(target: HostedTarget, opts: HostedOptions = {}) {
    if (!target.apiKey) {
      // Every route is bearer-only; failing here names the problem instead of
      // letting the first call come back as an opaque 401.
      throw new Error("hosted target needs an API key (apiKey / INFINO_API_KEY)");
    }
    this.target = { ...target, baseUrl: target.baseUrl.replace(/\/+$/, "") };
    this.fetchImpl = opts.fetch ?? platformFetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.coldStartMs = (opts.coldStartSecs ?? DEFAULT_COLD_START_SECS) * MS_PER_SEC;
    this.deadlineMs = opts.deadlineMs ?? Number.POSITIVE_INFINITY;
    this.onCall = opts.onCall;
    this.checkedReadTimeoutMs = opts.checkedReadTimeoutMs ?? CHECKED_READ_TIMEOUT_MS;
  }

  /** Telemetry of the most recent logical call, or null before the first. */
  lastCall(): HostedCallInfo | null {
    return this.last;
  }

  // --- tables ---

  /** `POST /v1/list_tables/{db}`: the database's table names. */
  async listTables(): Promise<string[]> {
    const exchange = await this.call({ op: "list_tables", method: "POST", acceptJson: true, timeoutMs: this.timeoutMs });
    return this.parseJson(exchange, "list_tables") as string[];
  }

  /** `POST /v1/schema/{db}` with `{table_name}`: the platform's JSON column
   * descriptors (`[{name, type, nullable, ...}]`), parsed as they came. */
  async schema(table: string): Promise<RowRecord> {
    const exchange = await this.postJson("schema", { table_name: table }, true);
    return this.parseJson(exchange, "schema") as RowRecord;
  }

  /** `POST /v1/create_table/{db}`: `{table_name, schema, indexes}`. A bare
   * `{column}` fts entry takes the platform's default analyzer (`standard`). */
  async createTable(table: string, columns: JsonColumn[], indexes: HostedIndexes): Promise<void> {
    const body: RowRecord = {
      table_name: table,
      schema: columns.map(toSchemaField),
      indexes: {
        fts: indexes.fts.map((f) => (f.analyzer === undefined ? { column: f.column } : { column: f.column, analyzer: f.analyzer })),
        ...(indexes.vector ? { vector: indexes.vector.map((v) => ({ column: v.column, metric: v.metric })) } : {}),
      },
    };
    await this.postJson("create_table", body, false);
  }

  /** `POST /v1/drop_table/{db}`: `{table_name, purge}`. The platform defaults
   * purge to true; it is sent explicitly so the request says what it does. */
  async dropTable(table: string, purge = true): Promise<void> {
    await this.postJson("drop_table", { table_name: table, purge }, false);
  }

  /** `POST /v1/validate/{db}`: did this result answer this question? The
   * retrieval-contract check the platform's own answering loop gates every
   * query on, over the caller's statement, rows and (optionally) question.
   *
   * Served by the table's worker: a refusal is diagnosed against the index -
   * which of the question's terms occur nowhere in `column`, so no query will
   * find them - and that lookup is what the call meters, with the billed
   * tokens on the response header like every other call. It is the
   * platform's own copy of the rules rather than a second implementation
   * here, which would drift from the loop's within a release. Sent with no
   * rows, it is the diagnosis alone: the check to make before a query.
   *
   * `valid: true` means the result would be accepted as the answer, NOT that
   * the answer is correct: rows that name the question's terms and say
   * something false pass. */
  async validate(req: {
    table: string;
    column: string;
    statement: string;
    rows: readonly object[];
    question?: string;
  }): Promise<RowRecord> {
    const body: RowRecord = { table_name: req.table, field_name: req.column, statement: req.statement, rows: req.rows };
    if (req.question !== undefined) body.question = req.question;
    // jsonify, not JSON.stringify: rows off the local engine carry bigint
    // cells (a COUNT(*) is one), and the aggregate case is the one this
    // check exists for - the first live run lost exactly that case here.
    const exchange = await this.call({
      op: "validate",
      method: "POST",
      body: jsonify(body),
      contentType: JSON_CONTENT_TYPE,
      acceptJson: true,
      timeoutMs: this.timeoutMs,
    });
    return this.parseJson(exchange, "validate") as RowRecord;
  }

  /** `POST /v1/cite/{db}`: an answer's `path:line` and `path:start-end`
   * citations checked against a code table, repaired where the index says
   * where they belong, and - on a deployment that runs the grading model -
   * each cited sentence graded against its lines. The response carries the
   * answer as it stands after the pass (`answer`), the counts (`citations`,
   * `held`), what was `repaired`, `unplaced`, `unheld` and why, and `graded`
   * when a model ran; the model and its key stay on the platform. The pass
   * the platform runs on its own written answers, offered here to a caller
   * whose answer its own model wrote. */
  async cite(req: { table: string; column: string; answer: string; question?: string }): Promise<RowRecord> {
    const body: RowRecord = { table_name: req.table, field_name: req.column, answer: req.answer };
    if (req.question !== undefined) body.question = req.question;
    const exchange = await this.call({
      op: "cite",
      method: "POST",
      body: jsonify(body),
      contentType: JSON_CONTENT_TYPE,
      acceptJson: true,
      timeoutMs: this.timeoutMs,
    });
    return this.parseJson(exchange, "cite") as RowRecord;
  }

  /** `POST /v1/join_keys/{db}`: the keys two or more tables join on, found
   * on their values by the platform - never by matching column names. Each
   * join comes with the two sides, the share of the referencing side's values
   * found on the other, whether a statement counted it, and `predicate`, the
   * `ON` clause ready to paste (`logs.instance_id = issues.instance_id`,
   * `split_part(code.path, '/', 1) = issues.project`). The first call over
   * a pair counts it on the data and the platform remembers the verdict;
   * later calls read it back. What an agent calls before it writes a JOIN. */
  async joinKeys(tables: readonly string[]): Promise<RowRecord> {
    const exchange = await this.call({
      op: "join_keys",
      method: "POST",
      body: jsonify({ tables }),
      contentType: JSON_CONTENT_TYPE,
      acceptJson: true,
      timeoutMs: this.timeoutMs,
    });
    return this.parseJson(exchange, "join_keys") as RowRecord;
  }

  /** `POST /v1/graph_expand/{db}`: the rows of the other tables the
   * platform's graph links to these rows of `table` - the rows a verified
   * join reaches from their key values, the definitions of the names a code
   * row uses (`relation: defines <name>`, first), the rows the platform read
   * as mentioning the same entities - by table, strongest first, each row
   * as that table's search shows it. The platform's own answering loop runs
   * the same expansion on its own retrievals; this is how a caller driving
   * retrieval itself gets it. `seeds` is how many of the rows seeded the
   * walk, `note` why nothing was reached when nothing was. Rows carry the
   * engine's `_id` when the caller has it, else their place or key; sent
   * through jsonify since a cell may be a bigint. With `searched`, the facts
   * matching the words searched come back too, from every document. */
  async graphExpand(table: string, rows: readonly object[], searched?: Searched): Promise<RowRecord> {
    const exchange = await this.call({
      op: "graph_expand",
      method: "POST",
      body: jsonify({ table_name: table, rows, ...(searched?.query ? { query: searched.query } : {}), ...(searched?.statement ? { statement: searched.statement } : {}) }),
      contentType: JSON_CONTENT_TYPE,
      acceptJson: true,
      timeoutMs: this.timeoutMs,
    });
    return (this.parseJson(exchange, "graph_expand") as RowRecord | null) ?? {};
  }

  /** `POST /v1/graph_facts/{db}`: one read statement over the facts the
   * platform's graph read from this database's text - its `facts` table,
   * kept beside the database and never in its catalog, so no statement over
   * the database can name it. Its rows, and a note when the deployment builds
   * no graph. */
  async graphFacts(sql: string): Promise<RowRecord> {
    const exchange = await this.call({
      op: "graph_facts",
      method: "POST",
      body: jsonify({ sql }),
      contentType: JSON_CONTENT_TYPE,
      acceptJson: true,
      timeoutMs: this.timeoutMs,
    });
    return (this.parseJson(exchange, "graph_facts") as RowRecord | null) ?? {};
  }

  /** `GET /v1/table_card/{db}?table=[&tier=]`: the table's card - its schema
   * with each column's index role, per-column statistics (min, max, distinct)
   * and sample rows, as the platform's optimizer last computed them from the
   * table itself. A tier asks for a particular depth (`lean` is the measured
   * shape; `enriched` adds column descriptions and synonyms; `semantic` adds
   * the semantic map and is large); absent, the platform serves the best it
   * has. `options` ask for the card in another form (TableCardOptions, below):
   * laid out within a budget, or the entries matching a pattern. Nothing
   * about keys: those are `joinKeys`'s to return. The one GET on this
   * client: the card is a read of stored state, not a query, and the
   * platform routes it that way. */
  async tableCard(table: string, tier?: string, options: TableCardOptions = {}): Promise<RowRecord> {
    const query: Record<string, string> = { table, ...(tier ? { tier } : {}) };
    for (const [name, value] of Object.entries(options)) {
      if (value !== undefined) query[name] = String(value);
    }
    const exchange = await this.call({
      op: "table_card",
      method: "GET",
      query,
      acceptJson: true,
      timeoutMs: this.timeoutMs,
    });
    return this.parseJson(exchange, "table_card") as RowRecord;
  }

  /** `GET /v1/table_card/{db}?tables=[&tier=][&question=][&overview=true]`:
   * with `overview` and no question, every table in one line instead of its
   * card (what the start-up text describes a database by when its cards do
   * not fit); otherwise the cards of
   * `tables` rendered exactly as the platform's loop carries them in its
   * prompt - the same tables,
   * joins, layout and character budget, ranked for `question` when one is
   * given and the cards do not fit as they are - for this client to fold
   * into its own text unchanged rather than lay the cards out itself. A
   * platform that predates the form refuses it (it asks for `table`). */
  async promptCards(tables: readonly string[], tier?: string, question?: string, overview = false): Promise<PromptCards> {
    const query: Record<string, string> = {
      tables: tables.join(","),
      ...(tier ? { tier } : {}),
      ...(question ? { question } : {}),
      ...(overview && !question ? { overview: "true" } : {}),
    };
    const exchange = await this.call({
      op: "table_card",
      method: "GET",
      query,
      acceptJson: true,
      timeoutMs: this.timeoutMs,
    });
    const rendered = this.parseJson(exchange, "table_card") as RowRecord | null;
    // A platform that predates the form answers with something else, or not
    // at all: only the rendering itself is folded in.
    if (typeof rendered?.cards !== "string" || !Array.isArray(rendered.shown) || !Array.isArray(rendered.listed)) {
      throw new HostedError("table_card", 0, "the platform did not render the cards (no `cards` in its answer)");
    }
    return {
      cards: rendered.cards,
      vocabulary: typeof rendered.vocabulary === "string" ? rendered.vocabulary : "",
      shown: rendered.shown as string[],
      listed: rendered.listed as string[],
      missing: Array.isArray(rendered.missing) ? (rendered.missing as string[]) : [],
      tier: typeof rendered.tier === "string" ? rendered.tier : "",
      ranked: rendered.ranked === true,
      graded: rendered.graded === true,
      ...(typeof rendered.note === "string" ? { note: rendered.note } : {}),
    };
  }

  /** `GET /v1/hydrate/{db}?table=`: the record of the hydrate job that loaded
   * the table - its request (the columns it indexed and embedded, and how it
   * cut a long text column into passages), state and progress. A 404 for a
   * table no hydrate job loaded. */
  async hydrateJob(table: string): Promise<RowRecord> {
    const exchange = await this.call({
      op: "hydrate",
      method: "GET",
      query: { table },
      acceptJson: true,
      timeoutMs: this.timeoutMs,
    });
    return this.parseJson(exchange, "hydrate") as RowRecord;
  }

  /** `POST /v1/hydrate/{db}`: admit a hydrate job from `request`, the
   * platform's own request shape (`table`, `source`, `format`, `fts`,
   * `embed`, `chunk`, `if_exists`, `dry_run`, ...; the gateway refuses a
   * field it does not know, so nothing is added here). `202` with the job's
   * name and state - or, naming no table, one job per folder of the source -
   * and `200` for a dry run, which checks the job's admission and writes
   * nothing. Answered by the gateway from the job's envelope, so a cold
   * database never holds it. */
  async hydrateSubmit(request: RowRecord): Promise<RowRecord> {
    const exchange = await this.call({
      op: "hydrate",
      method: "POST",
      body: jsonify(request),
      contentType: JSON_CONTENT_TYPE,
      acceptJson: true,
      timeoutMs: this.timeoutMs,
    });
    return this.parseJson(exchange, "hydrate") as RowRecord;
  }

  /** `DELETE /v1/hydrate/{db}?table=`: cancel the table's live job (`202`,
   * the job now `cancelling`, returned) or clear an ended one so the table
   * can be hydrated again (`200`, no body: null). */
  async hydrateCancel(table: string): Promise<RowRecord | null> {
    const exchange = await this.call({
      op: "hydrate",
      method: "DELETE",
      query: { table },
      acceptJson: true,
      timeoutMs: this.timeoutMs,
    });
    return this.parseJson(exchange, "hydrate") as RowRecord | null;
  }

  /** `POST /v1/hydrate/{db}/uploads`: open an upload of files that are in
   * no bucket yet into the database's storage - files on the machine this
   * runs on, or on one it reaches (core/uploads.ts). `files` are each file's
   * path under the upload's root and its size; `origin` is the web origin
   * the platform lists as allowed to upload (the sessions are issued for
   * it). The answer carries the upload's id, the `prefix` under the database
   * root a hydrate request then loads from, and one session URL per file,
   * which the file's bytes are `PUT` to ([`uploadBytes`]) - straight to the
   * storage the database lives on, never through the gateway. */
  async openUploads(origin: string, files: Array<{ name: string; size: number }>, upload?: string): Promise<RowRecord> {
    const body: RowRecord = { origin, files };
    if (upload !== undefined) body.upload = upload;
    const exchange = await this.call({
      op: "hydrate",
      suffix: "/uploads",
      method: "POST",
      body: jsonify(body),
      contentType: JSON_CONTENT_TYPE,
      acceptJson: true,
      timeoutMs: this.timeoutMs,
    });
    return this.parseJson(exchange, "uploads") as RowRecord;
  }

  // --- writes ---

  /** `POST /v1/append/{db}?table=T` with an Arrow IPC stream body - the only
   * append encoding that can carry a vector column. */
  async appendIpc(table: string, ipc: Uint8Array): Promise<void> {
    await this.call({
      op: "append",
      method: "POST",
      query: { table },
      body: ipc,
      contentType: ARROW_STREAM_CONTENT_TYPE,
      acceptJson: true,
      timeoutMs: this.timeoutMs,
    });
  }

  /** `POST /v1/append/{db}?table=T` with the JSON `{"data": [...]}` envelope.
   * Rows are decoded server-side against the table's schema; a vector column
   * cannot ride this path (use `appendIpc`). */
  async appendRows(table: string, rows: RowRecord[]): Promise<void> {
    await this.call({
      op: "append",
      method: "POST",
      query: { table },
      body: jsonify({ data: rows }),
      contentType: JSON_CONTENT_TYPE,
      acceptJson: true,
      timeoutMs: this.timeoutMs,
    });
  }

  /** `POST /v1/remember/{db}` with `{"data": [...]}`: rows for the database's
   * memory, which the platform keeps in a store of its own under the
   * database's root and lists in no table listing. Each row is `{kind,
   * content, question?, path?, session_id?, created_at?}`; the platform
   * creates the store on the first write and embeds `question` and `content`
   * where the account embeds. */
  async remember(rows: RowRecord[]): Promise<void> {
    await this.postJson("remember", { data: rows }, true);
  }

  /** `POST /v1/recall/{db}`: the `k` memory rows nearest `query`, best first,
   * each `{kind, question, content, path, session_id, created_at, score}`;
   * none before anything was remembered. `kinds` keeps the recall to the
   * rows of those kinds: the hook's own answers and files, never the
   * playbook bullets a curator remembered for the platform's loop. */
  async recall(query: string, k: number, kinds?: readonly string[]): Promise<RowRecord[]> {
    const body: RowRecord = { query, k };
    if (kinds?.length) body.kinds = [...kinds];
    return this.rows(await this.postJson("recall", body, true), "recall");
  }

  /** `POST /v1/page/{db}`: the page a row of `table` came from - the row's
   * `document` and a page counted from 1 - as its scanned image:
   * `{media_type, data, width, height}`, `data` base64. Where the table's
   * documents lie is the deployment's to say (its card's `pages`); the
   * platform reads the document there, with the database's own credential,
   * and refuses a page drawn rather than scanned by name. */
  async page(table: string, document: string, page: number): Promise<RowRecord> {
    return this.parseJson(await this.postJson("page", { table, document, page }, true), "page") as RowRecord;
  }

  /** POST /v1/fetch/{database}: the text of the web page at `url`, from
   * character `offset` on - `{url, content_type, text, offset, total_chars,
   * next_offset}`. The platform reads the page, and refuses an address that
   * is not on the public internet. */
  async webFetch(url: string, offset: number): Promise<RowRecord> {
    return this.parseJson(await this.postJson("fetch", { url, offset }, true), "fetch") as RowRecord;
  }

  /** `POST /v1/delete/{db}?table=T&predicate=P` (no body): the mutation's
   * `{matched, n_tombstoned, n_not_found}`. */
  async deleteWhere(table: string, predicate: string): Promise<RowRecord> {
    const exchange = await this.call({
      op: "delete",
      method: "POST",
      query: { table, predicate },
      acceptJson: true,
      timeoutMs: this.timeoutMs,
    });
    return this.parseJson(exchange, "delete") as RowRecord;
  }

  // --- reads ---

  /** `POST /v1/query_sql/{db}` with `{query}`: rows as a JSON array. Used by
   * a sync's recount of the table, and by `sql` when the hosted index is the
   * one being read (see `hybridSearch`). */
  async querySql(sql: string): Promise<RowRecord[]> {
    return this.rows(await this.postJson("query_sql", { query: sql }, true), "query_sql");
  }

  /** `POST /v1/query_sql/{db}` with `{query, validate?, rerank?}`: the rows
   * with what the platform did to them in the same call - checked against
   * the question (`validate`) and ordered by its grader (`rerank`) where
   * they lie, so no row travels back up to be checked or ranked. */
  async querySqlChecked(sql: string, checks: ReadChecks): Promise<CheckedRows> {
    const plain = (asked: ReadChecks, coldStartMs?: number, timeoutMs?: number) =>
      this.withRerank(asked, (c) =>
        this.postJson("query_sql", { query: sql, ...readChecks(c) }, true, coldStartMs, timeoutMs).then((exchange) =>
          this.checkedRows(exchange, "query_sql"),
        ),
      );
    if (!checks.validate || this.validateUnsupported) return plain({ ...checks, validate: undefined });
    try {
      // The checked attempt waits out no cold start and has a budget of its
      // own (CHECKED_READ_TIMEOUT_MS): a database coming up, or a check that
      // will not answer, is left to the plain statement below, which has the
      // rows to give - so the worst case is that budget plus one plain read.
      return await plain(checks, 0, this.checkedReadTimeoutMs);
    } catch (err) {
      if (refusedEitherWay(err)) throw err;
      // A deployment without validation says so; no later statement asks.
      if (validationUnavailable(err)) this.validateUnsupported = true;
      // Whatever kept the check from answering, the rows still come.
      return plain({ ...checks, validate: undefined });
    }
  }

  /** `read` with `checks`, and - when the platform refuses the `rerank`
   * because it predates it (a 400 naming the field) - again without it,
   * remembering the refusal so no later read asks: a platform without the
   * rerank answers as it did before the client knew of it. Any other
   * failure is the read's own. */
  private async withRerank<T>(checks: ReadChecks, read: (checks: ReadChecks) => Promise<T>): Promise<T> {
    if (!checks.rerank || this.rerankUnsupported) return read({ ...checks, rerank: undefined });
    try {
      return await read(checks);
    } catch (err) {
      if (!(err instanceof HostedError && err.status === HTTP_BAD_REQUEST && /\brerank\b/.test(err.message))) throw err;
      this.rerankUnsupported = true;
      return read({ ...checks, rerank: undefined });
    }
  }

  /** `POST /v1/hybrid_search/{db}`: BM25 and the vector leg fused, over the
   * HOSTED index, returned as rows.
   *
   * `vector_text` is the whole point - the platform embeds the query with the
   * column's own model, so a caller needs no embedder, no model download and
   * no vectors of its own, and the query is embedded by the same recipe that
   * embedded the rows. That is not something a client can arrange for itself:
   * embedding a query locally with a different model would rank it against a
   * space it does not belong to.
   *
   * This exists so that the hosted index can be read WITHOUT the platform's
   * answering loop. Before it, the only remote retrieval surface was the
   * platform's loop itself - so "hosted index, local brain" was not
   * expressible, and the choice was the whole platform or none of it. A reviewer asked for exactly that middle configuration and it
   * could not be measured. */
  async hybridSearch(
    table: string,
    textField: string,
    vectorField: string,
    query: string,
    k: number,
    projection: string[],
    rerank?: ReadChecks["rerank"],
  ): Promise<RowRecord[]> {
    return this.withRerank({ rerank }, (asked) =>
      this.postJson(
        "hybrid_search",
        {
          table_name: table,
          text_field: textField,
          text_query: query,
          // The engine's Or: a row need not carry every term. The platform's
          // own loop searches the same way.
          mode: "Or",
          vector_field: vectorField,
          vector_text: query,
          k,
          projection,
          ...readChecks(asked),
        },
        true,
      ).then((exchange) => this.checkedRows(exchange, "hybrid_search").rows),
    );
  }

  /** `POST /v1/vector_search/{db}` with `query_text`: the `k` rows nearest
   * `text` by `field`, the text embedded on the platform. The platform
   * embeds it only for an embedding column of the model it embeds queries
   * with, and refuses any other column with a 400 saying why - for a column
   * filled under another model, both models named. No projection is sent,
   * so each row comes back as the engine's `_id` and `score`. */
  async vectorSearchText(table: string, field: string, text: string, k: number): Promise<RowRecord[]> {
    return this.rows(
      await this.postJson("vector_search", { table_name: table, field_name: field, query_text: text, k }, true),
      "vector_search",
    );
  }

  /** `POST /v1/bm25_search/{db}`: the keyword leg alone over the HOSTED
   * index, returned as rows. The search a table without an embedding column
   * gets: there is no vector to fuse, and asking `hybrid_search` for one is
   * a 400. Same `Or` as the hybrid search, for the same reason. */
  async bm25Search(
    table: string,
    field: string,
    query: string,
    k: number,
    projection: string[],
    rerank?: ReadChecks["rerank"],
  ): Promise<RowRecord[]> {
    return this.withRerank({ rerank }, (asked) =>
      this.postJson(
        "bm25_search",
        { table_name: table, field_name: field, query, k, mode: "Or", projection, ...readChecks(asked) },
        true,
      ).then((exchange) => this.checkedRows(exchange, "bm25_search").rows),
    );
  }

  // --- plumbing ---

  /** A JSON request body. Through jsonify, as every body here: a value the
   * caller took from a platform answer may carry a bigint
   * (`keepBigIntegers`), which JSON.stringify refuses and Number() rounds. */
  private postJson(op: string, body: RowRecord, acceptJson: boolean, coldStartMs?: number, timeoutMs?: number): Promise<Exchange> {
    return this.call({
      op,
      method: "POST",
      body: jsonify(body),
      contentType: JSON_CONTENT_TYPE,
      acceptJson,
      timeoutMs: timeoutMs ?? this.timeoutMs,
      ...(coldStartMs !== undefined ? { coldStartMs } : {}),
    });
  }

  /** A read response as rows. The platform answers Arrow unless asked for JSON,
   * so a body that came back as Arrow means the negotiation failed - said so,
   * rather than handed to JSON.parse. An empty body is an empty result. */
  private rows(exchange: Exchange, op: string): RowRecord[] {
    const contentType = exchange.headers.get("content-type") ?? "";
    if (contentType.includes(ARROW_STREAM_CONTENT_TYPE)) {
      throw new HostedError(op, exchange.status, "expected JSON rows but the server answered an Arrow stream");
    }
    if (exchange.text.trim().length === 0) return [];
    return this.parseJson(exchange, op) as RowRecord[];
  }

  /** A read response that may be the platform's envelope - `{rows,
   * validation?, rerank?}`, what a read that asked for a check or a rerank
   * gets - or the bare rows a read that asked for neither does. */
  private checkedRows(exchange: Exchange, op: string): CheckedRows {
    const contentType = exchange.headers.get("content-type") ?? "";
    if (contentType.includes(ARROW_STREAM_CONTENT_TYPE)) {
      throw new HostedError(op, exchange.status, "expected JSON rows but the server answered an Arrow stream");
    }
    const parsed = this.parseJson(exchange, op);
    if (parsed === null) return { rows: [] };
    if (Array.isArray(parsed)) return { rows: parsed as RowRecord[] };
    const envelope = parsed as RowRecord;
    return {
      rows: Array.isArray(envelope.rows) ? (envelope.rows as RowRecord[]) : [],
      ...(envelope.validation && typeof envelope.validation === "object" ? { validation: envelope.validation as RowRecord } : {}),
      ...(envelope.rerank && typeof envelope.rerank === "object" ? { rerank: envelope.rerank as RowRecord } : {}),
    };
  }

  private parseJson(exchange: Exchange, op: string): unknown {
    if (exchange.text.trim().length === 0) return null;
    try {
      return JSON.parse(exchange.text, keepBigIntegers as (this: unknown, key: string, value: unknown) => unknown);
    } catch (err) {
      throw new HostedError(op, exchange.status, `response is not JSON: ${(err as Error).message}`);
    }
  }

  private url(op: string, query?: Record<string, string>, suffix = ""): string {
    let url = `${this.target.baseUrl}${API_PREFIX}/${op}/${encodeURIComponent(this.target.database)}${suffix}`;
    if (query) url += `?${new URLSearchParams(query).toString()}`;
    return url;
  }

  /** One logical call: issue the request, re-issue it while the platform says
   * "not yet" (503 / 529, and a 409 that carries `Retry-After` - a write that
   * lost the single-writer race; a 409 without one is a name collision and
   * terminal) until the cold-start budget is spent, or while it says "at
   * capacity" (429) until the call's own budget is spent, then record the
   * telemetry and either return the exchange or throw the server's error.
   * Two budgets because they are two different waits: a database coming up
   * is bounded by --cold-start-secs whatever the call; a pool with no room is
   * worth waiting on for exactly as long as the caller would wait for the
   * answer itself. A client with a deadline (`deadlineMs`) ends both budgets
   * there: no request starts after it, the one in flight is abandoned at it,
   * and a wait that would outlive it is not taken. */
  private async call(spec: CallSpec): Promise<Exchange> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.target.apiKey}` };
    if (spec.acceptJson) headers.accept = JSON_CONTENT_TYPE;
    if (spec.contentType) headers["content-type"] = spec.contentType;
    const url = this.url(spec.op, spec.query, spec.suffix);
    const started = Date.now();
    const coldStartMs = spec.coldStartMs ?? this.coldStartMs;
    const coldStartDeadline = Math.min(started + coldStartMs, this.deadlineMs);
    const capacityDeadline = Math.min(started + spec.timeoutMs, this.deadlineMs);
    let retries = 0;

    for (;;) {
      // The attempt's own timeout, or what is left of the client's deadline
      // when that comes first.
      const left = this.deadlineMs - Date.now();
      if (left <= 0) throw new HostedError(spec.op, 0, PAST_DEADLINE, { pastDeadline: true });
      const cutByDeadline = left < spec.timeoutMs;
      const t0 = performance.now();
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: spec.method,
          headers,
          // fetch takes a Uint8Array body; the DOM typing only spells it as
          // BodyInit, hence the cast.
          ...(spec.body !== undefined ? { body: spec.body as BodyInit } : {}),
          signal: AbortSignal.timeout(cutByDeadline ? left : spec.timeoutMs),
        });
      } catch (err) {
        const rttMs = performance.now() - t0;
        this.record({ op: spec.op, status: 0, rttMs, retries });
        const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
        const pastDeadline = timedOut && cutByDeadline;
        throw new HostedError(
          spec.op,
          0,
          pastDeadline ? PAST_DEADLINE : timedOut ? `no response within ${spec.timeoutMs} ms` : `request failed: ${(err as Error).message}`,
          { cause: err, pastDeadline },
        );
      }
      const text = await response.text();
      const rttMs = performance.now() - t0;
      const info: HostedCallInfo = { op: spec.op, status: response.status, rttMs, retries };
      const readTokens = tokensHeader(response.headers, READ_TOKENS_HEADER);
      const writeTokens = tokensHeader(response.headers, WRITE_TOKENS_HEADER);
      const resultBytes = tokensHeader(response.headers, RESULT_BYTES_HEADER);
      if (readTokens !== undefined) info.readTokens = readTokens;
      if (writeTokens !== undefined) info.writeTokens = writeTokens;
      if (resultBytes !== undefined) info.resultBytes = resultBytes;

      if (response.ok) {
        this.record(info);
        return { status: response.status, headers: response.headers, text };
      }

      const retryAfter = response.headers.get("retry-after");
      const atCapacity = response.status === HTTP_TOO_MANY_REQUESTS;
      const notReady =
        response.status === HTTP_SERVICE_UNAVAILABLE ||
        response.status === HTTP_OVERWHELMED ||
        (response.status === HTTP_CONFLICT && retryAfter !== null);
      if (atCapacity || notReady) {
        const waitMs = retryAfterMs(retryAfter);
        const deadline = atCapacity ? capacityDeadline : coldStartDeadline;
        // A wait that would outlive the budget is not taken: the caller learns
        // now that the answer is not coming in time.
        if (Date.now() + waitMs <= deadline) {
          retries++;
          await sleep(waitMs);
          continue;
        }
      }

      this.record(info);
      const message = serverMessage(response.status, text);
      // Whether it was the client's deadline, earlier than the call's own
      // budget, that left no room for another try.
      const ownBudgetEnd = atCapacity ? started + spec.timeoutMs : started + coldStartMs;
      const pastDeadline = (atCapacity || notReady) && this.deadlineMs < ownBudgetEnd;
      const budget = pastDeadline
        ? "this client's deadline"
        : atCapacity
        ? `the call's ${spec.timeoutMs / MS_PER_SEC} s budget`
        : `the ${coldStartMs / MS_PER_SEC} s cold-start budget`;
      const gaveUp = atCapacity || notReady ? ` (gave up after ${retries} retr${retries === 1 ? "y" : "ies"} within ${budget})` : "";
      throw new HostedError(spec.op, response.status, `${message}${gaveUp}`, {
        ...(retryAfter !== null ? { retryAfterSecs: retryAfterMs(retryAfter) / MS_PER_SEC } : {}),
        pastDeadline,
      });
    }
  }

  private record(info: HostedCallInfo): void {
    this.last = info;
    this.onCall?.(info);
  }
}

// --- schema and Arrow IPC ------------------------------------------------------------

/** One `create_table` column as the platform's `SchemaField` spells it. An
 * embedding column carries no `nullable`: the platform fills every row, and
 * declares such a column never nullable itself. */
function toSchemaField(column: JsonColumn): RowRecord {
  const nullable = column.nullable === undefined ? {} : { nullable: column.nullable };
  if (typeof column.type === "string") return { name: column.name, type: column.type, ...nullable };
  if (column.type.type === "vector") return { name: column.name, type: "vector", dim: column.type.dim, ...nullable };
  return { name: column.name, type: "embedding", source: column.type.source };
}

/** The Arrow field an appended batch must carry for `column`. Nullability
 * defaults to true exactly as the platform's `create_table` defaults it: the
 * engine compares an appended batch's fields to the table's by type AND
 * nullability, so the two defaults have to agree. */
function toArrowField(column: JsonColumn): arrow.Field {
  const nullable = column.nullable ?? true;
  if (typeof column.type === "string") {
    const make = SCALAR_TYPES[column.type];
    if (!make) throw new Error(`rowsToIpc: unsupported column type ${JSON.stringify(column.type)} for "${column.name}"`);
    return new arrow.Field(column.name, make(), nullable);
  }
  if (column.type.type === "vector") {
    const item = new arrow.Field("item", new arrow.Float32(), true);
    return new arrow.Field(column.name, new arrow.FixedSizeList(column.type.dim, item), nullable);
  }
  throw new Error(`rowsToIpc: embedding column "${column.name}" is filled by the platform and is never sent`);
}

/** Build one typed column. Scalars go through Arrow's builder from the row
 * values (an omitted key is a null, not the type's zero); a vector column is a
 * FixedSizeList over one flat Float32 buffer, built by hand because the builder
 * path does not take nested data. Every row must carry a full-width vector - a
 * short one would make a silently wrong index, the one unrecoverable outcome. */
function buildColumn(field: arrow.Field, column: JsonColumn, rows: RowRecord[]): arrow.Vector {
  const values = rows.map((r) => r[column.name] ?? null);
  if (typeof column.type !== "string") {
    const dim = (column.type as { dim: number }).dim;
    const flat = new Float32Array(rows.length * dim);
    values.forEach((v, i) => {
      if (!Array.isArray(v) && !(v instanceof Float32Array)) {
        throw new Error(`rowsToIpc: row ${i} has no vector for "${column.name}"`);
      }
      if (v.length !== dim) {
        throw new Error(`rowsToIpc: row ${i} vector for "${column.name}" has ${v.length} values, expected ${dim}`);
      }
      flat.set(v as ArrayLike<number>, i * dim);
    });
    const listType = field.type as arrow.FixedSizeList;
    const child = arrow.makeData({ type: listType.children[0].type as arrow.Float32, length: flat.length, data: flat });
    const data = arrow.makeData({ type: listType, length: rows.length, nullCount: 0, child });
    return arrow.makeVector(data);
  }
  const typed = INT64_TYPES.has(column.type) ? values.map((v) => (v == null ? null : BigInt(v as number | bigint))) : values;
  return arrow.vectorFromArray(typed, field.type);
}

/** Rows as an Arrow IPC stream carrying one record batch whose schema is the
 * table's: text as `large_utf8`, line numbers as `int32`, a vector column as
 * `FixedSizeList<Float32, dim>`. Embedding columns are left out - the platform
 * fills them and rejects a batch that sends them. */
export function rowsToIpc(columns: JsonColumn[], rows: RowRecord[]): Uint8Array {
  const sent = columns.filter((c) => typeof c.type === "string" || c.type.type !== "embedding");
  const fields = sent.map(toArrowField);
  const schema = new arrow.Schema(fields);
  // The batch is assembled by hand around the declared schema. Handing the
  // columns to `new Table(schema, columns)` would let Arrow re-derive the
  // schema from the vectors when a batch is empty (every field nullable), and
  // the declared nullability is exactly what the engine checks on append.
  const children = sent.map((c, i) => {
    const vector = buildColumn(fields[i], c, rows);
    if (vector.data.length !== 1) {
      throw new Error(`rowsToIpc: column "${c.name}" built as ${vector.data.length} chunks, expected one`);
    }
    return vector.data[0];
  });
  const structData = arrow.makeData({ type: new arrow.Struct(fields), length: rows.length, nullCount: 0, children });
  const table = new arrow.Table(schema, new arrow.RecordBatch(schema, structData));
  return arrow.tableToIPC(table, IPC_STREAM);
}
