// Deterministic fixture for the markdown-report renderer snapshot test.
// Plausible-looking but entirely synthetic. Timestamps that *should not*
// appear in the rendered output use the distinctive value
// "2099-12-31T11:11:11.111Z" so a leak is loud.
//
// Pure data: no imports from src/ runtime, only types. (Type-only imports
// are inert and do not violate any layering rule.)

import type { AnalyzedAnswer } from "../../../src/types/analysis.js";
import type { Answer, Comment } from "../../../src/types/answer.js";
import type { TopicRanking, TopicReport } from "../../../src/types/report.js";
import type { ConversionSignal } from "../../../src/types/signal.js";

/** Distinctive timestamp string that must never leak into the rendered output. */
export const LEAK_SENTINEL_ISO = "2099-12-31T11:11:11.111Z";

// ---------- topic 1: visa-agent question ----------

const visaAnswer: Answer = {
  id: "ans-101",
  questionId: "q-1001",
  questionTitle: "去英国留学，怎么挑选靠谱的中介？",
  body:
    "我之前找了三家中介都不太行，最后是朋友推荐的一个独立顾问帮我搞定的。" +
    "如果你也在找，可以参考下面几个判断标准：1) 顾问个人背景；2) 合同条款；" +
    "3) 是否有过往学生联系方式可以核实。私信我可以发一份我整理的对比表。",
  authorName: "留学老白",
  upvotes: 2480,
  commentCount: 142,
  createdAt: "2025-09-01T03:14:00.000Z",
  url: "https://www.zhihu.com/question/1001/answer/101",
  scrapedAt: "2026-04-22T08:00:00.000Z",
};

const visaComment: Comment = {
  id: "cmt-9001",
  answerId: "ans-101",
  body: "怎么联系您？想要那份对比表，加个微信吧",
  authorName: "申请季的Mia",
  upvotes: 12,
  createdAt: "2025-09-02T10:00:00.000Z",
  scrapedAt: "2026-04-22T08:00:00.000Z",
};

const visaSignals: ReadonlyArray<ConversionSignal> = [
  {
    kind: "contact-request",
    keyword: "私信我",
    location: { kind: "answer-body", answerId: "ans-101" },
    spanStart: 96,
    spanEnd: 99,
  },
  {
    kind: "contact-request",
    keyword: "怎么联系",
    location: { kind: "comment", commentId: "cmt-9001", answerId: "ans-101" },
    spanStart: 0,
    spanEnd: 4,
  },
  {
    kind: "contact-request",
    keyword: "加个微信",
    location: { kind: "comment", commentId: "cmt-9001", answerId: "ans-101" },
    spanStart: 14,
    spanEnd: 18,
  },
];

const visaAnalyzed: AnalyzedAnswer = {
  answer: visaAnswer,
  comments: [visaComment],
  signals: visaSignals,
  signalsPer1kChars: 18.42,
  intentSummary: "readers want personal contact for an independent agent",
  intentConfidence: 0.83,
  analyzedAt: LEAK_SENTINEL_ISO,
};

const visaTopic: TopicRanking = {
  questionId: "q-1001",
  questionTitle: "去英国留学，怎么挑选靠谱的中介？",
  analyzedAnswerCount: 18,
  totalSignalCount: 41,
  signalsByKind: {
    "contact-request": 22,
    "recommendation-request": 11,
    "payment-intent": 5,
    "dm-pull": 3,
  },
  signalsPer1kChars: 12.7,
  topAnswers: [visaAnalyzed],
};

// ---------- topic 2: IELTS prep question ----------

const ieltsAnswer1: Answer = {
  id: "ans-202",
  questionId: "q-1002",
  questionTitle: "雅思口语7分有什么靠谱的备考方法？",
  body:
    "口语7的核心其实不是练得多，而是练得准。每天30分钟，用真题录音，对照官方评分。" +
    "如果有具体题目想看示范，我整理了一个题库，需要的可以发我一份你最怕的题，我录段示范给你。",
  authorName: "雅思老周",
  upvotes: 980,
  commentCount: 67,
  createdAt: "2025-11-15T07:00:00.000Z",
  url: "https://www.zhihu.com/question/1002/answer/202",
  scrapedAt: "2026-04-22T08:00:00.000Z",
};

const ieltsComment1: Comment = {
  id: "cmt-9101",
  answerId: "ans-202",
  body: "求推荐一个靠谱的口语陪练，付费咨询也可以",
  authorName: "考鸭小琪",
  upvotes: 4,
  createdAt: "2025-11-16T01:00:00.000Z",
  scrapedAt: "2026-04-22T08:00:00.000Z",
};

const ieltsSignals1: ReadonlyArray<ConversionSignal> = [
  {
    kind: "dm-pull",
    keyword: "发我一份",
    location: { kind: "answer-body", answerId: "ans-202" },
    spanStart: 70,
    spanEnd: 74,
  },
  {
    kind: "recommendation-request",
    keyword: "求推荐",
    location: { kind: "comment", commentId: "cmt-9101", answerId: "ans-202" },
    spanStart: 0,
    spanEnd: 3,
  },
  {
    kind: "payment-intent",
    keyword: "付费咨询",
    location: { kind: "comment", commentId: "cmt-9101", answerId: "ans-202" },
    spanStart: 14,
    spanEnd: 18,
  },
];

const ieltsAnalyzed1: AnalyzedAnswer = {
  answer: ieltsAnswer1,
  comments: [ieltsComment1],
  signals: ieltsSignals1,
  signalsPer1kChars: 9.05,
  intentSummary: "readers want personalised speaking practice and quotes",
  intentConfidence: 0.71,
  analyzedAt: LEAK_SENTINEL_ISO,
};

// A second top answer for the IELTS topic, with NO signals, to exercise
// the "Signals: _(none)_" branch inside an otherwise interesting report.
const ieltsAnswer2: Answer = {
  id: "ans-203",
  questionId: "q-1002",
  questionTitle: "雅思口语7分有什么靠谱的备考方法？",
  body: "我没什么神奇方法，每天背一篇范文，背了三个月从5.5到7。慢就是快。",
  authorName: "佛系考鸭",
  upvotes: 220,
  commentCount: 9,
  createdAt: "2025-12-01T07:00:00.000Z",
  url: "https://www.zhihu.com/question/1002/answer/203",
  scrapedAt: "2026-04-22T08:00:00.000Z",
};

const ieltsAnalyzed2: AnalyzedAnswer = {
  answer: ieltsAnswer2,
  comments: [],
  signals: [],
  signalsPer1kChars: 0,
  intentSummary: "",
  intentConfidence: 0,
  analyzedAt: LEAK_SENTINEL_ISO,
};

const ieltsTopic: TopicRanking = {
  questionId: "q-1002",
  questionTitle: "雅思口语7分有什么靠谱的备考方法？",
  analyzedAnswerCount: 12,
  totalSignalCount: 17,
  signalsByKind: {
    "contact-request": 4,
    "recommendation-request": 6,
    "payment-intent": 5,
    "dm-pull": 2,
  },
  signalsPer1kChars: 7.33,
  topAnswers: [ieltsAnalyzed1, ieltsAnalyzed2],
};

// ---------- the report ----------

export const sampleReport: TopicReport = {
  date: "2026-04-22",
  generatedAt: LEAK_SENTINEL_ISO,
  rankings: [visaTopic, ieltsTopic],
};
