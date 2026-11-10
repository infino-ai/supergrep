// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The figures of a final answer that no tool result holds: numbers the model
// produced itself rather than read or computed through a tool.
//
// A model that reads every input right can still compute a figure by hand
// and get it slightly wrong - a multi-step average whose first step is off by
// cents carries the error into every later step - and an answer checked for
// an exact figure is then wrong. A sentence telling the model to compute
// through `sql` is a request it can skip; this is the check behind it. A figure a
// statement computed is in that statement's result, and a figure read from a
// row is in the row; one in neither came from the model's own arithmetic.

/** One number as written: its value, and how many decimals it was given. */
export interface Figure {
  text: string;
  value: number;
  decimals: number;
  percent: boolean;
}

/** A number as text: an optional sign and dollar sign, digits grouped by
 * thousands or not, an optional fraction, an optional percent. Grouping is
 * read strictly (`1,234,567`), so a list's `5, 56.30` is two numbers. */
const NUMBER = /([-−]?)\$?((?:\d{1,3}(?:,\d{3})+)|\d+)(\.\d+)?(\s?%)?/g;
/** A ledger amount printed with its cents after a space - `7,046,001 98` in
 * the scanned receipts tables - read as the decimal it is. Only ever adds a
 * candidate a tool result holds, so a false reading can back a figure, never
 * flag one. */
const SPACED_CENTS = /(\d{1,3}(?:,\d{3})+|\d+) (\d{2})(?!\d)/g;
/** Where a final answer states itself when the question asks for tags. */
const FINAL_ANSWER = /<FINAL_ANSWER>([\s\S]*?)<\/FINAL_ANSWER>/g;
/** Whole numbers the check leaves alone: small counts and ranks, which a
 * model counts rather than computes, and four-digit years. */
const SMALL_INTEGER_MAX = 100;
const YEAR_MIN = 1000;
const YEAR_MAX = 2100;
/** Slack on a comparison beyond the written precision, for float noise. */
const RELATIVE_SLACK = 1e-9;
/** Percent to fraction. */
const PERCENT = 100;

/** Every number in `text`. */
export function figuresIn(text: string): Figure[] {
  const out: Figure[] = [];
  for (const m of text.matchAll(NUMBER)) {
    const fraction = m[3] ?? "";
    const value = Number(`${m[2].replace(/,/g, "")}${fraction}`) * (m[1] ? -1 : 1);
    if (!Number.isFinite(value)) continue;
    out.push({ text: m[0].trim(), value, decimals: Math.max(0, fraction.length - 1), percent: Boolean(m[4]) });
  }
  return out;
}

/** The values a tool result holds: every number in it, and every ledger
 * amount written with spaced cents. */
export function toolValues(text: string): number[] {
  const values = figuresIn(text).map((f) => f.value);
  for (const m of text.matchAll(SPACED_CENTS)) values.push(Number(`${m[1].replace(/,/g, "")}.${m[2]}`));
  return values;
}

/** The part of a reply that is its final answer: the last tagged answer when
 * the reply has one, else its last non-empty line. */
export function finalAnswerPart(reply: string): string {
  const tagged = [...reply.matchAll(FINAL_ANSWER)];
  if (tagged.length) return tagged[tagged.length - 1][1];
  const lines = reply.split("\n").filter((l) => l.trim());
  return lines.length ? lines[lines.length - 1] : "";
}

/** Whether the check leaves `figure` alone: a small whole number or a year. */
function exempt(figure: Figure): boolean {
  if (figure.decimals > 0 || figure.percent) return false;
  const v = Math.abs(figure.value);
  return v < SMALL_INTEGER_MAX || (v >= YEAR_MIN && v <= YEAR_MAX && !figure.text.includes(","));
}

/** Whether some value in `values` is `figure` as written: equal once rounded
 * to the figure's decimals, by magnitude (a sign is a convention the answer
 * may state either way), and for a percent either the percent itself or the
 * fraction it stands for. */
function backed(figure: Figure, values: readonly number[]): boolean {
  const targets = figure.percent ? [Math.abs(figure.value), Math.abs(figure.value) / PERCENT] : [Math.abs(figure.value)];
  return targets.some((target, i) => {
    const decimals = i === 0 ? figure.decimals : figure.decimals + 2;
    const half = 0.5 * 10 ** -decimals + RELATIVE_SLACK * target;
    return values.some((v) => Math.abs(Math.abs(v) - target) <= half);
  });
}

/** The figures of `reply`'s final answer that no value in `values` holds,
 * as the answer wrote them. */
export function unbackedFigures(reply: string, values: readonly number[]): string[] {
  return figuresIn(finalAnswerPart(reply))
    .filter((f) => !exempt(f) && !backed(f, values))
    .map((f) => f.text);
}

/** How a reply says it named a reading of the question and did not compute
 * it - "I did not compute that variant", "if you instead take the literal
 * ratio" - when the reading it left uncomputed may be the one the question
 * meant. A model told to compute every reading it names still does this; the
 * phrases are the ones such replies use. */
const UNCOMPUTED_READING =
  /\b(?:did not|didn't|have not|haven't|was not able to|could not) (?:compute|calculate|work out|run)\b|\balternative reading\b|\bif you (?:instead|include|exclude|count|use|take)\b|\bunder the other reading\b/i;

/** Whether `reply` names a reading of the question it did not compute. */
export function namesUncomputedReading(reply: string): boolean {
  return UNCOMPUTED_READING.test(reply);
}

/** What the model is told when its reply names a reading it did not
 * compute: compute each, then choose by the question's own words. */
export const UNCOMPUTED_READING_REASON =
  "Your reply names a reading of the question you did not compute. Compute each reading you name with sql, then " +
  "answer with the one the question's own words define - everything except what it excludes, over exactly the " +
  "period it states, with the sign its formula gives - and give your final answer again.";

/** What the model is told when its answer holds figures no tool result
 * does: which ones, and how to compute them through a tool. */
export function figuresReason(figures: readonly string[]): string {
  return (
    `These figures in your final answer appear in no tool result: ${figures.join(", ")}. A figure you computed by hand ` +
    "is not checked: compute each with sql - one SELECT over the values you read, sums and differences over " +
    "CAST(x AS DECIMAL(38,6)) and ratios, products and powers over CAST(x AS DOUBLE) (a series with a window or WITH " +
    "RECURSIVE, its columns named in the first SELECT) - and give your final answer again from what it returns."
  );
}
