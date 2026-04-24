// report command: read every AnalyzedAnswer under <dataDir>/processed/,
// group by question id, compute per-topic rollups, rank topics by raw
// signal density, and render to a Markdown file at
// <dataDir>/reports/<YYYY-MM-DD>.md.
//
// Ranking has two scopes:
//   - Intra-topic ordering of topAnswers uses confidence-weighted
//     density so Claude's judgement on an answer dampens keyword-only
//     noise (ADR 004). Weighted density is computed here, not stored
//     in the AnalyzedAnswer, because the weighting formula is the
//     kind of thing we might tune and we don't want to re-analyze
//     every row when we do.
//   - Inter-topic ranking uses raw total-signals-per-1000-chars-across
//     -the-whole-topic, exactly what TopicRanking's type comment says.
//     Aggregating weighted densities would mix two different notions of
//     "signal" at the same call site; clearer to keep topic-level raw
//     and per-answer-within-topic weighted.
//
// The report date is an explicit parameter, not derived from `now`.
// That way the CLI can accept `--date 2026-04-21` for back-dating a
// report over an older batch without time-travel tricks.

import { SIGNAL_KINDS_IN_ORDER } from "../../config/signals.js";
import {
  MAX_TOPICS_PER_REPORT,
  TOP_ANSWERS_PER_TOPIC_IN_REPORT,
} from "../../config/thresholds.js";
import { renderTopicReport } from "../../outputs/markdown-report.js";
import { confidenceWeightedDensity } from "../../processors/signal-matcher.js";
import type { AnalyzedAnswer } from "../../types/analysis.js";
import type { SignalKind } from "../../types/signal.js";
import type { TopicRanking, TopicReport } from "../../types/report.js";
import {
  processedDir,
  reportPath,
  reportsDir,
  type FsLike,
} from "../io/data-dir.js";
import type { Logger } from "./scrape.js";

export type ReportOptions = {
  readonly dataDir: string;
  /** ISO-8601 calendar date the report covers ("2026-04-24"). */
  readonly reportDate: string;
  /** Wall-clock timestamp for `generatedAt`. Only the date field goes into the body. */
  readonly now: Date;
  readonly fs: FsLike;
  readonly logger: Logger;
};

export type ReportResult = {
  readonly topicsInReport: number;
  readonly answersRead: number;
  readonly reportPath: string;
};

export async function runReport(opts: ReportOptions): Promise<ReportResult> {
  await opts.fs.mkdir(reportsDir(opts.dataDir), { recursive: true });

  const answers = await readAllAnalyzed(opts);
  const rankings = buildRankings(answers);
  const limited = rankings.slice(0, MAX_TOPICS_PER_REPORT);

  const report: TopicReport = {
    date: opts.reportDate,
    generatedAt: opts.now.toISOString(),
    rankings: limited,
  };

  const md = renderTopicReport(report);
  const outPath = reportPath(opts.dataDir, opts.reportDate);
  await opts.fs.writeFile(outPath, md);
  opts.logger.info(
    `report: wrote ${outPath} (${limited.length} topics, ${answers.length} analyzed answers)`,
  );

  return {
    topicsInReport: limited.length,
    answersRead: answers.length,
    reportPath: outPath,
  };
}

// ---------- read ----------

async function readAllAnalyzed(
  opts: ReportOptions,
): Promise<ReadonlyArray<AnalyzedAnswer>> {
  const pd = processedDir(opts.dataDir);
  let names: ReadonlyArray<string>;
  try {
    names = await opts.fs.readdir(pd);
  } catch {
    opts.logger.warn(`report: processed dir ${pd} not readable; empty report`);
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
        `report: could not read ${path}: ${describeError(err)}`,
      );
    }
  }
  return out;
}

// ---------- aggregate ----------

/**
 * Group by questionId, compute rollups, sort desc by topic-level density.
 * Topic-level density is raw (total signals / total chars × 1000); intra-
 * topic top-answer ordering is confidence-weighted.
 */
export function buildRankings(
  answers: ReadonlyArray<AnalyzedAnswer>,
): ReadonlyArray<TopicRanking> {
  const groups = new Map<string, AnalyzedAnswer[]>();
  for (const a of answers) {
    const qid = a.answer.questionId;
    const list = groups.get(qid) ?? [];
    list.push(a);
    groups.set(qid, list);
  }

  const rankings: TopicRanking[] = [];
  for (const [questionId, group] of groups) {
    rankings.push(buildOneRanking(questionId, group));
  }

  rankings.sort((a, b) => b.signalsPer1kChars - a.signalsPer1kChars);
  return rankings;
}

function buildOneRanking(
  questionId: string,
  group: ReadonlyArray<AnalyzedAnswer>,
): TopicRanking {
  let totalSignalCount = 0;
  let totalChars = 0;
  const byKind = emptySignalsByKind();

  for (const a of group) {
    totalSignalCount += a.signals.length;
    totalChars += a.answer.body.length;
    for (const c of a.comments) totalChars += c.body.length;
    for (const s of a.signals) byKind[s.kind] += 1;
  }

  const signalsPer1kChars =
    totalChars === 0 ? 0 : (totalSignalCount * 1000) / totalChars;

  const topAnswers = [...group]
    .sort(
      (x, y) =>
        confidenceWeightedDensity(y.signalsPer1kChars, y.intentConfidence) -
        confidenceWeightedDensity(x.signalsPer1kChars, x.intentConfidence),
    )
    .slice(0, TOP_ANSWERS_PER_TOPIC_IN_REPORT);

  return {
    questionId,
    questionTitle: group[0]?.answer.questionTitle ?? "",
    analyzedAnswerCount: group.length,
    totalSignalCount,
    signalsByKind: byKind,
    signalsPer1kChars,
    topAnswers,
  };
}

function emptySignalsByKind(): Record<SignalKind, number> {
  const out = {} as Record<SignalKind, number>;
  for (const k of SIGNAL_KINDS_IN_ORDER) out[k] = 0;
  return out;
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
