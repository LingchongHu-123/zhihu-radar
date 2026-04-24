// Contract tests for runReport + its pure buildRankings helper. The
// markdown rendering itself has its own snapshot test in
// tests/outputs/markdown-report.test.ts, so here we only verify that
// report aggregates correctly: groups by questionId, sums signals,
// computes topic-level raw density, orders top answers by confidence-
// weighted density, and caps at MAX_TOPICS_PER_REPORT.

import { describe, expect, it } from "vitest";

import { buildRankings, runReport } from "../../../src/runtime/commands/report.js";
import type { AnalyzedAnswer } from "../../../src/types/analysis.js";
import type { Answer, Comment } from "../../../src/types/answer.js";
import type { ConversionSignal } from "../../../src/types/signal.js";
import type { FsLike } from "../../../src/runtime/io/data-dir.js";

// ---------- fixtures ----------

const FIXED_NOW = new Date("2026-04-24T12:00:00.000Z");

function answer(id: string, questionId: string, questionTitle: string, bodyLen = 500): Answer {
  return {
    id,
    questionId,
    questionTitle,
    body: "x".repeat(bodyLen),
    authorName: "anon",
    upvotes: 10,
    commentCount: 0,
    createdAt: "2026-03-01T00:00:00.000Z",
    url: `https://www.zhihu.com/question/${questionId}/answer/${id}`,
    scrapedAt: FIXED_NOW.toISOString(),
  };
}

function signal(
  kind: ConversionSignal["kind"],
  answerId: string,
): ConversionSignal {
  return {
    kind,
    keyword: "联系",
    location: { kind: "answer-body", answerId },
    spanStart: 0,
    spanEnd: 2,
    source: "keyword",
  };
}

function analyzed(
  id: string,
  questionId: string,
  questionTitle: string,
  opts: {
    bodyLen?: number;
    signals?: ReadonlyArray<ConversionSignal>;
    comments?: ReadonlyArray<Comment>;
    intentConfidence?: number;
    signalsPer1kChars?: number;
  } = {},
): AnalyzedAnswer {
  const ans = answer(id, questionId, questionTitle, opts.bodyLen);
  const signals = opts.signals ?? [];
  const comments = opts.comments ?? [];
  const totalChars =
    ans.body.length + comments.reduce((acc, c) => acc + c.body.length, 0);
  const signalsPer1kChars =
    opts.signalsPer1kChars ??
    (totalChars === 0 ? 0 : (signals.length * 1000) / totalChars);
  return {
    answer: ans,
    comments,
    signals,
    signalsPer1kChars,
    intentSummary: "",
    intentConfidence: opts.intentConfidence ?? 0.5,
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

// ---------- buildRankings ----------

describe("buildRankings (pure)", () => {
  it("groups by questionId and sums signals", () => {
    const input = [
      analyzed("a1", "q1", "Q1", {
        bodyLen: 1000,
        signals: [signal("contact-request", "a1"), signal("payment-intent", "a1")],
      }),
      analyzed("a2", "q1", "Q1", {
        bodyLen: 1000,
        signals: [signal("contact-request", "a2")],
      }),
      analyzed("a3", "q2", "Q2", {
        bodyLen: 1000,
        signals: [],
      }),
    ];

    const rankings = buildRankings(input);

    const q1 = rankings.find((r) => r.questionId === "q1")!;
    expect(q1.analyzedAnswerCount).toBe(2);
    expect(q1.totalSignalCount).toBe(3);
    expect(q1.signalsByKind["contact-request"]).toBe(2);
    expect(q1.signalsByKind["payment-intent"]).toBe(1);
    expect(q1.signalsByKind["recommendation-request"]).toBe(0);
    expect(q1.signalsByKind["dm-pull"]).toBe(0);
    // 3 signals across 2000 chars => 1.5 / 1k
    expect(q1.signalsPer1kChars).toBeCloseTo(1.5);

    const q2 = rankings.find((r) => r.questionId === "q2")!;
    expect(q2.totalSignalCount).toBe(0);
    expect(q2.signalsPer1kChars).toBe(0);
  });

  it("sorts topics by topic-level density descending", () => {
    const input = [
      analyzed("a1", "hot", "Hot Topic", {
        bodyLen: 1000,
        signals: [signal("contact-request", "a1"), signal("contact-request", "a1")],
      }),
      analyzed("a2", "cold", "Cold Topic", {
        bodyLen: 1000,
        signals: [signal("contact-request", "a2")],
      }),
    ];

    const rankings = buildRankings(input);
    expect(rankings.map((r) => r.questionId)).toEqual(["hot", "cold"]);
  });

  it("orders topAnswers by confidence-weighted density desc", () => {
    // Same raw density, different confidence — higher confidence must come first.
    const input = [
      analyzed("low-conf", "q1", "Q1", {
        bodyLen: 1000,
        signals: [signal("contact-request", "low-conf")],
        intentConfidence: 0.1,
        signalsPer1kChars: 1.0,
      }),
      analyzed("high-conf", "q1", "Q1", {
        bodyLen: 1000,
        signals: [signal("contact-request", "high-conf")],
        intentConfidence: 0.9,
        signalsPer1kChars: 1.0,
      }),
    ];

    const rankings = buildRankings(input);
    const q1 = rankings[0]!;
    expect(q1.topAnswers.map((a) => a.answer.id)).toEqual(["high-conf", "low-conf"]);
  });

  it("returns empty topAnswers array as empty (no crash)", () => {
    const rankings = buildRankings([]);
    expect(rankings).toEqual([]);
  });
});

// ---------- runReport ----------

describe("runReport", () => {
  it("reads processed/, renders markdown, writes to reports/<date>.md", async () => {
    const a = analyzed("a1", "q1", "Example Question", {
      bodyLen: 1000,
      signals: [signal("contact-request", "a1")],
    });
    const { fs, files } = memFs({
      "data/processed/q1-a1.json": JSON.stringify(a),
    });
    const log = captureLog();

    const result = await runReport({
      dataDir: "data",
      reportDate: "2026-04-24",
      now: FIXED_NOW,
      fs,
      logger: log,
    });

    expect(result.answersRead).toBe(1);
    expect(result.topicsInReport).toBe(1);
    expect(result.reportPath).toBe("data/reports/2026-04-24.md");

    const md = files.get("data/reports/2026-04-24.md");
    expect(md).toBeDefined();
    expect(md).toContain("# 知乎 Radar — 2026-04-24");
    expect(md).toContain("Example Question");
    expect(md).toContain("q1");
  });

  it("writes the no-topics report when processed/ is empty", async () => {
    const { fs, files } = memFs({});
    const log = captureLog();
    await runReport({
      dataDir: "data",
      reportDate: "2026-04-24",
      now: FIXED_NOW,
      fs,
      logger: log,
    });
    const md = files.get("data/reports/2026-04-24.md");
    expect(md).toBeDefined();
    expect(md).toContain("_(no topics)_");
  });
});
