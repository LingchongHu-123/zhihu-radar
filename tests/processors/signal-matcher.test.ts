// Tests for the pure signal-matching processor. No network, no Claude,
// no fixture file — every input is constructed inline. Keyword strings
// are pulled from SIGNAL_KEYWORDS so a future edit to the config doesn't
// silently break these tests.

import { describe, it, expect } from "vitest";

import {
  matchSignals,
  computeSignalDensity,
} from "../../src/processors/signal-matcher.js";
import type { Answer, Comment } from "../../src/types/answer.js";
import {
  SIGNAL_KEYWORDS,
  SIGNAL_KINDS_IN_ORDER,
} from "../../src/config/signals.js";
import { MIN_CHARS_FOR_DENSITY } from "../../src/config/thresholds.js";

// ---------- helpers ----------

function makeAnswer(overrides: Partial<Answer> = {}): Answer {
  return {
    id: "ans-1",
    questionId: "q-1",
    questionTitle: "test question",
    body: "",
    authorName: "tester",
    upvotes: 10,
    commentCount: 0,
    createdAt: "2026-01-01T00:00:00Z",
    url: "https://www.zhihu.com/question/1/answer/1",
    scrapedAt: "2026-04-23T00:00:00Z",
    ...overrides,
  };
}

function makeComment(overrides: Partial<Comment> = {}): Comment {
  return {
    id: "c-1",
    answerId: "ans-1",
    body: "",
    authorName: "commenter",
    upvotes: 0,
    createdAt: "2026-01-02T00:00:00Z",
    scrapedAt: "2026-04-23T00:00:00Z",
    ...overrides,
  };
}

// Pull representative keywords from the config. If any kind ever has an
// empty list these lookups will yield `undefined` and the tests will fail
// loudly — which is the correct behavior: a kind with zero keywords is a
// bug in config, not something a test should paper over.
const CONTACT_KW = SIGNAL_KEYWORDS["contact-request"][0]!;
const PAYMENT_KW = SIGNAL_KEYWORDS["payment-intent"][0]!;
const DM_PULL_KW = SIGNAL_KEYWORDS["dm-pull"][0]!;

