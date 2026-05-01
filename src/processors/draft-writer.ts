// Claude-backed draft writer. Takes one TopicRanking and returns a
// GeneratedDraft — a Chinese 知乎-style answer aimed at attracting study-
// abroad consulting leads. Drafts are NEVER auto-published; they are
// written to data/drafts/ for human review (the reviewer adds real
// contact info to the CTA line before posting).
//
// Per ADR 002 the prompt is split into a **stable prefix** (system rules
// + writing-style guide + output schema + few-shot examples) and a
// **volatile payload** (this topic's question title + matched signals +
// excerpts from top answers). The stable prefix is marked with
// `cache_control: ephemeral`; subsequent calls with different topics
// hit the cached prefix and bill at ~10%.
//
// Content rules live in the system prompt, NOT in reviewer's head:
//   - Never impersonate a named third party.
//   - No quantitative promises ("保 offer", "100% 录取", 排名承诺).
//   - 3–6 paragraphs, 知乎 register, end with one open-ended CTA line.
//   - Do NOT emit phone/WeChat/QQ/email — the reviewer adds real
//     contact info during human review.
//
// The ClaudeClient / ClaudeRequest / ClaudeResponse / CachedTextBlock
// types are imported from intent-analysis. Both files live in the same
// processors/ layer; sharing the SDK-shaped types (rather than redefining
// them) means runtime/io/claude-client serves both processors with the
// same fetch wrapper.
//
// `now` is an explicit parameter, same pattern as intent-analysis: a
// processor that reads the wall clock can't be pinned to a fixture.

import type { TopicRanking } from "../types/report.js";
import type { GeneratedDraft } from "../types/draft.js";
import type {
  CachedTextBlock,
  ClaudeClient,
  ClaudeRequest,
  ClaudeResponse,
} from "./intent-analysis.js";
import { SIGNAL_KINDS_IN_ORDER } from "../config/signals.js";

// ---------- per-call constants (build-time within a run) ----------

const DRAFT_MODEL = "claude-opus-4-6";
// 4096 leaves room for a 3-6 paragraph 知乎 answer in Chinese, which
// can run ~1500–3500 chars of body plus title and CTA line. If a real
// run consistently truncates, raise here rather than threading per-call.
const DRAFT_MAX_TOKENS = 4096;

// Cap on how many top-answer excerpts we feed in as evidence. More than
// this and the volatile payload bloats the per-call cost without adding
// useful signal — Claude already saw the kinds and density numbers.
const MAX_EXCERPT_ANSWERS = 3;

// Per-excerpt body cap. Same reasoning: enough to convey what readers
// are asking for, not so much we're paying to send the whole thread.
const EXCERPT_BODY_CHARS = 400;

// ---------- system prompt (the stable prefix) ----------

// Single-string constant. Any per-call interpolation here would
// invalidate the cache for every call. ADR 002 invariant.
const SYSTEM_PROMPT = [
  "You are a senior Chinese-language study-abroad advisor drafting a 知乎",
  "answer that attracts genuine readers seeking consulting help. The",
  "reader has a specific question (passed to you in the user message).",
  "Your goal is to write an answer that is *useful first, lead-attracting",
  "second*: a reader should learn something concrete even if they never",
  "contact you.",
  "",
  "Output strictly valid JSON with this exact shape and nothing else:",
  '  {',
  '    "title": string,',
  '    "body": string,',
  '    "ctaLine": string',
  '  }',
  "",
  "Field rules:",
  "- title: a short Chinese hook for the answer, <= 30 characters. 知乎",
  "  doesn't render answer titles, but we use it for filing and to make",
  "  you commit to one thesis before writing the body.",
  "- body: Chinese Markdown, 3–6 paragraphs. Plain prose — no bullet",
  "  spam, no numbered lists masquerading as paragraphs. 知乎 register:",
  "  first-person, conversational, specific. Do NOT include the CTA",
  "  line in the body; it is rendered separately.",
  "- ctaLine: ONE Chinese sentence inviting a private message. Open-",
  "  ended (\"想聊聊可以私信\", \"具体情况私信我说一下\"). Do NOT include any",
  "  phone, WeChat, QQ, email, or other contact identifier — the human",
  "  reviewer fills those in before posting.",
  "",
  "Content safety rules (HARD — drafts that violate these get thrown",
  "out at review):",
  "- Never impersonate or name a specific third party (中介公司、咨询师、",
  "  机构) you don't represent. \"我同事\", \"朋友\", \"以前的学生\" are fine",
  "  if generic; named brands are not.",
  "- Never make quantitative or guaranteed promises: no \"保 offer\",",
  "  \"100% 录取\", \"必上\", 具体排名承诺 (\"上 G5\", \"冲 T10\")，no fee or",
  "  refund guarantees. Soft language only (\"通常\", \"大多数情况下\",",
  "  \"看背景而定\").",
  "- Don't fabricate credentials. Don't claim to have placed students",
  "  at specific schools.",
  "- Stay specific to the question. Generic recruiting copy gets",
  "  downvoted off 知乎.",
  "",
  "Signal categories you may reference when explaining what readers",
  "in this thread are asking for (closed set, do NOT invent new):",
].join("\n");

