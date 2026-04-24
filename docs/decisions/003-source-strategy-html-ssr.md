# ADR 003: Source 知乎 data via SSR HTML, not the JSON API

- **Status:** Proposed
- **Date:** 2026-04-22
- **Author:** Phase A fixture-capture session

## Context

`src/sources/` is the layer that pulls raw answer, question, and comment
data from 知乎 and hands it to the rest of the pipeline. The original
implementation at `src/sources/zhihu-answers.ts` targeted the JSON API
directly: `/api/v4/questions/<id>/answers` for answer lists and
`/api/v4/answers/<id>/root_comments` for comments. That choice was made
on the assumption that a logged-in session cookie would be sufficient
authentication for a self-use scraper.

On 2026-04-22, during Phase A fixture capture, every authenticated
request to `/api/v4/...` came back as:

```
403 Forbidden
{"error":{"code":40362,"message":"您当前请求存在异常，暂时限制本次访问..."}}
```

Root cause: 知乎 gates `/api/v4/...` behind an `x-zse-96` request
signature computed by obfuscated browser JavaScript from the `d_c0`
cookie, the request path, and the request body. A session cookie alone
is not enough. The server-rendered HTML page at
`https://www.zhihu.com/question/<id>` has no such gate — it embeds the
same entity data in a `<script id="js-initialData" type="text/json">`
blob whose `initialState.entities.{answers,questions,users,comments,
lineComments,...}` trees use the same shapes the API would have
returned.

The pipeline needs a sourcing strategy that is stable enough to build
fixtures against and cheap enough to maintain as a solo project.

## Decision

Source 知乎 data by fetching the server-rendered question page
(`https://www.zhihu.com/question/<id>`), extracting the
`js-initialData` script blob, `JSON.parse`-ing it, and reading the
entity maps under `initialState.entities`. **Do not call
`/api/v4/...` endpoints.**

This applies to answers, questions, users, and comments. The SSR payload
contains all four entity kinds for the first page of content, keyed by
id, already in the shape the downstream processors want.

This ADR covers the *strategy* only. The concrete code changes —
rewriting `src/sources/zhihu-answers.ts` from an API client to an SSR
parser, lifting `AnswerWire` into `src/types/` — are follow-up
implementation tasks and not part of this decision.

## Consequences

**Positive**

- No new runtime dependencies. A regex to locate the script tag plus
  `JSON.parse` is the entire parser surface — no HTML DOM library, no
  headless browser.
- No participation in the `x-zse-96` arms race. 知乎 rotates that
  algorithm every few months; we never have to care.
- Fixture-friendly: a single HTTP GET captures answers, questions,
  users, and comments for a given question in one blob, making
  `tests/fixtures/` snapshots trivial.
- The SSR page structure has been stable for years, so the maintenance
  cost of the parser itself is expected to be low.

**Negative**

- The SSR page only embeds the first batch of answers (typically 3–5).
  Pagination beyond that batch still lives behind either a signed
  `/api/v4/...` call or per-answer pages at
  `/question/<id>/answer/<aid>`. Phase A only needs one fixture, so
  this is deferred; Phase E (full runtime) must solve pagination
  before it ships.
- We are coupled to an undocumented implementation detail
  (`js-initialData`). If 知乎 removes SSR hydration or restructures the
  embedded state, the source layer breaks until we adapt.

**Neutral**

- "Source of truth" for wire shapes becomes whatever the SSR blob
  contains, not the nominal public API. In practice the two are the
  same today; if they diverge we follow the SSR shape, since that is
  what we actually read.

## Alternatives considered

- **Reverse-engineer `x-zse-96` and keep calling `/api/v4/...`.**
  Community implementations exist, but 知乎 rotates the signing
  algorithm on a multi-month cadence, turning this into a perpetual
  maintenance tax. It also drifts into gray-area territory that is
  harder to defend if legal questions ever come up. Not worth the
  ongoing cost for a self-use tool.
- **Headless browser (Playwright).** Technically the most robust
  option: a real browser runs the real JS and signs requests
  naturally. Rejected because Playwright adds a 300MB+ runtime
  dependency (violates CLAUDE.md rule 4), is slow per request, and is
  overkill for what amounts to parsing a static JSON blob embedded in
  HTML.
- **Mobile API (`api.zhihu.com`).** May have different gating than the
  web API. Untried, and pursuing it speculatively would just move the
  signature problem to a different host. Held in reserve as a fallback
  if both SSR and the web API become unworkable.

## Amendment 2026-04-23 — comments via `/api/v4/comment_v5`

The "Do not call `/api/v4/...` endpoints" rule above was written when
every known `/api/v4` path observed from this machine was returning the
40362 anti-bot wall. Phase A followup probing (see
`scripts/probe-comments.ts`) established that
`GET /api/v4/comment_v5/answers/<aid>/root_comment` is **not** walled —
it returns JSON unauthenticated and unsigned, no `x-zse-96` required.
And since the SSR question page never hydrates its
`entities.comments` map in practice (it is always `{}`), comments
*must* come from some XHR endpoint. `comment_v5` is the one that
works without participating in the signing arms race this ADR was
written to avoid.

Therefore: **comments are a scoped exception to the `/api/v4`
prohibition.** `src/sources/zhihu-answers.ts::fetchCommentsForAnswer`
calls this specific endpoint. The prohibition still stands for the
answer-list and question-detail endpoints, which is where the 40362
wall actually lives. If the `comment_v5` endpoint ever starts
demanding a signature, revisit this amendment *before* shipping any
reverse-engineering effort — the failure mode there is identical to
the one this ADR was drafted to sidestep.

## Revisit if

- 知乎 removes SSR hydration — i.e. the question page arrives with
  content only after client-side JS runs — and `js-initialData` is no
  longer present or is no longer populated.
- The `js-initialData` schema changes in a way that breaks our parser
  more than once. A single breakage is normal maintenance; a pattern
  of breakages is a signal the strategy is wrong.
- We genuinely need the 100+ answers behind the "load more" button for
  production analysis. At that scale the per-answer SSR workaround
  gets expensive and Playwright (or a signed-API reversal) finally
  justifies its cost.
