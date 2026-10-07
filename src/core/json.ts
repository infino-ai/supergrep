// `JSON.rawJSON` is in every Node this package runs on (engines: >=22.19),
// but not in the ES2022 library the compiler targets.
declare global {
  interface JSON {
    rawJSON(text: string): unknown;
  }
}

/** JSON.stringify that survives bigint values: a COUNT(*) or a 64-bit column
 * comes off the local engine as a bigint, and the hosted client parses every
 * integer past 2^53 the platform writes into one (`keepBigIntegers` in
 * hosted.ts) - a row's `_id`, a nanosecond timestamp in a log table, a card's
 * statistics over such a column. JSON.stringify refuses a bigint outright,
 * and a refusal at the MCP server's startup, serializing a log table's card,
 * left the server dead and the caller's model with no tools at all
 * (2026-10-05: a visitor's OpenTelemetry logs). Written as its exact digits -
 * a JSON number of any size - never through Number(), which rounds it: a
 * timestamp or an id written rounded names a different value. On its own so
 * the hosted client can use it without importing the searcher (which
 * imports the local engine). */
export function jsonify(value: unknown, pretty = false): string {
  return JSON.stringify(
    value,
    (_k, v) => (typeof v === "bigint" ? JSON.rawJSON(v.toString()) : v),
    pretty ? 2 : undefined,
  );
}
