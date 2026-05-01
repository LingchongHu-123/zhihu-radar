// Tests for the Claude-backed draft writer. No network: every Claude
// call goes through a mock ClaudeClient. The load-bearing test here is
// "ADR 002 cache-friendly prefix": two drafts for different topics must
// produce byte-identical system-block text. If that fails, something
// leaked a per-call value into the cached prefix and the ~10% cache-hit
// billing goes out the window.
//
// We also pin parse-error behavior since title/body/ctaLine are the
// entire draft — silent malformed responses must throw, not produce
// partial drafts.

import { describe, expect, it } from "vitest";

import {
  buildDraftRequest,
  buildDraftStablePrefix,
  buildDraftVolatilePayload,
  writeDraft,
  type DraftOptions,
} from "../../src/processors/draft-writer.js";
import type {
  ClaudeClient,
  ClaudeRequest,
  ClaudeResponse,
} from "../../src/processors/intent-analysis.js";
import { SIGNAL_KINDS_IN_ORDER } from "../../src/config/signals.js";
import type { AnalyzedAnswer } from "../../src/types/analysis.js";
import type { Answer } from "../../src/types/answer.js";
import type { TopicRanking } from "../../src/types/report.js";

// ---------- helpers ----------

const FIXED_NOW = new Date("2026-04-25T09:00:00.000Z");

function makeAnswer(overrides: Partial<Answer> = {}): Answer {
  return {
    id: "ans-1",
    questionId: "q-100",
    questionTitle: "去英国留学，怎么挑选靠谱的中介？",
    body: "我去年走完了一轮申请，对挑中介这事有些感受。",
    authorName: "tester",
    upvotes: 100,
    commentCount: 5,
    createdAt: "2026-01-01T00:00:00.000Z",
    url: "https://www.zhihu.com/question/100/answer/1",
    scrapedAt: "2026-04-23T00:00:00.000Z",
    ...overrides,
  };
}

function makeAnalyzed(overrides: Partial<AnalyzedAnswer> = {}): AnalyzedAnswer {
  return {
    answer: makeAnswer(),
    comments: [],
    signals: [],
    signalsPer1kChars: 5,
    intentSummary: "读者在找靠谱的独立顾问",
    intentConfidence: 0.7,
    analyzedAt: FIXED_NOW.toISOString(),
    ...overrides,
  };
}

function makeRanking(overrides: Partial<TopicRanking> = {}): TopicRanking {
  return {
    questionId: "q-100",
    questionTitle: "去英国留学，怎么挑选靠谱的中介？",
    analyzedAnswerCount: 12,
    totalSignalCount: 24,
    signalsByKind: {
      "contact-request": 14,
      "recommendation-request": 8,
      "payment-intent": 1,
      "dm-pull": 1,
    },
    signalsPer1kChars: 7.4,
    topAnswers: [makeAnalyzed()],
    ...overrides,
  };
}

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

const VALID_DRAFT_JSON = JSON.stringify({
  title: "选中介前先想清楚这几件事",
  body: "第一段。\n\n第二段。\n\n第三段。",
  ctaLine: "想聊具体院校组合的话，可以私信我。",
});

// ---------- buildDraftStablePrefix ----------

describe("buildDraftStablePrefix", () => {
  it("is byte-stable across calls", () => {
    expect(buildDraftStablePrefix()).toBe(buildDraftStablePrefix());
  });

  it("contains every SignalKind in SIGNAL_KINDS_IN_ORDER", () => {
    const prefix = buildDraftStablePrefix();
    for (const kind of SIGNAL_KINDS_IN_ORDER) {
      expect(prefix).toContain(kind);
    }
  });

  it("includes the no-quantitative-promises rule", () => {
    const prefix = buildDraftStablePrefix();
    // We don't pin exact phrasing — only that the rule is present in
    // some form, since that's what the reviewer actually relies on.
    expect(prefix).toMatch(/保 offer|100%|guarantee|necessarily|必上/);
  });
});

// ---------- buildDraftRequest ----------

