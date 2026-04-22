// Env reads. The only file in the codebase that touches process.env.
//
// Two rules:
//   1. Never import this from a module that runs at import-time from
//      something tests load. Reads are lazy (function calls, not top-level
//      consts) so tests can stub env without timing hazards.
//   2. Never log the values these return. Error messages say what is
//      missing, not what was present.
//
// The exception "config has no behavior" from architecture.md is deliberate:
// these are functions, not computations. They read a string and hand it
// back. The layering rule still holds.

/**
 * Anthropic API key for processors/. Throws with a clear, actionable
 * message if unset — we'd rather fail loudly than send a blank key.
 */
export function getAnthropicApiKey(): string {
  const value = process.env["ANTHROPIC_API_KEY"];
  if (value === undefined || value === "") {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Add it to .env or export it in the shell before running processors.",
    );
  }
  return value;
}

/**
 * 知乎 cookie string for authenticated JSON-API requests. Optional: some
 * endpoints work anonymously but many return partial data or get
 * rate-limited faster without a session cookie. Returns undefined when
 * unset rather than throwing — sources/ decides whether to proceed.
 */
export function getZhihuCookie(): string | undefined {
  const value = process.env["ZHIHU_COOKIE"];
  if (value === undefined || value === "") {
    return undefined;
  }
  return value;
}

/**
 * User-Agent string sent with 知乎 requests. We keep this configurable
 * because 知乎 occasionally tightens UA filtering and we want to adjust
 * without a code change. Falls back to a recent desktop Chrome string.
 */
export function getZhihuUserAgent(): string {
  const value = process.env["ZHIHU_USER_AGENT"];
  if (value === undefined || value === "") {
    return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
  }
  return value;
}
