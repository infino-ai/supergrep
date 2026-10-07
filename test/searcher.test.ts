import { describe, expect, it } from "vitest";
import {
  analyzerOf,
  analyzerTokens,
  applyEmbeds,
  excerpt,
  guardSql,
  matchLines,
  numberLines,
  numberRowLines,
  plainTerms,
  withoutComments,
} from "../src/core/searcher.js";
import { hasIndexableToken, isAnalyzer } from "../src/core/analyzer.js";
import { ordersRows } from "../src/core/facts.js";
import { emptyManifest } from "../src/core/manifest.js";
import type { Embedder } from "../src/core/embedder.js";

describe("analyzerTokens (ascii_lower)", () => {
  // The analyzer is always named: which one a table has depends on where it
  // lives, so there is no default to fall back on.
  const ascii = (text: string) => analyzerTokens(text, "ascii_lower");

  it("splits on anything outside [A-Za-z0-9] and lowercases, like the index analyzer", () => {
    // `parse_config` indexes as two tokens: the underscore is a separator.
    expect(ascii("parse_config(Path)")).toEqual(["parse", "config", "path"]);
  });

  it("dedupes repeated tokens", () => {
    expect(ascii("a.a A")).toEqual(["a"]);
  });

  it("drops a run that touches non-ASCII text, as the analyzer does", () => {
    expect(ascii("Süd ok")).toEqual(["ok"]);
    // The non-ASCII character extends the run rather than splitting it, so
    // the ASCII neighbours go with it.
    expect(ascii("abcédef ghi")).toEqual(["ghi"]);
  });

  it("yields nothing for punctuation-only text", () => {
    expect(ascii("->")).toEqual([]);
    expect(ascii("")).toEqual([]);
  });
});

describe("analyzerTokens (standard)", () => {
  const std = (text: string) => analyzerTokens(text, "standard");

  it("keeps an underscored identifier as one word and lowercases", () => {
    // UAX #29: the underscore (ExtendNumLet) joins letters, so `parse_config`
    // is one token where ascii_lower makes two.
    expect(std("parse_config(Path)")).toEqual(["parse_config", "path"]);
    expect(std("foo_bar")).toEqual(["foo_bar"]);
  });

  it("keeps non-ASCII letters, lowercased with full Unicode case mapping", () => {
    expect(std("Süd ok")).toEqual(["süd", "ok"]);
    expect(std("Café RÉSUMÉ")).toEqual(["café", "résumé"]);
    // Context-sensitive: a word-final capital sigma folds to final sigma ς,
    // as the engine's str::to_lowercase does.
    expect(std("ΟΔΟΣ")).toEqual(["οδος"]);
    expect(std("ΟΔΟΣ")[0].endsWith("ς")).toBe(true);
  });

  it("keeps digit runs, and a period or comma between digits", () => {
    expect(std("pi is 3.14")).toEqual(["pi", "is", "3.14"]);
    expect(std("1,000 items")).toEqual(["1,000", "items"]);
    expect(std("foo123 bar456 0x1F")).toEqual(["foo123", "bar456", "0x1f"]);
    expect(std("404 200")).toEqual(["404", "200"]);
  });

  it("keeps a mid-word apostrophe and drops a wrapping one", () => {
    expect(std("don't stop")).toEqual(["don't", "stop"]);
    expect(std("'quoted'")).toEqual(["quoted"]);
  });

  it("splits on hyphens and other punctuation, and drops punctuation-only text", () => {
    expect(std("wi-fi, hello!")).toEqual(["wi", "fi", "hello"]);
    expect(std("hello,world!foo;bar")).toEqual(["hello", "world", "foo", "bar"]);
    expect(std("...   ???")).toEqual([]);
    expect(std("")).toEqual([]);
    expect(std("   \t\n")).toEqual([]);
  });

  it("keeps a segment only when it holds an alphanumeric, like the engine's unicode_words", () => {
    // ICU calls a run of underscores word-like and a circled digit not; the
    // engine keeps a segment iff a char is alphabetic or numeric, so it does
    // the reverse. The mirror follows the engine.
    expect(std("___")).toEqual([]);
    expect(std("①")).toEqual(["①"]);
  });

  it("dedupes repeated tokens", () => {
    expect(std("Foo foo FOO")).toEqual(["foo"]);
  });
});

