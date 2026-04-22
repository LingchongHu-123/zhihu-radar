# Agent Learnings

A running log of non-obvious gotchas encountered while working on this
project. Future-you and future agents should skim this **before** starting
a session, and **append to it** after resolving anything non-trivial.

## How to use this file

- **Read it first.** If you are about to debug an error, check whether a
  past session has already solved it.
- **Append, don't rewrite.** Each entry is dated and scoped. Don't delete
  entries unless they are provably wrong; mark them `[OBSOLETE]` instead.
- **Keep entries short.** One paragraph of context, one paragraph of fix.
  If an entry needs more than that, it probably deserves its own doc in
  `docs/` or an ADR in `docs/decisions/`.

## What belongs here vs elsewhere

- **Architectural decisions** → `docs/decisions/` (ADRs).
- **How-tos that are always true** → `docs/architecture.md` or CLAUDE.md.
- **Gotchas, version quirks, "this looked like X but was actually Y"** →
  here.

## Entry format

```
### YYYY-MM-DD — Short title
**Context:** what you were trying to do
**Symptom:** what went wrong (exact error or observation)
**Root cause:** the real reason
**Fix:** what worked
**Keep in mind:** (optional) the general principle worth remembering
```

---

<!-- New entries go below this line, most recent first. -->
