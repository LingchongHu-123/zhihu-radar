// Analyzed shapes. processors/ turns raw Answer + Comment[] into an
// AnalyzedAnswer by (a) finding mechanical keyword matches and (b) asking
// Claude for a structured summary of the buying intent in the thread.
//
// Keeping mechanical and LLM-derived fields side-by-side lets outputs/
// show both without re-running anything.

import type { Answer, Comment } from "./answer.js";
import type { ConversionSignal } from "./signal.js";

/**
 * One answer plus everything we learned about it. The shape an output
 * renderer consumes.
 */
export type AnalyzedAnswer = {
  /** The original scraped answer. Unchanged. */
  answer: Answer;
  /** The comments on that answer at scrape time. Unchanged. */
  comments: ReadonlyArray<Comment>;
  /** All mechanical keyword matches across body and comments. */
  signals: ReadonlyArray<ConversionSignal>;
  /**
   * Signal density: number of matched signals per 1000 characters of
   * combined body+comment text. The main ranking input.
   */
  signalsPer1kChars: number;
  /**
   * Claude-produced one-line summary of what the readers seem to actually
   * want ("contact for visa agent", "price quotes for IELTS prep", etc.).
   * Empty string if processors/ hasn't run yet.
   */
  intentSummary: string;
  /**
   * Claude's confidence (0..1) that the intentSummary is accurate. 0 means
   * the processor gave up (no clear signal, too little text, etc.).
   */
  intentConfidence: number;
  /** ISO-8601 UTC timestamp when the analysis ran. */
  analyzedAt: string;
};
