// zhihu-radar CLI entry.
//
// Dispatches `scrape | analyze | report` to the command modules in
// runtime/commands/. Kept deliberately thin: all business logic lives in
// the commands, and all I/O implementations are injected from here.
//
// Zero-dependency arg parsing is plenty for three verbs. If a fourth
// command ever needs real flag grammar we can revisit, but CLAUDE.md
// rule 4 (no runtime deps without asking) points at rolling our own.

import { getAnthropicApiKey } from "../config/env.js";

import {
  runAnalyze,
  type AnalyzeOptions,
} from "./commands/analyze.js";
import { runDraft } from "./commands/draft.js";
import { runReport } from "./commands/report.js";
import { runScrape, type ScrapeOptions } from "./commands/scrape.js";
import { DEFAULT_DATA_DIR } from "./io/data-dir.js";
import type { FsLike } from "./io/data-dir.js";
import { createAnthropicClient } from "./io/claude-client.js";
import { nodeFs } from "./io/node-fs.js";
import {
  fetchAnswersForQuestion,
  fetchCommentsForAnswer,
} from "../sources/zhihu-answers.js";

/** Deps injectable from tests. Production wiring supplies real fs/clock/console. */
export type CliDeps = {
  readonly fs: FsLike;
  readonly now: () => Date;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  /** Scrape fetchers — injected so tests don't hit the network. */
  readonly scrapeFetchers: ScrapeOptions["fetchers"];
  /** Factory for the Claude client — a factory (not a client) so tests can assert the api key path. */
  readonly makeClaudeClient: (apiKey: string) => AnalyzeOptions["claudeClient"];
};

export type CliResult = {
  /** 0 on success, non-zero on usage error or partial failure. */
  readonly exitCode: number;
};

// ---------- default (production) deps ----------

export function productionDeps(): CliDeps {
  return {
    fs: nodeFs,
    now: () => new Date(),
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line),
    scrapeFetchers: {
      fetchAnswers: fetchAnswersForQuestion,
      fetchComments: fetchCommentsForAnswer,
    },
    makeClaudeClient: (apiKey) => createAnthropicClient({ apiKey }),
  };
}

// ---------- entry point ----------

/**
 * `argv` is everything after `node <script>`, i.e. what
 * `process.argv.slice(2)` gives you in production.
 */
export async function main(
  argv: ReadonlyArray<string>,
  deps: CliDeps,
): Promise<CliResult> {
  const [command, ...rest] = argv;
  const logger = {
    info: deps.stdout,
    warn: deps.stderr,
  };

  if (command === undefined || command === "--help" || command === "-h") {
    printUsage(deps.stdout);
    return { exitCode: command === undefined ? 2 : 0 };
  }

  try {
    switch (command) {
      case "scrape":
        return await handleScrape(rest, deps, logger);
      case "analyze":
        return await handleAnalyze(rest, deps, logger);
      case "report":
        return await handleReport(rest, deps, logger);
      case "draft":
        return await handleDraft(rest, deps, logger);
      default:
        deps.stderr(`unknown command: ${command}`);
        printUsage(deps.stderr);
        return { exitCode: 2 };
    }
  } catch (err) {
    deps.stderr(`fatal: ${describeError(err)}`);
    return { exitCode: 1 };
  }
}

// ---------- per-command handlers ----------

async function handleScrape(
  args: ReadonlyArray<string>,
  deps: CliDeps,
  logger: { info: (l: string) => void; warn: (l: string) => void },
): Promise<CliResult> {
  const parsed = parseArgs(args, new Set(["--data-dir"]));
  const dataDir = parsed.flags["--data-dir"] ?? DEFAULT_DATA_DIR;
  const questionIds = parsed.positional;

  if (questionIds.length === 0) {
    deps.stderr("scrape: need at least one question id");
    deps.stderr("usage: zhihu-radar scrape <qid>... [--data-dir <path>]");
    return { exitCode: 2 };
  }

  const result = await runScrape({
    questionIds,
    dataDir,
    now: deps.now(),
    fs: deps.fs,
    fetchers: deps.scrapeFetchers,
    logger,
  });

  deps.stdout(
    `scrape: ${result.bundlesWritten} bundles written, ${result.questionIdsFailed.length} failed`,
  );
  return { exitCode: result.questionIdsFailed.length === 0 ? 0 : 1 };
}

async function handleAnalyze(
  args: ReadonlyArray<string>,
  deps: CliDeps,
  logger: { info: (l: string) => void; warn: (l: string) => void },
): Promise<CliResult> {
  const parsed = parseArgs(args, new Set(["--data-dir", "--no-skip-existing"]));
  const dataDir = parsed.flags["--data-dir"] ?? DEFAULT_DATA_DIR;
  const skipExisting = !parsed.flagPresent.has("--no-skip-existing");

  const apiKey = getAnthropicApiKey();
  const claudeClient = deps.makeClaudeClient(apiKey);

  const result = await runAnalyze({
    dataDir,
    now: deps.now(),
    claudeClient,
    skipExisting,
    fs: deps.fs,
    logger,
  });

  deps.stdout(
    `analyze: ${result.analyzed} analyzed, ${result.skippedExisting} skipped-existing, ${result.rejectedByQuality} rejected-by-quality, ${result.failed} failed`,
  );
  return { exitCode: result.failed === 0 ? 0 : 1 };
}