const FEW_SHOT_EXAMPLE = [
  "Few-shot example (illustrative only — do NOT copy phrasing):",
  "",
  "Topic: 美研 CS 申请 选校信息怎么找最靠谱?",
  "Top signals: recommendation-request (强), contact-request (中)",
  "",
  "Sample title: 美研 CS 选校,信息差比文书重要",
  "",
  "Sample body opening: \"申请这件事最容易踩的坑,是把选校当成排名表勾选",
  "题。我带过的几届里,真正决定结果的不是 USNews 多少名,而是你目标方向",
  "的几个实验室是不是收今年这一届…\"",
  "",
  "Sample CTA: \"如果你想就具体院校组合聊一下,可以私信我说一下你的背景。\"",
].join("\n");

// ---------- public API ----------

/**
 * Build the deterministic stable prefix string. Exposed so tests can
 * assert byte-identical bytes across calls with different topics.
 *
 * Includes: SYSTEM_PROMPT, the SignalKind enum line, then the few-shot
 * example. Nothing here interpolates per-call data.
 */
export function buildDraftStablePrefix(): string {
  const lines: string[] = [SYSTEM_PROMPT];
  for (const kind of SIGNAL_KINDS_IN_ORDER) {
    lines.push(`- ${kind}`);
  }
  lines.push("");
  lines.push(FEW_SHOT_EXAMPLE);
  return lines.join("\n");
}

/**
 * Render the topic ranking into the volatile user-message body. Includes
 * the question title, signal totals (by kind), and short excerpts from
 * the top-N answers as evidence of what readers are actually asking for.
 *
 * Body excerpts are clipped at EXCERPT_BODY_CHARS so we don't pay to
 * send entire threads — Claude only needs enough text to gauge tone.
 */
export function buildDraftVolatilePayload(ranking: TopicRanking): string {
  const parts: string[] = [];
  parts.push(`Question: ${ranking.questionTitle}`);
  parts.push(`Question id: ${ranking.questionId}`);
  parts.push(
    `Analyzed answers: ${ranking.analyzedAnswerCount}, total signals: ${ranking.totalSignalCount}`,
  );
  parts.push(
    `Signal density: ${ranking.signalsPer1kChars.toFixed(2)} per 1k chars`,
  );
  parts.push("Signals by kind:");
  for (const kind of SIGNAL_KINDS_IN_ORDER) {
    parts.push(`  - ${kind}: ${ranking.signalsByKind[kind]}`);
  }

  const excerpts = ranking.topAnswers.slice(0, MAX_EXCERPT_ANSWERS);
  if (excerpts.length === 0) {
    parts.push("");
    parts.push("Top answers: (none)");
  } else {
    parts.push("");
    parts.push(`Top answers (${excerpts.length} excerpts):`);
    let i = 0;
    for (const a of excerpts) {
      parts.push(
        `[Answer #${i}] upvotes=${a.answer.upvotes}, density=${a.signalsPer1kChars.toFixed(2)}, intent=${a.intentSummary === "" ? "(none)" : a.intentSummary}`,
      );
      parts.push(clipBody(a.answer.body));
      i += 1;
    }
  }

  parts.push("");
  parts.push(
    "Write a draft answer for this question. Output JSON exactly as specified.",
  );
  return parts.join("\n");
}

