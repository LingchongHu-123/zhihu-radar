// Tests for src/sources/zhihu-answers.ts.
//
// These tests are fully offline: every call into the module is given a
// stub `fetchImpl` that returns an in-memory Response. The real fixture
// at tests/fixtures/zhihu/question-292527529-initialData.json is the raw
// `js-initialData` JSON blob that 知乎 injects into the SSR HTML; the
// helper `okHtml` wraps it back into a minimal HTML envelope so the
// module's extraction regex has something to bite on.
//
// If this ever flakes with a "Response is not defined" error it means
// someone pointed vitest at a pre-Node-18 runtime — `Response` is a
// global in Node 20+, which is our stated minimum in package.json.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, it, expect } from "vitest";

import {
  fetchAnswersForQuestion,
  fetchCommentsForAnswer,
} from "../../src/sources/zhihu-answers.js";

// Load the fixture via readFileSync rather than a JSON import attribute:
// JSON import attributes (`with { type: "json" }`) are still ESM-only
// syntax that vitest's TS transform handles unevenly across versions,
// while readFileSync + JSON.parse works identically under every runner.
const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(
  here,
  "../fixtures/zhihu/question-292527529-initialData.json",
);
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
  initialState: {
    entities: {
      answers: Record<
        string,
        {
          id: string;
          voteupCount: number;
          commentCount: number;
          createdTime: number;
          updatedTime: number;
          url: string;
          content: string;
          question: { id: string; title: string };
          author: { name: string };
        }
      >;
      questions: Record<string, { title: string }>;
    };
  };
};

/** Wrap the raw initialData JSON back into the HTML envelope the scraper expects. */
const okHtml = (payload: unknown): string =>
  `<!doctype html><html><body><script id="js-initialData" type="text/json">${JSON.stringify(
    payload,
  )}</script></body></html>`;

/** Default stub: always returns the fixture as a 200 HTML response. */
const fixtureFetchImpl: typeof fetch = async () =>
  new Response(okHtml(fixture), {
    status: 200,
    statusText: "OK",
    headers: { "content-type": "text/html; charset=utf-8" },
  });

// ISO-8601 shape: YYYY-MM-DDTHH:MM:SS(.sss)?Z — Node's Date#toISOString always
// produces the `.sssZ` form, but accept both to stay honest.
const ISO_8601_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