describe("matchSignals", () => {
  it("finds a single keyword match in the answer body", () => {
    const prefix = "关于出国的问题";
    const suffix = "呢？";
    const answer = makeAnswer({
      id: "ans-42",
      body: `${prefix}${CONTACT_KW}${suffix}`,
    });

    const signals = matchSignals(answer, []);

    expect(signals).toHaveLength(1);
    const [s] = signals;
    expect(s).toBeDefined();
    expect(s!.kind).toBe("contact-request");
    expect(s!.keyword).toBe(CONTACT_KW);
    expect(s!.location).toEqual({
      kind: "answer-body",
      answerId: "ans-42",
    });
    expect(s!.spanStart).toBe(prefix.length);
    expect(s!.spanEnd).toBe(prefix.length + CONTACT_KW.length);
  });

  it("finds a single keyword match in a comment", () => {
    const answer = makeAnswer({
      id: "ans-77",
      body: "这是一段完全没有任何信号关键词的正文内容，用来排除误报。",
    });
    const commentPrefix = "请问这个服务";
    const comment = makeComment({
      id: "c-9",
      answerId: "ans-77",
      body: `${commentPrefix}${PAYMENT_KW}吗`,
    });

    const signals = matchSignals(answer, [comment]);

    expect(signals).toHaveLength(1);
    const [s] = signals;
    expect(s).toBeDefined();
    expect(s!.kind).toBe("payment-intent");
    expect(s!.keyword).toBe(PAYMENT_KW);
    expect(s!.location).toEqual({
      kind: "comment",
      commentId: "c-9",
      answerId: "ans-77",
    });
    expect(s!.spanStart).toBe(commentPrefix.length);
    expect(s!.spanEnd).toBe(commentPrefix.length + PAYMENT_KW.length);
  });

  it("emits one signal per occurrence when a keyword repeats in the body", () => {
    const filler = "中间一些无关文字";
    const body = `${CONTACT_KW}${filler}${CONTACT_KW}${filler}${CONTACT_KW}`;
    const answer = makeAnswer({ body });

    const signals = matchSignals(answer, []);

    const contactHits = signals.filter(
      (s) => s.kind === "contact-request" && s.keyword === CONTACT_KW,
    );
    expect(contactHits).toHaveLength(3);

    const starts = contactHits.map((s) => s.spanStart);
    expect(new Set(starts).size).toBe(3);

    const expectedStarts = [
      0,
      CONTACT_KW.length + filler.length,
      2 * (CONTACT_KW.length + filler.length),
    ];
    expect(starts).toEqual(expectedStarts);

    for (const s of contactHits) {
      expect(s.spanEnd).toBe(s.spanStart + CONTACT_KW.length);
    }
  });

  it("returns an empty array when nothing matches", () => {
    const answer = makeAnswer({
      body: "完全不包含任何买家意图的普通文本。",
    });
    const comment = makeComment({
      body: "这是一条普通评论，讨论与转化无关的事情。",
    });

    const signals = matchSignals(answer, [comment]);
    expect(signals).toEqual([]);
  });

  it("returns signals in SIGNAL_KINDS_IN_ORDER (contact-request before dm-pull)", () => {
    // Sanity check: the canonical ordering places contact-request before
    // dm-pull. If someone reorders SIGNAL_KINDS_IN_ORDER this test will
    // start failing, which is the intended early warning.
    const contactIdx = SIGNAL_KINDS_IN_ORDER.indexOf("contact-request");
    const dmIdx = SIGNAL_KINDS_IN_ORDER.indexOf("dm-pull");
    expect(contactIdx).toBeGreaterThanOrEqual(0);
    expect(dmIdx).toBeGreaterThanOrEqual(0);
    expect(contactIdx).toBeLessThan(dmIdx);

    // Put the dm-pull keyword physically FIRST in the body so that any
    // naive "first appearance wins" implementation would emit it first.
    // The implementation must still emit contact-request first because
    // it walks SIGNAL_KINDS_IN_ORDER.
    const body = `${DM_PULL_KW} 之后再问 ${CONTACT_KW}`;
    const answer = makeAnswer({ body });

    const signals = matchSignals(answer, []);

    expect(signals).toHaveLength(2);
    expect(signals[0]!.kind).toBe("contact-request");
    expect(signals[1]!.kind).toBe("dm-pull");
  });
});

describe("computeSignalDensity", () => {
  it("returns 0 when combined body+comment length is below MIN_CHARS_FOR_DENSITY", () => {
    // Body containing one keyword, but the total combined length is well
    // under the floor — density must be exactly 0 regardless of hits.
    const body = CONTACT_KW; // short on purpose
    expect(body.length).toBeLessThan(MIN_CHARS_FOR_DENSITY);
    const answer = makeAnswer({ body });

    const signals = matchSignals(answer, []);
    expect(signals.length).toBeGreaterThanOrEqual(1);

    const density = computeSignalDensity(signals, answer, []);
    expect(density).toBe(0);
  });

  it("returns signals * 1000 / totalChars when combined length meets the floor", () => {
    // Build a body long enough to clear MIN_CHARS_FOR_DENSITY and that
    // contains exactly one match of CONTACT_KW.
    const padChar = "文";
    const padLength = Math.max(
      0,
      MIN_CHARS_FOR_DENSITY - CONTACT_KW.length + 5,
    );
    const body = padChar.repeat(padLength) + CONTACT_KW;
    const answer = makeAnswer({ body });

    // One comment with no matches, just additional chars to exercise the
    // "combined body+comment text" part of the formula.
    const commentBody = "一条不含关键词的评论。".repeat(3);
    const comment = makeComment({ body: commentBody });

    const signals = matchSignals(answer, [comment]);
    // Sanity: exactly the one contact-request hit from the body.
    expect(signals).toHaveLength(1);
    expect(signals[0]!.kind).toBe("contact-request");

    const totalChars = body.length + commentBody.length;
    expect(totalChars).toBeGreaterThanOrEqual(MIN_CHARS_FOR_DENSITY);

    const density = computeSignalDensity(signals, answer, [comment]);
    const expected = (signals.length * 1000) / totalChars;

    expect(density).toBeCloseTo(expected, 10);
  });
});
