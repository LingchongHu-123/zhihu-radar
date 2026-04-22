# Git workflow for zhihu-radar

This file exists so that every future agent session starts knowing the same
rules without the human having to re-paste them. The memory system
(`~/.claude/projects/.../memory/`) also has this info, but memory is
machine-local and would be lost if the repo is cloned elsewhere. **The repo
is the source of truth.**

## Repo facts

- **Remote:** `git@github.com:LingchongHu-123/zhihu-radar.git` (SSH only)
- **Main branch:** `main`
- **Default user SSH key:** `~/.ssh/id_ed25519` (already registered with
  GitHub on this machine)

## Hard rules

1. **SSH only, never HTTPS.** This machine's HTTPS-to-github.com channel
   fails the TLS handshake. See `docs/agent-learnings.md` entry
   `2026-04-22 — push over HTTPS fails on this machine` for the full post-mortem.
   - If `git remote -v` ever shows `https://...`, restore it to
     `git@github.com:LingchongHu-123/zhihu-radar.git`.
   - **Never** `git config http.sslVerify false`.
   - **Never** embed a PAT in the remote URL.
   - **Never** `git push --no-verify` or bypass any signing/hook flag.

2. **Never push without an explicit human go-ahead.**
   Before `git push`, always run these first and show the output:
   ```
   git status --short
   git diff --stat origin/main..HEAD
   ```
   Then wait for the user to say "push" (or equivalent). Do not push
   preemptively even if the commits look clean.

3. **`pnpm check` must be green before any commit.**
   This is also CLAUDE.md rule 3 and is enforced mechanically by the Stop
   hook (`.claude/hooks/stop-check.mjs`) and by the pre-commit flow.
   No exceptions — if check is red, fix the code, not the rule.

4. **Commit messages use conventional prefixes.**
   - `feat:` new capability
   - `fix:` bug fix
   - `chore:` tooling / housekeeping (hooks, gitignore, deps)
   - `docs:` docs-only change
   - Optional scope in parentheses: `feat(sources): …`, `chore(harness): …`
   - **One line, explaining *why* not *what*.** The diff shows what.
     The message should tell a future reader why this change was worth
     making. Body (optional, after a blank line) may add context.
   - Include the `Co-Authored-By: Claude Opus …` trailer when the agent
     authored the change, per standing Claude Code convention.

5. **Commit scope: one concern per commit.**
   - A new types file + a new config file + a new scraper is three
     commits, not one. Future you will thank current you when bisecting
     or reverting.
   - Conversely: a rename across 8 files is *one* commit — that's one
     concern.

6. **If a push fails, stop and ask the human.**
   Do not try alternative credentials, do not switch the remote, do not
   paper over the error. The last time an agent "just tried HTTPS", it
   cost a day of debugging. See the agent-learnings entry.

## Verification commands

Any of these is safe to run at any time:

```
ssh -T git@github.com     # should print: Hi LingchongHu-123! ...
git remote -v             # should show two lines, both git@github.com:...
git status --short
git log --oneline -5
```

## Why these rules exist (one paragraph)

The rules above look bureaucratic for a solo project, but each one comes
from a specific past failure. HTTPS was tried and broke. Auto-push
happened and pushed something unintended. Commit messages written as
"what" (rather than "why") became useless three months later. Each rule
is a learned reflex to a real past mistake. A future agent reading this
should understand: these aren't rituals; they're scars.

## When in doubt

`docs/agent-learnings.md` has dated narratives for the specific incidents
that shaped these rules. Read it if any rule here feels arbitrary — the
incident entry will explain the cost that justified the rule.
