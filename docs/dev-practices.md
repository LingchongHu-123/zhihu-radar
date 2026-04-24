# Dev practices — zhihu-radar

This file catalogs the engineering practices used in this project that
proved out during Phase A–D (April 2026). It exists as **source material**
for a future "standardized project template" the author plans to distill
later. Treat this as a snapshot, not a template — it captures what
worked HERE, before any cross-project generalization.

Scope is deliberately narrow: **architecture, quality gates, git**.
Workflow / agent-collaboration / decision-recording practices live in
their own files (`CLAUDE.md`, the ADRs in `docs/decisions/`,
`docs/agent-learnings.md`) and are not duplicated here.

---

## 1. Architecture & code shape

### 1.1 Strict one-way layering, mechanically enforced

```
types/  →  config/  →  { sources, processors, validators, outputs }  →  runtime/
```

- A lower layer never imports from a higher one.
- Each rule is enforced by `dependency-cruiser`, not honor system. See
  `.dependency-cruiser.cjs` — every `forbidden` rule has a `comment`
  field explaining WHY and HOW to fix violations.
- Full rationale: `docs/architecture.md`.

**Why:** the rule answers "where does this new code go?" without
debate. Without mechanical enforcement, layering decays inside three
months.

### 1.2 Sibling isolation (the load-bearing rule)

Within the parallel layer (`sources` / `processors` / `validators` /
`outputs`), siblings cannot import each other. Cross-sibling
orchestration belongs in `runtime/` only.

**Why:** lets you swap, cache, or test any sibling independently. If
you can't, the abstraction is wrong — fix the abstraction, not the
import.

### 1.3 Pure functions wherever possible; side effects pushed to runtime

- `types/` is pure (no behavior).
- `config/` is pure (constants + lazy env reads as functions, never
  top-level reads).
- `validators/`, `processors/`, `outputs/` are pure transformers.
- `runtime/` is the ONLY layer allowed to do I/O, network, or FS.

**Why:** every layer except runtime is fixture-testable without mocks.

### 1.4 Dependency injection over implicit globals

Three knobs every async-ish module exposes via an options parameter:

| Knob | Default in production | Default in tests |
|---|---|---|
| `fetchImpl` | global `fetch` | stub returning fixture HTML |
| `clientImpl` (LLM) | required, no default — Phase E will pick SDK or fetch wrapper | mock function returning canned `ClaudeResponse` |
| `now: Date` | passed in by caller (runtime supplies a single batch-wide value) | fixed `new Date("2026-04-23T00:00:00Z")` |

**Why:** every dependency is visible at the call site. No hidden globals,
no surprise mocks, no test-suite-wide setup that diverges from
production wiring. The `now`-as-parameter rule especially: a function
that reads the wall clock can't be pinned to a fixture.

The one accepted exception: `sources/zhihu-answers.ts` reads
`new Date().toISOString()` for `scrapedAt` because the scrape itself
is the wall-clock event being recorded. Tests there assert "scrapedAt
within 60s of now" rather than pinning to a fixed value.

### 1.5 No new runtime dependencies without justification

dev-deps are cheap; runtime deps ship and become maintenance burden.
Every runtime dep must answer "could this be done in 50 lines instead?"
before being added. Examples held to this:

- HTML parsing: regex + `JSON.parse` instead of a DOM library (kept
  the SSR scraper dep-free; see ADR 003).
- LLM: `clientImpl` injection deferred adding `@anthropic-ai/sdk` until
  Phase E forces the wiring decision.

---

## 2. Quality gates

### 2.1 Single check command, must be green before any commit

`pnpm check` = `tsc --noEmit` + `eslint .` + `dep-cruise`. No exceptions.
Not "almost green", not "one warning". Pre-commit hook
(`.claude/hooks/stop-check.mjs`) enforces it mechanically.

**Why:** a single gate prevents the 100-warning slow rot. When every
check is mandatory, you fix problems immediately instead of
accumulating.

### 2.2 Strict TypeScript — fix the code, never the config

