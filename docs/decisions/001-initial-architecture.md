# ADR 001: Initial layered architecture

- **Status:** Accepted
- **Date:** 2026-04-22
- **Author:** initial scaffolding session

## Context

zhihu-radar is a solo-author CLI tool, but a significant fraction of the
code will be written by Claude as pair. Two anti-patterns are likely:

1. **Spaghetti from Claude.** Without structural guardrails, an agent told to
   "add feature X" will reach for whatever import gets the job done today,
   gradually turning the project into a mesh where every module depends on
   every other.
2. **Fake layering.** Writing "keep it clean" in CLAUDE.md and trusting
   agents to honor it does not work. Rules that are not mechanically
   enforced are not rules.

We need a shape that (a) makes the common pipeline obvious, (b) lets each
piece be tested in isolation, and (c) is checked by a tool that blocks
commits, not by goodwill.

## Decision

Adopt a strict one-directional layered architecture under `src/`:

```
types → config → { sources, processors, validators, outputs } → runtime
```

- `types/` depends on nothing.
- `config/` depends only on `types/`.
- `sources/`, `processors/`, `validators/`, `outputs/` each depend only on
  `types/` and `config/`, and **must not import from each other**.
- `runtime/` is the orchestrator and may import from any layer. It is the
  only place where cross-layer wiring is legal.

Enforcement is mechanical, via `dependency-cruiser`, with each forbidden
rule carrying a `comment` field that explains why the rule exists and what
to do if it fires. `pnpm check` runs tsc + eslint + dependency-cruiser and
is the single green-light gate.

## Consequences

**Positive**

- The blast radius of any single change is bounded by layer. An agent
  adding a processor cannot accidentally rewrite the scraper.
- Each non-runtime layer is a pure function of its input, trivially
  unit-testable with fixtures.
- A new contributor (future us) can read `types/` + `runtime/` and
  reconstruct the whole pipeline without spelunking every file.

**Negative**

- Occasional friction: "I just want to call a validator from a processor"
  is forbidden; the orchestration has to move up into `runtime/`.
- There is real overhead to keeping `docs/architecture.md` and
  `.dependency-cruiser.cjs` in sync. We accept this cost: the
  `.dependency-cruiser.cjs` comments ARE the docs, effectively.

**Neutral**

- Splits within a layer will be by domain (e.g. `sources/zhihu-answers.ts`,
  `sources/zhihu-comments.ts`), not by technical role (no
  `sources/fetcher.ts` + `sources/parser.ts`).

## Alternatives considered

- **Flat `src/`, no layers.** Rejected: works for a weekend project, not
  for something we want to evolve over months with an agent's help.
- **Hexagonal/ports-and-adapters.** Rejected: too much ceremony for a
  single-author CLI. We may revisit if the tool ever grows a second
  deployment target (e.g. a web dashboard).
- **Feature-folders (`src/features/topic-analysis/`…).** Rejected for now
  because the pipeline is small and linear; feature folders hide the
  pipeline shape. If we grow to multiple pipelines, reconsider.

## Revisit if

- We add a second data source beyond 知乎 — the split between "scraping
  logic" and "知乎-specific parsing" might need its own layer.
- We find ourselves writing orchestration code inside `runtime/` that is
  hundreds of lines long — that's a sign `runtime/` itself needs internal
  structure.
- Agent sessions repeatedly hit the sibling-import wall for the *same*
  legitimate reason — that's a signal the architecture is wrong, not that
  the agent is wrong.
