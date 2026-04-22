# Architecture

## The shape

```
        ┌──────────┐
        │  types/  │   pure data shapes
        └────┬─────┘
             │
        ┌────▼─────┐
        │ config/  │   constants, env
        └────┬─────┘
             │
  ┌──────────┼──────────┬───────────┐
  │          │          │           │
┌─▼───┐  ┌───▼────┐ ┌───▼────┐  ┌───▼────┐
│src/ │  │ src/   │ │ src/   │  │ src/   │
│sour-│  │proces- │ │valida- │  │outputs/│
│ces/ │  │ sors/  │ │ tors/  │  │        │
└──┬──┘  └───┬────┘ └───┬────┘  └────┬───┘
   │         │          │            │
   └─────────┴────┬─────┴────────────┘
                  │
             ┌────▼─────┐
             │ runtime/ │   orchestrator / CLI entry
             └──────────┘
```

Arrows point in the direction of allowed imports. The tip of an arrow says
"I may import from there". Siblings have no arrow between them on purpose.

## Why layers at all

This project will grow in fits and starts, mostly at the author's hands with
Claude as pair. The failure mode of small solo projects is not "too rigid";
it is "code that was easy to write becomes impossible to change, because
everything imports everything". Layers are a cheap structural forcing
function that:

1. **Make refactoring safe.** When you want to swap the scraper, you only
   need to re-read `sources/` and `runtime/`. Nothing else can have grown
   fingers into sources.
2. **Make testing obvious.** Each layer is a pure function of its inputs
   (modulo network in `sources/` and Claude in `processors/`). Fixture a
   layer's input, assert its output.
3. **Give Claude (the agent) a narrow job.** When an agent is told "add a new
   processor", the blast radius is bounded. It cannot accidentally rewire the
   scraper or the reporter.

## Why this specific split

- **types/** is the glue. Every layer speaks in terms of the same shapes.
  It is pure so it can be imported everywhere without cycles.
- **config/** is separated from types because a constant ("MIN_UPVOTES = 50")
  is not a type, and because env reads belong somewhere. Keeping config
  downstream of types lets config *return* typed values.
- **sources/** is the only layer that does I/O against 知乎. Isolating it
  means we can cache its output to `data/raw/` and replay without hitting
  the network.
- **processors/** is the only layer that talks to Claude. Isolating it means
  Claude costs are predictable and mockable. A fixture-driven test of a
  processor never spends a cent.
- **validators/** are predicates. They exist because scraped data is messy —
  we need to throw away answers that are too short, too old, too spammy,
  before we pay Claude to analyze them. Keeping them as pure functions on
  already-typed data makes them trivially testable.
- **outputs/** renders. It must be pure so that snapshot tests of reports
  are deterministic.
- **runtime/** is the orchestrator. It is allowed to wire everything. This
  is where the actual CLI commands live: "scrape today", "analyze the
  backlog", "generate last week's report". Keeping orchestration in one
  place is what lets the other layers stay dumb.

## The sibling-non-import rule, specifically

The most load-bearing rule is that `sources/`, `processors/`, `validators/`,
`outputs/` are all at the same "level" and **none of them may import from
any other**. This rule feels annoying in the moment — "I just want my
processor to call a validator once, it's right there" — but the cost of
letting it happen is enormous: within a few weeks, every layer imports
every other, and the "layering" exists only on paper.

If you feel the pull to cross siblings:

- You probably want the orchestration to move up. Have `runtime/` call
  the validator first, then pass the validated-or-null result into the
  processor.
- Or the shared piece is actually a type or a constant. Move it down into
  `types/` or `config/`.
- Or you've found a genuine gap in the architecture. In that case, write an
  ADR in `docs/decisions/` and propose a new layer or a new utility module.
  Do not silently bend the rule.

## What lives outside src/

- **tests/** — Vitest tests and fixtures. May import from `src/` freely;
  `src/` may not import from `tests/`.
- **data/raw/** — scraped-but-unprocessed pages. Gitignored.
- **data/processed/** — structured output of processors. Gitignored.
- **data/reports/** — generated reports. Gitignored (the interesting ones
  get committed explicitly when we want to keep a dated snapshot).
- **docs/** — this file and its siblings.
- **.claude/** — agent definitions and slash commands. Not code.

## On growth

When a layer starts to feel crowded, split it by domain, not by role. For
example, when `sources/` grows beyond the first 知乎 scraper, the next
files are `sources/zhihu-answers.ts`, `sources/zhihu-comments.ts` — not
`sources/fetcher.ts` and `sources/parser.ts`. Domain-split preserves the
"one file, end-to-end" mental model. Role-split hides the domain and
forces you to jump between files to understand one thing.
