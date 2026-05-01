// CLI dispatcher tests. We don't re-prove the commands here; we prove
// that argv parsing routes to the right command with the right options
// and returns a sensible exit code. The commands themselves are tested
// in tests/runtime/commands/.

import { beforeEach, describe, expect, it } from "vitest";

import { main, type CliDeps } from "../../src/runtime/cli.js";
import type { Answer, Comment } from "../../src/types/answer.js";
import type { FsLike } from "../../src/runtime/io/data-dir.js";

const FIXED_NOW = new Date("2026-04-24T12:00:00.000Z");

function answer(id: string, questionId: string): Answer {
  return {
    id,
    questionId,
    questionTitle: "Q",
    body: "x".repeat(100),
    authorName: "anon",
    upvotes: 42,
    commentCount: 0,
    createdAt: "2026-04-20T00:00:00.000Z",
    url: `https://www.zhihu.com/question/${questionId}/answer/${id}`,
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

function makeDeps(
  overrides: {
    fs?: FsLike;
    scrapeAnswers?: CliDeps["scrapeFetchers"]["fetchAnswers"];
    scrapeComments?: CliDeps["scrapeFetchers"]["fetchComments"];
    envApiKey?: string | undefined;
  } = {},
): {
  deps: CliDeps;
  out: string[];
  err: string[];
  claudeCalls: number;
} {
  const out: string[] = [];
  const err: string[] = [];
  let claudeCalls = 0;
  const deps: CliDeps = {
    fs: overrides.fs ?? memFs().fs,
    now: () => FIXED_NOW,
    stdout: (l) => out.push(l),
    stderr: (l) => err.push(l),
    scrapeFetchers: {
      fetchAnswers:
        overrides.scrapeAnswers ??
        (async (qid) => [answer("a1", qid)]),
      fetchComments:
        overrides.scrapeComments ?? (async (): Promise<Comment[]> => []),
    },
    makeClaudeClient: () => async () => {
      claudeCalls += 1;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              intentSummary: "",
              intentConfidence: 0.0,
              discoveredSignals: [],
            }),
          },
        ],
      };
    },
  };
  return {
    deps,
    out,
    err,
    get claudeCalls() {
      return claudeCalls;
    },
  } as {
    deps: CliDeps;
    out: string[];
    err: string[];
    claudeCalls: number;
  };
}

