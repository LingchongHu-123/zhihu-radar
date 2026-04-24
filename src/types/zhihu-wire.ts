// Wire-level types for 知乎's SSR `<script id="js-initialData">` blob
// AND 知乎's `/api/v4/comment_v5/...` XHR responses.
//
// These are NOT domain types. They mirror, verbatim, the shape that
// 知乎 serializes over the wire. The SSR blob is camelCase; the
// `comment_v5` XHR is snake_case — each half of this file keeps the
// casing of its origin so that "the wire type matches reality" stays
// literally true. The canonical domain equivalents live in
// `./answer.ts` (`Answer`, `Comment`); mappers in the `sources/` layer
// will translate wire → domain (including the case flip for comments).
//
// Shape sources:
//   - SSR blob: `tests/fixtures/zhihu/question-292527529-initialData.json`
//     (three answers, one question, zero users/comments at SSR time).
//   - comment_v5 XHR: `tests/fixtures/zhihu/answer-2543422324-comments-page1.json`
//     (10 root comments) and `…-comments-last.json` (4 root comments,
//     `paging.is_end: true`). Endpoint:
//     `GET /api/v4/comment_v5/answers/<aid>/root_comment`.
//
// Why we parse SSR HTML instead of hitting /api/v4 directly for the
// answer body: 知乎 returns a 40362 anti-bot wall on unauthenticated
// REST calls to the answer endpoints, so the page-embedded
// `js-initialData` JSON is the path of least resistance. Comments,
// however, are lazy-loaded by the page via `comment_v5` and that
// endpoint does serve unauthenticated-enough responses for our use.
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
/*                          Comments (comment_v5 XHR)                         */
/* -------------------------------------------------------------------------- */

/*
 * Everything below mirrors the snake_case response body of
 *   GET https://www.zhihu.com/api/v4/comment_v5/answers/<aid>/root_comment
 * Do not rename fields to camelCase here — the sources-layer mapper is
 * the single place that case-flips wire → domain.
 */

/**
 * The `author` sub-object on a `comment_v5` comment. Distinct from
 * `ZhihuAuthorWire` (which is the SSR camelCase author) because this
 * endpoint ships snake_case plus a different slice of sub-objects
 * (`vip_info`, `kvip_info`, `level_info`, `ring_info`, etc.).
 *
 * Precise for fields the mapper reads (`id`, `name`, `url_token`,
 * `headline`); permissive elsewhere because we haven't committed to
 * consuming nested shapes like `badge_v2` or the vip bags.
 */
export type ZhihuCommentAuthorWire = {
  /** Stable user id (hex string). Surfaces into domain `Comment.authorId`. */
  readonly id: string;
  /** Short slug used in URLs; may be an auto-generated `user-xxxxxxxx`. */
  readonly url_token: string;
  /** Display name. May be an auto-generated `user-xxxxxxxx` for anon/stub accounts. */
  readonly name: string;
  /** Self-written headline. Often empty string. */
  readonly headline: string;
  /* -------- fields we acknowledge but do not consume ---------- */
  readonly avatar_url: string;
  readonly avatar_url_template: string;
  readonly is_org: boolean;
  /** Observed value: `"people"`. */
  readonly type: string;
  readonly url: string;
  /** Observed value: `"people"`. */
  readonly user_type: string;
  /** -1/0/1 per 知乎 convention; kept wide. */
  readonly gender: number;
  readonly is_advertiser: boolean;
  readonly badge_v2: Record<string, unknown>;
  /**
   * Present on every fixture author, but the "no medal" case ships all
   * empty strings rather than omitting the object. Kept permissive.
   */
  readonly exposed_medal: Record<string, unknown>;
  readonly vip_info: Record<string, unknown>;
  readonly kvip_info: Record<string, unknown>;
  /** Fixture had `null` on every author. */
  readonly level_info: unknown;
  readonly is_anonymous: boolean;
  /** Fixture had `null` on every author. */
  readonly ring_info: unknown;
};

/**
 * One element of the `data` array returned by `comment_v5/…/root_comment`.
 *
 * Recursive via `child_comments`: 知乎 can inline up to N replies inside
 * a root comment's `child_comments` array (every fixture row has it as
 * an empty array, but the field is always present and the API contract
 * is that each element has the same shape as a root comment).
 */