describe("hasIndexableToken", () => {
  it("depends on the analyzer", () => {
    expect(hasIndexableToken("Süd", "ascii_lower")).toBe(false);
    expect(hasIndexableToken("Süd", "standard")).toBe(true);
    expect(hasIndexableToken("->", "ascii_lower")).toBe(false);
    expect(hasIndexableToken("->", "standard")).toBe(false);
    expect(hasIndexableToken("x", "ascii_lower")).toBe(true);
  });
});

describe("analyzerOf", () => {
  it("reads the recorded analyzer and defaults an absent one to the engine default", () => {
    expect(analyzerOf(emptyManifest())).toBe("ascii_lower");
    expect(analyzerOf({ ...emptyManifest(), analyzer: "standard" })).toBe("standard");
    expect(analyzerOf({ ...emptyManifest(), analyzer: "ascii_lower" })).toBe("ascii_lower");
  });

  it("defaults an absent analyzer on a hosted manifest to the platform default, never the engine's", () => {
    // A hosted table's bare column took the platform default (`standard`);
    // reading it as `ascii_lower` would reject queries the index can serve.
    expect(analyzerOf({ ...emptyManifest(), origin: "hosted" })).toBe("standard");
    expect(analyzerOf({ ...emptyManifest(), origin: "hosted", analyzer: "ascii_lower" })).toBe("ascii_lower");
  });

  it("isAnalyzer accepts only the two engine names", () => {
    expect(isAnalyzer("ascii_lower")).toBe(true);
    expect(isAnalyzer("standard")).toBe(true);
    expect(isAnalyzer("icu")).toBe(false);
    expect(isAnalyzer(undefined)).toBe(false);
  });
});

describe("plainTerms", () => {
  it("blanks the engine's query-grammar characters and nothing else", () => {
    // A leading `-` would negate, `--flag` would be negation-only, `"` a phrase.
    expect(plainTerms("git -C repo")).toBe("git  C repo");
    expect(plainTerms("--max-files")).toBe("  max files");
    expect(plainTerms('say "hi there"')).toBe("say  hi there ");
    expect(plainTerms("a + b")).toBe("a   b");
    expect(plainTerms("parse_config(Path).x")).toBe("parse_config(Path).x");
  });

  it("does not change the token set under either analyzer", () => {
    for (const text of ["git -C repo", "--max-files", 'say "hi there"', "x+y-z", "e-mail 3.14 don't"]) {
      expect(analyzerTokens(plainTerms(text), "ascii_lower"), text).toEqual(analyzerTokens(text, "ascii_lower"));
      expect(analyzerTokens(plainTerms(text), "standard"), text).toEqual(analyzerTokens(text, "standard"));
    }
  });
});

describe("matchLines", () => {
  const content = "let parse_config = 1;\nparse config\nPARSE_CONFIG";

  it("cites 1-based lines offset from the chunk start and matches the literal, not its tokens", () => {
    // Line 2 has both tokens but not the literal.
    expect(matchLines(content, 10, "parse_config", false)).toEqual([{ line: 10, text: "let parse_config = 1;", at: 4 }]);
  });

  it("is case-sensitive unless asked otherwise", () => {
    expect(matchLines(content, 10, "parse_config", true).map((m) => m.line)).toEqual([10, 12]);
  });

  it("strips a CRLF file's carriage return from the cited text", () => {
    expect(matchLines("x = 1;\r\ny = 2;\r\n", 1, "y =", false)).toEqual([{ line: 2, text: "y = 2;", at: 0 }]);
  });
});

describe("numberLines", () => {
  it("prefixes each line with its own number in the file, counting from the chunk's start", () => {
    expect(numberLines("fn a() {\n  body\n}", 418)).toBe("418: fn a() {\n419:   body\n420: }");
  });

  it("leaves empty text empty, so a row that carries only a place gains no phantom line", () => {
    expect(numberLines("", 7)).toBe("");
  });

  it("numbers a single line without a trailing newline", () => {
    expect(numberLines("one line", 1)).toBe("1: one line");
  });
});

describe("numberRowLines", () => {
  it("numbers a multi-line text cell from the row's start-line column", () => {
    expect(numberRowLines({ path: "a.rs", start_line: 5, end_line: 6, content: "let x = 1;\nlet y = 2;" })).toEqual({
      path: "a.rs",
      start_line: 5,
      end_line: 6,
      content: "5: let x = 1;\n6: let y = 2;",
    });
  });

  it("leaves a row with no start-line column untouched - nothing places its text", () => {
    const row = { path: "a.rs", content: "let x = 1;\nlet y = 2;" };
    expect(numberRowLines(row)).toEqual(row);
  });

  it("leaves single-line cells alone, so aggregates and names are not prefixed", () => {
    expect(numberRowLines({ path: "a.rs", start_line: 5, symbol: "parse", n: 12 })).toEqual({
      path: "a.rs",
      start_line: 5,
      symbol: "parse",
      n: 12,
    });
  });

  it("takes the least start-like column, the row's own first line", () => {
    // `start_line` places the text; `window_start` is a larger number that
    // must not be mistaken for it.
    expect(numberRowLines({ start_line: 10, window_start: 40, content: "a\nb" }).content).toBe("10: a\n11: b");
  });
});

