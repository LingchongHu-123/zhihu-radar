// Path conventions for on-disk artifacts and a minimal `FsLike` interface
// so command functions stay testable without a real filesystem.
//
// Single place that knows the directory layout:
//
//   <dataDir>/raw/<questionId>.json              one bundle per scrape target
//   <dataDir>/processed/<qid>-<aid>.json          one file per analyzed answer
//   <dataDir>/reports/<YYYY-MM-DD>.md             one Markdown report per day
//
// Per-answer (not per-question) files in `processed/` so re-analysis of a
// single bad row doesn't rewrite a whole bundle, and so listing is cheap.
// Per-question bundles in `raw/` because scrape atomically produces a
// matched set (answers + their comments) and splitting would create files
// that are only ever read together.

export const DEFAULT_DATA_DIR = "data";

const RAW = "raw";
const PROCESSED = "processed";
const REPORTS = "reports";

export function rawDir(dataDir: string): string {
  return `${dataDir}/${RAW}`;
}

export function processedDir(dataDir: string): string {
  return `${dataDir}/${PROCESSED}`;
}

export function reportsDir(dataDir: string): string {
  return `${dataDir}/${REPORTS}`;
}

export function rawBundlePath(dataDir: string, questionId: string): string {
  return `${rawDir(dataDir)}/${questionId}.json`;
}

export function processedAnswerPath(
  dataDir: string,
  questionId: string,
  answerId: string,
): string {
  return `${processedDir(dataDir)}/${questionId}-${answerId}.json`;
}

export function reportPath(dataDir: string, isoDate: string): string {
  return `${reportsDir(dataDir)}/${isoDate}.md`;
}

/**
 * Minimal filesystem surface commands depend on. Narrower than
 * `node:fs/promises` so tests can pass an in-memory stub without
 * implementing 50 methods we don't use.
 */
export type FsLike = {
  readFile(path: string): Promise<string>;
  writeFile(path: string, data: string): Promise<void>;
  readdir(path: string): Promise<ReadonlyArray<string>>;
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>;
};
