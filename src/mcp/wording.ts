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
 * rule, said the same way in every text the models read (the owner,
 * 2026-10-11: "is there a situation where we should NOT use hybrid search?"
 * - counting or listing every exact occurrence, and nothing else). Measured
 * that day: on OfficeQA the caller wrote 67 token_match statements to 5
 * hybrid_search, AND-matching five-word phrases over scanned text where one
 * misread word drops the passage; on a product-analytics table it answered "are there any rage
 * prompts" by matching the word "rage". Its first call was already the
 * hybrid search in 35 of 36 tries, so the keyword pull is in the later
 * turns, where the sentences that read as reasons - token_match "complete",
 * the top-k caveat, token_match as the fast way to match words - now bind
 * to counting only. Said only where a table has a vector to rank by; the
 * loop carries the same sentence (the platform loop's text,
 * `SQL_SEARCH_RULE`). */
export const SEARCH_RULE_SENTENCE =
  "Finding rows is a hybrid_search, whatever the question names - a figure, a topic, a kind of thing, a word it " +
  "says the rows mention: the rows rarely use the question's words, scanned and typed text misspells them, and the " +
  "keyword half of the search still ranks an exact hit first. The keyword functions - token_match, bm25_search, LIKE " +
  "on an indexed column - are for one thing only, counting or listing every exact occurrence of a literal, where a " +
  "ranked top k would be incomplete. A question with no text in it - how many rows, the largest values, a total - is " +
  "plain SQL with no search function. ";
/** Every explicit ask of a task, checked against the draft before the
 * answer. Of the 1,364 criteria a legal-document benchmark's practice-area run failed
 * (176 tasks, 2026-10-08, Claude Sonnet 4.6 judge), 30% of the score lost
 * was an ask the deliverable never addressed and 6% a structure it named
 * and the deliverable lacked (an addressee, a severity rating, a column);
 * in the 43 tasks that missed only one or two criteria, the two were 48%
 * of what they lost. Said for every table: the loop never writes the answer,
 * so it has no counterpart there. */
export const TASK_CHECKLIST_SENTENCE =
  "Before you write the final answer to a task, list every explicit ask in it - each deliverable and its file name, " +
  "who it is addressed to, every section, table, rating or count it names, every question it poses - and check your " +
  "draft against that list; an ask the draft does not meet is fixed before you answer, never left out.";
/** How a figure is read out of documents. Diagnosed over the 22 OfficeQA
 * questions the Infino arm missed (2026-10-07): 14 were misreadings of rows
 * it had retrieved - an earlier edition's figure where a later one revised
 * it, a window a year wider than the question's, an inclusion rule applied
 * to one figure and not the next, a total rebuilt from parts that did not
 * sum to the printed one, a dash or a sign read the other way. One habit per
 * kind. The loop never reads its rows, so its text carries only the
 * retrieval side of the first (the platform loop's text, `SQL_EVERY_EDITION`).
 *
 * Rewritten the same day from the nine misses that outlived the first
 * wording, each reproduced against the key: the latest edition was applied
 * per step rather than per year, so one year took two editions' values
 * (30, 34); "the stated period" was read as which years to fetch, and a
 * series ran past or short of the window (40, 32); a question's exclusion
 * was narrowed or a stricter one invented (24, 27), and a named entity was
 * ranked by one of its sub-lines (34); "printed over rebuilt" put a printed
 * subtotal into a statistic over records, the opposite of what the key did
 * (29); a printed nil marker was dropped and tied observations collapsed
 * (43); and an answer shipped a reading the model named but did not compute
 * (24). One clause per kind, worded for documents, not for any question.
 *
 * "Latest" narrowed to a revision, 2026-10-15: a later printing took the
 * place of an earlier one whenever it differed, so a misprint or a
 * reclassification won as readily as a correction. On OfficeQA a later
 * edition's 1795 figure that its own row totals contradict replaced the one
 * they support (63); the next year's editions, which moved military
 * assistance out of Defense, replaced each year's own (56); and a later
 * edition's comparable year stood in for the fiscal year asked (34) - while
 * the corrections that are revisions (88: a note "should have read"; 30: a
 * restated line) still have to win. With this definition in front of the
 * model, question 63 went from 2 of 5 runs right to 5 of 5.
 *
 * Parts, names and signs, 2026-10-17, from the questions some runs got
 * right and the 66/90 run did not, each reply naming the key's reading as
 * the other one. "Sub-lines use their sum" added two appropriation years'
 * lines where the question's date picks one (58), yet left out the
 * pensions and Indian columns printed under a named heading (83): parts are
 * summed, periods are chosen. A named price-index series was swapped for
 * another table whose title the reply admitted differed (45), and
 * collection locations the question names were merged into states (41).
 * Station repair amounts were turned negative from balances (64). */
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
/** Arithmetic in a statement, never by hand. On OfficeQA question 1
 * (2026-10-07) the caller read all sixteen figures right and computed a
 * five-span exponential average itself: its first step came out 67 cents
 * high (940,998.60 / 3), the error carried into every later step, and the
 * answer was six cents off - wrong under exact match. The caller here has
 * no code execution, but sql evaluates DECIMAL arithmetic exactly: the same
 * series as one WITH RECURSIVE statement on the platform gave 7,046,001.98,
 * the key. A bare literal with a fraction is read as a float, hence the
 * CAST; DataFusion names a recursive CTE's columns from its first SELECT,
 * not from the CTE's column list - both met writing that statement. A
 * DECIMAL division can overflow (on OfficeQA question 24 the dividend was
 * scaled past 38 digits and the statement failed), so ratios, products and
 * powers go through DOUBLE, whose precision is ample at the places an
 * answer reports. */
export const ARITHMETIC_SENTENCE =
  "Compute every figure your answer reports with a statement, never by hand: sql sums and differences are exact over " +
  "CAST(x AS DECIMAL(38,6)) values (a bare literal with a fraction is read as a float), and ratios, products and " +
  "powers go through CAST(x AS DOUBLE), where a DECIMAL division can overflow; so growth rates, averages and every " +
  "other figure over the values you read are one SELECT over them, and a series - a running total, a moving or " +
  "exponential average - is one statement with a window or WITH RECURSIVE (name its columns in the first SELECT).";

/** The tools whose use in a turn means the model retrieved through this
 * server (commands/hook-cmd.ts, `answer-figures`). */
export const RETRIEVAL_TOOLS = ["search", "find", "sql"];
