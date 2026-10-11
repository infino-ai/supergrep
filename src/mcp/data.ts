// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The account's data, reached from the one server: every database the key
// may see and every table in them, addressed per call by the `database`
// argument the tools take, beside the repository a `path` names.
//
// The server was built around one database and one table, decided at
// startup from the environment (CX_TABLE), so a session could reach one
// dataset and only by starting a server for it. Here a database is named on
// the call: its client is made on first use and kept, a table's shape
// (schema, card, how its load cut the rows, which column the platform
// embeds) is read on first use and kept, and nothing is asked at startup -
// a session that never names a database costs nothing here.
//
// Also the way data gets IN: `hydrate` admits a load from a bucket the
// platform reads itself, or from files that are in no bucket yet - on this
// machine or on one reached over ssh (core/uploads.ts) - which are put into
// the database's storage first through the platform's upload sessions, then
// loaded from there.

import { createDatabase, listDatabases, type AccountDatabase, type AccountTarget, type CreateOutcome } from "../core/account-api.js";
import { hostedDbFor } from "../core/context.js";
import { uploadBytes, type HostedDb, type HostedOptions, type RowRecord } from "../core/hosted.js";
import { resolveTableShape, type TableShape } from "../core/table-shape.js";
import { fileBytes, localFiles, remoteFiles, uploadAll, type Listing, type Runner, type UploadFile } from "../core/uploads.js";

/** Where a hydrate reads from, as the tool takes it. `bucket` and `prefix`
 * are the platform's own sources, passed through; `path` and `ssh` are
 * files this process reads and puts into the database's storage first. */
export type HydrateToolSource =
  | { kind: "bucket"; bucket: string; prefix: string }
  | { kind: "prefix"; prefix: string }
  | { kind: "path"; path: string }
  | { kind: "ssh"; host: string; path: string };

/** The `hydrate` tool's request: the database, the table (absent, one
 * table per folder of the source), the source, and the load's options in
 * the platform's own names. `options` carries any other field of the
 * platform's request as it is spelled there, so the tool need not restate
 * every one; the platform refuses a field it does not know, by name. */
export interface HydrateToolRequest {
  database: string;
  table?: string;
  source: HydrateToolSource;
  format?: string;
  fts?: string[];
  embed?: { column: string; source: string[] };
  no_embed?: boolean;
  chunk?: RowRecord;
  if_exists?: "refuse" | "append";
  dry_run?: boolean;
  notify_email?: string;
  options?: RowRecord;
}

/** The format a load is given when the caller names none: the platform
 * reads each file by its extension. The platform's own default is parquet,
 * which refuses a folder of CSV or JSON; a tool pointed at "any dataset"
 * asks for the one that reads whatever is there. */
const DEFAULT_FORMAT = "auto";

/** The platform's spelling of the source files are loaded from once they
 * are put in the database's storage. */
const PREFIX_SOURCE = "prefix";

export interface DataPlaneOptions {
  /** The platform and the key: the account every database is reached on. */
  account: AccountTarget;
  /** The client's tuning (`hostedClientOptions`) and a test's fetch. */
  clientOptions: HostedOptions;
  /** The card tier a table's shape folds in. */
  cardTier: string;
  /** Hears what a shape read passed over, and what a card read refused. */
  onNote: (line: string) => void;
  /** The origin upload sessions are opened for (`openUploads`). */
  origin: string;
  /** How long a verdict on a statement's rows is waited for: the rows are
   * the answer and the verdict advice about them (see the server's
   * VERDICT_TIMEOUT_MS). */
  verdictTimeoutMs: number;
  /** Runs `ssh` for a remote listing; a test injects one. */
  run?: Runner;
}

export class DataPlane {
  private readonly account: AccountTarget;
  private readonly clientOptions: HostedOptions;
  private readonly cardTier: string;
  private readonly onNote: (line: string) => void;
  readonly origin: string;
  private readonly verdictTimeoutMs: number;
  private readonly run: Runner | undefined;
  private readonly clients = new Map<string, HostedDb>();
  private readonly quickClients = new Map<string, HostedDb>();
  private readonly verdictClients = new Map<string, HostedDb>();
  private readonly shapes = new Map<string, Promise<TableShape>>();
  private readonly names = new Map<string, Promise<string[]>>();

