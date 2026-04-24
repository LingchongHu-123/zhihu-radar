// Tests for src/sources/zhihu-answers.ts.
//
// These tests are fully offline: every call into the module is given a
// stub `fetchImpl` that returns an in-memory Response. The real fixture
// at tests/fixtures/zhihu/question-292527529-initialData.json is the raw
// `js-initialData` JSON blob that 知乎 injects into the SSR HTML; the
// helper `okHtml` wraps it back into a minimal HTML envelope so the
// module's extraction regex has something to bite on.
//
// The comment-endpoint fixtures (`answer-2543422324-comments-page1.json`
// and `…-comments-last.json`) are raw `/api/v4/comment_v5/...` response
// bodies, captured from a real unauthenticated request. The last-page
// fixture deliberately keeps `paging.next` populated even though
// `paging.is_end === true` — that loop-back is the key termination
// invariant the comment tests pin.
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

// Minimal row shape mirroring `ZhihuCommentWire` — just the fields the
// mapper consumes plus the assertion fields the tests read. Matching the
// full wire type here would couple the test to every optional sub-object.
type CommentRow = {
  id: string;
  content: string;
  created_time: number;
  is_delete: boolean;
  reply_comment_id: string;
  like_count: number;
  author: { name: string };
  child_comments: ReadonlyArray<CommentRow>;
};

type CommentsPageFixture = {
  data: CommentRow[];
  paging: {
    is_end: boolean;
    is_start: boolean;
    next?: string;
    previous?: string;
    totals?: number;
  };
};

const commentsPage1Path = resolve(
  here,
  "../fixtures/zhihu/answer-2543422324-comments-page1.json",
);
const commentsLastPath = resolve(
  here,
  "../fixtures/zhihu/answer-2543422324-comments-last.json",
);
const commentsPage1 = JSON.parse(
  readFileSync(commentsPage1Path, "utf8"),
) as CommentsPageFixture;
const commentsLast = JSON.parse(
  readFileSync(commentsLastPath, "utf8"),
) as CommentsPageFixture;

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

/** Convert whatever fetch accepts as `input` into a string URL for logging. */
const urlOf = (input: RequestInfo | URL): string =>
  typeof input === "string"
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url;

/** JSON Response helper shaped like the comment_v5 endpoint. */
const jsonResponse = (payload: unknown, init?: ResponseInit): Response =>
  new Response(JSON.stringify(payload), {
    status: 200,
    statusText: "OK",
    headers: { "content-type": "application/json" },
    ...init,
  });

/**
 * Build a recording fetchImpl for the comments endpoint.
 *
 * First call (expected to be the initial URL ending in `offset=`) returns
 * page1; a second call whose URL starts with page1's `paging.next` returns
 * the last-page fixture; any third call throws so a pagination bug (e.g.
 * trusting `paging.next` presence instead of `is_end`) surfaces as a
 * test failure rather than a hang.
 */
