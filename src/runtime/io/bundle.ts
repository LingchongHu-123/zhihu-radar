// The on-disk shapes runtime/ writes and reads. Kept inside runtime/
// because nothing outside runtime cares about them — sources/ returns
// in-memory domain objects, outputs/ takes in-memory TopicReport. The
// "JSON file" format is this layer's internal contract, not the data
// model's.

import type { Answer, Comment } from "../../types/answer.js";

/**
 * One question's complete scrape: the question's identity at scrape time,
 * all the answers pulled for it, and the comments attached to each answer
 * keyed by answer id. A scrape writes exactly one of these per target
 * question; analyze consumes them in bulk.
 *
 * The commented-only-by-answerId shape (rather than flattened
 * `comments: Comment[]`) exists so analyze can match comments to their
 * parent answer in O(1) without re-grouping.
 */
export type RawBundle = {
  readonly questionId: string;
  readonly questionTitle: string;
  readonly scrapedAt: string;
  readonly answers: ReadonlyArray<Answer>;
  readonly commentsByAnswerId: Readonly<Record<string, ReadonlyArray<Comment>>>;
};
