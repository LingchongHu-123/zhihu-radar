# ADR 004: Augment keyword signal matching with Claude-discovered signals

- **Status:** Proposed
- **Date:** 2026-04-24
- **Author:** Intent-analysis recall session

## Context

The pipeline measures buying-intent density by counting `ConversionSignal`
hits in answer bodies and comment threads. Until now those hits were
produced exclusively by `src/processors/signal-matcher.ts` — a mechanical
keyword matcher whose vocabulary is a curated list ("怎么联系", "滴滴",
"求推荐", "私信我", "加个微信", and similar).

Two things have become clear from looking at real fixtures:

- Pure keyword matching has low recall on this domain. 知乎 留学 commenters
  routinely use idiomatic variants — "v我", "咋联系", "在吗", "想咨询下" —
  that no static list catches without an unsustainable arms race.
- Buying-intent comments are sparse to begin with. Missing roughly 30% of
  them shrinks the daily sample below the size needed to support the
  report as a content basis.

Meanwhile `src/processors/intent-analysis.ts` already calls Claude once
per answer for `intentSummary` + `intentConfidence`. The model reads the
full answer and comments in that call. Asking it to *also* surface the
phrases that triggered its judgment is essentially free in token terms —
the input is unchanged and the output grows by a small JSON array.

The pipeline needs higher recall on idiomatic intent without (a) adding a
second model dependency, (b) multiplying request count, or (c) abandoning
the deterministic, byte-precise keyword path that already works.

## Decision

`intent-analysis` now returns `discoveredSignals` alongside the summary
and confidence. The processor's response schema becomes:

```
{
  intentSummary: string,
  intentConfidence: number,
  discoveredSignals: [{ kind, evidence, location }]
}
```

Claude must quote evidence verbatim and reference comments by
`[Comment #N]` index labels embedded in the volatile payload.
Paraphrased or unfindable evidence is dropped silently — `discoveredSignals`
is recall augmentation, not a strict contract.

`signal-matcher` keeps mechanical hits and gains two new responsibilities:

- Tag every mechanical hit with `source: "keyword"` on the existing
  `ConversionSignal` shape (a new optional `source: "keyword" | "claude"`
  field). Claude-discovered signals are tagged `source: "claude"`.
- Expose `mergeSignals(keywordSignals, claudeSignals)` with a
  deterministic dedup policy: when a Claude signal overlaps a keyword
  signal at the same location, the Claude signal is dropped. The keyword
  hit is byte-precise and unambiguously categorized; it always wins ties.
- Expose `confidenceWeightedDensity(rawDensity, intentConfidence)` using
  `density × (FLOOR + (1 - FLOOR) × confidence)` with
  `CONFIDENCE_WEIGHT_FLOOR = 0.3` in `src/config/thresholds.ts`. This
  lets `runtime/` rank topics with Claude's confidence dampening
  keyword-only false positives without zeroing them out.

Caps and limits:

- `MAX_DISCOVERED_SIGNALS = 32` protects the density math against a
  confused LLM flooding the result.
- `DEFAULT_MAX_TOKENS` for the intent-analysis call goes from 512 → 1024
  to fit the new array on long comment threads.

This ADR covers the *strategy*. The merge function, the schema change,
and the weighting helper land as follow-up implementation tasks.

## Consequences

**Positive**

- Recall on idiomatic buying-intent phrases improves at near-zero
  marginal token cost — Claude is already reading the full thread for
  the summary call.
- The deterministic keyword path is preserved. Mechanical hits remain
  free, byte-precise, and unambiguous; the LLM only adds, never replaces.
- Confidence weighting gives `runtime/` a principled way to dampen
  noisy keyword hits in low-confidence answers without throwing them
  away outright.
- The `source` field makes the provenance of each signal inspectable
  downstream — useful for debugging false positives and for any future
  output that wants to show "matched by keyword" vs "found by Claude".

**Negative**

- `discoveredSignals` parsing is tolerant — malformed or unfindable rows
  are dropped silently. We accept lower precision visibility for higher
  recall.
- The `DEFAULT_MAX_TOKENS` bump from 512 → 1024 is a small per-call cost
  increase. Negligible at self-use volume; worth noting.
- Signal counts gain non-determinism. The same answer analyzed twice
  may yield slightly different `discoveredSignals`. This is the
  unavoidable cost of putting an LLM in the count-producing path.
- `src/outputs/markdown-report.ts` does not yet display the `source`
  field per signal. Minor follow-up tweak, not a blocker.

**Neutral**

- The canonical definition of "what counts as a conversion signal"
  becomes a hybrid: the curated keyword list *plus* whatever Claude
  surfaces from the prompt. The keyword list remains the deterministic
  baseline; Claude is additive.

## Alternatives considered

- **Embedding similarity (Voyage / SBERT seed corpus + cosine
  threshold).** Rejected: another runtime dependency (violates
  CLAUDE.md rule 4 without strong justification), threshold tuning is
  finicky, and the per-answer Claude call we already make achieves the
  same recall improvement at zero marginal cost.
- **Two-pass: keyword pre-filter then Claude per-comment.** Rejected:
  per-comment Claude calls would multiply request count by 10–50× per
  answer. The single per-answer call we already make is cheaper *and*
  gives the model surrounding context the per-comment call would lack.
- **Aggressively expand the keyword list.** Done partially (added
  口语 variants), but the long tail of natural-language paraphrase is
  unenumerable. Mechanical lists hit a ceiling fast on this domain.
- **Replace the keyword matcher entirely with the LLM.** Rejected:
  keyword hits are deterministic, byte-precise, and free. Throwing them
  away to depend solely on a non-deterministic LLM is the wrong
  direction — we want LLM as augmentation, not as sole source of truth.

## Revisit if

- Real runs show `discoveredSignals` consistently flooding up to
  `MAX_DISCOVERED_SIGNALS`. That means the cap was wrong, or the
  prompt is too permissive.
- Claude routinely paraphrases evidence and most rows get dropped
  during the verbatim-match check. The prompt needs reinforcement, or
  the schema needs to switch to span-based references rather than
  quoted evidence.
- Noise from Claude-discovered signals exceeds the keyword false-positive
  rate it was meant to fix. At that point we'd want a per-signal
  confidence threshold from Claude, not just a per-answer one.
- The merge dedup policy (keyword always wins) starts losing genuine
  Claude finds because they overlap a keyword hit at the same location
  with a more specific `kind`. Would motivate switching the tie-break
  rule rather than dropping the augmentation.
