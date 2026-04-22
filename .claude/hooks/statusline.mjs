#!/usr/bin/env node
// Claude Code statusLine: shows a rough context-usage percentage so the
// author can decide when to `/compact` manually before auto-compact kicks
// in (which happens around ~83% and can lose nuance).
//
// We can't get the real token count from outside Claude Code, so this
// estimates: total character count of the transcript / CHARS_PER_TOKEN.
// The number trends correctly with usage even if it's not exact — which
// is all this indicator needs to be.
//
// Input (stdin, JSON): Claude Code passes { session_id, transcript_path,
//   cwd, model: { id, display_name }, ... }.
// Output (stdout): one line of text with ANSI colors.

import { readFileSync, existsSync } from "node:fs";
import { basename } from "node:path";

const CONTEXT_LIMIT = 200_000; // default Claude Code context window
const CHARS_PER_TOKEN = 3.0; // rough for mixed Chinese + English + code

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const BOLD_RED = "\x1b[1;31m";

function colorForPct(pct) {
  if (pct < 60) return GREEN;
  if (pct < 80) return YELLOW;
  if (pct < 90) return RED;
  return BOLD_RED;
}

function accumulateChars(node) {
  // Recursively pull every string payload out of a transcript row. Handles
  // the nested message.content shapes Claude Code produces (string, array
  // of parts, tool_use/tool_result objects).
  if (node == null) return 0;
  if (typeof node === "string") return node.length;
  if (typeof node !== "object") return 0;
  if (Array.isArray(node)) {
    let total = 0;
    for (const item of node) total += accumulateChars(item);
    return total;
  }
  let total = 0;
  for (const key of ["text", "content", "input", "output", "result", "command"]) {
    if (key in node) total += accumulateChars(node[key]);
  }
  return total;
}

function estimateTokens(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return null;
  try {
    const raw = readFileSync(transcriptPath, "utf8");
    let totalChars = 0;
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        totalChars += accumulateChars(row.message ?? row);
      } catch {
        // skip malformed jsonl rows
      }
    }
    return Math.round(totalChars / CHARS_PER_TOKEN);
  } catch {
    return null;
  }
}

let input = {};
try {
  input = JSON.parse(readFileSync(0, "utf8"));
} catch {
  // no stdin / bad JSON — render a degraded line
}

const tokens = estimateTokens(input.transcript_path);
const cwdName = input.cwd ? basename(input.cwd) : "";
const modelName = input.model?.display_name ?? "claude";

let head;
if (tokens === null) {
  head = `${DIM}ctx ?${RESET}`;
} else {
  const pct = Math.min(999, Math.round((tokens / CONTEXT_LIMIT) * 100));
  const color = colorForPct(pct);
  const kTokens = (tokens / 1000).toFixed(0);
  const hint = pct >= 80 ? " /compact?" : "";
  head = `${color}ctx ${pct}% (${kTokens}k/200k)${hint}${RESET}`;
}

const tail = [cwdName, modelName].filter(Boolean).join(" · ");
process.stdout.write(tail ? `${head} ${DIM}· ${tail}${RESET}` : head);
