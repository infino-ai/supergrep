// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The engine's `standard` FTS analyzer, mirrored client-side. The engine
// tokenizes indexed text and every query itself, so the client never
// tokenizes to *query* - but it does have to know whether a query holds
// anything the index can look up (find rejects a punctuation-only query
// instead of returning an empty "no matches") and which lines of a hit carry
// a query term.

/** `standard` keeps a UAX #29 word segment only when it holds an alphabetic
 * or numeric character - the engine's `unicode_words` filter, which is
 * `char::is_alphanumeric` (the Alphabetic property, or a Nd/Nl/No digit).
 * This is deliberately not `Intl.Segmenter`'s `isWordLike`: ICU marks a run
 * of underscores word-like and a circled digit not, and the engine does the
 * opposite on both. */
const HAS_ALPHANUMERIC = /[\p{Alphabetic}\p{N}]/u;

/** UAX #29 word segmenter with no locale tailoring, matching the engine's
 * locale-free `unicode_words`. One instance: construction is the expensive
 * part and the segmenter is stateless across calls. */
const WORD_SEGMENTER = new Intl.Segmenter("und", { granularity: "word" });

/** Whether the analyzer yields at least one token for `text` - the test find
 * runs before asking the index for candidates, since a token-less query
 * matches nothing and would read as "no occurrences" rather than "the index
 * cannot look this up". */
export function hasIndexableToken(text: string): boolean {
  return analyzerTokens(text).length > 0;
}

/** The distinct tokens `standard` produces for `text`, in first-occurrence
 * order; duplicates are dropped, since every client-side use is set-shaped.
 * Tokens are UAX #29 word segments that contain an alphanumeric, lowercased
 * with full Unicode case mapping (context-sensitive, so a word-final Greek
 * sigma folds to ς as the engine's `str::to_lowercase` does) and no
 * normalization. The word rules keep `parse_config` (underscore joins), `3.14`
 * and `1,000` (a separator between digits joins), `don't` and `x.y` (an
 * apostrophe or period between letters joins) as one token each, and split on
 * hyphens and other punctuation; non-ASCII letters are kept (`Süd` → `süd`).
 * Known divergence: ICU segments CJK text by dictionary, so `日本語` is one
 * segment here where the engine emits one token per ideograph - the engine
 * does the authoritative split at query time, so this mirror only decides
 * whether such a query has a token at all, and there both agree. */
export function analyzerTokens(text: string): string[] {
  const out = new Set<string>();
  for (const { segment } of WORD_SEGMENTER.segment(text)) {
    if (HAS_ALPHANUMERIC.test(segment)) out.add(segment.toLowerCase());
  }
  return [...out];
}
