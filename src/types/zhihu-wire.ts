// Wire-level types for 知乎's SSR `<script id="js-initialData">` blob.
//
// These are NOT domain types. They mirror, verbatim, the shape that
// 知乎 serializes over the wire (camelCase, all of their internal
// bookkeeping fields intact). The canonical domain equivalents live in
// `./answer.ts` (`Answer`, `Comment`); a follow-up mapper in the
// `sources/` layer will translate `ZhihuAnswerWire` → `Answer` etc.
//
// Shape was knitted by inspecting the captured fixture
// `tests/fixtures/zhihu/question-292527529-initialData.json`
// (three answers, one question, zero users/comments at SSR time).
//
// Why we parse SSR HTML instead of hitting /api/v4 directly: 知乎 now
// returns a 40362 anti-bot wall on unauthenticated REST calls, so the
// page-embedded `js-initialData` JSON is the path of least resistance.
// See `docs/decisions/003-*.md` (ADR 003) for the full rationale.
//
// Fields we actively consume are typed precisely. Fields we don't
// consume but know exist are kept as `unknown` (or permissive records)
// so that (a) TypeScript still surfaces a typo if we reach for them and
// (b) we're not lying about nested structure we never verified.

/* -------------------------------------------------------------------------- */
/*                                   Author                                   */
/* -------------------------------------------------------------------------- */

/**
 * The `author` sub-object found on both answers and questions.
 *
 * Answer-authors and question-authors share most fields, but the
 * question variant in the fixture carries extra relationship flags
 * (`isCelebrity`, `isBlocking`, `isBlocked`) while the answer variant
 * carries `exposedMedal`. Those all-caps-optional fields are marked
 * optional below so a single type can absorb both observed shapes.
 */
export type ZhihuAuthorWire = {
  readonly id: string;
  readonly urlToken: string;
  readonly name: string;
  readonly avatarUrl: string;
  readonly avatarUrlTemplate: string;
  /** Observed literal values: `"people"`. Kept as `string` for tolerance. */
  readonly type: string;
  /** Observed literal values: `"people"`. */
  readonly userType: string;
  readonly url: string;
  readonly headline: string;
  /** Observed empty-array in all fixture samples; element shape unknown. */
  readonly badge: readonly unknown[];
  readonly badgeV2: {
    readonly title: string;
    readonly mergedBadges: readonly unknown[];
    readonly detailBadges: readonly unknown[];
    readonly icon: string;
    readonly nightIcon: string;
  };
  /**
   * -1 = undeclared, 0 = female, 1 = male (per 知乎 convention). Kept
   * as `number` because the public wire doesn't narrow it.
   */
  readonly gender: number;
  readonly isOrg: boolean;
  readonly isAdvertiser: boolean;
  readonly isPrivacy: boolean;
  readonly followerCount: number;
  readonly isFollowing: boolean;
  readonly isFollowed: boolean;
  /** Only present on answer-authors in the fixture. */
  readonly exposedMedal?: {
    readonly avatarUrl: string;
    readonly description: string;
    readonly medalAvatarFrame: string;
    readonly medalId: string;
    readonly medalName: string;
    readonly miniAvatarUrl: string;
  };
  /** Only present on question-authors in the fixture. */
  readonly isCelebrity?: boolean;
  /** Only present on question-authors in the fixture. */
  readonly isBlocking?: boolean;
  /** Only present on question-authors in the fixture. */
  readonly isBlocked?: boolean;
};

/* -------------------------------------------------------------------------- */
/*                                   Topics                                   */
/* -------------------------------------------------------------------------- */

/** Elements of `ZhihuQuestionWire.topics`. */
export type ZhihuTopicWire = {
  readonly id: string;
  readonly type: string;
  readonly url: string;
  readonly name: string;
  readonly avatarUrl: string;
  /** Observed value: `"NORMAL"`. Kept as `string` for tolerance. */
  readonly topicType: string;
};

