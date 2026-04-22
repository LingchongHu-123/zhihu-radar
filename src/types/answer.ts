// Raw 知乎 data shapes — what a scraper produces and every other layer
// speaks in terms of. These are domain types, not wire types: the
// translation from 知乎's JSON API payload into these shapes happens in
// sources/. Nothing here imports anything else, by architecture.

/** A single 知乎 answer attached to one question. */
export type Answer = {
  /** 知乎 answer id (stringified because it's a 64-bit number on the wire). */
  id: string;
  /** The question this answer belongs to. */
  questionId: string;
  /** Question title as seen at scrape time. */
  questionTitle: string;
  /** Plain-text body, with 知乎's HTML stripped. Markdown is acceptable. */
  body: string;
  /** Author display name. Never store real identifiers. */
  authorName: string;
  /** Upvote count at scrape time. */
  upvotes: number;
  /** Comment count at scrape time (may include deleted). */
  commentCount: number;
  /** ISO-8601 UTC timestamp of answer creation. */
  createdAt: string;
  /** ISO-8601 UTC timestamp of last edit, if different from createdAt. */
  updatedAt?: string;
  /** Canonical URL (https://www.zhihu.com/question/<qid>/answer/<id>). */
  url: string;
  /** ISO-8601 UTC timestamp when *we* scraped this row. */
  scrapedAt: string;
};

/** A comment on an answer. 知乎 comments are nested but we flatten them. */
export type Comment = {
  /** 知乎 comment id. */
  id: string;
  /** The answer this comment belongs to. */
  answerId: string;
  /** Plain-text body. */
  body: string;
  /** Author display name. */
  authorName: string;
  /**
   * Parent comment id if this is a reply, otherwise absent. We flatten but
   * keep the pointer so reconstruction is possible in outputs/ if ever needed.
   */
  parentCommentId?: string;
  /** Upvote count at scrape time. */
  upvotes: number;
  /** ISO-8601 UTC timestamp of comment creation. */
  createdAt: string;
  /** ISO-8601 UTC timestamp when we scraped this row. */
  scrapedAt: string;
};
