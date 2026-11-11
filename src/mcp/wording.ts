// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// Sentences of the tool text and instructions that measurements put there,
// kept apart from the server so another program that drives these tools -
// the Supermodel service, whose model reads them in its own instructions -
// takes the same words without loading the server and everything it starts.
// The server imports them from here and re-exports them, so its tool text
// and its tests are unchanged.

/** When a search is the hybrid one and when it is a keyword match: the one
 * rule, said the same way in every text the models read. Hybrid search is for
 * finding rows; the keyword functions are for counting or listing every exact
 * occurrence, and nothing else. Without the rule a caller drifts to
 * AND-matching whole phrases with token_match over scanned text, where one
 * misread word drops the passage, or answers a question about a kind of
 * thing by matching one word. The sentences that read as reasons to prefer
 * token_match - "complete", the top-k caveat, matching words fast - are tied
 * to counting here. Said only where a table has a vector to rank by; the
 * platform's own loop carries the same sentence. */
export const SEARCH_RULE_SENTENCE =
  "Finding rows is a hybrid_search, whatever the question names - a figure, a topic, a kind of thing, a word it " +
  "says the rows mention: the rows rarely use the question's words, scanned and typed text misspells them, and the " +
  "keyword half of the search still ranks an exact hit first. The keyword functions - token_match, bm25_search, LIKE " +
  "on an indexed column - are for one thing only, counting or listing every exact occurrence of a literal, where a " +
  "ranked top k would be incomplete. A question with no text in it - how many rows, the largest values, a total - is " +
  "plain SQL with no search function. ";
/** Every explicit ask of a task, checked against the draft before the
 * answer. A deliverable most often loses points by leaving out something the
 * task asked for, or a structure it named - an addressee, a rating, a column
 * - and a draft checked against a list of the asks catches both. Said for
 * every table. */
export const TASK_CHECKLIST_SENTENCE =
  "Before you write the final answer to a task, list every explicit ask in it - each deliverable and its file name, " +
  "who it is addressed to, every section, table, rating or count it names, every question it poses - and check your " +
  "draft against that list; an ask the draft does not meet is fixed before you answer, never left out.";
/** How a figure is read out of documents. A model that retrieved the right
 * rows still misreads them in a few recurring ways: an earlier edition's
 * figure where a later one revised it, a window a year wider than the
 * question's, an inclusion rule applied to one figure and not the next, a
 * total rebuilt from parts that do not sum to the printed one, a dash or a
 * sign read the other way, a printed nil marker dropped, a named series
 * swapped for a similar one, parts of a period summed where the question
 * picks one. One clause per kind, worded for documents, not for any
 * question. "Latest" means a revision: a later printing replaces an earlier
 * one only where it corrects it, not where it reclassifies or misprints. The
 * platform's own loop never reads its rows, so its text carries only the
 * retrieval side of the first. */
export const READING_HABITS =
  "Reading figures from documents: build one series first, each period's value from the latest document that " +
  "revises it - a later printing of the same measure, for the same period and coverage, that the documents present " +
  "as a correction or whose own totals support it; a later figure its own totals contradict, or one reflecting a " +
  "reclassification or a different period, is not a revision, and the earlier printing stands - then compute over " +
  "that series - never two editions' values for one period; use exactly the period the " +
  "question states, every observation dated inside it through its last and none outside, so n periods give n-1 " +
  "changes; the question's exclusions are complete, so keep every row and component it does not exclude, add back " +
  "any a later report splits out, and when a table splits the named entity into parts - sub-lines, or sub-columns " +
  "printed under its heading - use their sum, but lines that split it by period, one per appropriation or fiscal " +
  "year, are periods, and the period the question names picks one; a source, series or table the question names by " +
  "its title is the one used, never another standing in for it, and figures are taken at the grain the question " +
  "names - its locations, payees or accounts as printed - never merged into a coarser group; a value keeps the sign " +
  "it is printed with, never one inferred from balances or totals; a figure " +
  "asked for as printed is taken as printed, but a statistic over records is built from the rows with one rule and " +
  "printed subtotals only check it; a printed nil marker (-, ----) is zero, and a statistic uses every observation, " +
  "ties kept; and never answer with a reading you name but did not compute - compute each reading you name, then " +
  "choose.";
/** Arithmetic in a statement, never by hand. A multi-step figure computed by
 * hand can drift by a few cents and be wrong under exact match; the caller
 * here has no code execution, but sql evaluates DECIMAL arithmetic exactly,
 * and a series is one WITH RECURSIVE statement. A bare literal with a
 * fraction is read as a float, hence the CAST; the engine names a recursive
 * CTE's columns from its first SELECT, not from the CTE's column list. A
 * DECIMAL division can overflow past 38 digits, so ratios, products and
 * powers go through DOUBLE, whose precision is ample at the places an answer
 * reports. */
export const ARITHMETIC_SENTENCE =
  "Compute every figure your answer reports with a statement, never by hand: sql sums and differences are exact over " +
  "CAST(x AS DECIMAL(38,6)) values (a bare literal with a fraction is read as a float), and ratios, products and " +
  "powers go through CAST(x AS DOUBLE), where a DECIMAL division can overflow; so growth rates, averages and every " +
  "other figure over the values you read are one SELECT over them, and a series - a running total, a moving or " +
  "exponential average - is one statement with a window or WITH RECURSIVE (name its columns in the first SELECT).";

/** The tools whose use in a turn means the model retrieved through this
 * server (commands/hook-cmd.ts, `answer-figures`). */
export const RETRIEVAL_TOOLS = ["search", "find", "sql"];
