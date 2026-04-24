// Tests for checkAnswerQuality. The predicate takes `now` as an explicit
// parameter by design, so every test pins `now` to a fixed Date — never
// new Date() / Date.now() — to keep assertions deterministic as the wall
// clock moves. Threshold constants are imported, not hardcoded, so retuning
// the gates doesn't silently break these tests.

import { describe, it, expect } from "vitest";

import type { Answer } from "../../src/types/answer.js";
import {
  MAX_ANSWER_AGE_DAYS,
  MIN_BODY_CHARS_FOR_ANALYSIS,
  MIN_UPVOTES_FOR_ANALYSIS,
} from "../../src/config/thresholds.js";
import { checkAnswerQuality } from "../../src/validators/answer-quality.js";

const NOW = new Date("2026-04-23T00:00:00.000Z");
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Build an ISO string for a Date `days` before NOW. */
function daysBeforeNow(days: number): string {
  return new Date(NOW.getTime() - days * MS_PER_DAY).toISOString();
}

/** Body of exactly `len` chars. Uses ASCII so .length === char count. */
function bodyOfLength(len: number): string {
  return "x".repeat(len);
}

/** A baseline passing answer. Individual tests override only the field under test. */
function makePassingAnswer(overrides: Partial<Answer> = {}): Answer {
  return {
    id: "answer-1",
    questionId: "question-1",
    questionTitle: "Some 知乎 question",
    body: bodyOfLength(MIN_BODY_CHARS_FOR_ANALYSIS + 10),
    authorName: "someone",
    upvotes: MIN_UPVOTES_FOR_ANALYSIS + 10,
    commentCount: 3,
    createdAt: daysBeforeNow(30),
    url: "https://www.zhihu.com/question/1/answer/1",
    scrapedAt: NOW.toISOString(),
    ...overrides,
  };
}

describe("checkAnswerQuality", () => {
  it("returns ok:true when all three gates pass", () => {
    const answer = makePassingAnswer();
    const result = checkAnswerQuality(answer, NOW);
    expect(result).toEqual({ ok: true });
  });

  it("rejects when upvotes are one below the minimum", () => {
    const answer = makePassingAnswer({
      upvotes: MIN_UPVOTES_FOR_ANALYSIS - 1,
    });
    const result = checkAnswerQuality(answer, NOW);
    expect(result.ok).toBe(false);
    if (result.ok) return; // type guard for TS
    expect(result.reasons).toHaveLength(1);
    expect(result.reasons[0]).toMatch(/upvotes/i);
  });

  it("rejects when body length is one below the minimum", () => {
    const answer = makePassingAnswer({
      body: bodyOfLength(MIN_BODY_CHARS_FOR_ANALYSIS - 1),
    });
    const result = checkAnswerQuality(answer, NOW);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reasons).toHaveLength(1);
    expect(result.reasons[0]).toMatch(/body/i);
  });

  it("rejects when age exceeds MAX_ANSWER_AGE_DAYS", () => {
    // One full day past the cutoff so age > MAX_ANSWER_AGE_DAYS strictly.
    const answer = makePassingAnswer({
      createdAt: daysBeforeNow(MAX_ANSWER_AGE_DAYS + 1),
    });
    const result = checkAnswerQuality(answer, NOW);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reasons).toHaveLength(1);
    expect(result.reasons[0]).toMatch(/age/i);
  });

  it("emits all rejection reasons at once when every gate fails", () => {
    const answer = makePassingAnswer({
      upvotes: MIN_UPVOTES_FOR_ANALYSIS - 1,
      body: bodyOfLength(MIN_BODY_CHARS_FOR_ANALYSIS - 1),
      createdAt: daysBeforeNow(MAX_ANSWER_AGE_DAYS + 1),
    });
    const result = checkAnswerQuality(answer, NOW);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reasons).toHaveLength(3);
  });

  it("accepts boundary values: upvotes/body at min, age exactly MAX_ANSWER_AGE_DAYS", () => {
    // Validator uses strict `<` for upvotes and body, and `>` for age, so
    // these exact boundary values must all pass.
    const answer = makePassingAnswer({
      upvotes: MIN_UPVOTES_FOR_ANALYSIS,
      body: bodyOfLength(MIN_BODY_CHARS_FOR_ANALYSIS),
      createdAt: daysBeforeNow(MAX_ANSWER_AGE_DAYS),
    });
    const result = checkAnswerQuality(answer, NOW);
    expect(result).toEqual({ ok: true });
  });
});