describe("fetchAnswersForQuestion", () => {
  it("returns all 3 answers with every required Answer field present", async () => {
    const rows = await fetchAnswersForQuestion("292527529", {
      fetchImpl: fixtureFetchImpl,
    });

    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(typeof row.id).toBe("string");
      expect(typeof row.questionId).toBe("string");
      expect(typeof row.questionTitle).toBe("string");
      expect(typeof row.body).toBe("string");
      expect(typeof row.authorName).toBe("string");
      expect(typeof row.upvotes).toBe("number");
      expect(typeof row.commentCount).toBe("number");
      expect(typeof row.createdAt).toBe("string");
      expect(typeof row.url).toBe("string");
      expect(typeof row.scrapedAt).toBe("string");
    }
  });

  it("maps wire fields onto the domain Answer shape for answer 1309100505", async () => {
    const rows = await fetchAnswersForQuestion("292527529", {
      fetchImpl: fixtureFetchImpl,
    });
    const target = rows.find((r) => r.id === "1309100505");
    expect(target).toBeDefined();
    if (target === undefined) return; // for the type-narrower

    const wire = fixture.initialState.entities.answers["1309100505"];
    expect(wire).toBeDefined();
    if (wire === undefined) return;

    expect(target.id).toBe(String(wire.id));
    expect(target.questionId).toBe("292527529");
    expect(target.questionTitle).toBe(
      "出国留学中介靠谱的都有哪些（前十名）？",
    );
    expect(target.upvotes).toBe(wire.voteupCount);
    expect(target.commentCount).toBe(wire.commentCount);
    expect(target.url).toBe(wire.url);

    // createdAt round-trips to the wire createdTime (seconds since epoch).
    expect(target.createdAt).toMatch(ISO_8601_RE);
    expect(Math.floor(new Date(target.createdAt).getTime() / 1000)).toBe(
      wire.createdTime,
    );

    // scrapedAt is ISO-8601 and close to now.
    expect(target.scrapedAt).toMatch(ISO_8601_RE);
    const scrapedAtDelta = Date.now() - new Date(target.scrapedAt).getTime();
    expect(scrapedAtDelta).toBeGreaterThanOrEqual(0);
    expect(scrapedAtDelta).toBeLessThan(60_000);
  });

  it("emits updatedAt as ISO-8601 when the wire's updatedTime differs from createdTime", async () => {
    const rows = await fetchAnswersForQuestion("292527529", {
      fetchImpl: fixtureFetchImpl,
    });
    // All three fixture answers have createdTime !== updatedTime, so every
    // row should carry an updatedAt. We assert on one explicitly and then
    // generalise.
    const target = rows.find((r) => r.id === "1309100505");
    expect(target).toBeDefined();
    if (target === undefined) return;

    const wire = fixture.initialState.entities.answers["1309100505"];
    expect(wire).toBeDefined();
    if (wire === undefined) return;
    expect(wire.createdTime).not.toBe(wire.updatedTime);

    expect(target.updatedAt).toBeDefined();
    expect(target.updatedAt).toMatch(ISO_8601_RE);
    expect(
      Math.floor(new Date(target.updatedAt ?? "").getTime() / 1000),
    ).toBe(wire.updatedTime);

    for (const row of rows) {
      const w = fixture.initialState.entities.answers[row.id];
      if (w !== undefined && w.createdTime !== w.updatedTime) {
        expect(row.updatedAt).toMatch(ISO_8601_RE);
      }
    }
  });

  it("strips HTML from answer bodies and leaves substantive text", async () => {
    const rows = await fetchAnswersForQuestion("292527529", {
      fetchImpl: fixtureFetchImpl,
    });
    for (const row of rows) {
      expect(row.body).not.toContain("<");
      expect(row.body).not.toContain(">");
      expect(row.body.length).toBeGreaterThan(100);
    }
  });

  it("respects the maxRows cap", async () => {
    const rows = await fetchAnswersForQuestion("292527529", {
      fetchImpl: fixtureFetchImpl,
      maxRows: 2,
    });
    expect(rows).toHaveLength(2);
  });

  it("calls fetchImpl exactly once with the canonical question URL", async () => {
    const calls: Array<string> = [];
    const recordingFetch: typeof fetch = async (input) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      calls.push(url);
      return new Response(okHtml(fixture), { status: 200, statusText: "OK" });
    };

    await fetchAnswersForQuestion("292527529", { fetchImpl: recordingFetch });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe("https://www.zhihu.com/question/292527529");
  });

  it("throws a recognisable error when the page has no js-initialData script", async () => {
    const emptyFetch: typeof fetch = async () =>
      new Response("<!doctype html><html><body><p>login wall</p></body></html>", {
        status: 200,
        statusText: "OK",
      });

    await expect(
      fetchAnswersForQuestion("292527529", { fetchImpl: emptyFetch }),
    ).rejects.toThrow(/js-initialData/);
  });

  it("throws an error containing the status code and URL on a non-OK HTTP response", async () => {
    const forbiddenFetch: typeof fetch = async () =>
      new Response("", { status: 403, statusText: "Forbidden" });

    const promise = fetchAnswersForQuestion("292527529", {
      fetchImpl: forbiddenFetch,
    });
    await expect(promise).rejects.toThrow(/403/);
    await expect(promise).rejects.toThrow(
      /https:\/\/www\.zhihu\.com\/question\/292527529/,
    );
  });
});

describe("fetchCommentsForAnswer", () => {
  it("throws 'not yet implemented' so callers get a loud, pointable failure", async () => {
    // The spec explicitly locks this contract: when a future implementer
    // replaces the stub they'll see this test fail and know to update it.
    const neverCalled: typeof fetch = async () => {
      throw new Error(
        "fetchCommentsForAnswer should not reach fetchImpl while it is a stub",
      );
    };

    await expect(
      fetchCommentsForAnswer("1309100505", { fetchImpl: neverCalled }),
    ).rejects.toThrow(/not yet implemented/i);
  });
});
