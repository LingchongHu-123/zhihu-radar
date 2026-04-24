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
types/       ████████░░ 80%  shapes defined, not validated against real data
config/      █████████░ 90%  signals/thresholds/env all present
sources/     ████░░░░░░ 40%  written, zero tests, zero real-data fixtures
validators/  ░░░░░░░░░░  0%
processors/  ░░░░░░░░░░  0%  (ADR 002 sets the caching rule)
outputs/     ░░░░░░░░░░  0%
runtime/     ██░░░░░░░░ 20%  (placeholder cli.ts only)
tests/       ░░░░░░░░░░  0%  no fixtures, no tests
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

### Phase F — draft generation (content marketing loop)

**Goal:** turn each high-intent `TopicRanking` into a 知乎-style Chinese
answer draft aimed at attracting study-abroad consulting leads. Output
lands under `data/drafts/` as Markdown, to be human-reviewed before any
publication. **This is a new layer's worth of work, not a tweak to
outputs/** — it introduces a second Claude-backed processor and its own
output renderer.

Files to create:

- `src/types/draft.ts` — `GeneratedDraft` shape: questionId the draft
  answers, title, body (Markdown), open-ended CTA line, model id,
  `generatedAt`.
- `src/processors/draft-writer.ts` — Claude-backed. Input: one
  `TopicRanking`. Output: `GeneratedDraft`. ADR 002 prompt-caching
  rules apply: writing-style rules + output schema + few-shot examples
  go before the `cache_control` breakpoint; topic-specific payload
  (question title + top answers excerpt + matched signals) after.
- `src/outputs/markdown-draft.ts` — deterministic renderer of
  `GeneratedDraft` to a Markdown file under `data/drafts/`. Filename
  convention: `draft-<questionId>-<YYYY-MM-DD>.md`.
- `src/runtime/commands/draft.ts` — reads the day's `TopicReport` (or
  `AnalyzedAnswer` batch) from `data/processed/`, picks top N topics
  by density, calls `draft-writer` on each, writes results via
  `markdown-draft`.

**Content rules (encoded in draft-writer's system prompt, not in
reviewer's head):**

- Never impersonate a named third party; never invent credentials.
- No quantitative promises ("保 offer", "100% 录取", 排名承诺).
- Chinese, 知乎 register, 3–6 paragraphs, one open-ended CTA line at
  the end (designed to invite a private message — **do not** emit
  phone/WeChat/QQ; the human review step adds real contact info).
- Write as an experienced advisor sharing perspective, not as a sales
  pitch.

**Caching structure (non-negotiable, ADR 002 applied):** the
style-rules + few-shot block must be byte-identical across two draft
runs with different topics. Test covers this, same shape as Phase C.

**Definition of done:**

- `pnpm dev draft` against a fixture `TopicReport` produces a readable
  Markdown file in `data/drafts/`.
- draft-writer round-trips a fixture topic to a mocked Claude call and
  returns a valid `GeneratedDraft`; a separate test pins the stable
  prefix bytes.
- markdown-draft has a snapshot test that stays green on re-run.
- `pnpm check` + `pnpm test` both green.

## Definition of "this plan is done"

- Every layer status bar above is 100% **including Phase F's new
  files**.
- A single `pnpm dev scrape … && pnpm dev analyze && pnpm dev report`
  run produces a report file in `data/reports/`.
- `pnpm dev draft` produces at least one Markdown draft in
  `data/drafts/` from that same analyzed batch.
- `pnpm check` + `pnpm test` both green.

When all four are true, move this file to `docs/exec-plans/completed/`
with a closing note.

## Decisions log

<!-- append-only. dated decisions that changed the plan. -->

- 2026-04-22 (opened) — Initial plan drafted after types/, config/, and
  sources/ landed. Order is sources → validators → processors → outputs
  because each downstream layer depends on the shape of the upstream's
  fixtures; building out-of-order means re-work.
- 2026-04-23 — Phase F (draft generation) added. Product goal: convert
  the intent-radar's output into a lead-attraction content pipeline for
  study-abroad consulting. Kept as a new phase rather than folding into
  outputs/: the draft writer calls Claude, and outputs/ is deliberately
  pure-render-only. Content-safety rules (no impersonation, no numeric
  promises, no embedded contact info) live in draft-writer's system
  prompt so they're centrally reviewable rather than scattered.
