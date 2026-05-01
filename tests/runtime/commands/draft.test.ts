// Contract tests for runDraft. We don't re-test writeDraft (it has its
// own suite) — we test that runDraft reads every AnalyzedAnswer under
// processed/, re-aggregates rankings, picks the top N, calls Claude
// once per topic, writes a Markdown draft per topic, and correctly
// classifies the three outcomes (drafted / skipped-existing / failed).

import { describe, expect, it } from "vitest";

import { runDraft } from "../../../src/runtime/commands/draft.js";
import type { AnalyzedAnswer } from "../../../src/types/analysis.js";
import type { Answer } from "../../../src/types/answer.js";
import type { ConversionSignal } from "../../../src/types/signal.js";
import type { ClaudeClient } from "../../../src/processors/intent-analysis.js";
import type { FsLike } from "../../../src/runtime/io/data-dir.js";

const FIXED_NOW = new Date("2026-04-25T09:00:00.000Z");

function answer(
  id: string,
  questionId: string,
  questionTitle: string,
  bodyLen = 500,
): Answer {
  return {
    id,
    questionId,
    questionTitle,
    body: "x".repeat(bodyLen),
    authorName: "anon",
    upvotes: 50,
    commentCount: 0,
    createdAt: "2026-04-01T00:00:00.000Z",
    url: `https://www.zhihu.com/question/${questionId}/answer/${id}`,
    scrapedAt: FIXED_NOW.toISOString(),
  };
}

function signal(answerId: string): ConversionSignal {
  return {
    kind: "contact-request",
    keyword: "私信我",
    location: { kind: "answer-body", answerId },
    spanStart: 0,
    spanEnd: 3,
    source: "keyword",
  };
}

function analyzed(
  id: string,
  questionId: string,
  questionTitle: string,
  signalCount: number,
  bodyLen = 500,
): AnalyzedAnswer {
  const ans = answer(id, questionId, questionTitle, bodyLen);
  const signals = Array.from({ length: signalCount }, () => signal(id));
  const signalsPer1kChars =
    bodyLen === 0 ? 0 : (signalCount * 1000) / bodyLen;
  return {
    answer: ans,
    comments: [],
    signals,
    signalsPer1kChars,
    intentSummary: "想私信咨询",
    intentConfidence: 0.7,
    analyzedAt: FIXED_NOW.toISOString(),
  };
}

function memFs(seed: Record<string, string> = {}): {
  fs: FsLike;
  files: Map<string, string>;
} {
  const files = new Map<string, string>(Object.entries(seed));
  const fs: FsLike = {
    async readFile(path) {
      const v = files.get(path);
      if (v === undefined) throw new Error(`ENOENT ${path}`);
      return v;
    },
    async writeFile(path, data) {
      files.set(path, data);
    },
    async readdir(path) {
      const prefix = path.endsWith("/") ? path : path + "/";
      const names: string[] = [];
      for (const key of files.keys()) {
        if (key.startsWith(prefix) && !key.slice(prefix.length).includes("/")) {
          names.push(key.slice(prefix.length));
        }
      }
      return names;
    },
    async mkdir() {},
  };
  return { fs, files };
}

function captureLog() {
  const log: { kind: "info" | "warn"; line: string }[] = [];
  return {
    log,
    info: (line: string) => log.push({ kind: "info", line }),
    warn: (line: string) => log.push({ kind: "warn", line }),
  };
}

const VALID_DRAFT_JSON = JSON.stringify({
  title: "选中介这件事",
  body: "段落一。\n\n段落二。\n\n段落三。",
  ctaLine: "想聊可以私信。",
});

function mockClaude(json = VALID_DRAFT_JSON): ClaudeClient {
  return async () => ({ content: [{ type: "text", text: json }] });
}

// ---------- tests ----------