/* -------------------------------------------------------------------------- */
/*                              Question (entity)                             */
/* -------------------------------------------------------------------------- */

/**
 * The stubby `question` sub-object embedded inside each answer. Carries
 * just enough to identify/label the question without re-shipping the
 * whole entity. The full entity shape is `ZhihuQuestionWire`.
 */
export type ZhihuAnswerQuestionStub = {
  readonly id: string;
  readonly title: string;
  /** Unix seconds. */
  readonly created: number;
  /** Unix seconds. */
  readonly updatedTime: number;
  /** Observed value: `"question"`. */
  readonly type: string;
  /** Observed value: `"normal"`. */
  readonly questionType: string;
  readonly url: string;
  /** Fixture had `null`; real authenticated sessions likely return an object. */
  readonly relationship: unknown;
};

/** One full value under `entities.questions[<qid>]`. */
export type ZhihuQuestionWire = {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  readonly editableDetail: string;
  readonly excerpt: string;
  readonly url: string;
  /** Observed value: `"question"`. */
  readonly type: string;
  /** Observed value: `"normal"`. */
  readonly questionType: string;
  /** Unix seconds. */
  readonly created: number;
  /** Unix seconds. */
  readonly updatedTime: number;
  readonly answerCount: number;
  readonly visitCount: number;
  readonly commentCount: number;
  readonly followerCount: number;
  readonly voteupCount: number;
  readonly collapsedAnswerCount: number;
  readonly answerCountDescription: string;
  readonly isMuted: boolean;
  readonly isVisible: boolean;
  readonly isNormal: boolean;
  readonly isEditable: boolean;
  readonly isLabeled: boolean;
  readonly isBannered: boolean;
  readonly adminClosedComment: boolean;
  readonly hasPublishingDraft: boolean;
  readonly showAuthor: boolean;
  readonly showEncourageAuthor: boolean;
  readonly canVote: boolean;
  /** Observed value: `"all"`. */
  readonly commentPermission: string;
  readonly status: {
    readonly isLocked: boolean;
    readonly isClose: boolean;
    readonly isEvaluate: boolean;
    readonly isSuggest: boolean;
  };
  readonly canComment: {
    readonly status: boolean;
    readonly reason: string;
  };
  readonly topics: readonly ZhihuTopicWire[];
  readonly author: ZhihuAuthorWire;
  /** Empty in the fixture; element shape not yet observed. */
  readonly relatedCards: readonly unknown[];
  /* -------- fields we acknowledge but do not consume ---------- */
  readonly thumbnailInfo: unknown;
  readonly reviewInfo: unknown;
  readonly muteInfo: unknown;
  readonly reactionInstruction: unknown;
  readonly invisibleAuthor: unknown;
  readonly relationship: unknown;
};

/* -------------------------------------------------------------------------- */
/*                                   Answer                                   */
/* -------------------------------------------------------------------------- */

