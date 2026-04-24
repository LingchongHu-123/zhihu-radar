// Contract tests for runScrape. We don't re-test the fetchers here — those
// have their own suite — we test that runScrape orders the two fetchers
// correctly, writes one RawBundle per unique question id, skips empties
// and duplicates, and is robust to per-question failures.

import { describe, expect, it } from "vitest";

import { runScrape } from "../../../src/runtime/commands/scrape.js";
import type { Answer, Comment } from "../../../src/types/answer.js";
import type { FsLike } from "../../../src/runtime/io/data-dir.js";
import type { RawBundle } from "../../../src/runtime/io/bundle.js";

// ---------- fixtures ----------

const FIXED_NOW = new Date("2026-04-24T12:00:00.000Z");

function answer(id: string, questionId: string, title: string): Answer {
  return {
    id,
    questionId,
    questionTitle: title,
    body: "body of " + id,
    authorName: "anon",
    upvotes: 10,
    commentCount: 0,
    createdAt: "2026-03-01T00:00:00.000Z",
    url: `https://www.zhihu.com/question/${questionId}/answer/${id}`,
    scrapedAt: FIXED_NOW.toISOString(),
  };
}

function comment(id: string, answerId: string): Comment {
  return {
    id,
    answerId,
    body: "body of comment " + id,
    authorName: "anon",
    upvotes: 1,
    createdAt: "2026-03-02T00:00:00.000Z",
    scrapedAt: FIXED_NOW.toISOString(),
  };
}

// ---------- in-memory FsLike ----------

function memFs(): {
  fs: FsLike;
  files: Map<string, string>;
  dirs: Set<string>;
} {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
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
    async mkdir(path) {
      dirs.add(path);
    },
  };
  return { fs, files, dirs };
}

function logger(): {
  log: { kind: "info" | "warn"; line: string }[];
  info: (line: string) => void;
  warn: (line: string) => void;
} {
  const log: { kind: "info" | "warn"; line: string }[] = [];
  return {
    log,
    info: (line) => log.push({ kind: "info", line }),
    warn: (line) => log.push({ kind: "warn", line }),
  };
}

// ---------- tests ----------

describe("runScrape", () => {
  it("writes one bundle per question id with answers + comments", async () => {
    const { fs, files, dirs } = memFs();
    const log = logger();

    const result = await runScrape({
      questionIds: ["111", "222"],
      dataDir: "data",
      now: FIXED_NOW,
      fs,
      fetchers: {
        fetchAnswers: async (qid) => [answer(qid + "a", qid, "Title " + qid)],
        fetchComments: async (aid) => [comment(aid + "c1", aid)],
      },
      logger: log,
    });

    expect(result.bundlesWritten).toBe(2);
    expect(result.questionIdsFailed).toEqual([]);
    expect(dirs.has("data/raw")).toBe(true);

    const bundle111 = JSON.parse(files.get("data/raw/111.json")!) as RawBundle;
    expect(bundle111.questionId).toBe("111");
    expect(bundle111.questionTitle).toBe("Title 111");
    expect(bundle111.scrapedAt).toBe(FIXED_NOW.toISOString());
    expect(bundle111.answers.map((a) => a.id)).toEqual(["111a"]);
    expect(bundle111.commentsByAnswerId["111a"]?.map((c) => c.id)).toEqual([
      "111ac1",
    ]);
  });

  it("skips empty and duplicate ids", async () => {
    const { fs, files } = memFs();
    const log = logger();
    const seen: string[] = [];

    const result = await runScrape({
      questionIds: ["333", "", "333", "  ", "444"],
      dataDir: "data",
      now: FIXED_NOW,
      fs,
      fetchers: {
        fetchAnswers: async (qid) => {
          seen.push(qid);
          return [answer(qid + "a", qid, "Q")];
        },
        fetchComments: async () => [],
      },
      logger: log,
    });

    expect(result.bundlesWritten).toBe(2);
    expect(seen).toEqual(["333", "444"]);
    expect(files.has("data/raw/333.json")).toBe(true);
    expect(files.has("data/raw/444.json")).toBe(true);
  });

  it("isolates per-question failures", async () => {
    const { fs, files } = memFs();
    const log = logger();

    const result = await runScrape({
      questionIds: ["good", "bad", "good2"],
      dataDir: "data",
      now: FIXED_NOW,
      fs,
      fetchers: {
        fetchAnswers: async (qid) => {
          if (qid === "bad") throw new Error("boom");
          return [answer(qid + "a", qid, "Q")];
        },
        fetchComments: async () => [],
      },
      logger: log,
    });

    expect(result.bundlesWritten).toBe(2);
    expect(result.questionIdsFailed).toEqual(["bad"]);
    expect(files.has("data/raw/good.json")).toBe(true);
    expect(files.has("data/raw/good2.json")).toBe(true);
    expect(files.has("data/raw/bad.json")).toBe(false);

    const warnLines = log.log.filter((e) => e.kind === "warn").map((e) => e.line);
    expect(warnLines.some((l) => l.includes("bad") && l.includes("boom"))).toBe(
      true,
    );
  });

  it("writes empty-answers bundle with empty title when the page has none", async () => {
    const { fs, files } = memFs();
    const log = logger();

    await runScrape({
      questionIds: ["555"],
      dataDir: "d",
      now: FIXED_NOW,
      fs,
      fetchers: {
        fetchAnswers: async () => [],
        fetchComments: async () => [],
      },
      logger: log,
    });

    const b = JSON.parse(files.get("d/raw/555.json")!) as RawBundle;
    expect(b.answers).toEqual([]);
    expect(b.questionTitle).toBe("");
    expect(b.commentsByAnswerId).toEqual({});
  });
});