`tsconfig.json` has `strict: true`, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`, `noImplicitOverride`. When tsc complains,
the answer is always to fix the code, never to downgrade strictness.

**Why:** each strictness setting catches a real class of bug.
Downgrading to silence errors moves them to runtime, where they cost
more.

### 2.3 Tests against real fixtures, not fabricated shapes

- 知乎 wire data: a real SSR blob is captured once, sanitized, and
  committed under `tests/fixtures/zhihu/` (see ADR 003 + Phase A).
- Composed types: inline construction in the test is fine, but only if
  it matches what real callers produce.

**Why:** tests against fabricated shapes pass while production fails.

### 2.4 Zero network in tests

If a src module makes network calls, it accepts an injectable client
(`fetchImpl` or `clientImpl`); the test passes a stub. A test that
hits the real network is a failed test by definition.

**Why:** tests must be deterministic, fast, runnable offline, and
unaffected by upstream outages.

### 2.5 Snapshot via committed file, not vitest's `.snap`

For deterministic renderers (e.g. `outputs/markdown-report.ts`), the
expected output is a real `.md` (or `.json`, `.txt`) file under
`tests/fixtures/.../expected.*`. The test reads it via `readFileSync`
and `===` compares.

**Why:** you can `cat` the file to see what your renderer produces.
The committed file IS the spec — it survives clones, reviews cleanly
in PRs, and the author can update it intentionally. Vitest's `.snap`
files are an opaque side-effect of running tests; they don't review
well and nobody opens them.

### 2.6 Don't silence errors

Banned in this repo:

- `// eslint-disable` to dodge a lint
- Editing a `.dependency-cruiser.cjs` rule to dodge a violation
- `--no-verify` to dodge a hook
- Loosening tsconfig strictness to dodge a type error

**Why:** silencing is debt. The error is the diagnostic; the fix is
upstream. If you genuinely think a rule is wrong, write an ADR
arguing the case before changing the rule.

---

## 3. Git & commits

### 3.1 SSH only, never HTTPS

Remote: `git@github.com:LingchongHu-123/zhihu-radar.git`. HTTPS to
github.com fails the TLS handshake on this machine (see
`docs/agent-learnings.md`). Never `http.sslVerify=false`, never embed
a PAT in the remote URL. Full rules: `docs/git-workflow.md`.

### 3.2 Ask before push, every batch

A previous "push" approval doesn't carry to the next batch of commits.
Before any `git push`, run:

```
git status --short
git log --oneline origin/<branch>..HEAD
```

…show the output, wait for explicit "push" (or equivalent) from the
human.

**Why:** the cost of asking is one sentence; the cost of an unwanted
push can be lost work or a public mistake.

### 3.3 Conventional commits — write WHY, not WHAT

Prefixes: `feat`, `fix`, `docs`, `chore`, `test`, optional scope:
`feat(processors):`, `chore(harness):`. Subject one line. Body
(optional, after a blank line) explains the motivation. The diff IS
the WHAT — the message is for the future reader who is wondering WHY.

**Why:** in six months you won't care what changed; you'll care why
it was worth changing. A "what" message makes a six-month-old commit
useless; a "why" message makes it teach.

### 3.4 One concern per commit

- A new types file + a new config file + a new scraper = three
  commits, not one.
- A rename across eight files = one commit. (Renames are one concern.)

**Why:** bisect, revert, and review all break down when commits bundle
unrelated work. Phase B + ADR + Phase C in one commit means you can't
revert just Phase C without losing the ADR.

### 3.5 No skipping hooks, no force-pushing main

`--no-verify`, `--force` to `main`: never without explicit human OK.
If a hook fails, fix the underlying issue. The hook is the safety net,
not an obstacle.

### 3.6 Co-Authored-By for agent-authored commits

```
Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
```

**Why:** provenance. `git blame` then distinguishes agent vs human
work, which matters for both audit and "who do I ask about this code".

---

## What's NOT in this file (and where to find it)

| Topic | Lives in |
|---|---|
| Project policy / non-negotiables | `CLAUDE.md` |
| The full layered architecture rationale | `docs/architecture.md` |
| Architectural decisions (the "why we picked X over Y") | `docs/decisions/NNN-*.md` |
| Non-obvious gotchas + their root cause + fix | `docs/agent-learnings.md` |
| Git workflow specifics (full rules, escape valves) | `docs/git-workflow.md` |
| Subagent definitions + their hard boundaries | `.claude/agents/*.md` |
| In-progress work, layer status, build order | `docs/exec-plans/active/*.md` |

---

## When this file is wrong

This snapshot was written after Phase D. If practices change (new ADR,
new tooling, new rule), update this file in the same commit as the
change. A practices doc that lags reality is worse than no doc — it
tells future-you a confident lie.
