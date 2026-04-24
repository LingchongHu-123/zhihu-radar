// Claude-backed intent analyzer. Takes one Answer + its Comments, returns
// a full AnalyzedAnswer: mechanical signals (via signal-matcher), signal
// density, plus a Claude-produced one-line intent summary, confidence,
// AND any signals that the LLM spotted but the keyword list missed
// ("v我", "在吗", "咋联系" — see ADR 004 for the rationale on splitting
// signals across two sources).
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
import type {
  ConversionSignal,
  SignalKind,
  SignalLocation,
} from "../types/signal.js";
import { SIGNAL_KEYWORDS, SIGNAL_KINDS_IN_ORDER } from "../config/signals.js";
import {
  computeSignalDensity,
  matchSignals,
  mergeSignals,
} from "./signal-matcher.js";

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
// Bumped from 512 → 1024 because the response now carries a
// discoveredSignals array on top of the summary; long threads can blow
// past 512 once Claude lists half a dozen evidence strings.
const DEFAULT_MAX_TOKENS = 1024;

// Maximum discoveredSignals we'll accept from one response. Cap exists
// so a confused LLM can't flood density math with hundreds of low-grade
// candidates. Tune in code if a real run consistently saturates.
const MAX_DISCOVERED_SIGNALS = 32;

