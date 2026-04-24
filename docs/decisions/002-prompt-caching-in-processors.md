# ADR 002: Prompt caching in processors

- **Status:** Accepted (implemented in Phase C; cache-friendly prefix invariant pinned by test in `tests/processors/intent-analysis.test.ts`)
- **Date:** 2026-04-22
- **Author:** adr-drafter session

## Context

The `src/processors/` layer sends every scraped 知乎 answer (body +
comment thread) to the Anthropic Claude API to score explicit conversion
signals. A realistic daily run is 50–500 answers; at the upper end, and
especially across many daily runs, this becomes the dominant cost line
of the project.

Most of the prompt sent on each of those calls is identical from one
call to the next:

- system instructions describing the scoring task,
- the JSON output schema,
- the signal-keyword list sourced from `src/config/signals.ts`,
- a small set of few-shot examples.

Only the last chunk — the answer body and its comments — changes between
calls. Without prompt caching, every call pays full input-token price
for the same ~2–3 KB of stable prefix. Anthropic's prompt-caching
feature lets us mark that prefix with `cache_control`; the first call in
a cache window pays full price, and subsequent calls that hit the same
cached prefix pay roughly 10% of normal input cost for those tokens.

For a 100-answer run, that is an expected 60–80% reduction in input-
token cost on the processor layer. For a solo-use CLI where the author
reviews the bill personally, this is the difference between "run it
daily without thinking" and "run it weekly and worry".

## Decision

Every module in `src/processors/` that calls the Anthropic Claude API
must structure its prompt so that:

1. The **stable prefix** — system instructions, output schema, the
   `SIGNAL_KEYWORDS` list from `src/config/signals.ts`, and any
   few-shot examples — is placed first and marked with `cache_control`.
2. The **volatile per-answer payload** — the answer body and its
   comment thread — is appended *after* the cache breakpoint.
3. The serialization of the stable prefix is deterministic. In
   particular, `SIGNAL_KEYWORDS` must be emitted in a stable order
   (source order, not `Object.keys`/`Set` iteration order that could
   shift), and no per-run values (timestamps, request IDs, answer
   counts) may leak into the prefix.

Processor tests must assert cache-friendly structure: given two
different answer payloads, the prefix bytes up to the cache breakpoint
must be byte-identical.

## Consequences

**Positive**

- Predictable, bounded input-token cost per daily run. The first call
  in a run pays full price for the prefix; the remaining N-1 calls pay
  ~10% of that.
- Safe to scale the number of answers per run up without a surprise
  bill — cost grows with the *volatile* payload, not the prefix.
- Forces a clean separation in processor code between "what the model
  always needs to know" and "what we're asking about this time",
  which is independently good for readability.

**Negative**

- Imposes structural discipline on processor code. Any dynamic content
  accidentally injected into the stable prefix (e.g. interpolating a
  current date, shuffling the keyword list, including the answer URL
  in the system block) silently breaks the cache and we pay full price
  with no loud failure.
- Every processor needs tests that pin the prefix bytes. That is extra
  test surface the processors would not otherwise carry.
- Couples processor code to an Anthropic-specific API feature. If we
  ever swap LLM providers, the prefix/volatile split stays useful but
  the `cache_control` annotation has to be redone.

**Neutral**

- The prefix/volatile split maps naturally onto how the prompt wants
  to be written anyway, so the code shape is not distorted by this
  decision — it is mostly formalized.

## Alternatives considered

- **No caching.** Simplest; works fine at <10 answers/run. Rejected
  because the project's whole point is to scan many answers, and input-
  token cost would scale linearly with that count.
- **Batch API (50% discount).** Rejected: the Batch API's 24-hour
  completion window does not fit the "daily report, read it with
  morning coffee" cadence. Caching gives a larger discount *and*
  preserves interactive latency.
- **Dedicated per-run fine-tune.** Rejected: far too heavy for a
  single-author CLI, and the stable prefix is small enough that
  caching closes almost all of the cost gap a fine-tune would.

## Revisit if

- Anthropic changes prompt-caching pricing materially (either direction)
  — the cost math here assumes roughly 10% cached-read pricing.
- We switch primary model and the new model's caching semantics differ.
- We find ourselves consistently running with <10 answers per run; below
  roughly 5 reuses the caching overhead (code complexity + prefix-pinning
  tests) is not worth the savings.
- The stable prefix grows large enough (tens of KB) that we start
  worrying about cache-window eviction between runs — at that point the
  decision is still correct but the operational picture changes.
