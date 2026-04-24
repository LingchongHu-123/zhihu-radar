# Exec Plan 001 — Buildout of the remaining layers

**Status:** Active
**Opened:** 2026-04-22
**Owner:** any agent that picks this up in a future session

## Why this file exists

Session-local Plan/Todo state dies with the session. An agent that opens this
repo cold tomorrow has no way to know what was being worked on, what the
priority order is, or what "done" means for each layer. This file is that
source of truth. **Read before picking up any non-trivial work.**

If you finish a phase, mark it done here. If you change the plan, record why
in the Decisions log at the bottom.

## Current layer status

```
types/       ██████████ 100% answers + comments carved from real fixtures
config/      █████████░ 90%  signals/thresholds/env all present
sources/     ██████████ 100% both fetchers implemented + tested against real fixtures
validators/  ░░░░░░░░░░ 0%   next phase (Phase B)
processors/  ░░░░░░░░░░ 0%   (ADR 002 sets the caching rule)
outputs/     ░░░░░░░░░░ 0%
runtime/     ██░░░░░░░░ 20%  (placeholder cli.ts only)
tests/       ██████░░░░ 60%  sources covered; validators/processors/outputs/runtime still 0
```

## Build order (do not skip)

The data flows `sources → validators → processors → outputs`. Build in
**that** order, not in the order that looks easy. Reason: each layer's
definition of "done" depends on feeding real artifacts from the layer below.
Skipping order means re-working later.

### Phase A — freeze real-data ground truth (prereq for everything)

**Goal:** one real 知乎 fixture pinned in `tests/fixtures/zhihu/`, so every
downstream layer is tested against real shapes, not imagined shapes.

Steps:

1. `pnpm dev` against one study-abroad question id, capture both
   `fetchAnswersForQuestion` and `fetchCommentsForAnswer` raw responses.
2. Save raw JSON under `tests/fixtures/zhihu/question-<id>-answers.json`
   and `-comments.json`. These are committed (they're public 知乎 data, no
   secrets). Sanitize author handles if any look identifying.
3. Delegate to `type-carver`: have it reconcile `AnswerWire` /
   `CommentWire` in `src/sources/zhihu-answers.ts` against the real fixture.
4. Delegate to `test-scribe`: write vitest tests for
   `fetchAnswersForQuestion` and `fetchCommentsForAnswer` using the fixture
   + a `fetchImpl` stub. Assert pagination termination, wire→domain mapping,
   and HTML-strip correctness.

**Definition of done:** fixture files exist, `pnpm test` passes with at
least 6 assertions across the two fetchers, `pnpm check` still green.

### Phase B — validators/

**Goal:** a pure-function predicate for each quality gate in
`src/config/thresholds.ts`.

Files to create:

- `src/validators/answer-quality.ts` — returns `{ ok: true } | { ok: false,
  reasons: ReadonlyArray<string> }`. Gates: MIN_UPVOTES_FOR_ANALYSIS,
  MIN_BODY_CHARS_FOR_ANALYSIS, MAX_ANSWER_AGE_DAYS.

Tests live next to types-level fixtures (re-use Phase A).

**Definition of done:** every threshold constant in `config/thresholds.ts`
is read by exactly one validator; each predicate has at least one "pass"
and one "reject" test case.

### Phase C — processors/

**Goal:** one processor that takes an `Answer + Comment[]` and returns an
`AnalyzedAnswer`, backed by the Claude SDK with prompt caching per ADR 002.

Files to create:

- `src/processors/intent-analysis.ts` — the Claude-backed analyzer.
- `src/processors/signal-matcher.ts` — pure keyword-matching using
  `SIGNAL_KEYWORDS`. No Claude call.

**Caching structure (non-negotiable, see ADR 002):** system prompt + output
schema + `SIGNAL_KEYWORDS` serialization goes before the `cache_control`
breakpoint; per-answer body goes after. The test suite MUST include an
assertion that the request payload sent to the SDK has a `cache_control`
marker on the stable prefix. This is how we keep the ADR honest.

**Definition of done:** the processor round-trips a fixture answer to a
mocked Claude call and returns a valid `AnalyzedAnswer`; a separate test
asserts the payload structure is cache-friendly.

### Phase D — outputs/

**Goal:** render a `TopicReport` to a human-readable artifact and pin the
format with snapshot tests.

Files to create:

- `src/outputs/markdown-report.ts` — renders a `TopicReport` to a
  Markdown file. Deterministic: no timestamps in the body except the
  report's own `date` field, no randomness, stable ordering.

**Definition of done:** a `TopicReport` fixture renders to the same
Markdown on re-run; snapshot test passes; the file would be readable by
the author in a terminal.

### Phase E — runtime/

**Goal:** the actual CLI commands that wire the layers together.

Files to create (`src/runtime/` is the only place that may import across
sibling layers):

- `src/runtime/commands/scrape.ts` — reads a list of question ids, calls
  `sources/`, writes raw artifacts under `data/raw/`.
- `src/runtime/commands/analyze.ts` — reads `data/raw/`, passes each
  answer through `validators/` then `processors/`, writes results to
  `data/processed/`.
- `src/runtime/commands/report.ts` — reads `data/processed/`, groups by
  topic, calls `outputs/`, writes the daily report.
- `src/runtime/cli.ts` — stays small; dispatches to the commands above.

## Definition of "this plan is done"

- Every layer status bar above is 100%.
- A single `pnpm dev scrape … && pnpm dev analyze && pnpm dev report` run
  produces a report file in `data/reports/`.
- `pnpm check` + `pnpm test` both green.

When all three are true, move this file to `docs/exec-plans/completed/`
with a closing note.

## Decisions log

<!-- append-only. dated decisions that changed the plan. -->

- 2026-04-22 (opened) — Initial plan drafted after types/, config/, and
  sources/ landed. Order is sources → validators → processors → outputs
  because each downstream layer depends on the shape of the upstream's
  fixtures; building out-of-order means re-work.
- 2026-04-23 — Phase A (including its comments followup) closed.
  Answers fixture + comments-page1/last fixtures pinned under
  `tests/fixtures/zhihu/`; `ZhihuAnswerWire` + `ZhihuCommentWire` +
  envelope types carved from real samples; both `fetchAnswersForQuestion`
  (SSR parse) and `fetchCommentsForAnswer` (`/api/v4/comment_v5`, the
  one un-walled API path — see ADR 003 amendment) ship with 19 contract
  tests. `pnpm check` + `pnpm test` green. Next entry point is Phase B.