describe("excerpt", () => {
  it("returns a short line whole", () => {
    expect(excerpt("let x = needle;", 8, 6)).toBe("let x = needle;");
  });

  it("windows a long line around the match and marks both cut ends", () => {
    // A match past column 240 must still be in the cited text, or the hit
    // reads as wrong. Some lead-in is kept so the excerpt shows what the match
    // sits in, and both cuts are marked.
    const line = "a".repeat(600) + "NEEDLE" + "b".repeat(300);
    const out = excerpt(line, 600, "NEEDLE".length);
    expect(out).toContain("NEEDLE");
    expect(out.startsWith("...")).toBe(true);
    expect(out.endsWith("...")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(240 + "......".length);
    expect(out.indexOf("NEEDLE")).toBeGreaterThan("...".length);
  });

  it("marks only the end that was cut", () => {
    const head = excerpt("NEEDLE" + "b".repeat(600), 0, 6);
    expect(head.startsWith("NEEDLE")).toBe(true);
    expect(head.endsWith("...")).toBe(true);
    const tail = excerpt("a".repeat(600) + "NEEDLE", 600, 6);
    expect(tail.startsWith("...")).toBe(true);
    expect(tail.endsWith("NEEDLE")).toBe(true);
  });
});

describe("guardSql", () => {
  it("accepts a single SELECT / WITH statement and strips the trailing semicolon", () => {
    expect(guardSql("SELECT 1;")).toBe("SELECT 1");
    expect(guardSql("  with x as (select 1) select * from x  ")).toMatch(/^with x/);
  });

  it("rejects multiple statements", () => {
    expect(() => guardSql("SELECT 1; SELECT 2")).toThrow(/single statement/);
  });

  it("rejects writes", () => {
    expect(() => guardSql("DROP TABLE chunks")).toThrow(/read-only/);
    expect(() => guardSql("INSERT INTO chunks VALUES (1)")).toThrow(/read-only/);
  });

  // The shape refused 13 times on the demo from 2026-09-30, and every
  // other way a comment can stand before or after the statement. The
  // statement comes back as written - the engine reads its own comments -
  // trimmed and with a closing semicolon off its end, as before.
  it("accepts a statement that opens with comments, and returns it as written", () => {
    const opening = "-- For each top org, the subjects that cite it\nSELECT org FROM t";
    expect(guardSql(opening)).toBe(opening);
    expect(guardSql("-- one\n  -- two\nWITH m AS (SELECT 1) SELECT * FROM m")).toMatch(/WITH m AS/);
    expect(guardSql("/* a block */ SELECT 1")).toBe("/* a block */ SELECT 1");
    expect(guardSql("/* nested /* block */ comment */ SELECT 1")).toBe("/* nested /* block */ comment */ SELECT 1");
    expect(guardSql("(SELECT 1) UNION ALL (SELECT 2)")).toBe("(SELECT 1) UNION ALL (SELECT 2)");
    expect(guardSql("SELECT 1 -- a trailing comment")).toBe("SELECT 1 -- a trailing comment");
    expect(guardSql("SELECT 1; -- after the closing semicolon\n")).toBe("SELECT 1; -- after the closing semicolon");
    // The engine's parser skips empty statements, between semicolons and
    // before the first one.
    expect(guardSql("SELECT 1;;")).toBe("SELECT 1;");
    expect(guardSql(";SELECT 1")).toBe(";SELECT 1");
    expect(guardSql("; ; SELECT 1")).toBe("; ; SELECT 1");
  });

  it("reads a semicolon or a keyword inside a string, a quoted name or a comment as text", () => {
    for (const sql of [
      "SELECT ';' AS s",
      "SELECT 'it''s; fine' AS s",
      "SELECT E'a\\'; b' AS s",
      "SELECT $$; DROP TABLE t$$ AS s",
      'SELECT 1 AS "a;b"',
      "SELECT 1 -- a comment; with a semicolon\nFROM t",
      `SELECT path FROM hybrid_search('chunks','content','x','embedding', {{q:"wal; recovery -- why"}}, 20)`,
      "-- DROP TABLE chunks\nSELECT 1",
    ]) {
      expect(guardSql(sql)).toBe(sql);
    }
  });

  it("still refuses a second statement or a write, however commented", () => {
    expect(() => guardSql("SELECT 1; -- one\nSELECT 2")).toThrow(/single statement/);
    expect(() => guardSql("SELECT ';'; DELETE FROM chunks")).toThrow(/single statement/);
    expect(() => guardSql("/* SELECT */ DROP TABLE chunks")).toThrow(/read-only/);
    expect(() => guardSql("-- SELECT 1\nDELETE FROM chunks")).toThrow(/read-only/);
    expect(() => guardSql("-- only a comment")).toThrow(/read-only/);
    expect(() => guardSql("'SELECT' AS s")).toThrow(/read-only/);
    expect(() => guardSql("SELECTX 1")).toThrow(/read-only/);
  });

  // Read as a comment to the end, the rest of the statement would vanish
  // and a shorter one run: the filter after a nested `/*` in a path, or
  // after a forgotten `*/`, gone from a count that then covers every row.
  it("refuses a block comment that never closes, saying how to close it", () => {
    for (const sql of [
      "SELECT count(*) FROM chunks /* only files under src/* */ WHERE path LIKE 'src/%'",
      "SELECT count(*) FROM chunks /* the failing ones WHERE resolved = 'false'",
    ]) {
      expect(() => guardSql(sql), sql).toThrow(/comment in the statement never closes/);
      expect(withoutComments(sql), sql).toBe(sql);
    }
  });
});

describe("withoutComments", () => {
  it("reads out line and block comments, each leaving its newlines", () => {
    expect(withoutComments("-- which tables\nSELECT a /* the key */ FROM t -- done")).toBe("\nSELECT a   FROM t  ");
    expect(withoutComments("SELECT 1--1\nFROM t")).toBe("SELECT 1\nFROM t");
    expect(withoutComments("SELECT path,\n/* the file\n and its size */\ncount(*) n FROM chunks")).toBe("SELECT path,\n\n\ncount(*) n FROM chunks");
  });

  it("leaves no ORDER BY that only a comment wrote for the row ranking to read", () => {
    expect(ordersRows(withoutComments("-- order by the count\nSELECT path, count(*) FROM chunks GROUP BY path"))).toBe(false);
    expect(ordersRows(withoutComments("SELECT path FROM chunks ORDER BY path -- by path"))).toBe(true);
  });

  it("leaves a comment marker inside a string, a quoted name or the platform's placeholder alone", () => {
    const kept = [
      "SELECT '-- not a comment', 'a /* b */' FROM t",
      'SELECT "x--y" FROM t',
      "SELECT $$ -- $$ FROM t",
      `SELECT path FROM vector_search('chunks','embedding', {{q:"a -- b /* c"}}, 10)`,
    ];
    for (const sql of kept) expect(withoutComments(sql)).toBe(sql);
  });

  it("leaves a statement without comments exactly as written", () => {
    const sql = "SELECT c.path, count(*) FROM chunks c WHERE c.lang = 'rs' GROUP BY c.path ORDER BY 2 DESC";
    expect(withoutComments(sql)).toBe(sql);
  });
});

const fakeEmbedder: Embedder = {
  embed: async (texts) => texts.map(() => [0.25, 0.5]),
  dim: async () => 2,
  provider: "fake",
  model: "fake",
};

describe("applyEmbeds", () => {
  it("passes SQL without placeholders through untouched", async () => {
    const sql = "SELECT * FROM chunks";
    expect(await applyEmbeds(sql, undefined, fakeEmbedder)).toBe(sql);
  });

  it("substitutes vector literals for each placeholder", async () => {
    const sql = "SELECT * FROM hybrid_search('chunks','content','t','embedding', {{q}}, 5)";
    const out = await applyEmbeds(sql, { q: "query text" }, fakeEmbedder);
    expect(out).toContain("'0.25,0.5'");
    expect(out).not.toContain("{{");
  });

  it("errors on a referenced placeholder with no supplied text", async () => {
    await expect(applyEmbeds("SELECT {{q}}", {}, fakeEmbedder)).rejects.toThrow(/no 'embed' text/);
    await expect(applyEmbeds("SELECT {{q}}", undefined, fakeEmbedder)).rejects.toThrow(/embed/);
  });
});