async function handleReport(
  args: ReadonlyArray<string>,
  deps: CliDeps,
  logger: { info: (l: string) => void; warn: (l: string) => void },
): Promise<CliResult> {
  const parsed = parseArgs(args, new Set(["--data-dir", "--date"]));
  const dataDir = parsed.flags["--data-dir"] ?? DEFAULT_DATA_DIR;
  const now = deps.now();
  const reportDate = parsed.flags["--date"] ?? isoDate(now);

  const result = await runReport({
    dataDir,
    reportDate,
    now,
    fs: deps.fs,
    logger,
  });

  deps.stdout(
    `report: wrote ${result.reportPath} (${result.topicsInReport} topics from ${result.answersRead} analyzed answers)`,
  );
  return { exitCode: 0 };
}

async function handleDraft(
  args: ReadonlyArray<string>,
  deps: CliDeps,
  logger: { info: (l: string) => void; warn: (l: string) => void },
): Promise<CliResult> {
  const parsed = parseArgs(
    args,
    new Set(["--data-dir", "--date", "--no-skip-existing"]),
  );
  const dataDir = parsed.flags["--data-dir"] ?? DEFAULT_DATA_DIR;
  const now = deps.now();
  const draftDate = parsed.flags["--date"] ?? isoDate(now);
  const skipExisting = !parsed.flagPresent.has("--no-skip-existing");

  const apiKey = getAnthropicApiKey();
  const claudeClient = deps.makeClaudeClient(apiKey);

  const result = await runDraft({
    dataDir,
    draftDate,
    now,
    claudeClient,
    skipExisting,
    fs: deps.fs,
    logger,
  });

  deps.stdout(
    `draft: ${result.drafted} drafted, ${result.skippedExisting} skipped-existing, ${result.failed} failed (of ${result.topicsConsidered} topics)`,
  );
  return { exitCode: result.failed === 0 ? 0 : 1 };
}

// ---------- tiny arg parser ----------

type ParsedArgs = {
  /** Positional args (no leading --). */
  readonly positional: ReadonlyArray<string>;
  /** Flags that take a value, keyed by flag name including leading --. */
  readonly flags: Readonly<Record<string, string>>;
  /** Flags that were present (both value-taking and boolean). Useful for booleans. */
  readonly flagPresent: ReadonlySet<string>;
};

/**
 * Minimal parser: recognises long flags `--name value` (value-taking) or
 * `--name` (boolean) based on the `valueTaking` set. Unknown flags are
 * treated as boolean-present. No short flags, no `=` form — we don't need
 * them yet and adding them without a use case means more surface to test.
 */
function parseArgs(
  args: ReadonlyArray<string>,
  valueTaking: ReadonlySet<string>,
): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  const present = new Set<string>();
  for (let i = 0; i < args.length; i += 1) {
    const tok = args[i]!;
    if (tok.startsWith("--")) {
      present.add(tok);
      if (valueTaking.has(tok) && i + 1 < args.length) {
        const next = args[i + 1]!;
        flags[tok] = next;
        i += 1;
      }
    } else {
      positional.push(tok);
    }
  }
  return { positional, flags, flagPresent: present };
}

// ---------- misc ----------

function isoDate(d: Date): string {
  // YYYY-MM-DD in UTC. Matches what the report expects and what the
  // markdown renderer renders in the header.
  return d.toISOString().slice(0, 10);
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function printUsage(out: (line: string) => void): void {
  out("zhihu-radar — CLI for study-abroad intent-signal radar");
  out("");
  out("Commands:");
  out("  scrape <qid>... [--data-dir <path>]");
  out("      Fetch answers + comments for each question id, write raw bundles.");
  out("  analyze [--data-dir <path>] [--no-skip-existing]");
  out("      Validate + Claude-analyze every raw answer, write per-answer files.");
  out("  report [--data-dir <path>] [--date YYYY-MM-DD]");
  out("      Aggregate processed answers into a dated Markdown report.");
  out("  draft [--data-dir <path>] [--date YYYY-MM-DD] [--no-skip-existing]");
  out("      Generate Markdown draft answers for the top-density topics.");
}

// ---------- top-level ----------

// Only run when invoked directly (pnpm dev / tsx src/runtime/cli.ts),
// not when imported by tests. Node sets `import.meta.url === pathToFileURL(argv[1])`
// for direct invocation. `void` the promise — we handle exit via process.exit.
const directlyInvoked = (() => {
  const arg1 = process.argv[1];
  if (arg1 === undefined) return false;
  try {
    return import.meta.url === new URL(`file://${arg1.replaceAll("\\", "/")}`).href;
  } catch {
    return false;
  }
})();

if (directlyInvoked) {
  void main(process.argv.slice(2), productionDeps()).then((r) => {
    process.exit(r.exitCode);
  });
}
