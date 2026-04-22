// One-shot: capture a 知乎 question page's embedded SSR state and save it
// as a fixture under tests/fixtures/zhihu/. Phase A of
// docs/exec-plans/active/001-buildout.md.
//
// Why HTML instead of /api/v4/...: 知乎's JSON API requires an x-zse-96
// signature header that's computed by obfuscated browser JS. Without it,
// /api/v4 returns 403 + error 40362 ("您当前请求存在异常") even with a
// valid session cookie. The question page at /question/<id> has no such
// gate — it's server-rendered HTML with the first batch of answers
// pre-serialized into <script id="js-initialData">. That blob contains
// the same entity shapes the API would have returned (answers, users,
// questions), so it's a drop-in replacement for our source-of-truth
// purposes. Pagination beyond the first batch is a separate problem for
// later (Phase E) — for Phase A we only need one real fixture to pin
// types and write tests against.
//
// Run:    pnpm exec tsx scripts/capture-fixture.ts [questionId]
//         (default 19551648)
// Env:    ZHIHU_COOKIE       — required. Anonymous HTML still loads but
//                              with very little data and often a login wall.
//         ZHIHU_USER_AGENT   — optional override.
//
// Output:
//   tests/fixtures/zhihu/question-<id>-initialData.json
//     full raw js-initialData JSON (sanitized: user.name and user.urlToken
//     replaced with stable hashes; everything else byte-for-byte).
//
// This script exists outside tsconfig's rootDir / eslint scope / depcruise
// scope, so `pnpm check` does not evaluate it. tsx runs it directly.

import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { createHash } from "node:crypto";

const DEFAULT_QUESTION_ID = "19551648";

function buildHeaders(): Record<string, string> {
  const cookie = process.env["ZHIHU_COOKIE"];
  const ua =
    process.env["ZHIHU_USER_AGENT"] ??
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
  const h: Record<string, string> = {
    "User-Agent": ua,
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Upgrade-Insecure-Requests": "1",
  };
  if (cookie !== undefined && cookie !== "") {
    h["Cookie"] = cookie;
  }
  return h;
}

async function fetchQuestionHtml(questionId: string): Promise<string> {
  const url = `https://www.zhihu.com/question/${questionId}`;
  console.log(`[capture] GET ${url}`);
  const res = await fetch(url, { headers: buildHeaders() });
  if (!res.ok) {
    throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  }
  return await res.text();
}

// The SSR blob is injected as:
//   <script id="js-initialData" type="text/json">{...}</script>
// The JSON is HTML-unescaped already (the script tag's CDATA-ish semantics
// let 知乎 skip escaping), though </script> inside strings is escaped to
// \u003c/script\u003e. So plain JSON.parse works.
function extractInitialData(html: string): unknown {
  const match = html.match(
    /<script[^>]*id=["']js-initialData["'][^>]*>([\s\S]*?)<\/script>/,
  );
  if (match === null || match[1] === undefined) {
    throw new Error(
      "js-initialData script tag not found. Page may be a login wall or captcha interstitial.",
    );
  }
  return JSON.parse(match[1]);
}

function anon(s: string): string {
  return "user-" + createHash("sha256").update(s).digest("hex").slice(0, 8);
}

// Recursively walk the SSR tree and replace identifying fields in place.
// We only swap string values of `name` and `urlToken` (a.k.a. `url_token`)
// — types and structure are preserved, so the type-carver sees reality.
function sanitize(node: unknown): unknown {
  if (node === null || node === undefined) return node;
  if (Array.isArray(node)) {
    return node.map((item) => sanitize(item));
  }
  if (typeof node === "object") {
    const src = node as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(src)) {
      if ((key === "name" || key === "urlToken" || key === "url_token") &&
          typeof value === "string" && value !== "") {
        out[key] = anon(value);
      } else {
        out[key] = sanitize(value);
      }
    }
    return out;
  }
  return node;
}

// Best-effort readout of entity counts so we know what we actually got
// before handing off to type-carver / test-scribe. Doesn't fail if the
// shape is unexpected — just prints what it finds.
function summarize(data: unknown): void {
  if (data === null || typeof data !== "object") {
    console.log(`[capture] WARN: initialData is not an object`);
    return;
  }
  const root = data as Record<string, unknown>;
  console.log(`[capture] top-level keys: ${Object.keys(root).join(", ")}`);

  // Common 知乎 SSR paths, try both
  const initialState =
    (root["initialState"] as Record<string, unknown> | undefined) ??
    (root as Record<string, unknown>);
  const entities =
    (initialState["entities"] as Record<string, unknown> | undefined) ??
    (root["entities"] as Record<string, unknown> | undefined);

  if (entities === undefined) {
    console.log(`[capture] WARN: no 'entities' sub-tree found`);
    return;
  }

  console.log(`[capture] entities keys: ${Object.keys(entities).join(", ")}`);
  const answers = entities["answers"];
  if (answers !== null && typeof answers === "object") {
    const ids = Object.keys(answers as Record<string, unknown>);
    console.log(`[capture] answers: ${ids.length}`);
    if (ids.length > 0) {
      console.log(`[capture] sample answer ids: ${ids.slice(0, 5).join(", ")}`);
    }
  }
  const questions = entities["questions"];
  if (questions !== null && typeof questions === "object") {
    console.log(
      `[capture] questions: ${Object.keys(questions as Record<string, unknown>).length}`,
    );
  }
  const users = entities["users"];
  if (users !== null && typeof users === "object") {
    console.log(
      `[capture] users: ${Object.keys(users as Record<string, unknown>).length}`,
    );
  }
  const comments = entities["comments"];
  if (comments !== null && typeof comments === "object") {
    console.log(
      `[capture] comments: ${Object.keys(comments as Record<string, unknown>).length}`,
    );
  }
}

async function main(): Promise<void> {
  const questionId = process.argv[2] ?? DEFAULT_QUESTION_ID;
  const authenticated =
    process.env["ZHIHU_COOKIE"] !== undefined && process.env["ZHIHU_COOKIE"] !== "";

  console.log(
    `[capture] question=${questionId} authenticated=${authenticated}`,
  );
  if (!authenticated) {
    console.log(
      `[capture] WARNING: no ZHIHU_COOKIE set. HTML may be a login wall.`,
    );
  }

  const html = await fetchQuestionHtml(questionId);
  console.log(`[capture] HTML size: ${html.length} bytes`);

  const raw = extractInitialData(html);
  const sanitized = sanitize(raw);
  summarize(sanitized);

  const outPath = resolve(
    `tests/fixtures/zhihu/question-${questionId}-initialData.json`,
  );
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(sanitized, null, 2) + "\n", "utf8");
  console.log(`[capture] wrote ${outPath}`);
  console.log(`[capture] done.`);
}

main().catch((err) => {
  console.error(`[capture] FAILED:`);
  console.error(err);
  process.exit(1);
});
