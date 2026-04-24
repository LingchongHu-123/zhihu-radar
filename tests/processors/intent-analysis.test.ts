// Tests for the Claude-backed intent analyzer. No network: every call to
// Claude goes through a mock `ClaudeClient` constructed inline. No fixture
// files: Answer/Comment shapes are built in-place.
//
// The load-bearing test here is "ADR 002 cache-friendly prefix": two
// distinct answers must produce byte-identical system-block text. If that
// ever fails, something leaked a per-call value into the cached prefix
// and the ~10% cache-hit billing goes out the window.

import { describe, it, expect } from "vitest";

import {
  buildStablePrefix,
  buildVolatilePayload,
  buildClaudeRequest,
  analyzeAnswer,
  type ClaudeRequest,
  type ClaudeResponse,
  type ClaudeClient,
} from "../../src/processors/intent-analysis.js";
import type { Answer, Comment } from "../../src/types/answer.js";
import { SIGNAL_KEYWORDS, SIGNAL_KINDS_IN_ORDER } from "../../src/config/signals.js";

// ---------- helpers ----------

function makeAnswer(overrides: Partial<Answer> = {}): Answer {
  return {
    id: "ans-1",
    questionId: "q-1",
    questionTitle: "留学中介怎么选?",
    body: "关于出国申请的一点经验分享。",
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

/**
 * Build a mock `ClaudeClient` that:
 *   - records every request it sees (so tests can assert what was sent),
 *   - returns a ClaudeResponse whose single text block contains `responseText`.
 */
function makeMockClient(responseText: string): {
  client: ClaudeClient;
  requests: ClaudeRequest[];
} {
  const requests: ClaudeRequest[] = [];
  const client: ClaudeClient = async (req) => {
    requests.push(req);
    const res: ClaudeResponse = {
      content: [{ type: "text", text: responseText }],
    };
    return res;
  };
  return { client, requests };
}

const FIXED_NOW = new Date("2026-04-24T12:00:00.000Z");

// A short non-keyword phrase used as Claude-discovered evidence in the
// discoveredSignals tests below. Picked to NOT appear in any
// SIGNAL_KEYWORDS list, so that planting it in a body produces zero
// keyword hits and any resulting signal is unambiguously claude-sourced.
const NON_KEYWORD_EVIDENCE = "咋整啊";

// ---------- buildStablePrefix ----------

describe("buildStablePrefix", () => {
  it("is byte-stable across calls", () => {
    const a = buildStablePrefix();
    const b = buildStablePrefix();
    expect(a).toBe(b);
  });

  it("contains every SignalKind from SIGNAL_KINDS_IN_ORDER", () => {
    const prefix = buildStablePrefix();
    for (const kind of SIGNAL_KINDS_IN_ORDER) {
      expect(prefix).toContain(kind);
    }
  });
});

// ---------- buildClaudeRequest ----------

describe("buildClaudeRequest", () => {
  it("marks the system block as cacheable (ephemeral)", () => {
    const answer = makeAnswer();
    const req = buildClaudeRequest(answer, []);
    expect(req.system.length).toBe(1);
    expect(req.system[0]!.type).toBe("text");
    expect(req.system[0]!.cache_control).toEqual({ type: "ephemeral" });
  });

  // ADR 002: the stable prefix must be byte-identical across different
  // answers. If this test ever fails, the prefix leaked a per-call value.
  it("produces a byte-identical stable prefix for different answers (ADR 002)", () => {
    const answerA = makeAnswer({
      id: "ans-A",
      body: "申请美研的完整时间线,非常长的一段正文内容。",
      upvotes: 42,
    });
    const answerB = makeAnswer({
      id: "ans-B",
      body: "英硕 G5 的申请经验,完全不同的一篇。",
      upvotes: 999,
    });

    const reqA = buildClaudeRequest(answerA, []);
    const reqB = buildClaudeRequest(answerB, []);

    expect(reqA.system[0]!.text).toBe(reqB.system[0]!.text);
  });

  it("produces a volatile user message that differs between answers", () => {
    const answerA = makeAnswer({
      id: "ans-A",
      body: "申请美研的完整时间线。",
      upvotes: 42,
    });
    const answerB = makeAnswer({
      id: "ans-B",
      body: "英硕 G5 的申请经验。",
      upvotes: 999,
    });

    const reqA = buildClaudeRequest(answerA, []);
    const reqB = buildClaudeRequest(answerB, []);

    const textA = reqA.messages[0]!.content[0]!.text;
    const textB = reqB.messages[0]!.content[0]!.text;
    expect(textA).not.toBe(textB);
  });

  // Phase C-revisit: max_tokens bumped from 512 → 1024 to make room for
  // the discoveredSignals array. Pin it so any silent regression trips here.
  it("uses max_tokens = 1024 (bumped for discoveredSignals)", () => {
    const answer = makeAnswer();
    const req = buildClaudeRequest(answer, []);
    expect(req.max_tokens).toBe(1024);
  });
});

// ---------- buildVolatilePayload ----------

describe("buildVolatilePayload", () => {
  it("includes the answer body and comment bodies in the output", () => {
    const answer = makeAnswer({ body: "正文关键字XYZ" });
    const comments: ReadonlyArray<Comment> = [
      makeComment({ id: "c-1", body: "评论关键字ABC" }),
    ];
    const payload = buildVolatilePayload(answer, comments);
    expect(payload).toContain("正文关键字XYZ");
    expect(payload).toContain("评论关键字ABC");
  });

  it("labels comments with [Comment #N] markers in input order", () => {
    const answer = makeAnswer({ body: "答案正文。" });
    const comments: ReadonlyArray<Comment> = [
      makeComment({ id: "c-0", body: "first comment body" }),
      makeComment({ id: "c-1", body: "second comment body" }),
      makeComment({ id: "c-2", body: "third comment body" }),
    ];
    const payload = buildVolatilePayload(answer, comments);

    expect(payload).toContain("[Comment #0]");
    expect(payload).toContain("[Comment #1]");
    expect(payload).toContain("[Comment #2]");

    // Must appear in numeric order (matches input order).
    const i0 = payload.indexOf("[Comment #0]");
    const i1 = payload.indexOf("[Comment #1]");
    const i2 = payload.indexOf("[Comment #2]");
    expect(i0).toBeGreaterThanOrEqual(0);
    expect(i1).toBeGreaterThan(i0);
    expect(i2).toBeGreaterThan(i1);
  });
});

// ---------- analyzeAnswer ----------

describe("analyzeAnswer", () => {
  it("round-trips via a mock client into a full AnalyzedAnswer", async () => {
    const answer = makeAnswer({
      // Include a keyword so `signals.length > 0`.
      body: "申请美研的时间线,求推荐靠谱的中介。正文要长一些让总字符超过密度阈值,因此再写几句废话:申请、面试、文书、签证、行前准备等等等等等等等。",
      upvotes: 50,
    });
    const comments: ReadonlyArray<Comment> = [
      makeComment({
        id: "c-1",
        body: "私信我,我可以详细聊聊。再补充一些字数让评论本身也稍长一点。",
      }),
    ];

    const { client } = makeMockClient(
      '{"intentSummary":"读者在找靠谱的中介","intentConfidence":0.8,"discoveredSignals":[]}',
    );

    const result = await analyzeAnswer(answer, comments, {
      clientImpl: client,
      now: FIXED_NOW,
    });

    // Required AnalyzedAnswer fields.
    expect(result.answer).toBe(answer);
    expect(result.comments).toBe(comments);
    expect(result.intentSummary).toBe("读者在找靠谱的中介");
    expect(result.intentConfidence).toBe(0.8);
    expect(result.analyzedAt).toBe(FIXED_NOW.toISOString());
    // signals is an array, and since we planted keywords, should be non-empty.
    expect(Array.isArray(result.signals)).toBe(true);
    expect(result.signals.length).toBeGreaterThan(0);
    expect(typeof result.signalsPer1kChars).toBe("number");
  });

  it("passes the built request (with the stable prefix) to the client", async () => {
    const answer = makeAnswer();
    const { client, requests } = makeMockClient(
      '{"intentSummary":"x","intentConfidence":0.5,"discoveredSignals":[]}',
    );

    await analyzeAnswer(answer, [], { clientImpl: client, now: FIXED_NOW });

    expect(requests.length).toBe(1);
    expect(requests[0]!.system[0]!.text).toBe(buildStablePrefix());
  });

  it("tolerates JSON surrounded by prose", async () => {
    const answer = makeAnswer();
    const { client } = makeMockClient(
      'Sure! {"intentSummary":"读者想私信联系","intentConfidence":0.55,"discoveredSignals":[]} done.',
    );

    const result = await analyzeAnswer(answer, [], {
      clientImpl: client,
      now: FIXED_NOW,
    });

    expect(result.intentConfidence).toBe(0.55);
    expect(result.intentSummary).toBe("读者想私信联系");
  });

  it("rejects when the response contains no JSON object", async () => {
    const answer = makeAnswer();
    const client: ClaudeClient = async () => ({
      content: [{ type: "text", text: "I cannot help with that." }],
    });

    await expect(
      analyzeAnswer(answer, [], { clientImpl: client, now: FIXED_NOW }),
    ).rejects.toThrow(/no JSON/i);
  });

  it("rejects when intentConfidence is outside [0, 1]", async () => {
    const answer = makeAnswer();
    const { client } = makeMockClient(
      '{"intentSummary":"x","intentConfidence":1.5,"discoveredSignals":[]}',
    );

    await expect(
      analyzeAnswer(answer, [], { clientImpl: client, now: FIXED_NOW }),
    ).rejects.toThrow(/\[0, 1\]|outside/);
  });

  it("uses opts.now for analyzedAt (no hidden clock read)", async () => {
    const answer = makeAnswer();
    const { client } = makeMockClient(
      '{"intentSummary":"x","intentConfidence":0.1,"discoveredSignals":[]}',
    );
    const explicitNow = new Date("2026-04-24T12:00:00.000Z");

    const result = await analyzeAnswer(answer, [], {
      clientImpl: client,
      now: explicitNow,
    });

    expect(result.analyzedAt).toBe("2026-04-24T12:00:00.000Z");
  });
});

// ---------- discoveredSignals → ConversionSignal mapping ----------

describe("analyzeAnswer discoveredSignals", () => {
  it("merges a discovered signal whose evidence is found verbatim in the answer body", async () => {
    // Pin the offset of the evidence string deterministically.
    // Body uses no SIGNAL_KEYWORDS phrases, so the only signal that can
    // possibly come out is the claude-discovered one we inject below.
    const prefix = "无关前缀文字XX";
    const evidence = NON_KEYWORD_EVIDENCE;
    const suffix = "无关后缀文字YY";
    const body = `${prefix}${evidence}${suffix}`;
    const answer = makeAnswer({ id: "ans-disc", body });

    const expectedStart = body.indexOf(evidence);
    expect(expectedStart).toBe(prefix.length);

    const { client } = makeMockClient(
      JSON.stringify({
        intentSummary: "读者在试探性联系",
        intentConfidence: 0.6,
        discoveredSignals: [
          { kind: "contact-request", evidence, location: "answer-body" },
        ],
      }),
    );

    const result = await analyzeAnswer(answer, [], {
      clientImpl: client,
      now: FIXED_NOW,
    });

    const claudeHits = result.signals.filter((s) => s.source === "claude");
    expect(claudeHits).toHaveLength(1);
    const [hit] = claudeHits;
    expect(hit!.keyword).toBe(evidence);
    expect(hit!.kind).toBe("contact-request");
    expect(hit!.location).toEqual({ kind: "answer-body", answerId: "ans-disc" });
    expect(hit!.spanStart).toBe(expectedStart);
    expect(hit!.spanEnd).toBe(expectedStart + evidence.length);
  });

  it("resolves location 'comment-N' to the matching comment by index", async () => {
    const answer = makeAnswer({ id: "ans-X", body: "答案正文。" });
    const evidence = "独特短语ZZZ"; // engineered to live only in comment 1
    const comments: ReadonlyArray<Comment> = [
      makeComment({ id: "c-A", answerId: "ans-X", body: "评论零内容" }),
      makeComment({
        id: "c-B",
        answerId: "ans-X",
        body: `开头一些字${evidence}结尾`,
      }),
    ];

    const { client } = makeMockClient(
      JSON.stringify({
        intentSummary: "...",
        intentConfidence: 0.4,
        discoveredSignals: [
          { kind: "contact-request", evidence, location: "comment-1" },
        ],
      }),
    );

    const result = await analyzeAnswer(answer, comments, {
      clientImpl: client,
      now: FIXED_NOW,
    });

    const claudeHits = result.signals.filter((s) => s.source === "claude");
    expect(claudeHits).toHaveLength(1);
    const [hit] = claudeHits;
    expect(hit!.location).toEqual({
      kind: "comment",
      commentId: "c-B",
      answerId: "ans-X",
    });
    expect(hit!.keyword).toBe(evidence);
  });

  it("drops a discovered signal whose evidence is paraphrased (not byte-found)", async () => {
    const answer = makeAnswer({
      id: "ans-P",
      body: "完全不含任何买家信号的普通正文段落。",
    });

    const { client } = makeMockClient(
      JSON.stringify({
        intentSummary: "...",
        intentConfidence: 0.2,
        discoveredSignals: [
          // Evidence string does not appear verbatim anywhere in body/comments.
          {
            kind: "contact-request",
            evidence: "this string is nowhere in the source",
            location: "answer-body",
          },
        ],
      }),
    );

    const result = await analyzeAnswer(answer, [], {
      clientImpl: client,
      now: FIXED_NOW,
    });

    const claudeHits = result.signals.filter((s) => s.source === "claude");
    expect(claudeHits).toHaveLength(0);
  });

  it("drops a discovered signal whose kind is not in SIGNAL_KINDS_IN_ORDER", async () => {
    const evidence = NON_KEYWORD_EVIDENCE;
    const answer = makeAnswer({
      id: "ans-K",
      body: `前缀${evidence}后缀`,
    });

    const { client } = makeMockClient(
      JSON.stringify({
        intentSummary: "...",
        intentConfidence: 0.3,
        discoveredSignals: [
          { kind: "spam-signal", evidence, location: "answer-body" },
        ],
      }),
    );

    const result = await analyzeAnswer(answer, [], {
      clientImpl: client,
      now: FIXED_NOW,
    });

    const claudeHits = result.signals.filter((s) => s.source === "claude");
    expect(claudeHits).toHaveLength(0);
  });

  it("drops a discovered signal whose comment-N index is out of range", async () => {
    const answer = makeAnswer({ id: "ans-OOB", body: "答案正文。" });
    const comments: ReadonlyArray<Comment> = [
      makeComment({ id: "c-0", body: "comment 0" }),
      makeComment({ id: "c-1", body: "comment 1 contains x" }),
    ];

    const { client } = makeMockClient(
      JSON.stringify({
        intentSummary: "...",
        intentConfidence: 0.3,
        discoveredSignals: [
          // Only 2 comments exist (indices 0, 1); 99 is out of range.
          { kind: "contact-request", evidence: "x", location: "comment-99" },
        ],
      }),
    );

    const result = await analyzeAnswer(answer, comments, {
      clientImpl: client,
      now: FIXED_NOW,
    });

    const claudeHits = result.signals.filter((s) => s.source === "claude");
    expect(claudeHits).toHaveLength(0);
  });

  it("treats missing discoveredSignals as empty (no throw, backward compat)", async () => {
    const answer = makeAnswer({
      id: "ans-BC",
      body: "完全不含任何关键词的正文。",
    });

    // Note: no discoveredSignals key at all.
    const { client } = makeMockClient(
      '{"intentSummary":"summary","intentConfidence":0.4}',
    );

    const result = await analyzeAnswer(answer, [], {
      clientImpl: client,
      now: FIXED_NOW,
    });

    expect(result.intentSummary).toBe("summary");
    expect(result.intentConfidence).toBe(0.4);
    const claudeHits = result.signals.filter((s) => s.source === "claude");
    expect(claudeHits).toHaveLength(0);
  });

  it("mergeSignals integration: a discovered signal that overlaps a keyword span is dropped", async () => {
    // Plant a CONFIG keyword at a known offset in the answer body.
    const KEYWORD = SIGNAL_KEYWORDS["contact-request"][0]!; // e.g. "怎么联系"
    const prefix = "AAA";
    const suffix = "BBB";
    const body = `${prefix}${KEYWORD}${suffix}`;
    const keywordStart = body.indexOf(KEYWORD);
    expect(keywordStart).toBe(prefix.length);

    const answer = makeAnswer({ id: "ans-INT", body });

    // Claude returns a discoveredSignal whose evidence is the keyword
    // itself plus the suffix — verbatim in body, overlapping the keyword
    // span. mergeSignals should drop the claude signal because it overlaps
    // a keyword signal at the same location.
    const evidence = `${KEYWORD}${suffix}`;
    expect(body.indexOf(evidence)).toBe(keywordStart); // sanity: same start

    const { client } = makeMockClient(
      JSON.stringify({
        intentSummary: "...",
        intentConfidence: 0.7,
        discoveredSignals: [
          { kind: "contact-request", evidence, location: "answer-body" },
        ],
      }),
    );

    const result = await analyzeAnswer(answer, [], {
      clientImpl: client,
      now: FIXED_NOW,
    });

    // Exactly one signal at the keyword's span; it must be the keyword one.
    const atSpan = result.signals.filter(
      (s) => s.spanStart === keywordStart && s.location.kind === "answer-body",
    );
    expect(atSpan).toHaveLength(1);
    expect(atSpan[0]!.source).toBe("keyword");
    expect(atSpan[0]!.keyword).toBe(KEYWORD);

    // And no claude-source signals overall (the only candidate was dropped).
    const claudeHits = result.signals.filter((s) => s.source === "claude");
    expect(claudeHits).toHaveLength(0);
  });
});
