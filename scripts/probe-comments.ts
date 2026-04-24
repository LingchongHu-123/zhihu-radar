// One-shot probe: find an answer-comments endpoint that doesn't require an
// x-zse-96 signature. Phase A followup of
// docs/exec-plans/active/001-buildout.md.
//
// Why this exists: fetchCommentsForAnswer in src/sources/zhihu-answers.ts
// currently throws "not yet implemented" because the SSR question page
// does not embed comment entities, and the obvious /api/v4/answers/<aid>/
// root_comments endpoint is behind the same x-zse-96 wall that pushed us
// off /api/v4 for answers (see docs/agent-learnings.md — 40362 entry, and
// ADR 003). Before committing to an implementation we try three candidate
// paths, from most-likely-to-be-ungated to least, and print enough of each
// response that a human can eyeball which one actually returns real
// comment data vs. which ones are walled.
//
// Paths probed (in order):
//   1. SSR per-answer page:  GET /question/<qid>/answer/<aid>
//      Looks for `entities.comments` / `entities.lineComments` populated
//      in the same js-initialData blob we already parse for answers. If
//      this works we don't even need a new fetcher shape — comments come
//      along for free with the existing parser.
//   2. Mobile API:           GET api.zhihu.com/comments_v5/answers/<aid>/root_comment
//      The mobile app historically signs with a different scheme (zse-86
//      / x-zst-81) or nothing at all on comment endpoints. Worth a
//      no-signing shot.
//   3. New web path:          GET www.zhihu.com/api/v4/comment_v5/answers/<aid>/root_comment
//      The v5 comment refactor on the web — anecdotally sometimes responds
//      to a bare session cookie without the rotating signature. Last
//      resort before we give up and scrape per-answer SSR for comments.
//
// What "works" means: status 200, body is valid JSON (or HTML with a
// populated comments entities map for path 1), and the body is NOT the
// 40362 "您当前请求存在异常" wall text.
//
// Run:
//   ZHIHU_COOKIE="..." pnpm exec tsx scripts/probe-comments.ts [qid] [aid]
//   defaults: qid=292527529 aid=1309100505 (the fixture we already have)
//
// Output: human-readable report to stdout. No files written. The winning
// endpoint — if any — becomes the target of a follow-up fixture capture.
//
// Lives outside tsconfig rootDir / eslint scope / depcruise, same as
// capture-fixture.ts. `pnpm check` will not look at this file. tsx runs it.

const DEFAULT_QID = "292527529";
const DEFAULT_AID = "1309100505";

const BLOCK_MARKERS = [
  "40362",
  "您当前请求存在异常",
  "请求异常",
  "请完成安全验证",
] as const;

function commonHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const cookie = process.env["ZHIHU_COOKIE"];
  const ua =
    process.env["ZHIHU_USER_AGENT"] ??
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
  const h: Record<string, string> = {
    "User-Agent": ua,
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    ...extra,
  };
  if (cookie !== undefined && cookie !== "") {
    h["Cookie"] = cookie;
  }
  return h;
}

function looksBlocked(body: string): string | null {
  for (const marker of BLOCK_MARKERS) {
    if (body.includes(marker)) return marker;
  }
  return null;
}

function snippet(body: string, n = 400): string {
  const one = body.replace(/\s+/g, " ").trim();
  return one.length <= n ? one : one.slice(0, n) + "…";
}

// --- path 1: per-answer SSR page ------------------------------------------

