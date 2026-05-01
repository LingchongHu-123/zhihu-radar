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

### 2026-05-01 — `MAX_ANSWER_AGE_DAYS=365` rejects ~80% of evergreen 知乎 content
**Context:** First real end-to-end run, Phase F shipped. Scraped
question 52691102 (a 2016 study-abroad meta question), got 5 answers;
analyze rejected 4/5 by quality gate, all on age.
**Symptom:** `analyze: skipped <id> (quality: age N days > MAX_ANSWER_AGE_DAYS (365))`
with N ∈ {713, 1247, 3153, 3319}. The user's own URL pointed at a 713-day-old
answer; that answer had 557 upvotes and 70 comments — exactly the kind of
high-intent thread the product is supposed to surface.
**Root cause:** the threshold was a guess. The reasoning in
`config/thresholds.ts` ("buying intent expressed two years ago is not a
signal that someone is trying to buy *now*") sounds correct but is wrong
for this content type — 知乎's evergreen-ranking surfaces years-old
answers that still attract fresh comments today. The unit-test layer
can't catch this; the constant only fails against real data.
**Fix:** none yet. **Do NOT silently bump the constant** — the right
move is a calibration step (see Retro 001 §B): `pnpm dev calibrate` that
prints age/upvote/length histograms over `data/raw/`, then a human picks
the cutoff. Bumping to 1825 days "to make it work" without measurement
just moves the goalpost.
**Keep in mind:** any threshold that rejects rows is a candidate for
this same trap. `MIN_UPVOTES_FOR_ANALYSIS`, `MIN_BODY_CHARS_FOR_ANALYSIS`,
`MIN_CHARS_FOR_DENSITY` were also picked by feel — none have been
validated against a real distribution.

### 2026-05-01 — Anthropic `credit balance is too low` only surfaces mid-batch
**Context:** Same first-real-E2E run. After quality gate filtered 4/5
answers, analyze fired one Claude call for the surviving answer.
**Symptom:** `Anthropic /v1/messages returned 400: {"type":"error","error":
{"type":"invalid_request_error","message":"Your credit balance is too
low to access the Anthropic API. Please go to Plans & Billing to upgrade
or purchase credits."}}`. analyze counted it as `failed: 1` and exited.
For a multi-answer batch this would mean "spent budget on partial work,
no useful artifact at the end."
**Root cause:** no pre-flight budget check. The CLI happily starts an
N-call batch without verifying account state.
**Fix:** none in code yet. Workaround: top up the Anthropic account
before any analyze/draft run. **Real fix** is a `pnpm dev plan` command
that prints "would call Claude N times for ~\$X, press enter to confirm"
before firing — see Retro 001 §B.
**Keep in mind:** error surfaces with 400 status, NOT 402. Don't string-
match on status code; match on error.message containing "credit balance"
if you ever programmatic-handle it.

### 2026-05-01 — `.env` written by Windows 记事本 silently becomes `.env.txt`
**Context:** First-time setup of `ANTHROPIC_API_KEY`. User created
`.env` via Notepad as instructed.
**Symptom:** `pnpm dev analyze` errored with `ANTHROPIC_API_KEY is not
set`. `ls -la` showed `.env.txt` in the worktree root, no `.env`.
**Root cause:** Windows Notepad defaults to "Save as type: Text Documents
(*.txt)" and silently appends `.txt` even when the user typed `.env` as
the filename. The "Hide extensions for known file types" setting (default
on) makes it look correct in Explorer.
**Fix:** `mv .env.txt .env`. **Long term:** `docs/setup.md` should warn
explicitly and recommend either VS Code / Notepad++ or a one-line shell
write: `echo 'KEY=value' > .env` (note: must run in the directory you
want the file to land in, with single quotes to preserve `$` and `;`).
**Keep in mind:** also relevant for `.gitignore`, `.npmrc`, `.eslintrc`,
any dotfile created via Notepad on Windows.

### 2026-05-01 — `env.ts` error message says "Add it to .env" but project does NOT auto-load .env
**Context:** Same setup attempt. After `mv .env.txt .env` the value still
wasn't visible to `process.env`.
**Symptom:** Variable defined in `.env` (verified by `grep -c KEY .env`),
but `pnpm dev analyze` still threw `ANTHROPIC_API_KEY is not set`.
**Root cause:** `src/config/env.ts:22` says `"ANTHROPIC_API_KEY is not
set. Add it to .env or export it in the shell..."` — but no module in
this project imports `dotenv`. The error message is aspirational, not
factual. `process.env` only sees what the shell exports before the
process starts.
**Fix (this session):** inline-source per command:
`set -a && source .env && set +a && pnpm dev <verb>`. Works for one-off
runs. **Real fix:** EITHER add a minimal dotenv loader (would touch
CLAUDE.md rule 4 — needs an ADR for the new runtime dep), OR change the
error message to drop the .env reference and say "export it before
running."
**Keep in mind:** error-message accuracy is part of the API. A lying
message costs the next user 15 minutes of confused setup.

### 2026-05-01 — 知乎 returns 403 to anonymous requests; cookie required
**Context:** First real `pnpm dev scrape <qid>` attempt.
**Symptom:** `scrape: question <qid> failed: zhihu-radar: GET
https://www.zhihu.com/question/<qid> -> 403 Forbidden`. Followed by a
Windows-specific `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)
... src\\win\\async.c, line 76` exit assertion (harmless noise on
process exit, see prior agent-learnings entry on Windows uv).
**Root cause:** 知乎 wall on un-authenticated SSR document fetches.
Logged-in browsers attach a long cookie string (~1.5 KB) including
`z_c0`, `_xsrf`, etc.; without it the WAF returns 403.
**Fix:** set `ZHIHU_COOKIE` in `.env`. Cookie acquisition: Chrome
DevTools → Network tab → refresh page → click the top
`zhihu.com` document request → Headers → Request Headers → copy the
entire `cookie:` value (single-quote it in `.env` to preserve `;` and
`=`). Stays valid for weeks; refresh when 403s return.
**Keep in mind:** the comment-fetch endpoint
(`/api/v4/comment_v5/...`, see ADR 003) accepts the same cookie. If
scraping starts working but comments are sparse / 403, the cookie
expired — re-grab.

### 2026-04-24 — Windows CRLF silently breaks byte-exact snapshot tests
**Context:** Phase E prep — `pnpm check` was green but `pnpm test` went
red on `tests/outputs/markdown-report.test.ts > matches the bytes in
sample-report.expected.md`. The test is a byte-exact `===` comparison
against a committed fixture file. No code had changed in outputs/
recently.
**Symptom:** `expected false to be true`. `file sample-report.expected.md`
reported `CRLF line terminators`; the renderer emits `\n` only. Also:
fresh worktrees on this machine always show ~47 `.md` / `.mjs` / `.json`
files as "modified" in `git status` with zero content diff under
`git diff --ignore-cr-at-eol` — the phantom-change problem we kept
seeing.
**Root cause:** this machine has `git config --global core.autocrlf=true`,
and the repo had no `.gitattributes`. On checkout, git was silently
turning committed-LF files into CRLF in the working tree. Snapshot
tests compare bytes, so they broke; git status treats size changes as
modifications, hence the phantom "modified" list.
**Fix:** added `.gitattributes` with `* text=auto eol=lf`. But **a
plain `git add --renormalize .` + `git checkout-index -a -f` did not
refresh already-checked-out files** (index and blob were both LF
already; there was nothing for git to "renormalize"). The working-tree
copies had to be rewritten directly. A small node script that reads
the `git ls-files --eol` output and rewrites each `w/crlf` file to LF
in-place is the reliable way. After that, `git status` went empty and
the snapshot test turned green.
**Keep in mind:** `.gitattributes` fixes **future** checkouts, not
existing working-tree files that were put there before the attribute
was in effect. Any Windows contributor onboarding will need either a
fresh clone **or** the node-script trick to normalize in place. Don't
reach for `sed -i` or `dos2unix` on Windows — they may not exist in
Git Bash, and you'll waste time debugging the tool instead of the
actual problem.

### 2026-04-23 — comment_v5 is the one /api/v4 path that isn't walled
**Context:** Phase A followup — fetchCommentsForAnswer needed a source.
The SSR question page never hydrates `entities.comments` in practice
(always `{}`), so comments have to come from some XHR endpoint. After
the 40362 wall on the answer-list endpoint (entry below) the default
expectation was that every `/api/v4/...` path would be similarly gated.
**Symptom:** The obvious candidates were dead ends:
- `GET /question/<qid>/answer/<aid>` (per-answer SSR page): 403 Forbidden
  unauthenticated. Even authenticated the page's
  `entities.comments` / `entities.lineComments` maps stayed empty —
  comments are never hydrated in SSR, period.
- `GET api.zhihu.com/comments_v5/answers/<aid>/root_comment` (mobile
  host): 404 Not Found. That path doesn't live on the mobile API
  host.
**Root cause / finding:** `GET https://www.zhihu.com/api/v4/comment_v5/
answers/<aid>/root_comment?order_by=score&limit=N&offset=` returns a
well-formed `{ data: Comment[], paging: {...}, counts: {...} }`
response with **zero** authentication and **zero** x-zse-96 signature.
This is the one /api/v4 path that isn't behind the 40362 wall.
Kept reproducible by `scripts/probe-comments.ts` + `scripts/capture-comments.ts`.
**Fix:** `fetchCommentsForAnswer` calls `comment_v5`. Pagination
follows `paging.next` until `paging.is_end === true` — **not** until
`next` is absent: `next` is populated even on the last page (it loops
back to the first page's URL), so a naïve "while (next)" loop runs
forever. This is the one pagination invariant worth burning into
muscle memory for this endpoint.
**Keep in mind:** "the wall covers `/api/v4`" is too coarse a model.
The wall covers specifically the answer-list and question-detail
endpoints the web client hits constantly. Second-tier endpoints
(comment_v5 here, probably others) ship unsigned. When a wall blocks
you, probe adjacent paths for a few minutes before reverse-engineering
the signature.

### 2026-04-22 — 知乎 /api/v4 is gated by x-zse-96; use SSR HTML instead
**Context:** Phase A fixture capture. Script hit
`GET https://www.zhihu.com/api/v4/questions/<id>/answers?...` with a valid
session cookie (`z_c0` etc, 1211 chars).
**Symptom:** `403 Forbidden`, body
`{"error":{"message":"您当前请求存在异常，暂时限制本次访问...","code":40362}}`.
Happens on the first request, so it's not rate-limiting.
**Root cause:** 知乎's web client signs every `/api/v4/...` request with an
`x-zse-96` header computed by obfuscated JS (tied to `d_c0` cookie, path,
and body via a rotating HMAC-like scheme). Requests missing that header
— even authenticated ones — are rejected with 40362. Cookie alone is not
sufficient.
**Fix:** switched source strategy to scraping the SSR HTML at
`https://www.zhihu.com/question/<id>` and parsing the
`<script id="js-initialData" type="text/json">...</script>` blob. The JSON
contains `initialState.entities.{answers,questions,users,comments,...}`
with the same entity shapes the API would have returned (camelCase there,
snake_case on the API). No signature needed. See ADR 003.
**Keep in mind:** don't try to "reverse" x-zse-96 — community
implementations break every few months when 知乎 rotates the algorithm,
and attempting it is a signing-reversal task that's worth its own ADR
before you touch it. HTML SSR is the least-galaxy-brained path.

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
