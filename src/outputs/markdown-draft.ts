// Render a GeneratedDraft to a Markdown string. Pure function: no I/O,
// no Claude, no clock reads. Caller (runtime/) writes the result to
// disk; this module only formats it.
//
// Determinism rules (load-bearing for snapshot tests):
//   - The ONLY timestamp that may appear in the body is `draft.generatedAt`,
//     and even that lives in a metadata block at the top so a reviewer
//     editing the prose doesn't have to skip past it. If we ever ship
//     drafts with `generatedAt` in the prose, snapshots will shred.
//   - No internal sort, no random ordering — the renderer emits fields
//     in the same order on every call.
//   - One trailing newline at end-of-file. Same convention as
//     markdown-report.
//
// The CTA line is rendered as its own block at the bottom (under a
// horizontal rule) so the human reviewer can swap real contact info in
// without touching the body. Filename convention is set in runtime/io/
// data-dir.ts (`draft-<questionId>-<YYYY-MM-DD>.md`).

import type { GeneratedDraft } from "../types/draft.js";

/** Render a GeneratedDraft to its on-disk Markdown form. */
export function renderDraft(draft: GeneratedDraft): string {
  const lines: string[] = [];

  // Header: a short metadata block, kept tight so a reviewer scrolling
  // past it sees the prose immediately.
  lines.push(`# ${draft.title}`);
  lines.push("");
  lines.push(`> Question: ${draft.questionTitle}`);
  lines.push(`> Question id: \`${draft.questionId}\``);
  lines.push(`> Model: \`${draft.modelId}\``);
  lines.push(`> Generated at: ${draft.generatedAt}`);
  lines.push("");

  // Body. We trust the LLM to have produced clean Chinese Markdown;
  // we don't re-format paragraphs here (collapsing whitespace would
  // destroy intentional 知乎-style line breaks).
  lines.push(draft.body);
  lines.push("");

  // CTA block, separated by a horizontal rule so reviewers can find
  // and edit it without scanning.
  lines.push("---");
  lines.push("");
  lines.push("**CTA (replace with real contact info before posting):**");
  lines.push("");
  lines.push(draft.ctaLine);

  return finalise(lines);
}

function finalise(lines: string[]): string {
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}
