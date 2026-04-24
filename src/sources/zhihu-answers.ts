// 知乎 answer + comment scraper.
//
// As of 2026-04-22 we source answers from the server-rendered question
// page at `https://www.zhihu.com/question/<id>` and parse the embedded
// `<script id="js-initialData">` JSON blob. The `/api/v4/...` JSON API
// rejects unauthenticated requests with a 40362 "abnormal request" wall
// because it expects an `x-zse-96` signature header produced by
// obfuscated browser JS. See docs/decisions/003-source-strategy-html-ssr.md
// for the full rationale; see docs/agent-learnings.md for the debugging
// trail. The consequence for this module: one HTTP GET returns *all* the
// answer entities the page has pre-rendered (typically 3–5), and that's
// what we hand off to the rest of the pipeline.
//
// Exports:
//   fetchAnswersForQuestion(questionId, opts) -> ReadonlyArray<Answer>
//       (parses the SSR HTML `js-initialData` blob)
//   fetchCommentsForAnswer(answerId, opts)    -> ReadonlyArray<Comment>
//       (calls `/api/v4/comment_v5/answers/<aid>/root_comment`, the only
//        comment endpoint that returns JSON without an x-zse-96 signature
//        — see scripts/probe-comments.ts for the probe that picked it)
//
// Tests mock `fetchImpl` with fixture HTML; this module makes no
// assumption about being online. It also imposes no sleep/rate-limit —
// that's runtime/'s job, since only runtime knows whether we're doing a
// batch run or a one-off.

import type { Answer, Comment } from "../types/answer.js";
import type {
  ZhihuAnswerWire,
  ZhihuCommentWire,
  ZhihuCommentsPage,
  ZhihuInitialData,
  ZhihuQuestionWire,
} from "../types/zhihu-wire.js";
import { getZhihuCookie, getZhihuUserAgent } from "../config/env.js";

const ZHIHU_QUESTION_BASE = "https://www.zhihu.com/question";
const ZHIHU_COMMENT_V5_BASE = "https://www.zhihu.com/api/v4/comment_v5/answers";
const DEFAULT_MAX_ANSWERS = 50;
const DEFAULT_MAX_COMMENTS = 500;
const COMMENT_PAGE_LIMIT = 20;
// Hard cap on page follows so a bug in 知乎's pagination (or a pathological
// comment thread) can't walk us indefinitely. 500 comments at 20/page is
// 25 pages, so 50 is generously double that.
const MAX_COMMENT_PAGES = 50;

// Matches the JSON blob 知乎 injects into the page. The tag attribute order
// varies slightly, so we match by `id="js-initialData"` and capture the
// body. `[\s\S]*?` is non-greedy and crosses newlines.
const INITIAL_DATA_RE =
  /<script[^>]*id=["']js-initialData["'][^>]*>([\s\S]*?)<\/script>/;

/** Options shared by both fetchers. */
export type FetchOptions = {
  /** Upper bound on rows returned. */
  maxRows?: number;
  /** Override `fetch` — mainly for tests that want a stub. */
  fetchImpl?: typeof fetch;
};

// ---------- answers ----------

/**
 * Fetch and normalize answers for one question.
 *
 * Unlike the old /api/v4 implementation this does NOT paginate — the SSR
 * page hands us whatever it hydrated (typically 3–5 top answers) in a
 * single response. `maxRows` still applies as an upper bound in case 知乎
 * ever changes SSR to include many more.
 */
export async function fetchAnswersForQuestion(
  questionId: string,
  opts: FetchOptions = {},
): Promise<ReadonlyArray<Answer>> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxRows = opts.maxRows ?? DEFAULT_MAX_ANSWERS;
  const scrapedAt = new Date().toISOString();

  const url = `${ZHIHU_QUESTION_BASE}/${encodeURIComponent(questionId)}`;
  const html = await fetchHtml(url, fetchImpl);
  const initialData = extractInitialData(html);

  const entities = initialData.initialState.entities;
  const questionsMap = entities.questions;

  const collected: Answer[] = [];
  for (const wire of Object.values(entities.answers)) {
    collected.push(toAnswer(wire, questionsMap, scrapedAt));
    if (collected.length >= maxRows) break;
  }
  return collected;
}