/**
 * Assemble the full Claude request for one draft. System block carries
 * the stable prefix with `cache_control: ephemeral`; the user message
 * carries the volatile per-topic payload.
 */
export function buildDraftRequest(ranking: TopicRanking): ClaudeRequest {
  const systemBlock: CachedTextBlock = {
    type: "text",
    text: buildDraftStablePrefix(),
    cache_control: { type: "ephemeral" },
  };
  const userBlock: CachedTextBlock = {
    type: "text",
    text: buildDraftVolatilePayload(ranking),
  };
  return {
    model: DRAFT_MODEL,
    max_tokens: DRAFT_MAX_TOKENS,
    system: [systemBlock],
    messages: [{ role: "user", content: [userBlock] }],
  };
}

/** Options to `writeDraft`. All fields required — no env-sourced defaults. */
export type DraftOptions = {
  /** Async function that issues the Claude call. Production wiring lives in runtime/. */
  readonly clientImpl: ClaudeClient;
  /** Reference timestamp for `generatedAt`. See file header. */
  readonly now: Date;
};

/**
 * Generate one draft for one TopicRanking. Pipeline:
 *   1. buildDraftRequest + opts.clientImpl — one Claude call.
 *   2. parseDraftResponse — extract title/body/ctaLine from the JSON.
 *   3. assemble GeneratedDraft.
 *
 * Errors from the client propagate; parse errors throw with a slice of
 * the raw response included for debuggability.
 */
export async function writeDraft(
  ranking: TopicRanking,
  opts: DraftOptions,
): Promise<GeneratedDraft> {
  const req = buildDraftRequest(ranking);
  const res = await opts.clientImpl(req);
  const { title, body, ctaLine } = parseDraftResponse(res);
  return {
    questionId: ranking.questionId,
    questionTitle: ranking.questionTitle,
    title,
    body,
    ctaLine,
    modelId: DRAFT_MODEL,
    generatedAt: opts.now.toISOString(),
  };
}

// ---------- response parsing ----------

/**
 * Extract `{ title, body, ctaLine }` from a ClaudeResponse. Same JSON-
 * extraction strategy as intent-analysis: take the slice between the
 * first `{` and the last `}` and parse. Throws with a truncated raw
 * slice on any field error — load-bearing for review, since these
 * three fields are the entire draft.
 */
function parseDraftResponse(res: ClaudeResponse): {
  title: string;
  body: string;
  ctaLine: string;
} {
  const text = res.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");

  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace <= firstBrace) {
    throw new Error(
      `draft-writer: response contained no JSON object. Raw: ${truncate(text, 200)}`,
    );
  }
  const jsonSlice = text.slice(firstBrace, lastBrace + 1);

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonSlice);
  } catch (cause) {
    throw new Error(
      `draft-writer: JSON.parse failed: ${
        cause instanceof Error ? cause.message : String(cause)
      }. Raw slice: ${truncate(jsonSlice, 200)}`,
    );
  }

  if (parsed === null || typeof parsed !== "object") {
    throw new Error(
      `draft-writer: parsed payload is not an object: ${truncate(jsonSlice, 200)}`,
    );
  }
  const obj = parsed as Record<string, unknown>;
  const title = obj["title"];
  const body = obj["body"];
  const ctaLine = obj["ctaLine"];

  if (typeof title !== "string" || title.length === 0) {
    throw new Error(
      `draft-writer: title is not a non-empty string (got ${typeof title})`,
    );
  }
  if (typeof body !== "string" || body.length === 0) {
    throw new Error(
      `draft-writer: body is not a non-empty string (got ${typeof body})`,
    );
  }
  if (typeof ctaLine !== "string" || ctaLine.length === 0) {
    throw new Error(
      `draft-writer: ctaLine is not a non-empty string (got ${typeof ctaLine})`,
    );
  }

  return { title, body, ctaLine };
}

// ---------- helpers ----------

function clipBody(body: string): string {
  const collapsed = body.replace(/\s+/g, " ").trim();
  if (collapsed.length <= EXCERPT_BODY_CHARS) return collapsed;
  return `${collapsed.slice(0, EXCERPT_BODY_CHARS)}…`;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}
