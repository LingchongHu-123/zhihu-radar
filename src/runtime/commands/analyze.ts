// analyze command: read every RawBundle in <dataDir>/raw/, run each
// answer through the quality gate, then the intent-analysis processor,
// and write the AnalyzedAnswer to <dataDir>/processed/<qid>-<aid>.json.
//
// One Claude call per answer, one file per answer. Per-answer
// granularity means:
//   - a Claude failure on answer X costs one answer, not the whole
//     bundle
//   - resuming a crashed run is just "skip answers that already have a
//     processed file" (skipExisting: true)
//   - re-running a single answer is `rm data/processed/<qid>-<aid>.json`
//     away
//
// Validation rejections are logged but don't count as errors. "Skipped"
// means "correctly gated", not "broken".

import type { AnalyzedAnswer } from "../../types/analysis.js";
import type { Answer, Comment } from "../../types/answer.js";
import { analyzeAnswer } from "../../processors/intent-analysis.js";
import type { ClaudeClient } from "../../processors/intent-analysis.js";
import { checkAnswerQuality } from "../../validators/answer-quality.js";
import type { RawBundle } from "../io/bundle.js";
import {
  processedAnswerPath,
  processedDir,
  rawBundlePath,
  rawDir,
  type FsLike,
} from "../io/data-dir.js";
import type { Logger } from "./scrape.js";

export type AnalyzeOptions = {
  readonly dataDir: string;
  /** Batch reference timestamp. All quality checks and analyzedAt values use this. */
  readonly now: Date;
  /** Injected Claude client (see runtime/io/claude-client.ts for the prod impl). */
  readonly claudeClient: ClaudeClient;
  /**
   * When true, skip answers whose processed file already exists. Default
   * true — makes "resume a crashed batch" the normal mode of operation.
   */
  readonly skipExisting?: boolean;
  readonly fs: FsLike;
  readonly logger: Logger;
};

export type AnalyzeResult = {
  readonly analyzed: number;
  readonly skippedExisting: number;
  readonly rejectedByQuality: number;
  readonly failed: number;
};

export async function runAnalyze(opts: AnalyzeOptions): Promise<AnalyzeResult> {
  const skipExisting = opts.skipExisting ?? true;
  await opts.fs.mkdir(processedDir(opts.dataDir), { recursive: true });

  const bundles = await readAllBundles(opts);

  let analyzed = 0;
  let skippedExisting = 0;
  let rejected = 0;
  let failed = 0;

  for (const bundle of bundles) {
    for (const answer of bundle.answers) {
      const outPath = processedAnswerPath(
        opts.dataDir,
        bundle.questionId,
        answer.id,
      );

      if (skipExisting && (await fileExists(opts.fs, outPath))) {
        skippedExisting += 1;
        continue;
      }

      const gate = checkAnswerQuality(answer, opts.now);
      if (!gate.ok) {
        rejected += 1;
        opts.logger.info(
          `analyze: skipped ${answer.id} (quality: ${gate.reasons.join("; ")})`,
        );
        continue;
      }

      const comments = bundle.commentsByAnswerId[answer.id] ?? [];
      try {
        const analyzed1 = await analyzeOne(answer, comments, opts);
        await opts.fs.writeFile(
          outPath,
          `${JSON.stringify(analyzed1, null, 2)}\n`,
        );
        analyzed += 1;
        opts.logger.info(
          `analyze: wrote ${outPath} (density ${analyzed1.signalsPer1kChars.toFixed(2)}, confidence ${analyzed1.intentConfidence.toFixed(2)})`,
        );
      } catch (err) {
        failed += 1;
        opts.logger.warn(
          `analyze: answer ${answer.id} failed: ${describeError(err)}`,
        );
      }
    }
  }

  return {
    analyzed,
    skippedExisting,
    rejectedByQuality: rejected,
    failed,
  };
}

async function readAllBundles(opts: AnalyzeOptions): Promise<ReadonlyArray<RawBundle>> {
  const rd = rawDir(opts.dataDir);
  let names: ReadonlyArray<string>;
  try {
    names = await opts.fs.readdir(rd);
  } catch {
    opts.logger.warn(`analyze: raw dir ${rd} not readable; nothing to do`);
    return [];
  }
  const bundles: RawBundle[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const qid = name.slice(0, -".json".length);
    const path = rawBundlePath(opts.dataDir, qid);
    try {
      const raw = await opts.fs.readFile(path);
      bundles.push(JSON.parse(raw) as RawBundle);
    } catch (err) {
      opts.logger.warn(
        `analyze: could not read ${path}: ${describeError(err)}`,
      );
    }
  }
  return bundles;
}

async function analyzeOne(
  answer: Answer,
  comments: ReadonlyArray<Comment>,
  opts: AnalyzeOptions,
): Promise<AnalyzedAnswer> {
  return analyzeAnswer(answer, comments, {
    clientImpl: opts.claudeClient,
    now: opts.now,
  });
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
