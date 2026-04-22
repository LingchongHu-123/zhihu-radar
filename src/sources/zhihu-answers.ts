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
//   fetchCommentsForAnswer(answerId, opts)    -> ReadonlyArray<Comment>
//       (currently throws — comments are not embedded in SSR; the
//        companion capture/fixture is a follow-up task.)
//
// Tests mock `fetchImpl` with fixture HTML; this module makes no
// assumption about being online. It also imposes no sleep/rate-limit —
// that's runtime/'s job, since only runtime knows whether we're doing a
// batch run or a one-off.

import type { Answer, Comment } from "../types/answer.js";
import type {
  ZhihuAnswerWire,
  ZhihuInitialData,
  ZhihuQuestionWire,
} from "../types/zhihu-wire.js";
import { getZhihuCookie, getZhihuUserAgent } from "../config/env.js";

const ZHIHU_QUESTION_BASE = "https://www.zhihu.com/question";
const DEFAULT_MAX_ANSWERS = 50;

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
 * NOT YET IMPLEMENTED. The SSR page at `/question/<id>` does not embed
 * comment entities (its `initialState.entities.comments` map is always
 * empty); comments are loaded by a separate XHR after hydration, and
 * that XHR hits an `/api/v4/comments/...` endpoint subject to the same
 * x-zse-96 gate that pushed us off the API in the first place. A
 * follow-up task will capture a comments fixture (probably by parsing
 * the per-answer page at `/question/<qid>/answer/<aid>` and/or probing
 * which comment endpoints respond without signing), and then this
 * function will be implemented against that fixture.
 *
 * Throwing a clear error (rather than silently returning `[]`) so any
 * caller that tries to use comments today gets a loud, pointable
 * failure rather than an empty result that looks legitimate.
 */
export async function fetchCommentsForAnswer(
  _answerId: string,
  _opts: FetchOptions = {},
): Promise<ReadonlyArray<Comment>> {
  throw new Error(
    "fetchCommentsForAnswer: not yet implemented. The SSR question page " +
      "does not embed comment entities; a dedicated comments fixture + " +
      "endpoint probe is pending as a follow-up task. See " +
      "docs/exec-plans/active/001-buildout.md Phase A followup.",
  );
}

// ---------- shared internals ----------

async function fetchHtml(url: string, fetchImpl: typeof fetch): Promise<string> {
  const res = await fetchImpl(url, { headers: buildHeaders() });
  if (!res.ok) {
    throw new Error(`zhihu-radar: GET ${url} -> ${res.status} ${res.statusText}`);
  }
  return await res.text();
}

function buildHeaders(): Record<string, string> {
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