describe("runDraft", () => {
  it("drafts top-density topics and writes one Markdown file per topic", async () => {
    // Two topics, "hot" has higher density than "cold".
    const { fs, files } = memFs({
      "data/processed/hot-a1.json": JSON.stringify(
        analyzed("a1", "hot", "Hot Topic", 5, 500),
      ),
      "data/processed/cold-a1.json": JSON.stringify(
        analyzed("a1", "cold", "Cold Topic", 1, 500),
      ),
    });
    let calls = 0;
    const claudeClient: ClaudeClient = async (req) => {
      calls += 1;
      return (mockClaude())(req);
    };

    const result = await runDraft({
      dataDir: "data",
      draftDate: "2026-04-25",
      now: FIXED_NOW,
      claudeClient,
      fs,
      logger: captureLog(),
    });

    expect(result.drafted).toBe(2);
    expect(result.failed).toBe(0);
    expect(calls).toBe(2);

    const hotDraft = files.get("data/drafts/draft-hot-2026-04-25.md");
    expect(hotDraft).toBeDefined();
    expect(hotDraft).toContain("# 选中介这件事");
    expect(hotDraft).toContain("Hot Topic");

    expect(files.has("data/drafts/draft-cold-2026-04-25.md")).toBe(true);
  });

  it("respects maxDrafts: drafts only the top-N topics", async () => {
    const { fs, files } = memFs({
      "data/processed/q1-a.json": JSON.stringify(
        analyzed("a", "q1", "Q1", 9, 500),
      ),
      "data/processed/q2-a.json": JSON.stringify(
        analyzed("a", "q2", "Q2", 5, 500),
      ),
      "data/processed/q3-a.json": JSON.stringify(
        analyzed("a", "q3", "Q3", 1, 500),
      ),
    });
    const result = await runDraft({
      dataDir: "data",
      draftDate: "2026-04-25",
      now: FIXED_NOW,
      claudeClient: mockClaude(),
      maxDrafts: 2,
      fs,
      logger: captureLog(),
    });

    expect(result.drafted).toBe(2);
    expect(result.topicsConsidered).toBe(2);
    // Top two by density are q1 and q2; q3 must NOT be drafted.
    expect(files.has("data/drafts/draft-q1-2026-04-25.md")).toBe(true);
    expect(files.has("data/drafts/draft-q2-2026-04-25.md")).toBe(true);
    expect(files.has("data/drafts/draft-q3-2026-04-25.md")).toBe(false);
  });

  it("skips topics whose draft file for this date already exists", async () => {
    const { fs, files } = memFs({
      "data/processed/q1-a.json": JSON.stringify(
        analyzed("a", "q1", "Q1", 5, 500),
      ),
      "data/drafts/draft-q1-2026-04-25.md": "# pre-existing\n",
    });
    let calls = 0;
    const result = await runDraft({
      dataDir: "data",
      draftDate: "2026-04-25",
      now: FIXED_NOW,
      claudeClient: async (req) => {
        calls += 1;
        return (mockClaude())(req);
      },
      fs,
      logger: captureLog(),
    });

    expect(result.drafted).toBe(0);
    expect(result.skippedExisting).toBe(1);
    expect(calls).toBe(0);
    // Pre-existing file untouched.
    expect(files.get("data/drafts/draft-q1-2026-04-25.md")).toBe("# pre-existing\n");
  });

  it("counts Claude errors as failed without halting the batch", async () => {
    const { fs, files } = memFs({
      "data/processed/q1-a.json": JSON.stringify(
        analyzed("a", "q1", "Q1", 5, 500),
      ),
      "data/processed/q2-a.json": JSON.stringify(
        analyzed("a", "q2", "Q2", 3, 500),
      ),
    });
    let n = 0;
    const claudeClient: ClaudeClient = async (req) => {
      n += 1;
      if (n === 1) throw new Error("rate limited");
      return (mockClaude())(req);
    };

    const result = await runDraft({
      dataDir: "data",
      draftDate: "2026-04-25",
      now: FIXED_NOW,
      claudeClient,
      fs,
      logger: captureLog(),
    });

    expect(result.drafted).toBe(1);
    expect(result.failed).toBe(1);
    // The failed topic gets no draft file written.
    expect(files.has("data/drafts/draft-q1-2026-04-25.md")).toBe(false);
    expect(files.has("data/drafts/draft-q2-2026-04-25.md")).toBe(true);
  });

  it("returns zeroed result when processed/ does not exist", async () => {
    const { fs } = memFs();
    const result = await runDraft({
      dataDir: "data",
      draftDate: "2026-04-25",
      now: FIXED_NOW,
      claudeClient: mockClaude(),
      fs,
      logger: captureLog(),
    });
    expect(result).toEqual({
      drafted: 0,
      skippedExisting: 0,
      failed: 0,
      topicsConsidered: 0,
    });
  });
});