  constructor(opts: DataPlaneOptions) {
    this.account = opts.account;
    this.clientOptions = opts.clientOptions;
    this.cardTier = opts.cardTier;
    this.onNote = opts.onNote;
    this.origin = opts.origin;
    this.verdictTimeoutMs = opts.verdictTimeoutMs;
    this.run = opts.run;
  }

  /** The platform's name for the account, for messages. */
  get baseUrl(): string {
    return this.account.baseUrl;
  }

  /** The client for `database`, with the full cold-start budget: a database
   * asked a question is worth waiting for. One per database, kept. */
  client(database: string): HostedDb {
    let client = this.clients.get(database);
    if (!client) {
      client = hostedDbFor({ ...this.account, database }, this.clientOptions);
      this.clients.set(database, client);
    }
    return client;
  }

  /** The client for `database` that never waits a cold start out: for
   * listings, shape reads and verdicts, where a database still coming up is
   * reported rather than waited for. */
  quick(database: string): HostedDb {
    let client = this.quickClients.get(database);
    if (!client) {
      client = hostedDbFor({ ...this.account, database }, { ...this.clientOptions, coldStartSecs: 0 });
      this.quickClients.set(database, client);
    }
    return client;
  }

  /** The client a verdict on `database`'s rows is asked through: a few
   * seconds and no cold-start wait, as the server's own verdict client is
   * tuned - a platform that is slow must cost a statement its verdict, not
   * its rows. */
  verdict(database: string): HostedDb {
    let client = this.verdictClients.get(database);
    if (!client) {
      client = hostedDbFor({ ...this.account, database }, { ...this.clientOptions, coldStartSecs: 0, timeoutMs: this.verdictTimeoutMs });
      this.verdictClients.set(database, client);
    }
    return client;
  }

  /** The account's databases, as the platform lists them. Asked every time:
   * a database made since the last call must show. */
  databases(): Promise<AccountDatabase[]> {
    return listDatabases(this.account, this.clientOptions.fetch ? { fetch: this.clientOptions.fetch } : {});
  }

  /** The names of `database`'s tables, read once and kept until a hydrate
   * into it (`forget`); a read that failed is not kept. */
  tableNames(database: string): Promise<string[]> {
    let pending = this.names.get(database);
    if (!pending) {
      pending = this.quick(database)
        .listTables()
        .catch((err) => {
          this.names.delete(database);
          throw err;
        });
      this.names.set(database, pending);
    }
    return pending;
  }

  /** The shape of `table` in `database`, read once and kept: its schema,
   * its card at the tier, the record of the load that made it, and whether
   * the platform embeds a query for its vector column. A read that failed
   * is not kept, so the next call asks again. */
  shape(database: string, table: string): Promise<TableShape> {
    const key = `${database}\n${table}`;
    let pending = this.shapes.get(key);
    if (!pending) {
      const onNote = (line: string) => this.onNote(`${database}.${table}: ${line}`);
      pending = resolveTableShape(this.client(database), table, this.cardTier, (err) => onNote(`no card: ${(err as Error).message}`), true, {
        onNote,
        checkWith: this.quick(database),
      }).catch((err) => {
        this.shapes.delete(key);
        throw err;
      });
      this.shapes.set(key, pending);
    }
    return pending;
  }

  /** Forget what was read of `database`: its tables and their shapes. After
   * a hydrate into it, which adds a table or rewrites one. */
  forget(database: string): void {
    this.names.delete(database);
    for (const key of [...this.shapes.keys()]) if (key.startsWith(`${database}\n`)) this.shapes.delete(key);
  }

  /** Register `database` on the account, or find it there. */
  ensureDatabase(database: string): Promise<CreateOutcome> {
    return createDatabase(this.account, database, this.clientOptions.fetch ? { fetch: this.clientOptions.fetch } : {});
  }

