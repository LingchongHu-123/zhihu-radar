#!/usr/bin/env node
// Stop hook: runs `pnpm check` before the main agent yields to the user.
//
// Behavior:
//   - pnpm check passes => exit 0 silently, Stop proceeds normally.
//   - pnpm check fails  => emit {"decision":"block","reason":"..."} JSON
//                          on stdout so Claude Code reopens the turn with
//                          the failure fed back into the agent's context.
//   - We ourselves always exit 0. "Non-blocking" in the session-health
//     sense: a broken harness should never manifest as a crashed hook.
//
// This exists because CLAUDE.md mandates `pnpm check` as the single gate
// before declaring any task done. Mechanizing it here removes the agent's
// ability to forget.

import { spawnSync } from "node:child_process";

const projectDir = process.env["CLAUDE_PROJECT_DIR"] ?? process.cwd();

const result = spawnSync("pnpm", ["check"], {
  encoding: "utf8",
  shell: true, // needed on Windows so pnpm.cmd resolves
  cwd: projectDir,
});

if (result.status === 0) {
  process.exit(0);
}

const combined = (result.stdout ?? "") + (result.stderr ?? "");
const payload = {
  decision: "block",
  reason:
    "Stop hook blocked: `pnpm check` is not green. " +
    "Fix the errors below before declaring the task done.\n\n" +
    combined.trim(),
};

process.stdout.write(JSON.stringify(payload));
process.exit(0);
