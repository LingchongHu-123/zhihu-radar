// draft command: read every AnalyzedAnswer under <dataDir>/processed/,
// re-build TopicRankings (same shape report uses), pick the top N by
// topic-level density, run draft-writer against each, render with
// markdown-draft, write to <dataDir>/drafts/draft-<qid>-<date>.md.
//
// Why re-build rankings here instead of reading data/reports/<date>.md?
// The report file is human-facing Markdown (lossy by design); the
// AnalyzedAnswer JSONs are the source of truth. Re-aggregating is
// cheap, doesn't add a "must run report first" implicit dependency,
// and uses exactly the same code path as report.ts (buildRankings).
//
// One Claude call per drafted topic, one file per draft. Per-topic
// granularity for the same reasons as analyze: a Claude failure on
// topic X costs that topic, resuming a partial run is "skip topics
// that already have a draft file" (skipExisting: true), and re-
// drafting one topic is `rm data/drafts/draft-<qid>-<date>.md` away.

import { MAX_DRAFTS_PER_RUN } from "../../config/thresholds.js";
import { renderDraft } from "../../outputs/markdown-draft.js";
import {
  writeDraft,
  type DraftOptions as DraftWriterOptions,
} from "../../processors/draft-writer.js";
import type { ClaudeClient } from "../../processors/intent-analysis.js";
import type { AnalyzedAnswer } from "../../types/analysis.js";
import type { GeneratedDraft } from "../../types/draft.js";
import type { TopicRanking } from "../../types/report.js";
import {
  draftPath,
  draftsDir,
  processedDir,
  type FsLike,
} from "../io/data-dir.js";
import { buildRankings } from "./report.js";
import type { Logger } from "./scrape.js";

export type DraftCommandOptions = {
  readonly dataDir: string;
  /** ISO-8601 calendar date used in the draft filename. */
  readonly draftDate: string;
  /** Wall-clock timestamp recorded inside each GeneratedDraft.generatedAt. */
  readonly now: Date;
  /** Injected Claude client (see runtime/io/claude-client.ts for the prod impl). */
  readonly claudeClient: ClaudeClient;
  /**
   * When true (default), skip topics whose draft file for this date
   * already exists. Same resume-on-crash story as analyze.
   */
  readonly skipExisting?: boolean;
  /**
   * Optional override of the per-run cap. Defaults to MAX_DRAFTS_PER_RUN.
   * Useful for tests; production CLI doesn't expose this flag.
   */
  readonly maxDrafts?: number;
  readonly fs: FsLike;
  readonly logger: Logger;
};

export type DraftCommandResult = {
  /** Number of drafts successfully written this run. */
  readonly drafted: number;
  /** Topics whose draft for this date already existed and were skipped. */
  readonly skippedExisting: number;
  /** Topics where the Claude call failed. */
  readonly failed: number;
  /** Total topics considered (after the maxDrafts cap was applied). */
  readonly topicsConsidered: number;
};

export async function runDraft(
  opts: DraftCommandOptions,
): Promise<DraftCommandResult> {
  const skipExisting = opts.skipExisting ?? true;
  const maxDrafts = opts.maxDrafts ?? MAX_DRAFTS_PER_RUN;
  await opts.fs.mkdir(draftsDir(opts.dataDir), { recursive: true });

  const answers = await readAllAnalyzed(opts);
  const rankings = buildRankings(answers).slice(0, maxDrafts);

  let drafted = 0;
  let skippedExisting = 0;
  let failed = 0;

  for (const ranking of rankings) {
    const outPath = draftPath(opts.dataDir, ranking.questionId, opts.draftDate);

    if (skipExisting && (await fileExists(opts.fs, outPath))) {
      skippedExisting += 1;
      continue;
    }

    try {
      const draft = await writeOne(ranking, opts);
      await opts.fs.writeFile(outPath, renderDraft(draft));
      drafted += 1;
      opts.logger.info(
        `draft: wrote ${outPath} (title "${draft.title}")`,
      );
    } catch (err) {
      failed += 1;
      opts.logger.warn(
        `draft: topic ${ranking.questionId} failed: ${describeError(err)}`,
      );
    }
  }

  return {
    drafted,
    skippedExisting,
    failed,
    topicsConsidered: rankings.length,
  };
}

// ---------- helpers ----------

async function readAllAnalyzed(
  opts: DraftCommandOptions,
): Promise<ReadonlyArray<AnalyzedAnswer>> {
  const pd = processedDir(opts.dataDir);
  let names: ReadonlyArray<string>;
  try {
    names = await opts.fs.readdir(pd);
  } catch {
    opts.logger.warn(
      `draft: processed dir ${pd} not readable; nothing to draft`,
    );
    return [];
  }
  const out: AnalyzedAnswer[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const path = `${pd}/${name}`;
    try {
      const raw = await opts.fs.readFile(path);
      out.push(JSON.parse(raw) as AnalyzedAnswer);
    } catch (err) {
      opts.logger.warn(
        `draft: could not read ${path}: ${describeError(err)}`,
      );
    }
  }
  return out;
}

async function writeOne(
  ranking: TopicRanking,
  opts: DraftCommandOptions,
): Promise<GeneratedDraft> {
  const writerOpts: DraftWriterOptions = {
    clientImpl: opts.claudeClient,
    now: opts.now,
  };
  return writeDraft(ranking, writerOpts);
}

async function fileExists(fs: FsLike, path: string): Promise<boolean> {
  try {
    await fs.readFile(path);
    return true;
  } catch {
    return false;
  }
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
