# CLAUDE.md — zhihu-radar

## Project Overview

CLI tool. Scrapes 知乎 study-abroad answers, measures density of explicit
conversion signals (e.g. "怎么联系", "滴滴", "求推荐", "私信我", "加个微信") in
answer bodies and comment threads, and produces a daily report ranking topics
by how hard readers are actually trying to buy. Self-use.

## Tech Stack

- Node 20+, TypeScript (strict, NodeNext), pnpm, Vitest, dependency-cruiser,
  ESLint (flat config). Anthropic Claude API is the only LLM.

## Build & Commands

- `pnpm check` — typecheck + lint + architecture check. Must pass before any
  commit. This is the single gate.
- `pnpm test` — Vitest once. `pnpm test:watch` for dev.
- `pnpm depcruise` — architecture check alone; run when diagnosing a
  dependency-cruiser failure without the noise of tsc/eslint.
- `pnpm dev -- <args>` — run CLI via tsx (no compile step).

## Architecture

Strict layered, one-way only:

```
types → config → { sources, processors, validators, outputs } → runtime
```

- `src/types/` — data shapes. Depends on nothing.
- `src/config/` — constants, env reads. Depends only on types.
- `src/sources/` — 知乎 scrapers. Raw-data producers. Depends on types+config.
- `src/processors/` — Claude-based analysis. Pure transformers. Depends on types+config.
- `src/validators/` — quality predicates. Depends on types+config.
- `src/outputs/` — report renderers. Depends on types+config.
- `src/runtime/` — the ONLY layer allowed to orchestrate across siblings.

**Siblings (sources/processors/validators/outputs) must not import each
other.** This is mechanically enforced by `.dependency-cruiser.cjs`. Read
`docs/architecture.md` for the why.

## Non-Negotiable Rules

1. **Never bypass the layering.** If you're tempted to import a sibling, the
   orchestration belongs in `runtime/`. Move it up, don't sideways.
2. **Never edit `.dependency-cruiser.cjs` to silence a failure.** The rule
   exists for a reason (read the comment). Refactor the code instead. If you
   are truly convinced the rule is wrong, record an ADR in `docs/decisions/`
   first, then change the rule.
3. **`pnpm check` must be green before declaring any task done.** Not "almost",
   not "just one warning" — green.
4. **No new runtime dependencies without asking the user.** Dev deps are
   cheap; runtime deps ship.
5. **No network calls in tests.** Scrapers and Claude calls are mocked with
   fixture data stored under `tests/fixtures/`.
6. **No secrets in code.** API keys read from env only. `.env` is gitignored.
7. **Windows-first.** The author runs PowerShell. Prefer pnpm scripts over
   shell one-liners; if you must write shell, use cross-platform node scripts.

## When You Hit An Error

1. **Read the error.** dependency-cruiser errors quote the rule's `comment`
   field — it tells you why the rule exists and how to fix it.
2. **Check `docs/agent-learnings.md`.** If a past agent hit this same wall,
   the fix is likely recorded there.
3. **Don't silence.** Don't add `// eslint-disable`, don't loosen the
   dependency-cruiser rule, don't downgrade tsc strictness. Fix the code.
4. **If stuck after 2 attempts, stop and ask the user.** Don't spiral.
5. **After resolving a non-obvious error, append a short note to
   `docs/agent-learnings.md`** so the next agent doesn't re-walk the same path.

## Pointers

- `docs/architecture.md` — full rationale for the layering.
- `docs/decisions/` — ADRs. Read before changing architectural shape.
- `docs/agent-learnings.md` — accumulated gotchas from prior sessions.
- `.dependency-cruiser.cjs` — mechanical rules with inline comments.
