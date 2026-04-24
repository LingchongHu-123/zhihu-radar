// Claude-backed intent analyzer. Takes one Answer + its Comments, returns
// a full AnalyzedAnswer: mechanical signals (via signal-matcher), signal
// density, plus a Claude-produced one-line intent summary and confidence.
//
// Per ADR 002 the prompt is split into a **stable prefix** (system +
// output schema + SIGNAL_KEYWORDS in SIGNAL_KINDS_IN_ORDER) and a
// **volatile payload** (this answer's body + comments). The stable prefix
// is marked with `cache_control: ephemeral`; Anthropic bills subsequent
// calls at ~10% for the cached tokens. The prefix MUST be byte-identical
// across runs with different answers — that invariant is pinned by tests
// and documented in ADR 002.
//
// No @anthropic-ai/sdk runtime dependency yet (Phase C decision: defer
// the SDK question to Phase E once we know what wiring the CLI actually
// needs). Callers pass in a `clientImpl` function; tests pass a mock,
// Phase E will decide between the official SDK and a thin fetch wrapper.
//
// `now` is an explicit parameter, same pattern as validators/answer-quality:
// a processor that reads the wall clock can't be pinned to a fixture.

import type { Answer, Comment } from "../types/answer.js";
import type { AnalyzedAnswer } from "../types/analysis.js";
import { SIGNAL_KEYWORDS, SIGNAL_KINDS_IN_ORDER } from "../config/signals.js";
import { computeSignalDensity, matchSignals } from "./signal-matcher.js";

// ---------- request/response shapes (SDK-compatible, locally defined) ----------

/**
 * One text block in Anthropic's content-block format, optionally marked
 * as a cache breakpoint. We use the block-of-blocks form everywhere (not
 * the bare-string shortcut) because only blocks carry `cache_control`.
 */
export type CachedTextBlock = {
  readonly type: "text";
  readonly text: string;
  readonly cache_control?: { readonly type: "ephemeral" };
};

/**
 * The subset of Anthropic's `messages.create` params we actually produce.
 * Shaped to drop straight into `@anthropic-ai/sdk` if/when Phase E adds it.
 */
export type ClaudeRequest = {
  readonly model: string;
  readonly max_tokens: number;
  readonly system: ReadonlyArray<CachedTextBlock>;
  readonly messages: ReadonlyArray<{
    readonly role: "user";
    readonly content: ReadonlyArray<CachedTextBlock>;
  }>;
};

/**
 * The subset of Anthropic's response we read. Minimal on purpose — the
 * SDK returns a lot more (stop_reason, usage, id, ...) but none of it
 * feeds into AnalyzedAnswer. Tests can construct this shape trivially.
 */
export type ClaudeResponse = {
  readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }>;
};

/** A client is just a function taking the request to a response. */
export type ClaudeClient = (req: ClaudeRequest) => Promise<ClaudeResponse>;

// ---------- constants that go into the stable prefix ----------

// Model and max_tokens live in the request (volatile at the protocol
// level), but we treat them as build-time constants within a run. If
// they ever need to be tuned per-call, route the override through
// AnalyzeOptions rather than threading it through the prefix.
const DEFAULT_MODEL = "claude-opus-4-6";
const DEFAULT_MAX_TOKENS = 512;

// The system instructions. Keeping it a single string constant (not a
// template) is load-bearing: any per-call interpolation here would
// invalidate the cache for every call. If you need per-call context,
// it belongs in the user message, not the system block.
const SYSTEM_PROMPT = [
  "You are an analyst scoring buying intent in Chinese 知乎 (Zhihu) Q&A",
  "threads about studying abroad. For one answer and its comment thread,",
  "emit a one-line Chinese summary of what the readers (commenters) are",
  "actually trying to buy or get help with, plus a numeric confidence.",
  "",
  "Output strictly valid JSON with this exact shape and nothing else:",
  '  { "intentSummary": string, "intentConfidence": number }',
  "- intentSummary: one short Chinese sentence, <= 40 characters.",
  "- intentConfidence: float in [0, 1].",
  "",
  "Confidence guide:",
  "- 0.0–0.3: few or ambiguous signals; readers may just be discussing.",
  "- 0.3–0.7: clear interest, specific intent (contact / pay / refer) unclear.",
  "- 0.7–1.0: explicit, repeated buying or contact-seeking signals.",
  "",
  "Treat the signal categories below as a closed set. Do not invent new",
  "categories; do not quote the keywords verbatim in your summary.",
].join("\n");

// ---------- public API ----------

/**
 * Build the deterministic stable prefix. Exposed so tests can assert the
 * same bytes come out for two different answers.
 */
export function buildStablePrefix(): string {
  const lines: string[] = [SYSTEM_PROMPT, "", "Signal categories (closed set):"];
  for (const kind of SIGNAL_KINDS_IN_ORDER) {
    lines.push(`- ${kind}: ${SIGNAL_KEYWORDS[kind].join(", ")}`);
  }
  return lines.join("\n");
}