  /** The `hydrate` tool: admit a load into `database`. From a bucket or a
   * staged prefix, the request goes to the platform as given. From files
   * (`path`, `ssh`) they are listed, upload sessions opened for them, every
   * file's bytes sent to its session, and the load admitted from the prefix
   * the upload landed in. A dry run writes nothing: files are listed and
   * counted, and a bucket or prefix source is checked by the platform. The
   * database is registered first unless this is a dry run, which only
   * reports that it would be. Returns the platform's answer with what was
   * done around it. */
  async hydrate(req: HydrateToolRequest): Promise<RowRecord> {
    const { database } = req;
    const done: RowRecord = {};
    if (req.dry_run) {
      const known = (await this.databases()).some((d) => d.name === database);
      if (!known) done.database = `${database} is not a database of this account yet; a run that is not a dry run registers it first`;
    } else {
      done.database = (await this.ensureDatabase(database)) === "created" ? `registered ${database} on the account` : `${database} exists`;
    }

    let source: RowRecord;
    if (req.source.kind === "path" || req.source.kind === "ssh") {
      const from = req.source;
      const listing: Listing = from.kind === "path" ? await localFiles(from.path) : await remoteFiles(from.host, from.path, this.run);
      const bytes = listing.files.reduce((n, f) => n + f.size, 0);
      const where = from.kind === "path" ? from.path : `${from.host}:${from.path}`;
      if (req.dry_run) {
        return {
          dry_run: true,
          ...done,
          files: listing.files.length,
          bytes,
          would: `upload ${listing.files.length} files (${bytes} bytes) from ${where} into ${database}'s storage, then load them as ${req.table ?? "one table per folder"}`,
          note: "the platform checks a load from a bucket or a staged prefix on a dry run; files not uploaded yet cannot be checked before the upload",
        };
      }
      const client = this.client(database);
      const accepted = await client.openUploads(this.origin, listing.files);
      const sessions = accepted.files as Array<{ name: string; url: string }>;
      if (!Array.isArray(sessions) || sessions.length !== listing.files.length) {
        throw new Error(`the platform opened ${Array.isArray(sessions) ? sessions.length : 0} upload sessions for ${listing.files.length} files`);
      }
      const t0 = performance.now();
      await uploadAll(listing.files, (file: UploadFile, index: number) =>
        uploadBytes(sessions[index].url, fileBytes(from.kind === "ssh" ? { host: from.host, path: from.path } : { path: from.path }, file, listing.single), file.size, this.clientOptions.fetch),
      );
      done.uploaded = { files: listing.files.length, bytes, from: where, prefix: accepted.prefix, took_ms: Math.round(performance.now() - t0) };
      source = { kind: PREFIX_SOURCE, prefix: accepted.prefix };
    } else {
      source = { ...req.source };
    }

    const body: RowRecord = {
      ...(req.options ?? {}),
      ...(req.table !== undefined ? { table: req.table } : {}),
      source,
      format: req.format ?? DEFAULT_FORMAT,
      ...(req.fts !== undefined ? { fts: req.fts.map((column) => ({ column })) } : {}),
      ...(req.embed !== undefined ? { embed: req.embed } : {}),
      ...(req.no_embed !== undefined ? { no_embed: req.no_embed } : {}),
      ...(req.chunk !== undefined ? { chunk: req.chunk } : {}),
      ...(req.if_exists !== undefined ? { if_exists: req.if_exists } : {}),
      ...(req.dry_run ? { dry_run: true } : {}),
      ...(req.notify_email !== undefined ? { notify: { email: req.notify_email } } : {}),
    };
    const answer = await this.client(database).hydrateSubmit(body);
    if (!req.dry_run) this.forget(database);
    return {
      ...(req.dry_run ? { dry_run: true } : {}),
      ...done,
      request: body,
      ...answer,
      ...(req.dry_run
        ? {}
        : {
            follow: `the load runs on the platform; hydrate_status with database "${database}" and the table follows it, and the table answers sql, search, find and ask once its state is succeeded`,
          }),
    };
  }
}
