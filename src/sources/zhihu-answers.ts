// 知乎 answer + comment scraper.
//
// Talks to 知乎's undocumented v4 JSON API (the same endpoints the web app
// uses). Two exported entry points:
//
//   fetchAnswersForQuestion(questionId, opts) -> Answer[]
//   fetchCommentsForAnswer(answerId, opts)    -> Comment[]
//
// Wire-format quirks are contained here. Every other layer sees the clean
// domain shapes in src/types/answer.ts.
//
// Tests mock global fetch with fixtures; this module makes no assumption
// about being online. It also imposes no sleep/rate-limit — that's
// runtime/'s job (it knows whether we're in a batch run or a one-off).

import type { Answer, Comment } from "../types/answer.js";
import { getZhihuCookie, getZhihuUserAgent } from "../config/env.js";

const ZHIHU_API_BASE = "https://www.zhihu.com/api/v4";
const DEFAULT_PAGE_SIZE = 20;
const DEFAULT_MAX_ANSWERS = 50;
const DEFAULT_MAX_COMMENTS = 100;

/** Options shared by both fetchers. */
export type FetchOptions = {
  /** Upper bound on rows returned. Pagination stops early when reached. */
  maxRows?: number;
  /** Override `fetch` — mainly for tests that want a stub. */
  fetchImpl?: typeof fetch;
};

// ---------- answers ----------

type AnswerWirePage = {
  data: ReadonlyArray<AnswerWire>;
  paging: { is_end: boolean; next?: string };
};

type AnswerWire = {
  id: number;
  question: { id: number; title: string };
  content: string;
  author: { name: string };
  voteup_count: number;
  comment_count: number;
  created_time: number;
  updated_time?: number;
  url: string;
};

/**
 * Fetch and normalize answers for one question. Paginates internally until
 * the API says is_end or we hit the maxRows cap, whichever comes first.
 */
export async function fetchAnswersForQuestion(
  questionId: string,
  opts: FetchOptions = {},
): Promise<ReadonlyArray<Answer>> {
  const maxRows = opts.maxRows ?? DEFAULT_MAX_ANSWERS;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const scrapedAt = new Date().toISOString();

  const collected: Answer[] = [];
  let offset = 0;

  while (collected.length < maxRows) {
    const limit = Math.min(DEFAULT_PAGE_SIZE, maxRows - collected.length);
    const url =
      `${ZHIHU_API_BASE}/questions/${encodeURIComponent(questionId)}/answers` +
      `?include=content,voteup_count,comment_count,created_time,updated_time` +
      `&limit=${limit}&offset=${offset}&sort_by=default`;

    const page = await fetchJson<AnswerWirePage>(url, fetchImpl);
    for (const row of page.data) {
      collected.push(toAnswer(row, scrapedAt));
      if (collected.length >= maxRows) break;
    }
    if (page.paging.is_end || page.data.length === 0) break;
    offset += page.data.length;
  }

  return collected;
}

function toAnswer(w: AnswerWire, scrapedAt: string): Answer {
  const base: Answer = {
    id: String(w.id),
    questionId: String(w.question.id),
    questionTitle: w.question.title,
    body: stripHtml(w.content),
    authorName: w.author.name,
    upvotes: w.voteup_count,
    commentCount: w.comment_count,
    createdAt: new Date(w.created_time * 1000).toISOString(),
    url: w.url,
    scrapedAt,
  };
  if (w.updated_time !== undefined && w.updated_time !== w.created_time) {
    return { ...base, updatedAt: new Date(w.updated_time * 1000).toISOString() };
  }
  return base;
}

// ---------- comments ----------

type CommentWirePage = {
  data: ReadonlyArray<CommentWire>;
  paging: { is_end: boolean; next?: string };
};

type CommentWire = {
  id: string | number;
  content: string;
  author: { member: { name: string } };
  vote_count: number;
  created_time: number;
  reply_to_author?: { member: { name: string } } | null;
  // 知乎 sometimes returns parent_id at top level, sometimes under a
  // "reply_comment" block. We only read it when present.
  parent_id?: string | number | null;
};

/**
 * Fetch and normalize comments for one answer.
 *
 * Uses the root_comments endpoint, which returns top-level comments first
 * and nested replies as separate rows linked via parent_id.
 */
export async function fetchCommentsForAnswer(
  answerId: string,
  opts: FetchOptions = {},
): Promise<ReadonlyArray<Comment>> {
  const maxRows = opts.maxRows ?? DEFAULT_MAX_COMMENTS;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const scrapedAt = new Date().toISOString();

  const collected: Comment[] = [];
  let offset = 0;

  while (collected.length < maxRows) {
    const limit = Math.min(DEFAULT_PAGE_SIZE, maxRows - collected.length);
    const url =
      `${ZHIHU_API_BASE}/answers/${encodeURIComponent(answerId)}/root_comments` +
      `?order=normal&limit=${limit}&offset=${offset}`;

    const page = await fetchJson<CommentWirePage>(url, fetchImpl);
    for (const row of page.data) {
      collected.push(toComment(row, answerId, scrapedAt));
      if (collected.length >= maxRows) break;
    }
    if (page.paging.is_end || page.data.length === 0) break;
    offset += page.data.length;
  }

  return collected;
}

function toComment(w: CommentWire, answerId: string, scrapedAt: string): Comment {
  const base: Comment = {
    id: String(w.id),
    answerId,
    body: stripHtml(w.content),
    authorName: w.author.member.name,
    upvotes: w.vote_count,
    createdAt: new Date(w.created_time * 1000).toISOString(),
    scrapedAt,
  };
  if (w.parent_id !== undefined && w.parent_id !== null) {
    return { ...base, parentCommentId: String(w.parent_id) };
  }
  return base;
}

// ---------- shared internals ----------

async function fetchJson<T>(url: string, fetchImpl: typeof fetch): Promise<T> {
  const res = await fetchImpl(url, { headers: buildHeaders() });
  if (!res.ok) {
    throw new Error(`zhihu-radar: GET ${url} -> ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

function buildHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": getZhihuUserAgent(),
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    Referer: "https://www.zhihu.com/",
  };
  const cookie = getZhihuCookie();
  if (cookie !== undefined) {
    headers["Cookie"] = cookie;
  }
  return headers;
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
