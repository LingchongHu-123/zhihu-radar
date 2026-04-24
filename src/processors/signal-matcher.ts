// Pure mechanical signal matching. No Claude, no I/O — just substring
// search across an Answer body and its Comment[]. Lives in processors/
// because density is part of the analysis pipeline, not a quality gate
// (validators/) and not a renderer (outputs/).
//
// Two exports:
//   - matchSignals: every keyword hit in body + comments, with span and
//     location, walked in SIGNAL_KINDS_IN_ORDER for determinism.
//   - computeSignalDensity: signals per 1000 chars of combined text. Falls
//     back to 0 below MIN_CHARS_FOR_DENSITY to avoid the "one match in a
//     10-char comment = infinity density" pathology that thresholds.ts
//     warns about.
//
// Overlapping matches are NOT merged. If "加微信" and "加个微信" both
// appear in the same span, both fire — by design: they're different
// keywords, the report wants both receipts, and counting them once would
// require an ordering policy we don't have a strong reason for. If this
// turns out to inflate density numerically, computeSignalDensity is the
// right place to deduplicate (not matchSignals, which is supposed to
// surface every receipt).

import type { Answer, Comment } from "../types/answer.js";
import type { ConversionSignal } from "../types/signal.js";
import { SIGNAL_KEYWORDS, SIGNAL_KINDS_IN_ORDER } from "../config/signals.js";
import { MIN_CHARS_FOR_DENSITY } from "../config/thresholds.js";

/**
 * Find every keyword match across the answer body and each comment.
 * Return order is deterministic: outer loop walks SIGNAL_KINDS_IN_ORDER,
 * then keywords within a kind in their config-file order, then locations
 * (answer-body before each comment, comments in input order). This stable
 * ordering lets snapshot tests pin matches without sorting.
 */
export function matchSignals(
  answer: Answer,
  comments: ReadonlyArray<Comment>,
): ReadonlyArray<ConversionSignal> {
  const out: ConversionSignal[] = [];

  for (const kind of SIGNAL_KINDS_IN_ORDER) {
    for (const keyword of SIGNAL_KEYWORDS[kind]) {
      // Body matches first.
      for (const spanStart of findAllOccurrences(answer.body, keyword)) {
        out.push({
          kind,
          keyword,
          location: { kind: "answer-body", answerId: answer.id },
          spanStart,
          spanEnd: spanStart + keyword.length,
        });
      }
      // Then each comment, in input order.
      for (const comment of comments) {
        for (const spanStart of findAllOccurrences(comment.body, keyword)) {
          out.push({
            kind,
            keyword,
            location: {
              kind: "comment",
              commentId: comment.id,
              answerId: comment.answerId,
            },
            spanStart,
            spanEnd: spanStart + keyword.length,
          });
        }
      }
    }
  }

  return out;
}

/**
 * Compute signals per 1000 chars of combined body+comment text. Returns 0
 * below MIN_CHARS_FOR_DENSITY: a single match in a 30-char comment would
 * otherwise score ~33 signals/1k and dominate any ranking — that's the
 * "infinity density pathology" thresholds.ts calls out.
 */
export function computeSignalDensity(
  signals: ReadonlyArray<ConversionSignal>,
  answer: Answer,
  comments: ReadonlyArray<Comment>,
): number {
  let totalChars = answer.body.length;
  for (const c of comments) totalChars += c.body.length;
  if (totalChars < MIN_CHARS_FOR_DENSITY) return 0;
  return (signals.length * 1000) / totalChars;
}

/**
 * Return the start indices of every non-overlapping occurrence of `needle`
 * in `haystack`. Empty needle returns nothing (a defensive choice — the
 * keyword config should never produce an empty string, but if it ever
 * does we'd rather emit zero matches than infinite zero-length matches).
 */
function findAllOccurrences(
  haystack: string,
  needle: string,
): ReadonlyArray<number> {
  if (needle.length === 0) return [];
  const positions: number[] = [];
  let from = 0;
  while (true) {
    const found = haystack.indexOf(needle, from);
    if (found === -1) break;
    positions.push(found);
    from = found + needle.length;
  }
  return positions;
}