/** One full value under `entities.answers[<aid>]`. */
export type ZhihuAnswerWire = {
  readonly id: string;
  /** Observed value: `"answer"`. */
  readonly type: string;
  /** Observed value: `"normal"`. */
  readonly answerType: string;
  readonly url: string;
  /** Raw HTML body — what we actually scrape for signal density. */
  readonly content: string;
  readonly editableContent: string;
  readonly excerpt: string;
  /** Unix seconds. */
  readonly createdTime: number;
  /** Unix seconds. */
  readonly updatedTime: number;
  readonly voteupCount: number;
  readonly commentCount: number;
  readonly thanksCount: number;
  readonly favlistsCount: number;
  readonly isNormal: boolean;
  readonly isVisible: boolean;
  readonly isCollapsed: boolean;
  readonly isSticky: boolean;
  readonly isMine: boolean;
  readonly isCopyable: boolean;
  readonly isJumpNative: boolean;
  readonly canComment: {
    readonly status: boolean;
    readonly reason: string;
  };
  readonly commentPermission: string;
  readonly adminClosedComment: boolean;
  readonly hasPublishingDraft: boolean;
  readonly contentNeedTruncated: boolean;
  readonly forceLoginWhenClickReadMore: boolean;
  readonly visibleOnlyToAuthor: boolean;
  readonly allowSegmentInteraction: number;
  readonly collapseReason: string;
  readonly collapsedBy: string;
  readonly stickyInfo: string;
  readonly attachedInfo: string;
  readonly extras: string;
  readonly businessType: string;
  readonly reshipmentSettings: string;
  readonly matrixTips: string;
  readonly author: ZhihuAuthorWire;
  readonly question: ZhihuAnswerQuestionStub;
  /* -------- fields we acknowledge but do not consume ---------- */
  /** Fixture had `null`. */
  readonly annotationAction: unknown;
  readonly contentMark: unknown;
  readonly decorativeLabels: readonly unknown[];
  readonly reaction: unknown;
  readonly reactionInstruction: unknown;
  readonly relationship: unknown;
  readonly relevantInfo: unknown;
  readonly rewardInfo: unknown;
  readonly settings: unknown;
  readonly suggestEdit: unknown;
  readonly thumbnailInfo: unknown;
};

/* -------------------------------------------------------------------------- */
/*                                  Comments                                  */
/* -------------------------------------------------------------------------- */

/**
 * One value under `entities.comments[<cid>]`.
 *
 * TODO: the captured SSR fixture has `entities.comments = {}` (comments
 * are lazy-loaded by a separate XHR), so we have no real sample to
 * carve against. Leave this as a permissive record until we capture a
 * comments fixture, then replace with a precise shape. Do NOT fabricate
 * fields in the meantime — the whole point of a wire type is that it
 * matches reality.
 */
export type ZhihuCommentWire = Record<string, unknown>;

/** One value under `entities.lineComments[<cid>]`. Same TODO as above. */
export type ZhihuLineCommentWire = Record<string, unknown>;

/* -------------------------------------------------------------------------- */
/*                                  Entities                                  */
/* -------------------------------------------------------------------------- */

/**
 * `initialState.entities`. Every sub-key is a map of stringified id →
 * entity. zhihu-radar only reads `questions`, `answers`, `users`,
 * `comments`, and `lineComments`; the rest are held as permissive
 * records so we don't paint ourselves into a corner before we have a
 * reason to care about them.
 */
export type ZhihuEntitiesMap = {
  readonly questions: Readonly<Record<string, ZhihuQuestionWire>>;
  readonly answers: Readonly<Record<string, ZhihuAnswerWire>>;
  /** Empty in the SSR fixture; shape will be carved when a sample lands. */
  readonly users: Readonly<Record<string, Record<string, unknown>>>;
  readonly comments: Readonly<Record<string, ZhihuCommentWire>>;
  readonly lineComments: Readonly<Record<string, ZhihuLineCommentWire>>;
  readonly articles: Readonly<Record<string, unknown>>;
  readonly columns: Readonly<Record<string, unknown>>;
  readonly topics: Readonly<Record<string, unknown>>;
  readonly roundtables: Readonly<Record<string, unknown>>;
  readonly favlists: Readonly<Record<string, unknown>>;
  readonly notifications: Readonly<Record<string, unknown>>;
  readonly ebooks: Readonly<Record<string, unknown>>;
  readonly activities: Readonly<Record<string, unknown>>;
  readonly feeds: Readonly<Record<string, unknown>>;
  readonly pins: Readonly<Record<string, unknown>>;
  readonly promotions: Readonly<Record<string, unknown>>;
  readonly drafts: Readonly<Record<string, unknown>>;
  readonly chats: Readonly<Record<string, unknown>>;
  readonly posts: Readonly<Record<string, unknown>>;
  readonly zvideos: Readonly<Record<string, unknown>>;
  readonly eduCourses: Readonly<Record<string, unknown>>;
};

