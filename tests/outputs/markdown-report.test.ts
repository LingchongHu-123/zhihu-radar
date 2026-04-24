// Tests for the markdown-report renderer. Pure function under test, so
// every case is constructed inline (or pulled from a small fixture
// helper). No network, no clock reads, no fs writes outside tests/.
//
// Snapshot strategy: we deliberately do NOT use vitest's
// `toMatchSnapshot()`. Instead we commit a real `.expected.md` file
// alongside the test so the author can `cat` it in a terminal. The
// "snapshot" check is a plain string equality against the file's bytes.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

import { renderTopicReport } from "../../src/outputs/markdown-report.js";
import { SIGNAL_KINDS_IN_ORDER } from "../../src/config/signals.js";
import type { AnalyzedAnswer } from "../../src/types/analysis.js";
import type { Answer } from "../../src/types/answer.js";
import type { TopicRanking, TopicReport } from "../../src/types/report.js";
import { sampleReport, LEAK_SENTINEL_ISO } from "../fixtures/reports/sample-report.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXPECTED_MD_PATH = resolve(
  HERE,
  "..",
  "fixtures",
  "reports",
  "sample-report.expected.md",
);

// ---------- tiny inline builders for non-snapshot cases ----------

function makeAnswer(overrides: Partial<Answer> = {}): Answer {
  return {
    id: "ans-x",
    questionId: "q-x",
    questionTitle: "test question",
    body: "some body text",
    authorName: "tester",
    upvotes: 1,
    commentCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    url: "https://www.zhihu.com/question/x/answer/x",
    scrapedAt: "2026-01-02T00:00:00.000Z",
    ...overrides,
  };
}

function makeAnalyzed(overrides: Partial<AnalyzedAnswer> = {}): AnalyzedAnswer {
  return {
    answer: makeAnswer(),
    comments: [],
    signals: [],
    signalsPer1kChars: 0,
    intentSummary: "",
    intentConfidence: 0,
    analyzedAt: "2099-12-31T11:11:11.111Z",
    ...overrides,
  };
}

function makeRanking(overrides: Partial<TopicRanking> = {}): TopicRanking {
  return {
    questionId: "q-x",
    questionTitle: "test topic",
    analyzedAnswerCount: 0,
    totalSignalCount: 0,
    signalsByKind: {
      "contact-request": 0,
      "recommendation-request": 0,
      "payment-intent": 0,
      "dm-pull": 0,
    },
    signalsPer1kChars: 0,
    topAnswers: [],
    ...overrides,
  };
}

function makeReport(overrides: Partial<TopicReport> = {}): TopicReport {
  return {
    date: "2026-04-22",
    generatedAt: "2099-12-31T11:11:11.111Z",
    rankings: [],
    ...overrides,
  };
}

// ---------- tests ----------

describe("renderTopicReport — snapshot against committed .md file", () => {
  it("matches the bytes in sample-report.expected.md", () => {
    const rendered = renderTopicReport(sampleReport);

    if (!existsSync(EXPECTED_MD_PATH)) {
      // First-run convenience: write the expected file from the
      // renderer's actual output, then fail loudly so the author knows
      // to inspect and commit it. The next run will then pass.
      mkdirSync(dirname(EXPECTED_MD_PATH), { recursive: true });
      writeFileSync(EXPECTED_MD_PATH, rendered, "utf8");
      throw new Error(
        `sample-report.expected.md did not exist; wrote it from current ` +
          `renderer output to ${EXPECTED_MD_PATH}. Inspect it, commit it, ` +
          `and re-run.`,
      );
    }

    const expected = readFileSync(EXPECTED_MD_PATH, "utf8");
    // Plain `===`, not toMatchSnapshot. The committed file IS the snapshot.
    expect(rendered === expected).toBe(true);
  });
});

describe("renderTopicReport — determinism", () => {
  it("produces byte-identical output on repeated calls", () => {
    const a = renderTopicReport(sampleReport);
    const b = renderTopicReport(sampleReport);
    expect(a === b).toBe(true);
  });
});

describe("renderTopicReport — empty rankings", () => {
  it("renders the no-topics placeholder and ends with exactly one newline", () => {
    const out = renderTopicReport(makeReport({ rankings: [] }));
    expect(out).toContain("_(no topics)_");
    expect(out.endsWith("\n")).toBe(true);
    expect(out.endsWith("\n\n")).toBe(false);
  });
});

describe("renderTopicReport — empty topAnswers on a topic", () => {
  it("renders the no-top-answers placeholder inside the topic block", () => {
    const out = renderTopicReport(
      makeReport({
        rankings: [
          makeRanking({
            questionTitle: "lonely topic",
            topAnswers: [],
          }),
        ],
      }),
    );
    expect(out).toContain("_(no top answers)_");
  });
});

describe("renderTopicReport — empty signals on an answer", () => {
  it("renders `- Signals: _(none)_` for an answer with zero signals", () => {
    const out = renderTopicReport(
      makeReport({
        rankings: [
          makeRanking({
            topAnswers: [
              makeAnalyzed({
                signals: [],
              }),
            ],
          }),
        ],
      }),
    );
    expect(out).toContain("- Signals: _(none)_");
  });
});

describe("renderTopicReport — no timestamp leak", () => {
  it("does not include any per-answer analyzedAt or report.generatedAt", () => {
    const out = renderTopicReport(sampleReport);
    // Sentinel chosen to be impossible-looking. If it appears, a future
    // edit started rendering one of these timestamps.
    expect(out.includes(LEAK_SENTINEL_ISO)).toBe(false);
    // But the date the report covers should appear.
    expect(out).toContain("2026-04-22");
  });
});

describe("renderTopicReport — SignalKind ordering", () => {
  it("emits the four kinds in SIGNAL_KINDS_IN_ORDER", () => {
    const out = renderTopicReport(
      makeReport({
        rankings: [
          makeRanking({
            signalsByKind: {
              "contact-request": 1,
              "recommendation-request": 2,
              "payment-intent": 3,
              "dm-pull": 4,
            },
          }),
        ],
      }),
    );
    const positions = SIGNAL_KINDS_IN_ORDER.map((k) => out.indexOf(`- ${k}: `));
    // All four must be present.
    for (const p of positions) {
      expect(p).toBeGreaterThanOrEqual(0);
    }
    // And strictly ascending in the rendered string.
    for (let i = 1; i < positions.length; i += 1) {
      expect(positions[i]).toBeGreaterThan(positions[i - 1]!);
    }
  });
});

describe("renderTopicReport — preserves rankings input order", () => {
  it("renders #1/#2/#3 in input order, not sorted by density", () => {
    // Densities deliberately NOT in descending order. If the renderer
    // ever started sorting internally, the header order would change.
    const r1 = makeRanking({
      questionId: "q-A",
      questionTitle: "alpha",
      signalsPer1kChars: 1.0,
    });
    const r2 = makeRanking({
      questionId: "q-B",
      questionTitle: "bravo",
      signalsPer1kChars: 9.0,
    });
    const r3 = makeRanking({
      questionId: "q-C",
      questionTitle: "charlie",
      signalsPer1kChars: 5.0,
    });
    const out = renderTopicReport(makeReport({ rankings: [r1, r2, r3] }));

    const idxAlpha = out.indexOf("## #1 — alpha");
    const idxBravo = out.indexOf("## #2 — bravo");
    const idxCharlie = out.indexOf("## #3 — charlie");

    expect(idxAlpha).toBeGreaterThanOrEqual(0);
    expect(idxBravo).toBeGreaterThan(idxAlpha);
    expect(idxCharlie).toBeGreaterThan(idxBravo);
  });
});
