// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The MCP Registry refuses a manifest whose description runs past 100
// characters, and the publish workflow only finds out after the npm step.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("server.json", () => {
  it("keeps its description within the registry's 100 characters", () => {
    const manifest = JSON.parse(readFileSync(new URL("../server.json", import.meta.url), "utf8"));
    expect(manifest.description.length).toBeLessThanOrEqual(100);
  });
});
