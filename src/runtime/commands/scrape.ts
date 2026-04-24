// scrape command: for each question id, pull the SSR answers page and
// then each answer's comment thread, and write a single RawBundle per
// question to <dataDir>/raw/<qid>.json.
//
// This command is where sources/ is actually called. It's also the only
// place in the codebase that does sequential-with-awaits over network:
// the two fetchers from sources/ are deliberately unaware of batch
// ordering, so runtime/ owns the "don't flood 知乎" decision. For now we
// keep it one-at-a-time with no explicit delay — zhihu-radar is self-use
// and the per-question cost is small. If we ever need throttling it
// belongs here, not in sources/.
//
// Errors per-question are caught and logged through the injected logger;
// one bad question id doesn't take down the batch. That's the right
// default for a "scrape 10 topics overnight" workflow.

import type { Answer, Comment } from "../../types/answer.js";
import {
  fetchAnswersForQuestion,
  fetchCommentsForAnswer,
} from "../../sources/zhihu-answers.js";
import { rawBundlePath, rawDir, type FsLike } from "../io/data-dir.js";
import type { RawBundle } from "../io/bundle.js";

/** Implementation of the two 知乎 fetchers — injected for tests. */
export type ScrapeFetchers = {
  fetchAnswers: typeof fetchAnswersForQuestion;
  fetchComments: typeof fetchCommentsForAnswer;
};

/** Single sink for progress/error lines. stdout/stderr in production, spy in tests. */
export type Logger = {
  info(line: string): void;
  warn(line: string): void;
};

export type ScrapeOptions = {
  /** Question ids to scrape. Order is preserved. Duplicates are ignored. */
  readonly questionIds: ReadonlyArray<string>;
  /** Root data directory (raw/, processed/, reports/ live below this). */
  readonly dataDir: string;
  /** Scrape timestamp — injected so every bundle in a batch shares one. */
  readonly now: Date;
  readonly fs: FsLike;
  readonly fetchers: ScrapeFetchers;
  readonly logger: Logger;
};

export type ScrapeResult = {
  readonly bundlesWritten: number;
  readonly questionIdsFailed: ReadonlyArray<string>;
};

export async function runScrape(opts: ScrapeOptions): Promise<ScrapeResult> {
  await opts.fs.mkdir(rawDir(opts.dataDir), { recursive: true });

  const seen = new Set<string>();
  const failed: string[] = [];
  let written = 0;

  for (const rawId of opts.questionIds) {
    const questionId = rawId.trim();
    if (questionId === "" || seen.has(questionId)) continue;
    seen.add(questionId);

    try {
      const bundle = await scrapeOne(questionId, opts);
      const path = rawBundlePath(opts.dataDir, questionId);
      await opts.fs.writeFile(path, `${JSON.stringify(bundle, null, 2)}\n`);
      opts.logger.info(
        `scrape: wrote ${path} (${bundle.answers.length} answers, ${totalComments(bundle)} comments)`,
      );
      written += 1;
    } catch (err) {
      failed.push(questionId);
      opts.logger.warn(`scrape: question ${questionId} failed: ${describeError(err)}`);
    }
  }

  return { bundlesWritten: written, questionIdsFailed: failed };
}

async function scrapeOne(
  questionId: string,
  opts: ScrapeOptions,
): Promise<RawBundle> {
  const answers = await opts.fetchers.fetchAnswers(questionId);
  const commentsByAnswerId: Record<string, ReadonlyArray<Comment>> = {};
  for (const answer of answers) {
    commentsByAnswerId[answer.id] = await opts.fetchers.fetchComments(answer.id);
  }
  return {
    questionId,
    questionTitle: firstQuestionTitle(answers) ?? "",
    scrapedAt: opts.now.toISOString(),
    answers,
    commentsByAnswerId,
  };
}

function firstQuestionTitle(answers: ReadonlyArray<Answer>): string | undefined {
  const first = answers[0];
  return first === undefined ? undefined : first.questionTitle;
}

function totalComments(bundle: RawBundle): number {
  let sum = 0;
  for (const list of Object.values(bundle.commentsByAnswerId)) {
    sum += list.length;
  }
  return sum;
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