async function probeSsrAnswerPage(qid: string, aid: string): Promise<void> {
  const url = `https://www.zhihu.com/question/${qid}/answer/${aid}`;
  console.log(`\n[1] SSR per-answer page`);
  console.log(`    GET ${url}`);
  try {
    const res = await fetch(url, {
      headers: commonHeaders({
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Upgrade-Insecure-Requests": "1",
      }),
    });
    const body = await res.text();
    console.log(`    status: ${res.status} ${res.statusText}`);
    console.log(`    bytes : ${body.length}`);

    const blocked = looksBlocked(body);
    if (blocked !== null) {
      console.log(`    VERDICT: BLOCKED (marker "${blocked}")`);
      return;
    }

    const m = body.match(
      /<script[^>]*id=["']js-initialData["'][^>]*>([\s\S]*?)<\/script>/,
    );
    if (m === null || m[1] === undefined) {
      console.log(`    VERDICT: NO js-initialData TAG (login wall or redesign?)`);
      console.log(`    head: ${snippet(body, 300)}`);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(m[1]);
    } catch (e) {
      console.log(`    VERDICT: initialData JSON.parse FAILED: ${(e as Error).message}`);
      return;
    }
    const entities =
      (parsed as { initialState?: { entities?: Record<string, unknown> } })
        .initialState?.entities;
    if (entities === undefined) {
      console.log(`    VERDICT: no initialState.entities`);
      return;
    }
    const commentsMap = entities["comments"] as Record<string, unknown> | undefined;
    const lineCommentsMap = entities["lineComments"] as
      | Record<string, unknown>
      | undefined;
    const commentsCount =
      commentsMap !== undefined && commentsMap !== null ? Object.keys(commentsMap).length : 0;
    const lineCommentsCount =
      lineCommentsMap !== undefined && lineCommentsMap !== null
        ? Object.keys(lineCommentsMap).length
        : 0;

    console.log(`    entities.comments    : ${commentsCount}`);
    console.log(`    entities.lineComments: ${lineCommentsCount}`);
    if (commentsCount > 0 || lineCommentsCount > 0) {
      const sampleMap = commentsCount > 0 ? commentsMap! : lineCommentsMap!;
      const firstKey = Object.keys(sampleMap)[0] ?? "";
      const first = sampleMap[firstKey];
      console.log(`    sample comment keys: ${
        first !== null && typeof first === "object"
          ? Object.keys(first as Record<string, unknown>).join(", ")
          : "(not an object)"
      }`);
      console.log(`    VERDICT: WORKS — comments embedded in SSR`);
    } else {
      console.log(`    VERDICT: SSR loads but comments maps are EMPTY (lazy-loaded)`);
    }
  } catch (err) {
    console.log(`    VERDICT: network/parse error: ${(err as Error).message}`);
  }
}

// --- path 2: mobile API ---------------------------------------------------

async function probeMobileApi(aid: string): Promise<void> {
  // limit/offset tokens kept conservative so we don't look like a scraper
  // on the first hit even if this endpoint logs
  const url = `https://api.zhihu.com/comments_v5/answers/${aid}/root_comment?order_by=score&limit=10&offset=`;
  console.log(`\n[2] Mobile API comments_v5`);
  console.log(`    GET ${url}`);
  try {
    const res = await fetch(url, {
      headers: commonHeaders({
        Accept: "application/json, text/plain, */*",
      }),
    });
    const body = await res.text();
    console.log(`    status: ${res.status} ${res.statusText}`);
    console.log(`    bytes : ${body.length}`);

    const blocked = looksBlocked(body);
    if (blocked !== null) {
      console.log(`    VERDICT: BLOCKED (marker "${blocked}")`);
      console.log(`    body: ${snippet(body, 300)}`);
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      console.log(`    VERDICT: not JSON`);
      console.log(`    body: ${snippet(body, 300)}`);
      return;
    }
    const obj = parsed as Record<string, unknown>;
    if ("error" in obj) {
      console.log(`    VERDICT: API error: ${JSON.stringify(obj["error"])}`);
      return;
    }
    const data = obj["data"];
    const dataLen = Array.isArray(data) ? data.length : -1;
    console.log(`    top-level keys: ${Object.keys(obj).join(", ")}`);
    console.log(`    data.length   : ${dataLen}`);
    if (Array.isArray(data) && data.length > 0 && typeof data[0] === "object" && data[0] !== null) {
      console.log(`    sample comment keys: ${Object.keys(data[0] as Record<string, unknown>).join(", ")}`);
      console.log(`    VERDICT: WORKS — JSON comments returned`);
    } else {
      console.log(`    VERDICT: JSON but no data rows`);
    }
  } catch (err) {
    console.log(`    VERDICT: network/parse error: ${(err as Error).message}`);
  }
}

// --- path 3: web v5 comment API -------------------------------------------

async function probeWebV5(aid: string): Promise<void> {
  const url = `https://www.zhihu.com/api/v4/comment_v5/answers/${aid}/root_comment?order_by=score&limit=10&offset=`;
  console.log(`\n[3] Web /api/v4/comment_v5`);
  console.log(`    GET ${url}`);
  try {
    const res = await fetch(url, {
      headers: commonHeaders({
        Accept: "application/json, text/plain, */*",
        Referer: "https://www.zhihu.com/",
      }),
    });
    const body = await res.text();
    console.log(`    status: ${res.status} ${res.statusText}`);
    console.log(`    bytes : ${body.length}`);

    const blocked = looksBlocked(body);
    if (blocked !== null) {
      console.log(`    VERDICT: BLOCKED (marker "${blocked}")`);
      console.log(`    body: ${snippet(body, 300)}`);
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      console.log(`    VERDICT: not JSON`);
      console.log(`    body: ${snippet(body, 300)}`);
      return;
    }
    const obj = parsed as Record<string, unknown>;
    if ("error" in obj) {
      console.log(`    VERDICT: API error: ${JSON.stringify(obj["error"])}`);
      return;
    }
    const data = obj["data"];
    const dataLen = Array.isArray(data) ? data.length : -1;
    console.log(`    top-level keys: ${Object.keys(obj).join(", ")}`);
    console.log(`    data.length   : ${dataLen}`);
    if (Array.isArray(data) && data.length > 0 && typeof data[0] === "object" && data[0] !== null) {
      console.log(`    sample comment keys: ${Object.keys(data[0] as Record<string, unknown>).join(", ")}`);
      console.log(`    VERDICT: WORKS — JSON comments returned`);
    } else {
      console.log(`    VERDICT: JSON but no data rows`);
    }
  } catch (err) {
    console.log(`    VERDICT: network/parse error: ${(err as Error).message}`);
  }
}

async function main(): Promise<void> {
  const qid = process.argv[2] ?? DEFAULT_QID;
  const aid = process.argv[3] ?? DEFAULT_AID;
  const authed =
    process.env["ZHIHU_COOKIE"] !== undefined && process.env["ZHIHU_COOKIE"] !== "";

  console.log(`[probe-comments] qid=${qid} aid=${aid} authenticated=${authed}`);
  if (!authed) {
    console.log(
      `[probe-comments] WARNING: no ZHIHU_COOKIE — every path will likely look empty or blocked.`,
    );
  }

  await probeSsrAnswerPage(qid, aid);
  await probeMobileApi(aid);
  await probeWebV5(aid);

  console.log(`\n[probe-comments] done. Look for "VERDICT: WORKS" above to pick the endpoint.`);
}

main().catch((err) => {
  console.error(`[probe-comments] FAILED:`);
  console.error(err);
  process.exit(1);
});