describe("main (cli dispatcher)", () => {
  beforeEach(() => {
    delete process.env["ANTHROPIC_API_KEY"];
  });

  it("prints usage and exits 2 when called with no command", async () => {
    const { deps, out } = makeDeps();
    const r = await main([], deps);
    expect(r.exitCode).toBe(2);
    expect(out.join("\n")).toContain("Commands:");
  });

  it("prints usage and exits 0 on --help", async () => {
    const { deps, out } = makeDeps();
    const r = await main(["--help"], deps);
    expect(r.exitCode).toBe(0);
    expect(out.join("\n")).toContain("zhihu-radar");
  });

  it("rejects unknown command with non-zero exit", async () => {
    const { deps, err } = makeDeps();
    const r = await main(["fly"], deps);
    expect(r.exitCode).toBe(2);
    expect(err.some((l) => l.includes("unknown command"))).toBe(true);
  });

  describe("scrape", () => {
    it("routes question ids and data-dir flag", async () => {
      const { fs, files } = memFs();
      const seen: string[] = [];
      const { deps } = makeDeps({
        fs,
        scrapeAnswers: async (qid) => {
          seen.push(qid);
          return [answer("a1", qid)];
        },
      });

      const r = await main(
        ["scrape", "111", "--data-dir", "mydata", "222"],
        deps,
      );

      expect(r.exitCode).toBe(0);
      expect(seen).toEqual(["111", "222"]);
      expect(files.has("mydata/raw/111.json")).toBe(true);
      expect(files.has("mydata/raw/222.json")).toBe(true);
    });

    it("fails with exit 2 when no question id is given", async () => {
      const { deps, err } = makeDeps();
      const r = await main(["scrape"], deps);
      expect(r.exitCode).toBe(2);
      expect(err.some((l) => l.includes("need at least one"))).toBe(true);
    });
  });

  describe("analyze", () => {
    it("reads ANTHROPIC_API_KEY from env and routes to runAnalyze", async () => {
      const bundle = {
        questionId: "q1",
        questionTitle: "Q",
        scrapedAt: FIXED_NOW.toISOString(),
        answers: [answer("a1", "q1")],
        commentsByAnswerId: {},
      };
      const { fs, files } = memFs({
        "data/raw/q1.json": JSON.stringify(bundle),
      });
      process.env["ANTHROPIC_API_KEY"] = "test-key";

      const state = makeDeps({ fs });
      const r = await main(["analyze"], state.deps);

      expect(r.exitCode).toBe(0);
      expect(files.has("data/processed/q1-a1.json")).toBe(true);
    });

    it("fails loudly when ANTHROPIC_API_KEY is unset", async () => {
      const { deps, err } = makeDeps();
      const r = await main(["analyze"], deps);
      expect(r.exitCode).toBe(1);
      expect(err.some((l) => l.includes("ANTHROPIC_API_KEY"))).toBe(true);
    });
  });

  describe("report", () => {
    it("uses --date when provided, falls back to today's date in UTC", async () => {
      const { fs, files } = memFs();
      const { deps } = makeDeps({ fs });

      const r = await main(["report", "--date", "2026-01-01"], deps);
      expect(r.exitCode).toBe(0);
      expect(files.has("data/reports/2026-01-01.md")).toBe(true);

      const r2 = await main(["report"], deps);
      expect(r2.exitCode).toBe(0);
      // FIXED_NOW is 2026-04-24T12:00:00Z -> date "2026-04-24"
      expect(files.has("data/reports/2026-04-24.md")).toBe(true);
    });
  });

  describe("draft", () => {
    it("reads ANTHROPIC_API_KEY from env, drafts top topics, writes Markdown drafts", async () => {
      // Seed processed/ with one analyzed answer that has signals so the
      // density is non-zero and the topic is rankable.
      const seedAnalyzed = {
        answer: {
          id: "a1",
          questionId: "q-draft-1",
          questionTitle: "Draft topic title",
          body: "x".repeat(500),
          authorName: "anon",
          upvotes: 50,
          commentCount: 0,
          createdAt: "2026-04-01T00:00:00.000Z",
          url: "https://www.zhihu.com/question/q-draft-1/answer/a1",
          scrapedAt: FIXED_NOW.toISOString(),
        },
        comments: [],
        signals: [
          {
            kind: "contact-request",
            keyword: "私信我",
            location: { kind: "answer-body", answerId: "a1" },
            spanStart: 0,
            spanEnd: 3,
            source: "keyword",
          },
        ],
        signalsPer1kChars: 2,
        intentSummary: "想私信",
        intentConfidence: 0.7,
        analyzedAt: FIXED_NOW.toISOString(),
      };
      const { fs, files } = memFs({
        "data/processed/q-draft-1-a1.json": JSON.stringify(seedAnalyzed),
      });
      process.env["ANTHROPIC_API_KEY"] = "test-key";

      // Override Claude to return a valid draft JSON.
      const draftJson = JSON.stringify({
        title: "测试草稿",
        body: "段落一。\n\n段落二。",
        ctaLine: "想聊可以私信。",
      });
      const out: string[] = [];
      const err: string[] = [];
      const deps: CliDeps = {
        fs,
        now: () => FIXED_NOW,
        stdout: (l) => out.push(l),
        stderr: (l) => err.push(l),
        scrapeFetchers: {
          fetchAnswers: async () => [],
          fetchComments: async () => [],
        },
        makeClaudeClient: () => async () => ({
          content: [{ type: "text", text: draftJson }],
        }),
      };

      const r = await main(["draft"], deps);

      expect(r.exitCode).toBe(0);
      expect(files.has("data/drafts/draft-q-draft-1-2026-04-24.md")).toBe(true);
    });

    it("respects --date for the filename", async () => {
      const seedAnalyzed = {
        answer: {
          id: "a1",
          questionId: "qd",
          questionTitle: "T",
          body: "x".repeat(500),
          authorName: "anon",
          upvotes: 50,
          commentCount: 0,
          createdAt: "2026-04-01T00:00:00.000Z",
          url: "https://www.zhihu.com/question/qd/answer/a1",
          scrapedAt: FIXED_NOW.toISOString(),
        },
        comments: [],
        signals: [
          {
            kind: "contact-request",
            keyword: "私信我",
            location: { kind: "answer-body", answerId: "a1" },
            spanStart: 0,
            spanEnd: 3,
            source: "keyword",
          },
        ],
        signalsPer1kChars: 2,
        intentSummary: "x",
        intentConfidence: 0.5,
        analyzedAt: FIXED_NOW.toISOString(),
      };
      const { fs, files } = memFs({
        "data/processed/qd-a1.json": JSON.stringify(seedAnalyzed),
      });
      process.env["ANTHROPIC_API_KEY"] = "test-key";

      const draftJson = JSON.stringify({
        title: "T",
        body: "B。",
        ctaLine: "C。",
      });
      const out: string[] = [];
      const err: string[] = [];
      const deps: CliDeps = {
        fs,
        now: () => FIXED_NOW,
        stdout: (l) => out.push(l),
        stderr: (l) => err.push(l),
        scrapeFetchers: {
          fetchAnswers: async () => [],
          fetchComments: async () => [],
        },
        makeClaudeClient: () => async () => ({
          content: [{ type: "text", text: draftJson }],
        }),
      };

      const r = await main(["draft", "--date", "2026-05-01"], deps);
      expect(r.exitCode).toBe(0);
      expect(files.has("data/drafts/draft-qd-2026-05-01.md")).toBe(true);
    });

    it("fails loudly when ANTHROPIC_API_KEY is unset", async () => {
      const { deps, err } = makeDeps();
      const r = await main(["draft"], deps);
      expect(r.exitCode).toBe(1);
      expect(err.some((l) => l.includes("ANTHROPIC_API_KEY"))).toBe(true);
    });
  });
});
