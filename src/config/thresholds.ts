// Numeric thresholds that gate what validators/ accepts, what outputs/
// shows, and how processors/ budgets its work. Centralized so we can
// twiddle one number and feel the whole pipeline shift without a hunt.
//
// Each constant is named after what it gates, not what it compares against.
// "MIN_UPVOTES_FOR_ANALYSIS" says *why* the number exists; a generic
// "MIN_UPVOTES" would not.

/**
 * Answers with fewer upvotes than this are discarded before we spend Claude
 * tokens on them. Set low — in study-abroad topics, useful answers often
 * have modest upvote counts.
 */
export const MIN_UPVOTES_FOR_ANALYSIS = 5;

/**
 * Answer bodies shorter than this (in chars) are almost always low-quality
 * one-liners or image-only posts we can't analyze usefully.
 */
export const MIN_BODY_CHARS_FOR_ANALYSIS = 50;

/**
 * Answers older than this are excluded from daily reports. 知乎 surfaces
 * evergreen content, but buying intent expressed two years ago is not a
 * signal that someone is trying to buy *now*.
 */
export const MAX_ANSWER_AGE_DAYS = 365;

/**
 * Per-topic evidence cap in the report: the top N analyzed answers,
 * ranked by signal density, are embedded in the topic ranking. More than
 * that and reports become unreadable; fewer and the ranking feels arbitrary.
 */
export const TOP_ANSWERS_PER_TOPIC_IN_REPORT = 5;

/**
 * Global cap on how many topics appear in a single daily report. Prevents
 * the long tail from drowning the signal — if topic #40 matters, it will
 * climb on its own over a few days.
 */
export const MAX_TOPICS_PER_REPORT = 20;

/**
 * Guard for the density calculation: answers with combined body+comment
 * text shorter than this contribute 0 to signal density, avoiding the
 * "one match in a 10-char comment = infinity density" pathology.
 */
export const MIN_CHARS_FOR_DENSITY = 100;

/**
 * How many top-density topics get a draft per `draft` run. Each draft is a
 * Claude call, so the cap exists to keep one accidental run from torching
 * the budget. Tune up if you have a long-tail report you actually want
 * draft coverage on.
 */
export const MAX_DRAFTS_PER_RUN = 5;

/**
 * Floor weight for the confidence-weighted density formula
 *
 *   adjusted = rawDensity × (FLOOR + (1 - FLOOR) × intentConfidence)
 *
 * At confidence 0.0 the answer is still credited at FLOOR× the raw
 * density (i.e. mechanical signals matter even when Claude bailed); at
 * 1.0 it gets the full raw density. The floor exists because keyword
 * hits are precise — even with low Claude confidence we don't want to
 * zero them out completely. Tune by editing this number; every consumer
 * reads it from here, so there is no other place to change.
 */
export const CONFIDENCE_WEIGHT_FLOOR = 0.3;
