// Render a TopicReport to a Markdown string. Pure function: no I/O, no
// Claude, no clock reads. Caller (runtime/) is responsible for writing
// the result to disk and for whatever ordering it wants — this module
// renders in the order it receives, which keeps snapshot tests honest.
//
// Determinism rules (load-bearing for snapshot tests; see exec plan
// Phase D):
//   - The ONLY timestamp that appears in the body is `report.date`. We
//     deliberately do not render `report.generatedAt` or any per-answer
//     `analyzedAt` — those move every run and would shred snapshots
//     without telling the reader anything they couldn't get from the
//     filename.
//   - SignalKind iteration uses SIGNAL_KINDS_IN_ORDER, never
//     `Object.keys` (same reason as processors/intent-analysis: insertion
//     order is "fine in practice" but ADR 002 already burned us once on
//     trusting it).
//   - Floats (density, confidence) are emitted via `.toFixed(2)` so
//     binary noise in `0.1 + 0.2`-style results doesn't destabilise.
//   - Ordering: rankings rendered in given order, topAnswers in given
//     order, signals in given order. No internal sort. If the runtime
//     wants a different order, it sorts before calling.
//
// The output ends with exactly one trailing newline. POSIX-friendly,
// `git diff` doesn't whine, snapshots compare cleanly.

import type { AnalyzedAnswer } from "../types/analysis.js";
import type { TopicRanking, TopicReport } from "../types/report.js";
import type { ConversionSignal } from "../types/signal.js";
import { SIGNAL_KINDS_IN_ORDER } from "../config/signals.js";

const BODY_EXCERPT_CHARS = 120;

/** Render the full report. Top-level entry point. */
export function renderTopicReport(report: TopicReport): string {
  const lines: string[] = [];
  lines.push(`# 知乎 Radar — ${report.date}`);
  lines.push("");
  lines.push(
    "> Topics ranked by signal density (matches per 1000 chars of combined body + comment text).",
  );
  lines.push("");

  if (report.rankings.length === 0) {
    lines.push("_(no topics)_");
    return finalise(lines);
  }

  let rank = 0;
  for (const ranking of report.rankings) {
    rank += 1;
    pushTopic(lines, rank, ranking);
    lines.push("");
  }

  return finalise(lines);
}

// ---------- topic block ----------

function pushTopic(out: string[], rank: number, t: TopicRanking): void {
  out.push(`## #${rank} — ${t.questionTitle}`);
  out.push("");
  out.push(`- Question id: \`${t.questionId}\``);
  out.push(`- Analyzed answers: ${t.analyzedAnswerCount}`);
  out.push(`- Total signals: ${t.totalSignalCount}`);
  out.push(`- Signal density: ${formatFloat(t.signalsPer1kChars)} / 1k chars`);
  out.push(`- By kind:`);
  for (const kind of SIGNAL_KINDS_IN_ORDER) {
    out.push(`  - ${kind}: ${t.signalsByKind[kind]}`);
  }
  out.push("");
  out.push(`### Top answers`);
  if (t.topAnswers.length === 0) {
    out.push("");
    out.push("_(no top answers)_");
    return;
  }
  for (const a of t.topAnswers) {
    out.push("");
    pushAnalyzedAnswer(out, a);
  }
}

// ---------- per-answer block ----------

function pushAnalyzedAnswer(out: string[], a: AnalyzedAnswer): void {
  out.push(
    `#### ${a.answer.authorName} — density ${formatFloat(a.signalsPer1kChars)}`,
  );
  out.push(
    `- Upvotes: ${a.answer.upvotes}, comments: ${a.answer.commentCount}`,
  );
  const summary = a.intentSummary === "" ? "_(none)_" : a.intentSummary;
  out.push(
    `- Intent: ${summary} (confidence ${formatFloat(a.intentConfidence)})`,
  );
  out.push(`- URL: ${a.answer.url}`);
  if (a.signals.length === 0) {
    out.push(`- Signals: _(none)_`);
  } else {
    out.push(`- Signals (${a.signals.length}):`);
    for (const s of a.signals) {
      out.push(`  - ${s.kind} \`${s.keyword}\` — ${formatLocation(s)}`);
    }
  }
  const excerpt = excerptBody(a.answer.body);
  if (excerpt.length > 0) {
    out.push(`- Excerpt: ${excerpt}`);
  }
}

// ---------- formatters ----------

function formatLocation(s: ConversionSignal): string {
  return s.location.kind === "answer-body"
    ? "answer body"
    : `comment \`${s.location.commentId}\``;
}

/**
 * Format a non-negative float for display. Two decimals is enough
 * resolution for density and confidence in this report; anything finer
 * is noise the reader can't act on.
 */
function formatFloat(n: number): string {
  return n.toFixed(2);
}

/**
 * Trim and clip an answer body to a single readable line. The body is
 * already HTML-stripped by sources/, so we only need to collapse runs
 * of whitespace (including the `\n` that stripHtml leaves between
 * paragraphs) and cap the length.
 */
function excerptBody(body: string): string {
  const collapsed = body.replace(/\s+/g, " ").trim();
  if (collapsed.length <= BODY_EXCERPT_CHARS) return collapsed;
  return `${collapsed.slice(0, BODY_EXCERPT_CHARS)}…`;
}

/**
 * Collapse trailing blank lines and add exactly one final newline.
 * Centralised so every code path agrees on the end-of-file convention.
 */
function finalise(lines: string[]): string {
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}
