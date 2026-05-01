// Draft shapes. processors/draft-writer turns a TopicRanking into a
// GeneratedDraft — a Chinese 知乎-style answer aimed at attracting study-
// abroad consulting leads. Drafts are written to data/drafts/ for human
// review before any publication; this layer only defines the shape.
//
// The shape is deliberately small. Anything that depends on day-of run
// (e.g. the source report's date) lives at the runtime layer; this struct
// describes one self-contained answer draft.

/**
 * One draft 知乎 answer, ready for human review. Markdown body in
 * Chinese, plus an open-ended CTA line that the human reviewer is
 * expected to swap real contact info into before publishing.
 *
 * Keep this struct stable-ish — the on-disk JSON form (alongside the
 * rendered .md) is what we compare across runs to spot drift.
 */
export type GeneratedDraft = {
  /** 知乎 question id this draft answers. */
  questionId: string;
  /** Question title at the time the draft was generated. */
  questionTitle: string;
  /**
   * Suggested answer title / hook. 知乎 doesn't render answer titles,
   * but we keep it for organisational purposes (file naming hints,
   * report cross-linking) and to give the LLM a place to commit a
   * thesis before writing the body.
   */
  title: string;
  /**
   * Markdown body in Chinese. 3–6 paragraphs per the writing rules in
   * draft-writer's system prompt. Does NOT include the CTA line — that
   * is rendered separately so a reviewer can substitute real contact
   * info without scanning the whole body.
   */
  body: string;
  /**
   * Open-ended CTA line in Chinese. By contract: invites a private
   * message, never embeds phone/WeChat/QQ/email. The reviewer adds
   * real contact info before publishing.
   */
  ctaLine: string;
  /** The Claude model id that produced this draft. */
  modelId: string;
  /** ISO-8601 UTC timestamp when the draft was generated. */
  generatedAt: string;
};
