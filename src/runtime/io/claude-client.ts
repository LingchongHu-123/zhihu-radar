// Thin fetch-based implementation of processors/intent-analysis's
// `ClaudeClient`. No @anthropic-ai/sdk dependency — processors/ deliberately
// speaks a request shape that matches the SDK's `messages.create` input, so
// mapping it onto HTTP is straight line-to-line. Trading a small amount of
// protocol plumbing for one fewer runtime dep is worth it at self-use
// scale (see CLAUDE.md rule 4).
//
// The API key is supplied by the caller, not read from env here. That
// keeps config/env.ts the single place that touches process.env, and
// lets tests construct a client without any env fiddling.

import type {
  ClaudeClient,
  ClaudeRequest,
  ClaudeResponse,
} from "../../processors/intent-analysis.js";

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_API_VERSION = "2023-06-01";

export type CreateClientOptions = {
  readonly apiKey: string;
  /** Override for tests. Defaults to global `fetch`. */
  readonly fetchImpl?: typeof fetch;
};

/**
 * Build a `ClaudeClient` closed over an API key. Caller wires it into
 * `analyzeAnswer` via `AnalyzeOptions.clientImpl`.
 *
 * Errors on non-2xx responses include the status and the response body
 * (debuggability > prettiness — an opaque "request failed" is the worst
 * thing to see in a log when a batch just ate 100 answers worth of
 * compute budget).
 */
export function createAnthropicClient(opts: CreateClientOptions): ClaudeClient {
  const fetchImpl = opts.fetchImpl ?? fetch;
  return async (req: ClaudeRequest): Promise<ClaudeResponse> => {
    const res = await fetchImpl(ANTHROPIC_MESSAGES_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": opts.apiKey,
        "anthropic-version": ANTHROPIC_API_VERSION,
      },
      body: JSON.stringify(req),
    });
    if (!res.ok) {
      const body = await safeText(res);
      throw new Error(
        `Anthropic /v1/messages returned ${res.status}: ${body.slice(0, 500)}`,
      );
    }
    const parsed = (await res.json()) as ClaudeResponse;
    return parsed;
  };
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "(body unreadable)";
  }
}