export type ZhihuCommentWire = {
  /** Stable comment id (decimal string). */
  readonly id: string;
  /**
   * Numeric member id of the author. Note this is a DIFFERENT identifier
   * from `author.id` (hex string) — 知乎 exposes both and the mapper
   * prefers `author.id` for joins with SSR data.
   */
  readonly member_id: number;
  /** HTML-bearing body. May contain `<br>` and `<a>` tags; sources-layer strips HTML. */
  readonly content: string;
  /** Unix seconds. */
  readonly created_time: number;
  readonly like_count: number;
  /**
   * `"0"` means "this is a root comment, not a reply to another
   * comment". Any other value is the id of the parent comment.
   */
  readonly reply_comment_id: string;
  /**
   * Id of the root comment of the thread this comment belongs to. For a
   * root comment itself, this equals `id`.
   */
  readonly reply_root_comment_id: string;
  readonly is_delete: boolean;
  readonly collapsed: boolean;
  readonly reviewing: boolean;
  readonly child_comment_count: number;
  /**
   * Recursive. Empty array in every current fixture row, but always
   * present; when populated each element is a full `ZhihuCommentWire`.
   */
  readonly child_comments: readonly ZhihuCommentWire[];
  readonly author: ZhihuCommentAuthorWire;
  /* -------- fields we acknowledge but do not consume ---------- */
  /** Observed value: `"comment"`. */
  readonly type: string;
  /** Observed value: `"answer"`. */
  readonly resource_type: string;
  readonly url: string;
  readonly hot: boolean;
  readonly top: boolean;
  readonly score: number;
  readonly liked: boolean;
  readonly disliked: boolean;
  readonly dislike_count: number;
  readonly is_author: boolean;
  readonly can_like: boolean;
  readonly can_dislike: boolean;
  readonly can_delete: boolean;
  readonly can_reply: boolean;
  readonly can_hot: boolean;
  readonly can_author_top: boolean;
  readonly is_author_top: boolean;
  readonly can_collapse: boolean;
  readonly can_share: boolean;
  readonly can_unfold: boolean;
  readonly can_truncate: boolean;
  readonly can_more: boolean;
  readonly author_tag: readonly unknown[];
  readonly reply_author_tag: readonly unknown[];
  readonly content_tag: readonly unknown[];
  /** Carries `ip_info` (region) among other things; we don't read it today. */
  readonly comment_tag: readonly Record<string, unknown>[];
  /** Fixture had `null` on every row. */
  readonly child_comment_next_offset: unknown;
  readonly is_visible_only_to_myself: boolean;
  readonly is_gift: boolean;
  /** Fixture had `null` on every row. */
  readonly disclaimer_info: unknown;
  /** Only present on some rows (e.g. `level_tag: 2`). Optional accordingly. */
  readonly level_tag?: number;
};

/**
 * `paging` envelope on the `comment_v5` response.
 *
 * IMPORTANT: `next` is populated on EVERY page — including the last one
 * (where it loops back to the first page). Do NOT use `next` (or its
 * presence) as a termination signal. The sole termination signal is
 * `is_end === true`. See the fixture pair
 * `…-comments-page1.json` (`is_end: false`) vs `…-comments-last.json`
 * (`is_end: true`, `next` still populated).
 */
export type ZhihuCommentPaging = {
  /**
   * Sole termination signal for pagination. `true` means "do not fetch
   * another page". Do NOT rely on `next` being absent — it is populated
   * even on the last page (looping back to the first page's URL).
   */
  readonly is_end: boolean;
  readonly is_start: boolean;
  /**
   * URL of the next page. Present on both `is_end: false` and
   * `is_end: true` responses (on the latter it points back to the
   * start), so presence is not a termination signal.
   */
  readonly next?: string;
  readonly previous?: string;
  /** Total comment count across all pages; observed on every fixture. */
  readonly totals?: number;
};

/** Aggregate counts sub-object on a `comment_v5` page. */
export type ZhihuCommentCounts = {
  readonly total_counts: number;
  readonly collapsed_counts: number;
  readonly reviewing_counts: number;
  readonly segment_comment_counts: number;
};

/**
 * The whole response envelope from
 * `GET /api/v4/comment_v5/answers/<aid>/root_comment`.
 *
 * Precise for the three fields the sources layer consumes (`data`,
 * `paging`, `counts`) and permissive for the rest (`sorter`,
 * `edit_status`, the atmosphere-voting scaffolding, etc.) — we are not
 * lying about shapes we have not committed to reading.
 */
export type ZhihuCommentsPage = {
  readonly data: readonly ZhihuCommentWire[];
  readonly paging: ZhihuCommentPaging;
  readonly counts: ZhihuCommentCounts;
  /* -------- fields we acknowledge but do not consume ---------- */
  /** Fixture had `[]` on page1 and `null` on the last page — kept permissive. */
  readonly ad_plugin_infos: unknown;
  readonly atmosphere_voting_config: Record<string, unknown>;
  readonly comment_status: Record<string, unknown>;
  readonly edit_status: Record<string, unknown>;
  readonly header: readonly unknown[];
  readonly is_content_author: boolean;
  readonly is_content_rewardable: boolean;
  readonly sorter: readonly Record<string, unknown>[];
};

/**
 * One value under `entities.lineComments[<cid>]` in the SSR blob.
 *
 * TODO: no real line-comment sample has been captured yet — the
 * captured SSR fixture has `entities.lineComments = {}`. Leaving this
 * as a permissive record until a sample lands. Do NOT fabricate
 * fields in the meantime; the whole point of a wire type is that it
 * matches reality. When a sample does land, note that line-comments
 * are a distinct feature from top-level comments (they anchor to a
 * text range inside the answer body) and may carry different fields.
 */
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
  /**
   * NOTE: the SSR `entities.comments` map is camelCase (it's a sibling
   * of `entities.answers` etc.), but `ZhihuCommentWire` is snake_case
   * because it's carved from the `comment_v5` XHR response — that's
   * where we actually read comments from. The SSR map is empty in every
   * captured fixture (comments are lazy-loaded) and neither side of the
   * codebase currently reads it, so we tolerate the casing mismatch on
   * the type for now. If/when the SSR map starts shipping populated,
   * introduce a separate `ZhihuCommentSsrWire` type and point this
   * field at it.
   */
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