function toAnswer(
  w: ZhihuAnswerWire,
  questions: Readonly<Record<string, ZhihuQuestionWire>>,
  scrapedAt: string,
): Answer {
  // Prefer the full question entity's title when we have it; fall back
  // to the stub embedded in the answer. In practice both agree, but the
  // full entity may have more polished display formatting.
  const fullQuestion = questions[w.question.id];
  const questionTitle = fullQuestion !== undefined ? fullQuestion.title : w.question.title;

  const base: Answer = {
    id: w.id,
    questionId: w.question.id,
    questionTitle,
    body: stripHtml(w.content),
    authorName: w.author.name,
    upvotes: w.voteupCount,
    commentCount: w.commentCount,
    createdAt: new Date(w.createdTime * 1000).toISOString(),
    url: w.url,
    scrapedAt,
  };
  if (w.updatedTime !== w.createdTime) {
    return { ...base, updatedAt: new Date(w.updatedTime * 1000).toISOString() };
  }
  return base;
}

// ---------- comments ----------

/**
 * Fetch and normalize comments for one answer.
 *
 * Source: `GET https://www.zhihu.com/api/v4/comment_v5/answers/<aid>/
 * root_comment` — of the three paths probed in scripts/probe-comments.ts
 * (SSR per-answer page, mobile `api.zhihu.com/comments_v5`, and this
 * web `/api/v4/comment_v5`), this is the only one that returns real
 * comment JSON unauthenticated and without an x-zse-96 signature. A
 * cookie is sent if the env provides one (better rate-limit behaviour
 * under load) but is not required for the call to succeed.
 *
 * Pagination contract (carved from the captured fixtures): follow
 * `paging.next` until `paging.is_end === true`. Do NOT use `next` being
 * absent as a termination signal — even the last page ships a `next`
 * URL that loops back to the start. See ZhihuCommentPaging's doc-comment
 * on `is_end` for the full story.
 *
 * Flattening: each root comment may carry up to a handful of inline
 * replies in `child_comments`. We flatten them into the output array,
 * preserving parent→child linkage via `Comment.parentCommentId`, so
 * that signal-density scoring in later layers can count reply content
 * without re-fetching per-root-comment sub-threads.
 *
 * Filtering: deleted comments (`is_delete === true`) are dropped since
 * their `content` is empty anyway; collapsed and reviewing comments are
 * kept because their text may still contain conversion signals and the
 * scoring layer decides what to do with them, not us.
 */
export async function fetchCommentsForAnswer(
  answerId: string,
  opts: FetchOptions = {},
): Promise<ReadonlyArray<Comment>> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxRows = opts.maxRows ?? DEFAULT_MAX_COMMENTS;
  const scrapedAt = new Date().toISOString();

  const collected: Comment[] = [];
  let url = `${ZHIHU_COMMENT_V5_BASE}/${encodeURIComponent(
    answerId,
  )}/root_comment?order_by=score&limit=${COMMENT_PAGE_LIMIT}&offset=`;

  for (let page = 0; page < MAX_COMMENT_PAGES; page += 1) {
    const body = await fetchCommentsJson(url, fetchImpl);
    for (const wire of body.data) {
      pushCommentAndChildren(collected, wire, answerId, scrapedAt, maxRows);
      if (collected.length >= maxRows) return collected;
    }
    // Termination is is_end ONLY. paging.next is populated even on the
    // last page (it loops back to the first page), so trusting next to
    // be absent would walk us forever. See ZhihuCommentPaging.is_end.
    if (body.paging.is_end) return collected;
    const nextUrl = body.paging.next;
    if (nextUrl === undefined) return collected;
    url = nextUrl;
  }
  return collected;
}

function pushCommentAndChildren(
  into: Comment[],
  wire: ZhihuCommentWire,
  answerId: string,
  scrapedAt: string,
  maxRows: number,
): void {
  if (into.length >= maxRows) return;
  if (!wire.is_delete) {
    into.push(toComment(wire, answerId, scrapedAt));
  }
  for (const child of wire.child_comments) {
    if (into.length >= maxRows) return;
    if (child.is_delete) continue;
    into.push(toComment(child, answerId, scrapedAt));
  }
}

function toComment(
  w: ZhihuCommentWire,
  answerId: string,
  scrapedAt: string,
): Comment {
  const base: Comment = {
    id: w.id,
    answerId,
    body: stripHtml(w.content),
    authorName: w.author.name,
    upvotes: w.like_count,
    createdAt: new Date(w.created_time * 1000).toISOString(),
    scrapedAt,
  };
  // reply_comment_id === "0" means "this is a root comment". Any other
  // value is a real parent id.
  if (w.reply_comment_id !== "0" && w.reply_comment_id !== "") {
    return { ...base, parentCommentId: w.reply_comment_id };
  }
  return base;
}

