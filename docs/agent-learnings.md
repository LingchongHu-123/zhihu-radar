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

### 2026-04-22 — after moving the project folder, reinstall deps
**Context:** repo was moved with `mv` from one parent directory to another.
`pnpm check` had been green before the move.
**Symptom:** `error TS2688: Cannot find type definition file for 'node'`
even though `@types/node` is listed in `package.json` and `node_modules/`
appears to still exist in the new location.
**Root cause:** pnpm uses a content-addressable store and links packages
into `node_modules/` via hard-links / junctions whose resolution assumes
the project's original path. Moving the project breaks those links; the
directory tree looks right but `require.resolve`-style lookups fail.
`pnpm install` in-place refuses to fix it without a TTY to confirm the
purge (`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`).
**Fix:** from the project root, `rm -rf node_modules` then
`CI=true pnpm install`. (The `CI=true` env is what tells pnpm "no TTY is
coming, proceed non-interactively".)
**Keep in mind:** whenever you relocate a pnpm project, the dependency
tree has to be rebuilt. Don't trust that `node_modules/` "came with" the
move.

### 2026-04-22 — `src/runtime/cli.ts` is a load-bearing stub; do not delete
**Context:** initial scaffolding, no business code written yet, ran `pnpm check`.
**Symptom:** `error TS18003: No inputs were found in config file 'tsconfig.json'.
Specified 'include' paths were ["src/**/*.ts"]`. `pnpm check` fails before
eslint or depcruise even run.
**Root cause:** `tsc` refuses to run when its `include` matches zero files,
and there is no flag to opt out of this (no `--allowEmptyInput` or similar).
As long as `src/` has at least one `.ts` file, the check passes.
**Fix:** keep `src/runtime/cli.ts` — a 6-line stub that is literally
`export {};` plus a comment. It is already referenced by the `dev` script
and is exempt from the orphan rule (see `.dependency-cruiser.cjs` no-orphans
`pathNot`). If you "clean up" this file, `pnpm check` will start failing
with TS18003 on any fresh clone where nobody has written real runtime code
yet.
**Keep in mind:** a file that looks empty isn't necessarily dead. Before
deleting anything that seems unused, check whether the toolchain depends on
its existence (not its contents).

### 2026-04-22 — push over HTTPS fails on this machine; use SSH
**Context:** first push of the scaffolding commit to
`github.com/LingchongHu-123/zhihu-radar`.
**Symptom:** `fatal: 基础连接已经关闭: 未能为 SSL/TLS 安全通道建立信任关系`
followed by `fatal: could not read Username for 'https://github.com'`
(no `/dev/tty` in the sandboxed shell, so even a credential prompt dies).
**Root cause:** the Git-for-Windows CA bundle in this environment doesn't
chain cleanly to GitHub's cert (possibly corporate MITM, possibly just a
stale bundle). Separately, GitHub deprecated password auth in 2021, so the
HTTPS flow wouldn't have worked anyway.
**Fix:** the remote is configured as SSH
(`git@github.com:LingchongHu-123/zhihu-radar.git`). The SSH key at
`~/.ssh/id_ed25519` is already registered with the GitHub account. SSH
doesn't involve TLS trust and doesn't need a terminal prompt, so it works.
**DO NOT "fix" this by setting `http.sslVerify=false` or embedding a PAT
in the remote URL** — both are security anti-patterns. If SSH ever breaks,
install `gh` CLI and run `gh auth login` instead.
**Keep in mind:** when a secure channel fails, diagnose; don't disable the
security check to make the error go away.

### 2026-04-22 — dependency-cruiser v17 schema is stricter than v16
**Context:** authoring `.dependency-cruiser.cjs`, copied a `no-deprecated-core`
rule pattern from older tutorials.
**Symptom:** `ERROR: The supplied configuration is not valid: data/forbidden/N/to
must NOT have additional properties, ... must have required property 'reachable',
... must match exactly one schema in oneOf.`
**Root cause:** v17 tightened the rule-body schema. Properties that were
tolerated in v16 (e.g. putting `deprecationStatus` alongside
`dependencyTypes: ["core"]`) now cause validation failure. Each rule's `to`
must match exactly one sub-schema.
**Fix:** for deprecated-module detection in v17, use
`to: { dependencyTypes: ["deprecated"] }` as the sole matcher. For the
initial scaffold we removed the rule entirely; re-add it only when we
actually start consuming Node core APIs.
**Keep in mind:** when adding dep-cruiser rules, cross-check against the
installed version's JSON schema, not against blog posts — dep-cruiser has
had several breaking schema revisions.
