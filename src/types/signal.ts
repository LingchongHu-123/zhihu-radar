// Conversion-signal shapes. A "signal" is a span of text that looks like the
// reader is trying to buy, contact, or solicit: "怎么联系", "滴滴", "求推荐",
// "私信我", "加个微信". The concrete keyword lists live in config/; this
// layer only defines the shape of a matched occurrence.

/**
 * Category of buying-intent signal. Coarse on purpose — we want the report
 * to say "X% of comments are contact-seeking", not to track 20 sub-flavors.
 */
export type SignalKind =
  /** Reader wants to make direct contact ("怎么联系", "私信我", "加个微信"). */
  | "contact-request"
  /** Reader is asking for a vendor/agent recommendation ("求推荐", "有没有靠谱的"). */
  | "recommendation-request"
  /** Reader signals willingness to pay ("滴滴", "付费咨询", "多少钱"). */
  | "payment-intent"
  /** Reader is asking to be DM'd with details ("私信发链接", "发我一份"). */
  | "dm-pull";

/** Where in the scraped data a signal was found. */
export type SignalLocation =
  | { kind: "answer-body"; answerId: string }
  | { kind: "comment"; commentId: string; answerId: string };

/**
 * A single matched signal. Keyword-level granularity so outputs/ can show
 * receipts ("this was flagged because the comment said '怎么联系'").
 */
export type ConversionSignal = {
  /** Category — which kind of intent this matched. */
  kind: SignalKind;
  /** The exact keyword or phrase that matched. Taken from config/. */
  keyword: string;
  /** Where it was found. */
  location: SignalLocation;
  /** Character offset in the source body where the match starts. */
  spanStart: number;
  /** Character offset where the match ends (exclusive). */
  spanEnd: number;
};