/* -------------------------------------------------------------------------- */
/*                               Initial state                                */
/* -------------------------------------------------------------------------- */

/**
 * `initialData.initialState` — the giant redux-ish blob the 知乎 SPA
 * hydrates from. zhihu-radar only reads `.entities`; every other known
 * sub-key is kept as `unknown` so we can still discriminate presence
 * without promising a shape we never inspected.
 */
export type ZhihuInitialState = {
  readonly entities: ZhihuEntitiesMap;
  readonly common: unknown;
  readonly loading: unknown;
  readonly currentUser: unknown;
  readonly account: unknown;
  readonly settings: unknown;
  readonly notification: unknown;
  readonly people: unknown;
  readonly env: unknown;
  readonly me: unknown;
  readonly label: unknown;
  readonly ecommerce: unknown;
  readonly oiaModal: unknown;
  readonly comments: unknown;
  readonly commentsV2: unknown;
  readonly pushNotifications: unknown;
  readonly messages: unknown;
  readonly register: unknown;
  readonly login: unknown;
  readonly switches: unknown;
  readonly captcha: unknown;
  readonly sms: unknown;
  readonly chat: unknown;
  readonly emoticons: unknown;
  readonly creator: unknown;
  readonly creators: unknown;
  readonly question: unknown;
  readonly shareTexts: unknown;
  readonly answers: unknown;
  readonly banner: unknown;
  readonly topic: unknown;
  readonly explore: unknown;
  readonly articles: unknown;
  readonly favlists: unknown;
  readonly pins: unknown;
  readonly publishedModal: unknown;
  readonly topstory: unknown;
  readonly upload: unknown;
  readonly video: unknown;
  readonly zvideos: unknown;
  readonly guide: unknown;
  readonly reward: unknown;
  readonly search: unknown;
  readonly creatorSalt: unknown;
  readonly publicEditPermission: unknown;
  readonly readStatus: unknown;
  readonly draftHistory: unknown;
  readonly notifications: unknown;
  readonly specials: unknown;
  readonly collections: unknown;
  readonly userProfit: unknown;
  readonly mcn: unknown;
  readonly mcnActivity: unknown;
  readonly brand: unknown;
  readonly host: unknown;
  readonly campaign: unknown;
  readonly knowledgePlan: unknown;
  readonly wallE: unknown;
  readonly roundtables: unknown;
  readonly helpCenter: unknown;
  readonly republish: unknown;
  readonly commercialReport: unknown;
  readonly creatorMCN: unknown;
  readonly commentManage: unknown;
  readonly commentPermission: unknown;
  readonly creatorRightStatus: unknown;
  readonly zhiPlus: unknown;
  readonly streaming: unknown;
  readonly creationRanking: unknown;
  readonly eduSections: unknown;
  readonly adPromotion: unknown;
  readonly editVideo: unknown;
  readonly zhidaEntry: unknown;
  readonly guideZhidaCard: unknown;
  readonly hotSpot: unknown;
  readonly contentColumnCard: unknown;
  readonly rings: unknown;
  readonly menuIgnoreSet: unknown;
};

/* -------------------------------------------------------------------------- */
/*                                Top-level blob                              */
/* -------------------------------------------------------------------------- */

/**
 * Whatever is parsed out of `<script id="js-initialData">…</script>`
 * on a question page. `initialState` is the only field we actually
 * read; the others are page-level telemetry scaffolding.
 */
export type ZhihuInitialData = {
  readonly initialState: ZhihuInitialState;
  /** Observed value: `"main"`. */
  readonly subAppName: string;
  /** Observed value: `"QuestionPage"`. */
  readonly spanName: string;
  /** Feature-flag bag; observed values are all string-typed. */
  readonly canaryConfig: Readonly<Record<string, string>>;
};
