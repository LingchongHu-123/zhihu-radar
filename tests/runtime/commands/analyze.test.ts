// Contract tests for runAnalyze. We don't re-test analyzeAnswer here (it
// has its own suite) — we test that runAnalyze reads every bundle under
// raw/, gates each answer through validators/answer-quality, invokes the
// injected Claude client exactly once per passing answer, writes one
// processed file per answer, and correctly classifies the four outcomes
// (analyzed / skipped-existing / rejected-by-quality / failed).

import { describe, expect, it } from "vitest";

import { runAnalyze } from "../../../src/runtime/commands/analyze.js";
import type { Answer, Comment } from "../../../src/types/answer.js";
import type { AnalyzedAnswer } from "../../../src/types/analysis.js";
import type { FsLike } from "../../../src/runtime/io/data-dir.js";
import type { ClaudeClient } from "../../../src/processors/intent-analysis.js";

// ---------- fixtures ----------

const FIXED_NOW = new Date("2026-04-24T12:00:00.000Z");

function answer(overrides: Partial<Answer> = {}): Answer {
  return {
    id: "a1",
    questionId: "q1",
    questionTitle: "Q1",
    body:
      "This is a body that is clearly longer than fifty characters so the " +
      "validator does not complain about length at all.",
    authorName: "anon",
    upvotes: 42,
    commentCount: 0,
    createdAt: "2026-04-20T00:00:00.000Z",
    url: "https://www.zhihu.com/question/q1/answer/a1",
    scrapedAt: FIXED_NOW.toISOString(),
    ...overrides,
  };
}

function comment(id: string, answerId: string): Comment {
  return {
    id,
    answerId,
    body: "comment body",
    authorName: "c",
    upvotes: 0,
    createdAt: "2026-04-21T00:00:00.000Z",
    scrapedAt: FIXED_NOW.toISOString(),
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

function mockClaude(body: unknown): ClaudeClient {
  return async () => ({
    content: [{ type: "text", text: JSON.stringify(body) }],
  });
}

function goodClaudeResponse() {
  return {
    intentSummary: "想联系作者咨询留学中介",
    intentConfidence: 0.8,
    discoveredSignals: [],
  };
}

function bundleJson(
  questionId: string,
  answers: ReadonlyArray<Answer>,
  commentsByAnswerId: Record<string, ReadonlyArray<Comment>>,
): string {
  return JSON.stringify({
    questionId,
    questionTitle: `Title for ${questionId}`,
    scrapedAt: FIXED_NOW.toISOString(),
    answers,
    commentsByAnswerId,
  });
}

// ---------- tests ----------

describe("runAnalyze", () => {
  it("analyzes each quality-passing answer and writes one processed file per answer", async () => {
    const a1 = answer({ id: "a1", questionId: "q1" });
    const a2 = answer({ id: "a2", questionId: "q1" });
    const { fs, files } = memFs({
      "data/raw/q1.json": bundleJson("q1", [a1, a2], {
        a1: [comment("c1", "a1")],
        a2: [],
      }),
    });
    let calls = 0;

    const result = await runAnalyze({
      dataDir: "data",
      now: FIXED_NOW,
      claudeClient: async (req) => {
        calls += 1;
        return (mockClaude(goodClaudeResponse()))(req);
      },
      fs,
      logger: captureLog(),
    });

    expect(result.analyzed).toBe(2);
    expect(result.rejectedByQuality).toBe(0);
    expect(result.failed).toBe(0);
    expect(calls).toBe(2);

    const parsed1 = JSON.parse(files.get("data/processed/q1-a1.json")!) as AnalyzedAnswer;
    expect(parsed1.answer.id).toBe("a1");
    expect(parsed1.intentSummary).toBe("想联系作者咨询留学中介");
    expect(parsed1.intentConfidence).toBeCloseTo(0.8);
    expect(parsed1.analyzedAt).toBe(FIXED_NOW.toISOString());

    expect(files.has("data/processed/q1-a2.json")).toBe(true);
  });

  it("rejects answers that fail the quality gate without calling Claude", async () => {
    const tooOld = answer({
      id: "old",
      questionId: "q1",
      createdAt: "2020-01-01T00:00:00.000Z",
    });
    const tooShort = answer({ id: "short", questionId: "q1", body: "hi" });
    const lowVotes = answer({ id: "lv", questionId: "q1", upvotes: 0 });
    const { fs, files } = memFs({
      "data/raw/q1.json": bundleJson("q1", [tooOld, tooShort, lowVotes], {}),
    });
    let calls = 0;

    const result = await runAnalyze({
      dataDir: "data",
      now: FIXED_NOW,
      claudeClient: async (req) => {
        calls += 1;
        return (mockClaude(goodClaudeResponse()))(req);
      },
      fs,
      logger: captureLog(),
    });

    expect(result.analyzed).toBe(0);
    expect(result.rejectedByQuality).toBe(3);
    expect(calls).toBe(0);
    expect(files.has("data/processed/q1-old.json")).toBe(false);
  });

  it("skips answers whose processed file already exists when skipExisting is on", async () => {
    const a1 = answer({ id: "done", questionId: "q1" });
    const a2 = answer({ id: "new", questionId: "q1" });
    const { fs, files } = memFs({
      "data/raw/q1.json": bundleJson("q1", [a1, a2], {}),
      "data/processed/q1-done.json": '{"already": true}',
    });
    let calls = 0;

    const result = await runAnalyze({
      dataDir: "data",
      now: FIXED_NOW,
      claudeClient: async (req) => {
        calls += 1;
        return (mockClaude(goodClaudeResponse()))(req);
      },
      fs,
      logger: captureLog(),
    });

    expect(result.analyzed).toBe(1);
    expect(result.skippedExisting).toBe(1);
    expect(calls).toBe(1);
    // Original file untouched.
    expect(files.get("data/processed/q1-done.json")).toBe('{"already": true}');
  });

  it("counts Claude errors as failed without halting the batch", async () => {
    const a1 = answer({ id: "first", questionId: "q1" });
    const a2 = answer({ id: "second", questionId: "q1" });
    const { fs, files } = memFs({
      "data/raw/q1.json": bundleJson("q1", [a1, a2], {}),
    });
    let n = 0;

    const result = await runAnalyze({
      dataDir: "data",
      now: FIXED_NOW,
      claudeClient: async (req) => {
        n += 1;
        if (n === 1) throw new Error("rate limited");
        return (mockClaude(goodClaudeResponse()))(req);
      },
      fs,
      logger: captureLog(),
    });

    expect(result.analyzed).toBe(1);
    expect(result.failed).toBe(1);
    expect(files.has("data/processed/q1-first.json")).toBe(false);
    expect(files.has("data/processed/q1-second.json")).toBe(true);
  });

  it("returns empty result when raw/ does not exist", async () => {
    const { fs } = memFs();
    const log = captureLog();
    const result = await runAnalyze({
      dataDir: "data",
      now: FIXED_NOW,
      claudeClient: mockClaude(goodClaudeResponse()),
      fs,
      logger: log,
    });
    expect(result).toEqual({
      analyzed: 0,
      skippedExisting: 0,
      rejectedByQuality: 0,
      failed: 0,
    });
  });
});