describe("buildDraftRequest", () => {
  it("marks the system block as cacheable (ephemeral)", () => {
    const req = buildDraftRequest(makeRanking());
    expect(req.system.length).toBe(1);
    expect(req.system[0]!.type).toBe("text");
    expect(req.system[0]!.cache_control).toEqual({ type: "ephemeral" });
  });

  // ADR 002 invariant: stable prefix bytes-identical across topics.
  it("produces byte-identical stable prefix for different topics", () => {
    const reqA = buildDraftRequest(
      makeRanking({ questionId: "q-A", questionTitle: "美研 CS 选校" }),
    );
    const reqB = buildDraftRequest(
      makeRanking({
        questionId: "q-B",
        questionTitle: "雅思口语 7 分备考",
        signalsByKind: {
          "contact-request": 1,
          "recommendation-request": 9,
          "payment-intent": 0,
          "dm-pull": 0,
        },
      }),
    );
    expect(reqA.system[0]!.text).toBe(reqB.system[0]!.text);
  });

  it("produces a volatile user message that differs between topics", () => {
    const reqA = buildDraftRequest(makeRanking({ questionId: "q-A", questionTitle: "美研 CS 选校" }));
    const reqB = buildDraftRequest(
      makeRanking({ questionId: "q-B", questionTitle: "雅思口语 7 分备考" }),
    );
    expect(reqA.messages[0]!.content[0]!.text).not.toBe(
      reqB.messages[0]!.content[0]!.text,
    );
  });

  it("includes the question title and signal-by-kind counts in the volatile payload", () => {
    const ranking = makeRanking({
      questionTitle: "美研 CS 选校",
      signalsByKind: {
        "contact-request": 11,
        "recommendation-request": 22,
        "payment-intent": 33,
        "dm-pull": 44,
      },
    });
    const text = buildDraftVolatilePayload(ranking);
    expect(text).toContain("美研 CS 选校");
    expect(text).toContain("contact-request: 11");
    expect(text).toContain("recommendation-request: 22");
    expect(text).toContain("payment-intent: 33");
    expect(text).toContain("dm-pull: 44");
  });
});

// ---------- writeDraft ----------

describe("writeDraft", () => {
  it("round-trips a fixture topic into a full GeneratedDraft", async () => {
    const ranking = makeRanking();
    const { client, requests } = makeMockClient(VALID_DRAFT_JSON);

    const draft = await writeDraft(ranking, {
      clientImpl: client,
      now: FIXED_NOW,
    } satisfies DraftOptions);

    expect(draft.questionId).toBe(ranking.questionId);
    expect(draft.questionTitle).toBe(ranking.questionTitle);
    expect(draft.title).toBe("选中介前先想清楚这几件事");
    expect(draft.body).toContain("第一段");
    expect(draft.ctaLine).toContain("私信");
    expect(draft.modelId).toMatch(/^claude/);
    expect(draft.generatedAt).toBe(FIXED_NOW.toISOString());

    expect(requests.length).toBe(1);
    expect(requests[0]!.system[0]!.text).toBe(buildDraftStablePrefix());
  });

  it("tolerates JSON surrounded by prose", async () => {
    const { client } = makeMockClient(`Sure, here's the draft: ${VALID_DRAFT_JSON} done.`);
    const draft = await writeDraft(makeRanking(), {
      clientImpl: client,
      now: FIXED_NOW,
    });
    expect(draft.title).toBe("选中介前先想清楚这几件事");
  });

  it("rejects when the response contains no JSON object", async () => {
    const client: ClaudeClient = async () => ({
      content: [{ type: "text", text: "I cannot help with that." }],
    });
    await expect(
      writeDraft(makeRanking(), { clientImpl: client, now: FIXED_NOW }),
    ).rejects.toThrow(/no JSON/i);
  });

  it("rejects when title is missing or empty", async () => {
    const { client } = makeMockClient(
      JSON.stringify({ title: "", body: "x", ctaLine: "y" }),
    );
    await expect(
      writeDraft(makeRanking(), { clientImpl: client, now: FIXED_NOW }),
    ).rejects.toThrow(/title/);
  });

  it("rejects when body is missing or empty", async () => {
    const { client } = makeMockClient(
      JSON.stringify({ title: "x", body: "", ctaLine: "y" }),
    );
    await expect(
      writeDraft(makeRanking(), { clientImpl: client, now: FIXED_NOW }),
    ).rejects.toThrow(/body/);
  });

  it("rejects when ctaLine is missing or empty", async () => {
    const { client } = makeMockClient(
      JSON.stringify({ title: "x", body: "y", ctaLine: "" }),
    );
    await expect(
      writeDraft(makeRanking(), { clientImpl: client, now: FIXED_NOW }),
    ).rejects.toThrow(/ctaLine/);
  });

  it("uses opts.now for generatedAt (no hidden clock read)", async () => {
    const { client } = makeMockClient(VALID_DRAFT_JSON);
    const explicitNow = new Date("2027-01-02T03:04:05.000Z");
    const draft = await writeDraft(makeRanking(), {
      clientImpl: client,
      now: explicitNow,
    });
    expect(draft.generatedAt).toBe("2027-01-02T03:04:05.000Z");
  });
});