// The system instructions. Keeping it a single string constant (not a
// template) is load-bearing: any per-call interpolation here would
// invalidate the cache for every call. If you need per-call context,
// it belongs in the user message, not the system block.
const SYSTEM_PROMPT = [
  "You are an analyst scoring buying intent in Chinese 知乎 (Zhihu) Q&A",
  "threads about studying abroad. For one answer and its comment thread,",
  "produce three things: a one-line Chinese summary of what the readers",
  "(commenters) are trying to buy or get help with, a numeric confidence,",
  "and a list of signal phrases that show the intent — including idiomatic",
  "phrases the keyword list below may have missed.",
  "",
  "Output strictly valid JSON with this exact shape and nothing else:",
  '  {',
  '    "intentSummary": string,',
  '    "intentConfidence": number,',
  '    "discoveredSignals": [',
  '      { "kind": string, "evidence": string, "location": string }',
  '    ]',
  '  }',
  "",
  "Field rules:",
  "- intentSummary: one short Chinese sentence, <= 40 characters.",
  "- intentConfidence: float in [0, 1] (see guide below).",
  "- discoveredSignals: array, may be empty. Each entry MUST be:",
  "    * kind: exactly one of contact-request, recommendation-request,",
  "      payment-intent, dm-pull. Do NOT invent new categories.",
  "    * evidence: a VERBATIM substring copied from the answer body or one",
  "      comment. Do NOT paraphrase, translate, summarize, or reformat.",
  "      If you can't quote it byte-for-byte, leave it out.",
  "    * location: either the literal string \"answer-body\", or",
  "      \"comment-N\" where N is the zero-based index of the comment in",
  "      the volatile payload (the [Comment #N] markers below).",
  "- Do not list a phrase that already appears verbatim in the keyword",
  "  list — those will be matched mechanically. Focus on idiomatic",
  "  variants the list misses (e.g. \"v我\", \"咋联系\", \"在吗\", \"想咨询下\").",
  "",
  "Confidence guide:",
  "- 0.0–0.3: few or ambiguous signals; readers may just be discussing.",
  "- 0.3–0.7: clear interest, specific intent (contact / pay / refer) unclear.",
  "- 0.7–1.0: explicit, repeated buying or contact-seeking signals.",
  "",
  "Treat the signal categories below as a closed set.",
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
 *
 * Comments are tagged with `[Comment #N]` markers so Claude can refer to
 * them by index in `discoveredSignals[].location`. The marker scheme is
 * load-bearing: parseClaudeResponse maps "comment-N" back to the same
 * index, so changing the format here means changing both sides.
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
    let i = 0;
    for (const c of comments) {
      parts.push(`[Comment #${i}] [${c.authorName}] ${c.body}`);
      i += 1;
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
 *   1. matchSignals      — mechanical keyword hits (no network).
 *   2. buildClaudeRequest + opts.clientImpl — one Claude call returning
 *      summary, confidence, and idiomatic-signal candidates.
 *   3. mapDiscoveredSignals — turn each candidate into a ConversionSignal
 *      by locating its evidence text byte-for-byte in body or comments.
 *      Candidates whose evidence isn't found are dropped (Claude
 *      occasionally paraphrases despite the prompt).
 *   4. mergeSignals      — keyword + claude, dedup by overlapping span.
 *   5. computeSignalDensity over the merged set.
 *   6. assemble AnalyzedAnswer.
 *
 * Errors from the client propagate; parse errors throw with the raw
 * response text included (debuggability > prettiness).
 */
export async function analyzeAnswer(
  answer: Answer,
  comments: ReadonlyArray<Comment>,
  opts: AnalyzeOptions,
): Promise<AnalyzedAnswer> {
  const keywordSignals = matchSignals(answer, comments);

  const request = buildClaudeRequest(answer, comments);
  const response = await opts.clientImpl(request);
  const { intentSummary, intentConfidence, discoveredRaw } =
    parseClaudeResponse(response);

  const claudeSignals = mapDiscoveredSignals(discoveredRaw, answer, comments);
  const signals = mergeSignals(keywordSignals, claudeSignals);
  const signalsPer1kChars = computeSignalDensity(signals, answer, comments);

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

/** Internal shape of one entry in the LLM's discoveredSignals array. */
type DiscoveredSignalRaw = {
  readonly kind: string;
  readonly evidence: string;
  readonly location: string;
};

/**
 * Extract `{ intentSummary, intentConfidence, discoveredRaw }` from a
 * ClaudeResponse.
 *
 * We accept either a response whose text blocks are pure JSON, or one
 * that has JSON embedded (Claude sometimes adds a sentence around it
 * despite instructions). In either case we grab the slice between the
 * first `{` and the last `}`.
 *
 * intentSummary / intentConfidence failures throw — they're load-bearing
 * for ranking. discoveredSignals failures are tolerant: if the field is
 * missing, malformed, or contains garbage entries we drop those entries
 * and keep going. Phase C-revisit treats discoveredSignals as bonus
 * recall, not as a contract Claude is forced to honor perfectly.
 */
function parseClaudeResponse(res: ClaudeResponse): {
  intentSummary: string;
  intentConfidence: number;
  discoveredRaw: ReadonlyArray<DiscoveredSignalRaw>;
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
  const discovered = obj["discoveredSignals"];

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

  return {
    intentSummary: summary,
    intentConfidence: confidence,
    discoveredRaw: extractDiscoveredRaw(discovered),
  };
}

/**
 * Defensive extraction: if discoveredSignals is missing or ill-formed,
 * return []. Per-entry validation also drops bad rows silently. This is
 * intentional: the array is bonus recall, not a hard contract.
 */
function extractDiscoveredRaw(value: unknown): ReadonlyArray<DiscoveredSignalRaw> {
  if (!Array.isArray(value)) return [];
  const out: DiscoveredSignalRaw[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const kind = e["kind"];
    const evidence = e["evidence"];
    const location = e["location"];
    if (typeof kind !== "string") continue;
    if (typeof evidence !== "string" || evidence.length === 0) continue;
    if (typeof location !== "string") continue;
    out.push({ kind, evidence, location });
    if (out.length >= MAX_DISCOVERED_SIGNALS) break;
  }
  return out;
}

// ---------- discovered → ConversionSignal mapping ----------

const VALID_KINDS: ReadonlySet<SignalKind> = new Set(SIGNAL_KINDS_IN_ORDER);

/**
 * Turn the LLM's `discoveredSignals` rows into ConversionSignal[]. For
 * each row we:
 *   1. Reject unknown `kind` values (Claude occasionally improvises).
 *   2. Resolve `location` to the answer body or one specific comment.
 *   3. indexOf the evidence string in the resolved source. If missing,
 *      drop the row — paraphrased "evidence" cannot be cited.
 *   4. Build a ConversionSignal with `source: "claude"` and the real
 *      span computed from the indexOf result.
 *
 * Every dropped row is silently dropped; this is recall augmentation,
 * not a strict contract.
 */
function mapDiscoveredSignals(
  rows: ReadonlyArray<DiscoveredSignalRaw>,
  answer: Answer,
  comments: ReadonlyArray<Comment>,
): ReadonlyArray<ConversionSignal> {
  const out: ConversionSignal[] = [];
  for (const row of rows) {
    if (!isSignalKind(row.kind)) continue;
    const resolved = resolveLocation(row.location, answer, comments);
    if (resolved === null) continue;
    const spanStart = resolved.text.indexOf(row.evidence);
    if (spanStart === -1) continue;
    out.push({
      kind: row.kind,
      keyword: row.evidence,
      location: resolved.location,
      spanStart,
      spanEnd: spanStart + row.evidence.length,
      source: "claude",
    });
  }
  return out;
}

function isSignalKind(value: string): value is SignalKind {
  return VALID_KINDS.has(value as SignalKind);
}

/**
 * Resolve the LLM's `location` string ("answer-body" or "comment-N")
 * into the actual source text + a SignalLocation. Returns null when the
 * string is unparseable or the comment index is out of range, so callers
 * can drop the row without per-error logging.
 */
function resolveLocation(
  raw: string,
  answer: Answer,
  comments: ReadonlyArray<Comment>,
): { text: string; location: SignalLocation } | null {
  if (raw === "answer-body") {
    return {
      text: answer.body,
      location: { kind: "answer-body", answerId: answer.id },
    };
  }
  const m = /^comment-(\d+)$/.exec(raw);
  if (m === null || m[1] === undefined) return null;
  const idx = Number.parseInt(m[1], 10);
  const comment = comments[idx];
  if (comment === undefined) return null;
  return {
    text: comment.body,
    location: {
      kind: "comment",
      commentId: comment.id,
      answerId: comment.answerId,
    },
  };
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}
