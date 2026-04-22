// Keyword lists for mechanical signal matching. Grouped by SignalKind so
// validators/ and processors/ can say "this comment matched keyword K of
// kind contact-request" without inventing a category system of their own.
//
// These lists are intentionally short and conservative. False positives here
// are expensive (they drag unrelated topics up the ranking), false negatives
// are cheap (they mean we miss a buying signal, but the next one will catch
// it). When in doubt, leave a keyword out until a real thread proves it
// belongs.
//
// Treat this file as tuning dials: editing a phrase here changes behavior
// across every layer. That is the whole point of having a config layer.

import type { SignalKind } from "../types/signal.js";

/**
 * Map from SignalKind to the set of phrases that count as that kind.
 * Readers match against answer bodies and comments case-sensitively — 知乎
 * text is mostly Chinese so case doesn't apply, and it lets us avoid
 * accidentally lower-casing URLs.
 */
export const SIGNAL_KEYWORDS: Readonly<Record<SignalKind, ReadonlyArray<string>>> = {
  "contact-request": [
    "怎么联系",
    "如何联系",
    "联系方式",
    "私信我",
    "私信联系",
    "加个微信",
    "留个微信",
    "加微信",
    "留qq",
    "加qq",
  ],
  "recommendation-request": [
    "求推荐",
    "有没有推荐",
    "有没有靠谱",
    "求靠谱",
    "有经验的推荐",
    "推荐一个",
    "跪求推荐",
  ],
  "payment-intent": [
    "滴滴",
    "付费咨询",
    "愿意付费",
    "多少钱",
    "价格多少",
    "收费吗",
    "报价",
  ],
  "dm-pull": [
    "私信发",
    "发我一份",
    "发我链接",
    "求链接",
    "发份给我",
    "能发我吗",
  ],
};