const buildCommentsFetch = (): {
  fetchImpl: typeof fetch;
  calls: string[];
} => {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = urlOf(input);
    calls.push(url);
    if (calls.length === 1) {
      // The first call is the module's hand-built initial URL. It should
      // end in `offset=` (empty offset means "give me the first page").
      if (!url.endsWith("offset=")) {
        throw new Error(
          `unexpected first URL — expected trailing 'offset=', got ${url}`,
        );
      }
      return jsonResponse(commentsPage1);
    }
    if (calls.length === 2) {
      // The second call must be the URL page1 handed us in `paging.next`.
      const expectedNext = commentsPage1.paging.next;
      if (expectedNext === undefined || url !== expectedNext) {
        throw new Error(
          `unexpected second URL — expected ${String(expectedNext)}, got ${url}`,
        );
      }
      return jsonResponse(commentsLast);
    }
    throw new Error(
      `fetchCommentsForAnswer walked past is_end — extra call to ${url}`,
    );
  };
  return { fetchImpl, calls };
};

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
  it("returns every non-deleted comment from both pages of the fixture", async () => {
    const { fetchImpl } = buildCommentsFetch();

    const rows = await fetchCommentsForAnswer("2543422324", { fetchImpl });

    // Sanity-check the fixture against the expected 10+4 shape before
    // leaning on it. If a future recapture changes counts, this line tells
    // the next reader which invariant broke first.
    const page1Live = commentsPage1.data.filter((c) => c.is_delete === false);
    const lastLive = commentsLast.data.filter((c) => c.is_delete === false);
    expect(page1Live).toHaveLength(10);
    expect(lastLive).toHaveLength(4);

    expect(rows).toHaveLength(page1Live.length + lastLive.length);
    expect(rows).toHaveLength(14);
  });

  it("stops paginating when paging.is_end === true (is_end, not `next` absence, is the termination signal)", async () => {
    const { fetchImpl, calls } = buildCommentsFetch();

    await fetchCommentsForAnswer("2543422324", { fetchImpl });

    // The `last` fixture still carries a populated `paging.next` URL even
    // though `is_end === true` — so if the implementation ever regressed to
    // trusting `next` presence, it would issue a third call and the stub
    // would throw. Pinning the exact count makes that regression loud.
    expect(calls).toHaveLength(2);
    expect(commentsLast.paging.is_end).toBe(true);
    expect(commentsLast.paging.next).toBeDefined();
  });

  it("issues the initial URL with an empty `offset=` then follows paging.next for page 2", async () => {
    const { fetchImpl, calls } = buildCommentsFetch();

    await fetchCommentsForAnswer("2543422324", { fetchImpl });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatch(/\/answers\/2543422324\/root_comment\?/);
    expect(calls[0]).toMatch(/offset=$/);
    expect(calls[1]).toBe(commentsPage1.paging.next);
  });

  it("stamps answerId onto every returned comment", async () => {
    const { fetchImpl } = buildCommentsFetch();

    const rows = await fetchCommentsForAnswer("2543422324", { fetchImpl });

    for (const row of rows) {
      expect(row.answerId).toBe("2543422324");
    }
  });

  it("leaves parentCommentId unset on root comments and copies reply_comment_id onto inline child replies", async () => {
    const { fetchImpl } = buildCommentsFetch();

    const rows = await fetchCommentsForAnswer("2543422324", { fetchImpl });

    // Every row in the captured fixtures is a root comment
    // (reply_comment_id === "0"), so none should carry parentCommentId.
    for (const row of rows) {
      expect(row).not.toHaveProperty("parentCommentId");
    }

    // The fixture's `child_comments` arrays are all empty today, but the
    // mapper contract says any inline child should surface parentCommentId
    // from its wire `reply_comment_id`. Synthesise one via a JS spread so
    // the assertion survives even when 知乎 gives us empty children. We
    // inherit author/like_count/etc. from the host row via spread so the
    // mapper sees a fully-shaped wire row.
    const hostRow = commentsPage1.data[0];
    expect(hostRow).toBeDefined();
    if (hostRow === undefined) return;

    const syntheticChild: CommentRow = {
      ...hostRow,
      id: "99999999999",
      content: "child reply",
      created_time: 1_700_000_000,
      is_delete: false,
      reply_comment_id: "10447279921",
      child_comments: [],
    };

    const patchedPage1: CommentsPageFixture = {
      ...commentsPage1,
      data: [
        { ...hostRow, child_comments: [syntheticChild] },
        ...commentsPage1.data.slice(1),
      ],
    };

    const patchedFetch: typeof fetch = async (input) => {
      const url = urlOf(input);
      if (url.endsWith("offset=")) return jsonResponse(patchedPage1);
      return jsonResponse(commentsLast);
    };

    const patchedRows = await fetchCommentsForAnswer("2543422324", {
      fetchImpl: patchedFetch,
    });
    const child = patchedRows.find((r) => r.id === "99999999999");
    expect(child).toBeDefined();
    expect(child?.parentCommentId).toBe("10447279921");
    expect(child?.answerId).toBe("2543422324");
  });

  it("emits createdAt as ISO-8601 and round-trips to wire created_time (unix seconds)", async () => {
    const { fetchImpl } = buildCommentsFetch();

    const rows = await fetchCommentsForAnswer("2543422324", { fetchImpl });

    const wireById = new Map<string, CommentRow>();
    for (const row of commentsPage1.data) wireById.set(row.id, row);
    for (const row of commentsLast.data) wireById.set(row.id, row);

    for (const row of rows) {
      expect(row.createdAt).toMatch(ISO_8601_RE);
      const wire = wireById.get(row.id);
      expect(wire).toBeDefined();
      if (wire === undefined) continue;
      expect(Math.floor(new Date(row.createdAt).getTime() / 1000)).toBe(
        wire.created_time,
      );
    }
  });

  it("stamps scrapedAt as ISO-8601 and within 60 s of Date.now()", async () => {
    const { fetchImpl } = buildCommentsFetch();

    const before = Date.now();
    const rows = await fetchCommentsForAnswer("2543422324", { fetchImpl });
    const after = Date.now();

    for (const row of rows) {
      expect(row.scrapedAt).toMatch(ISO_8601_RE);
      const ts = new Date(row.scrapedAt).getTime();
      // Not strictly before-bounded (the call-site sampled `scrapedAt`
      // before our `before` millisecond) but always within a minute.
      expect(Math.abs(after - ts)).toBeLessThan(60_000);
      expect(ts).toBeGreaterThanOrEqual(before - 60_000);
    }
  });

  it("strips HTML from comment bodies while preserving plain-text content (51offer row)", async () => {
    const { fetchImpl } = buildCommentsFetch();

    const rows = await fetchCommentsForAnswer("2543422324", { fetchImpl });

    const target = rows.find((r) => r.id === "11261890110");
    expect(target).toBeDefined();
    if (target === undefined) return;

    // Precondition: the wire actually carries the HTML we expect to strip,
    // otherwise the assertion is vacuously true.
    const wire = commentsLast.data.find((r) => r.id === "11261890110");
    expect(wire).toBeDefined();
    expect(wire?.content).toMatch(/<br>/);
    expect(wire?.content).toMatch(/<a /);

    expect(target.body).not.toContain("<");
    expect(target.body).not.toContain(">");
    expect(target.body).toContain("实名举报51offer");
  });

  it("enforces maxRows as a HARD cap — no pagination past the cap", async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      calls.push(urlOf(input));
      if (calls.length === 1) return jsonResponse(commentsPage1);
      throw new Error(
        "fetchCommentsForAnswer paginated past maxRows — extra call issued",
      );
    };

    const rows = await fetchCommentsForAnswer("2543422324", {
      fetchImpl,
      maxRows: 5,
    });

    expect(rows).toHaveLength(5);
    expect(calls).toHaveLength(1);
  });

  it("throws an error mentioning the status code and URL on a non-OK HTTP response", async () => {
    const rateLimitedFetch: typeof fetch = async () =>
      new Response("", { status: 429, statusText: "Too Many Requests" });

    const promise = fetchCommentsForAnswer("2543422324", {
      fetchImpl: rateLimitedFetch,
    });
    await expect(promise).rejects.toThrow(/429/);
    await expect(promise).rejects.toThrow(
      /\/api\/v4\/comment_v5\/answers\/2543422324\/root_comment/,
    );
  });

  it("throws an error mentioning 'comment_v5' when the response is missing data/paging", async () => {
    const brokenFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ error: { message: "boom" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    await expect(
      fetchCommentsForAnswer("2543422324", { fetchImpl: brokenFetch }),
    ).rejects.toThrow(/comment_v5/);
  });
});
