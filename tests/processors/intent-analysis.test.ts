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
import { SIGNAL_KINDS_IN_ORDER } from "../../src/config/signals.js";

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
      '{"intentSummary":"读者在找靠谱的中介","intentConfidence":0.8}',
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
      '{"intentSummary":"x","intentConfidence":0.5}',
    );

    await analyzeAnswer(answer, [], { clientImpl: client, now: FIXED_NOW });

    expect(requests.length).toBe(1);
    expect(requests[0]!.system[0]!.text).toBe(buildStablePrefix());
  });

  it("tolerates JSON surrounded by prose", async () => {
    const answer = makeAnswer();
    const { client } = makeMockClient(
      'Sure! {"intentSummary":"读者想私信联系","intentConfidence":0.55} done.',
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
      '{"intentSummary":"x","intentConfidence":1.5}',
    );

    await expect(
      analyzeAnswer(answer, [], { clientImpl: client, now: FIXED_NOW }),
    ).rejects.toThrow(/\[0, 1\]|outside/);
  });

  it("uses opts.now for analyzedAt (no hidden clock read)", async () => {
    const answer = makeAnswer();
    const { client } = makeMockClient(
      '{"intentSummary":"x","intentConfidence":0.1}',
    );
    const explicitNow = new Date("2026-04-24T12:00:00.000Z");

    const result = await analyzeAnswer(answer, [], {
      clientImpl: client,
      now: explicitNow,
    });

    expect(result.analyzedAt).toBe("2026-04-24T12:00:00.000Z");
  });
});