// ---------- shared internals ----------

async function fetchHtml(url: string, fetchImpl: typeof fetch): Promise<string> {
  const res = await fetchImpl(url, { headers: buildHtmlHeaders() });
  if (!res.ok) {
    throw new Error(`zhihu-radar: GET ${url} -> ${res.status} ${res.statusText}`);
  }
  return await res.text();
}

async function fetchCommentsJson(
  url: string,
  fetchImpl: typeof fetch,
): Promise<ZhihuCommentsPage> {
  const res = await fetchImpl(url, { headers: buildJsonHeaders() });
  if (!res.ok) {
    throw new Error(`zhihu-radar: GET ${url} -> ${res.status} ${res.statusText}`);
  }
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch (cause) {
    throw new Error(
      `zhihu-radar: comment_v5 JSON.parse failed for ${url}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }
  // Structural guard at the boundary — same philosophy as
  // extractInitialData: fail here with a specific message rather than
  // dereferencing .data or .paging on something unexpected.
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    !Array.isArray((parsed as { data?: unknown }).data) ||
    typeof (parsed as { paging?: unknown }).paging !== "object" ||
    (parsed as { paging?: unknown }).paging === null
  ) {
    throw new Error(
      `zhihu-radar: comment_v5 response for ${url} is missing { data, paging }. ` +
        "This usually means 知乎 changed the envelope or returned an error body.",
    );
  }
  return parsed as ZhihuCommentsPage;
}

function buildHtmlHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": getZhihuUserAgent(),
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Upgrade-Insecure-Requests": "1",
  };
  const cookie = getZhihuCookie();
  if (cookie !== undefined) {
    headers["Cookie"] = cookie;
  }
  return headers;
}

function buildJsonHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": getZhihuUserAgent(),
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    // The comment endpoint returns 200 without Referer unauthenticated,
    // but including it matches what the web client does and costs
    // nothing — keeps us shaped like a browser if 知乎 tightens rules.
    Referer: "https://www.zhihu.com/",
  };
  const cookie = getZhihuCookie();
  if (cookie !== undefined) {
    headers["Cookie"] = cookie;
  }
  return headers;
}

/**
 * Pull the `js-initialData` JSON out of the page HTML and parse it.
 *
 * Known failure modes (each gets a distinct error for easier triage):
 *   - script tag not found → the page is a login wall, captcha
 *     interstitial, or 知乎 changed their SSR key name
 *   - JSON.parse throws    → blob is present but malformed (rare; usually
 *     signals a mid-request truncation or a 知乎 schema change)
 *   - entities.answers missing → well-formed JSON but the expected sub-
 *     tree isn't there (page might be rendering as "not found" or a
 *     redirect stub)
 */
function extractInitialData(html: string): ZhihuInitialData {
  const match = INITIAL_DATA_RE.exec(html);
  if (match === null || match[1] === undefined) {
    throw new Error(
      "zhihu-radar: could not find <script id=\"js-initialData\"> in response HTML. " +
        "The page may be a login wall or captcha interstitial. " +
        "Check the cookie is still valid.",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]);
  } catch (cause) {
    throw new Error(
      `zhihu-radar: js-initialData JSON.parse failed: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }
  // Structural guard: confirm the one path we're about to read actually
  // exists. Deeper type-narrowing is skipped — the types/ layer describes
  // what we *expect*, and if 知乎 sends something else we'd rather fail
  // at the boundary than deep in toAnswer.
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    !("initialState" in parsed) ||
    typeof (parsed as { initialState: unknown }).initialState !== "object"
  ) {
    throw new Error(
      "zhihu-radar: js-initialData blob is missing 'initialState'. " +
        "This usually means 知乎 changed its SSR schema.",
    );
  }
  return parsed as ZhihuInitialData;
}

/**
 * Strip 知乎's HTML to plain text. Intentionally minimal: removes tags,
 * collapses whitespace, decodes a handful of common entities. We keep this
 * dependency-free for now; if accuracy becomes a problem we'll reconsider
 * adding a parser (see CLAUDE.md rule 4 on runtime deps).
 */
function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
