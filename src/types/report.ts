// Report shapes. The daily artifact outputs/ writes to disk. A report is a
// ranked list of topics (questions) with summary stats per topic; each
// topic carries the top few analyzed answers as evidence.
//
// Keep this struct stable-ish — it's the snapshot format we commit into
// data/reports/ when we want to preserve a dated view.

import type { AnalyzedAnswer } from "./analysis.js";
import type { SignalKind } from "./signal.js";

/** Per-topic rollup. A topic == one 知乎 question. */
export type TopicRanking = {
  /** 知乎 question id. */
  questionId: string;
  /** Question title. */
  questionTitle: string;
  /** How many answers we pulled and analyzed for this topic. */
  analyzedAnswerCount: number;
  /** Sum of all signals across all analyzed answers for this topic. */
  totalSignalCount: number;
  /** Signal count broken down by kind. */
  signalsByKind: Readonly<Record<SignalKind, number>>;
  /**
   * Weighted density: total signals per 1000 characters of combined
   * body+comment text across the topic. The primary ranking key.
   */
  signalsPer1kChars: number;
  /**
   * Top N analyzed answers for this topic, by signalsPer1kChars desc.
   * Serves as "receipts" in the report — click through to see why the
   * topic scored high.
   */
  topAnswers: ReadonlyArray<AnalyzedAnswer>;
};

/** One day's worth of topic rankings. The root artifact the CLI produces. */
export type TopicReport = {
  /** ISO-8601 calendar date this report covers ("2026-04-22"). */
  date: string;
  /** ISO-8601 UTC timestamp when the report was generated. */
  generatedAt: string;
  /** Topic rankings, highest-intent first. */
  rankings: ReadonlyArray<TopicRanking>;
};
