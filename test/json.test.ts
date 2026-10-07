// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// jsonify writes a bigint as its exact digits: the hosted client parses every
// integer past 2^53 the platform writes into a bigint, and a nanosecond
// timestamp or a 64-bit id written through Number() is a different value.

import { describe, expect, it } from "vitest";
import { jsonify } from "../src/core/json.js";

/** A nanosecond timestamp: past 2^53, so Number() would round it. */
const NANOS = 1759617853701123457n;

describe("jsonify", () => {
  it("writes a bigint as its exact digits, nested or alone", () => {
    expect(jsonify(NANOS)).toBe("1759617853701123457");
    expect(jsonify({ timestamp: NANOS, rows: [{ n: -NANOS }] })).toBe('{"timestamp":1759617853701123457,"rows":[{"n":-1759617853701123457}]}');
    // Number() would have written the nearest double.
    expect(jsonify({ t: NANOS })).not.toContain(String(Number(NANOS)));
  });

  it("writes everything else as JSON.stringify does, pretty or not", () => {
    const value = { a: 1, b: "x", c: [true, null], d: 1.5 };
    expect(jsonify(value)).toBe(JSON.stringify(value));
    expect(jsonify(value, true)).toBe(JSON.stringify(value, null, 2));
    expect(jsonify({ big: 2n }, true)).toBe('{\n  "big": 2\n}');
  });
});
