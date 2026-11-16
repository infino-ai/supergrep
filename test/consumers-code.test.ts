// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The tools each consumer of the code index is offered, pinned. A consumer is
// a set of settings from docs/plugins.md; a tool that reaches one of them
// unannounced is what this file exists to catch. Adding a tool changes a list
// here on purpose, in the same change, and docs/plugins.md with it.
//
// The table consumers (CX_TABLE set at module load) are in
// consumers-table.test.ts.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { scriptPlatform, start, stop } from "./mcp-harness.js";

// Read at module load and at startup, so set before the server is imported.
delete process.env.CX_TABLE;
delete process.env.CX_SIBLING_TABLES;
delete process.env.CX_INDEX_DIR;
process.env.CX_NO_EMBED = "1";
// The switches a consumer sets: each test sets its own, none leaks in.
const SWITCHES = ["CX_ACCOUNT_DATA", "CX_API_TOOLS", "CX_READ_ONLY", "CX_MEMORY", "CX_WEB_FETCH", "CX_PLAYBOOK"];
for (const name of SWITCHES) delete process.env[name];

const { API_KEY_ENV, configureHosted, hostedSettingsFromFlags } = await import("../src/core/config.js");

/** The platform a server with an account starts against: the repository's
 * own database, empty, and no card for anything. */
const platform = () =>
  scriptPlatform({
    list_tables: () => [200, []],
    table_card: () => [404, { error: "no card" }],
  });

async function toolsOf(options: { accountData?: boolean } = {}): Promise<string[]> {
  const s = await start(platform(), "cx-consumer-", options);
  try {
    const { tools } = await s.client.listTools();
    return tools.map((t) => t.name).sort();
  } finally {
    await stop(s);
  }
}

afterEach(() => {
  for (const name of SWITCHES) delete process.env[name];
});

describe("SuperGrep, local: the code index and no account", () => {
  it("offers code search alone", async () => {
    expect(await toolsOf()).toEqual(["find", "read", "sql"]);
  });
});

describe("SuperGrep, with an account: the code index, the account's data, the checks", () => {
  beforeAll(() => {
    configureHosted(hostedSettingsFromFlags({ db: "http://127.0.0.1:9/repo" }, { [API_KEY_ENV]: "inf_test_key_do_not_log" }));
  });
  afterAll(() => {
    configureHosted(null);
  });

  const CODE = ["find", "join_keys", "read", "search", "sql"];
  const HYDRATE = ["hydrate", "hydrate_cancel", "hydrate_status"];

  it("offers code search, the account's data and the platform's checks", async () => {
    expect(await toolsOf()).toEqual([...CODE, ...HYDRATE, "tables"].sort());
  });

  it("with CX_READ_ONLY, nothing that writes", async () => {
    process.env.CX_READ_ONLY = "1";
    expect(await toolsOf()).toEqual([...CODE, "tables"].sort());
  });

  it("with CX_ACCOUNT_DATA=database, none of the account's other databases", async () => {
    process.env.CX_ACCOUNT_DATA = "database";
    expect(await toolsOf()).toEqual(CODE);
  });

  it("with CX_ACCOUNT_DATA=table, the code index's own table alone: no join_keys", async () => {
    process.env.CX_ACCOUNT_DATA = "table";
    expect(await toolsOf()).toEqual(CODE.filter((t) => t !== "join_keys"));
  });

  it("with CX_API_TOOLS, the platform's routes as tools", async () => {
    process.env.CX_API_TOOLS = "1";
    expect(await toolsOf()).toEqual([...CODE, ...HYDRATE, "tables", "cite", "table_card", "validate"].sort());
  });
});
