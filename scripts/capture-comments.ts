// One-shot: capture the comments of one 知乎 answer from the web v5 endpoint
// and save both the first page and the last page as fixtures under
// tests/fixtures/zhihu/. Phase A followup of
// docs/exec-plans/active/001-buildout.md.
//
// Why this endpoint: `/api/v4/comment_v5/answers/<aid>/root_comment` is the
// only one of the three probed paths that returns real comment JSON without
// an x-zse-96 signature and without a session cookie (see
// scripts/probe-comments.ts for the receipts). Response shape looks like:
//   { data: [...], paging: { is_end, next, totals, ... }, counts: {...} }
//
// We save two pages:
//   - page 1:   `offset=`
//   - last page: followed by `paging.next` repeatedly until `paging.is_end`.
//     We fetch all pages but only PERSIST page 1 and the final page —
//     enough to pin (a) the shape, (b) how the last page signals
//     termination, without committing tens of kilobytes of mid-pages to
//     git.
//
// Sanitization: same as capture-fixture.ts — replace `author.member.name`
// (and `url_token` style fields) with stable anonymised hashes so the
// fixture doesn't publish real display names. Everything else byte-for-byte.
//
// Run:
//   pnpm exec tsx scripts/capture-comments.ts <aid>
//   default aid = 2543422324 (has 24 comments in our question fixture)
//
// Output:
//   tests/fixtures/zhihu/answer-<aid>-comments-page1.json
//   tests/fixtures/zhihu/answer-<aid>-comments-last.json

import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { createHash } from "node:crypto";

const DEFAULT_AID = "2543422324";
const ENDPOINT_BASE = "https://www.zhihu.com/api/v4/comment_v5/answers";
// kept in sync with the pagination the frontend uses; makes our fixture
// look like an ordinary first-page request, and is small enough to keep
// the checked-in fixture bytes reasonable
const LIMIT = 10;
// hard stop so a misbehaving endpoint can't walk us into the weeds; 24
// comments at limit=10 is 3 pages, so 20 pages is generous
const MAX_PAGES = 20;

function buildHeaders(): Record<string, string> {
  const ua =
    process.env["ZHIHU_USER_AGENT"] ??
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
  const h: Record<string, string> = {
    "User-Agent": ua,
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    Referer: "https://www.zhihu.com/",
  };
  const cookie = process.env["ZHIHU_COOKIE"];
  if (cookie !== undefined && cookie !== "") {
    h["Cookie"] = cookie;
  }
  return h;
}

type Paging = {
  readonly is_end: boolean;
  readonly next?: string;
  readonly totals?: number;
};

type Page = {
  readonly data: readonly unknown[];
  readonly paging: Paging;
  readonly [k: string]: unknown;
};

async function fetchPage(url: string): Promise<Page> {
  console.log(`[capture-comments] GET ${url}`);
  const res = await fetch(url, { headers: buildHeaders() });
  if (!res.ok) {
    throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as Page;
  if (!Array.isArray(body.data) || typeof body.paging !== "object") {
    throw new Error(`malformed page: ${JSON.stringify(body).slice(0, 200)}`);
  }
  return body;
}

function anon(s: string): string {
  return "user-" + createHash("sha256").update(s).digest("hex").slice(0, 8);
}

// Swap string values of a few identifying keys with stable hashes.
// Same rules as capture-fixture.ts: only `name`, `url_token`, `urlToken`,
// and `headline` (the free-text bio is often a handle). Structure preserved.
function sanitize(node: unknown): unknown {
  if (node === null || node === undefined) return node;
  if (Array.isArray(node)) return node.map(sanitize);
  if (typeof node === "object") {
    const src = node as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(src)) {
      if (
        (k === "name" || k === "url_token" || k === "urlToken" || k === "headline") &&
        typeof v === "string" &&
        v !== ""
      ) {
        out[k] = anon(v);
      } else {
        out[k] = sanitize(v);
      }
    }
    return out;
  }
  return node;
}

async function main(): Promise<void> {
  const aid = process.argv[2] ?? DEFAULT_AID;
  const firstUrl = `${ENDPOINT_BASE}/${aid}/root_comment?order_by=score&limit=${LIMIT}&offset=`;

  const first = await fetchPage(firstUrl);
  console.log(
    `[capture-comments] page 1: data=${first.data.length} is_end=${first.paging.is_end} totals=${first.paging.totals ?? "?"}`,
  );

  let last: Page = first;
  let page = 1;
  while (!last.paging.is_end && last.paging.next !== undefined && page < MAX_PAGES) {
    page += 1;
    last = await fetchPage(last.paging.next);
    console.log(
      `[capture-comments] page ${page}: data=${last.data.length} is_end=${last.paging.is_end}`,
    );
  }

  if (page === 1) {
    console.log(
      `[capture-comments] NOTE: answer has only one page — "last" fixture will be identical to page1.`,
    );
  }

  const page1Out = resolve(`tests/fixtures/zhihu/answer-${aid}-comments-page1.json`);
  const lastOut = resolve(`tests/fixtures/zhihu/answer-${aid}-comments-last.json`);
  mkdirSync(dirname(page1Out), { recursive: true });

  writeFileSync(page1Out, JSON.stringify(sanitize(first), null, 2) + "\n", "utf8");
  console.log(`[capture-comments] wrote ${page1Out}`);

  writeFileSync(lastOut, JSON.stringify(sanitize(last), null, 2) + "\n", "utf8");
  console.log(`[capture-comments] wrote ${lastOut}`);

  console.log(`[capture-comments] done.`);
}

main().catch((err) => {
  console.error(`[capture-comments] FAILED:`);
  console.error(err);
  process.exit(1);
});