/**
 * Render one answer + its comments into the volatile user message body.
 * Everything in here may differ call-to-call; nothing in here is cached.
 */
export function buildVolatilePayload(
  answer: Answer,
  comments: ReadonlyArray<Comment>,
): string {
  const parts: string[] = [];
  parts.push(`Question: ${answer.questionTitle}`);
  parts.push(`Answer by ${answer.authorName} (upvotes: ${answer.upvotes}):`);
  parts.push(answer.body);
  if (comments.length > 0) {
    parts.push("");
    parts.push(`Comments (${comments.length}):`);
    for (const c of comments) {
      parts.push(`- [${c.authorName}] ${c.body}`);
    }
  } else {
    parts.push("");
    parts.push("Comments: (none)");
  }
  return parts.join("\n");
}

/**
 * Assemble the full Claude request for one answer. The system block is
 * the stable prefix marked with `cache_control: ephemeral`; the user
 * message is the volatile per-answer payload with no cache marker.
 */
export function buildClaudeRequest(
  answer: Answer,
  comments: ReadonlyArray<Comment>,
): ClaudeRequest {
  return {
    model: DEFAULT_MODEL,
    max_tokens: DEFAULT_MAX_TOKENS,
    system: [
      {
        type: "text",
        text: buildStablePrefix(),
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: buildVolatilePayload(answer, comments) }],
      },
    ],
  };
}

/** Options to `analyzeAnswer`. All fields are required — no env-sourced defaults. */
export type AnalyzeOptions = {
  /**
   * Async function invoked with the Claude request. Production wiring
   * lives in runtime/ (Phase E); tests pass a mock. Required so every
   * caller makes the wiring visible.
   */
  readonly clientImpl: ClaudeClient;
  /** Reference timestamp for `analyzedAt`. See file header for rationale. */
  readonly now: Date;
};

/**
 * Analyze one answer + its comments. Pipeline:
 *   1. matchSignals     — mechanical keyword hits (no network).
 *   2. computeSignalDensity — signals/1k chars.
 *   3. buildClaudeRequest + opts.clientImpl — Claude for intent summary.
 *   4. parse the JSON response, assemble AnalyzedAnswer.
 *
 * Errors from the client propagate; parse errors throw with the raw
 * response text included (debuggability > prettiness).
 */
export async function analyzeAnswer(
  answer: Answer,
  comments: ReadonlyArray<Comment>,
  opts: AnalyzeOptions,
): Promise<AnalyzedAnswer> {
  const signals = matchSignals(answer, comments);
  const signalsPer1kChars = computeSignalDensity(signals, answer, comments);

  const request = buildClaudeRequest(answer, comments);
  const response = await opts.clientImpl(request);
  const { intentSummary, intentConfidence } = parseClaudeResponse(response);

  return {
    answer,
    comments,
    signals,
    signalsPer1kChars,
    intentSummary,
    intentConfidence,
    analyzedAt: opts.now.toISOString(),
  };
}

// ---------- response parsing ----------

/**
 * Extract `{ intentSummary, intentConfidence }` from a ClaudeResponse.
 *
 * We accept either a response whose text blocks are pure JSON, or one
 * that has JSON embedded (Claude sometimes adds a sentence around it
 * despite instructions). In either case we grab the first balanced
 * top-level object.
 *
 * Every failure throws; silent defaults here would contaminate rankings.
 */
function parseClaudeResponse(res: ClaudeResponse): {
  intentSummary: string;
  intentConfidence: number;
} {
  const text = res.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");

  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace <= firstBrace) {
    throw new Error(
      `intent-analysis: response contained no JSON object. Raw: ${truncate(text, 200)}`,
    );
  }
  const jsonSlice = text.slice(firstBrace, lastBrace + 1);

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonSlice);
  } catch (cause) {
    throw new Error(
      `intent-analysis: JSON.parse failed: ${
        cause instanceof Error ? cause.message : String(cause)
      }. Raw slice: ${truncate(jsonSlice, 200)}`,
    );
  }

  if (parsed === null || typeof parsed !== "object") {
    throw new Error(
      `intent-analysis: parsed payload is not an object: ${truncate(jsonSlice, 200)}`,
    );
  }
  const obj = parsed as Record<string, unknown>;
  const summary = obj["intentSummary"];
  const confidence = obj["intentConfidence"];

  if (typeof summary !== "string") {
    throw new Error(
      `intent-analysis: intentSummary is not a string (got ${typeof summary})`,
    );
  }
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) {
    throw new Error(
      `intent-analysis: intentConfidence is not a finite number (got ${String(confidence)})`,
    );
  }
  if (confidence < 0 || confidence > 1) {
    throw new Error(
      `intent-analysis: intentConfidence ${confidence} outside [0, 1]`,
    );
  }

  return { intentSummary: summary, intentConfidence: confidence };
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}
