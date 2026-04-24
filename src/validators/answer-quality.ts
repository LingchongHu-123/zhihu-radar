// Quality gate for answers before they're handed to processors/. Pure
// predicate: takes an Answer + a "now" timestamp, returns either ok or a
// list of human-readable rejection reasons. The three thresholds it reads
// (MIN_UPVOTES_FOR_ANALYSIS, MIN_BODY_CHARS_FOR_ANALYSIS,
// MAX_ANSWER_AGE_DAYS) are this validator's exclusive turf — every other
// layer that wants to apply them should import this function rather than
// re-reading the constants, so there's a single place to change what
// "acceptable" means.
//
// "now" is an explicit parameter, not Date.now(). The point is testability:
// a predicate that reads the wall clock can't be pinned to a fixture.
// Whoever orchestrates this validator (runtime/) is responsible for
// supplying a consistent "now" for a whole batch — that way every answer
// in one report is aged against the same reference point.
//
// All reasons are emitted together: if an answer fails three gates, the
// caller gets three reasons, not the first one. That's by design — debug
// output for self-use is cheaper when you can see all the problems at once.

import type { Answer } from "../types/answer.js";
import {
  MAX_ANSWER_AGE_DAYS,
  MIN_BODY_CHARS_FOR_ANALYSIS,
  MIN_UPVOTES_FOR_ANALYSIS,
} from "../config/thresholds.js";

/** Outcome of a quality check. `reasons` is only present on failure. */
export type AnswerQualityResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reasons: ReadonlyArray<string> };

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Decide whether an answer is worth analyzing.
 *
 * Gates (all must pass):
 *   - upvotes >= MIN_UPVOTES_FOR_ANALYSIS
 *   - body length (chars) >= MIN_BODY_CHARS_FOR_ANALYSIS
 *   - age (now - createdAt, in days) <= MAX_ANSWER_AGE_DAYS
 *
 * @param answer  the candidate row
 * @param now     reference timestamp for age comparison. Pass the batch's
 *                single "now" Date so every answer in a run ages against
 *                the same point.
 */
export function checkAnswerQuality(
  answer: Answer,
  now: Date,
): AnswerQualityResult {
  const reasons: string[] = [];

  if (answer.upvotes < MIN_UPVOTES_FOR_ANALYSIS) {
    reasons.push(
      `upvotes ${answer.upvotes} < MIN_UPVOTES_FOR_ANALYSIS (${MIN_UPVOTES_FOR_ANALYSIS})`,
    );
  }

  if (answer.body.length < MIN_BODY_CHARS_FOR_ANALYSIS) {
    reasons.push(
      `body length ${answer.body.length} < MIN_BODY_CHARS_FOR_ANALYSIS (${MIN_BODY_CHARS_FOR_ANALYSIS})`,
    );
  }

  const createdAtMs = new Date(answer.createdAt).getTime();
  if (Number.isNaN(createdAtMs)) {
    reasons.push(`createdAt is not a parseable date: ${answer.createdAt}`);
  } else {
    const ageDays = (now.getTime() - createdAtMs) / MS_PER_DAY;
    if (ageDays > MAX_ANSWER_AGE_DAYS) {
      reasons.push(
        `age ${Math.floor(ageDays)} days > MAX_ANSWER_AGE_DAYS (${MAX_ANSWER_AGE_DAYS})`,
      );
    }
  }

  if (reasons.length === 0) {
    return { ok: true };
  }
  return { ok: false, reasons };
}
