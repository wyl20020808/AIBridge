/**
 * Wire-level translation for an OpenAI-compatible endpoint — **the provider-specific half**.
 *
 * HTTP status semantics, the vendor error body, `finish_reason` spellings, token-count field
 * names and SSE framing all live here and never leave this file except as mapped
 * `AiUsage` / `AiFinishReason` / `ProviderRawError` (AGENTS.md §4: a provider's raw error body is
 * not a public contract).
 */
import type { AiFinishReason, AiUsage, ProviderRawError } from '@aibridge/contracts';

/** The vendor error body field this adapter reads. Provider-shaped on purpose. */
type VendorErrorBody = {
  readonly error?: {
    readonly type?: unknown;
    readonly code?: unknown;
    readonly message?: unknown;
  };
};

function vendorErrorType(body: VendorErrorBody): string {
  const type = body.error?.type;
  const code = body.error?.code;
  return `${typeof type === 'string' ? type : ''} ${typeof code === 'string' ? code : ''}`.toLowerCase();
}

/** Parse a `Retry-After` header (delta-seconds form) to milliseconds. Date form is not supported. */
export function parseRetryAfterMs(headerValue: string | null): number | undefined {
  if (headerValue === null) {
    return undefined;
  }
  const seconds = Number(headerValue.trim());
  if (!Number.isFinite(seconds) || seconds < 0) {
    return undefined;
  }
  return Math.round(seconds * 1000);
}

/**
 * Map an HTTP failure to a **mapped** provider error. The vendor body is read here and reduced to
 * a closed category + generic reason; `rawMessage` keeps a bounded operator-only excerpt.
 *
 * Order: the vendor error *type* wins when it names the failure class (an OpenAI-compatible
 * endpoint reports `model_not_found` on 400 or 404, `overloaded_error` on 500 or 503 — the status
 * alone is not stable across implementations), then the status code.
 */
export function classifyHttpFailure(input: {
  readonly status: number;
  readonly body: VendorErrorBody;
  readonly retryAfterMs?: number;
}): ProviderRawError {
  const vendorType = vendorErrorType(input.body);
  const rawMessage = typeof input.body.error?.message === 'string' ? input.body.error.message : undefined;
  // A response arrived, so the outcome is **known** (not accepted) — safe to classify for retry.
  const base = {
    dispatched: true,
    ...(rawMessage === undefined ? {} : { rawMessage }),
    ...(input.retryAfterMs === undefined ? {} : { retryAfterMs: input.retryAfterMs }),
  };
  if (vendorType.includes('model')) {
    // "The routed model is not currently usable" is a routing problem, not a caller bug.
    return { category: 'BAD_REQUEST', reason: 'MODEL_UNAVAILABLE', ...base };
  }
  if (vendorType.includes('rate_limit') || vendorType.includes('over_rate')) {
    return { category: 'RATE_LIMIT', reason: 'PROVIDER_THROTTLED', ...base };
  }
  if (vendorType.includes('overloaded')) {
    return { category: 'OVERLOADED', reason: 'PROVIDER_OVERLOADED', ...base };
  }
  if (vendorType.includes('auth') || vendorType.includes('permission')) {
    return { category: 'AUTH', reason: 'PROVIDER_AUTH_FAILED', ...base };
  }
  if (vendorType.includes('content_filter')) {
    return { category: 'CONTENT_FILTER', reason: 'PROVIDER_CONTENT_FILTER', ...base };
  }
  if (vendorType.includes('insufficient')) {
    // `insufficient_quota` / `insufficient_balance`: the configured account cannot pay. Not a
    // broken credential and not transient — an operator must repair the deployment (OpenAI 429
    // insufficient_quota, DeepSeek 402 Insufficient Balance). Stage 6 names this precisely:
    // `PROVIDER_BALANCE_EXHAUSTED` (a different provider with a different wallet may still serve).
    return { category: 'AUTH', reason: 'PROVIDER_BALANCE_EXHAUSTED', ...base };
  }

  const status = input.status;
  if (status === 401 || status === 403) {
    return { category: 'AUTH', reason: 'PROVIDER_AUTH_FAILED', ...base };
  }
  if (status === 402) {
    // DeepSeek documents 402 "Insufficient Balance" — the account cannot pay.
    return { category: 'AUTH', reason: 'PROVIDER_BALANCE_EXHAUSTED', ...base };
  }
  if (status === 429) {
    return { category: 'RATE_LIMIT', reason: 'PROVIDER_THROTTLED', ...base };
  }
  if (status === 408) {
    return { category: 'UPSTREAM', reason: 'PROVIDER_TIMEOUT', ...base };
  }
  if (status === 503) {
    return { category: 'OVERLOADED', reason: 'PROVIDER_OVERLOADED', ...base };
  }
  if (status === 504) {
    return { category: 'UPSTREAM', reason: 'PROVIDER_TIMEOUT', ...base };
  }
  if (status >= 500) {
    return { category: 'UPSTREAM', reason: 'PROVIDER_UNAVAILABLE', ...base };
  }
  return { category: 'BAD_REQUEST', reason: 'PROVIDER_REQUEST_REJECTED', ...base };
}

/** A malformed success body. `INVALID_RESPONSE` semantics: upstream garbage, usually transient. */
export function malformedResponseError(rawMessage: string): ProviderRawError {
  return { category: 'UPSTREAM', reason: 'PROVIDER_BAD_RESPONSE', dispatched: true, rawMessage };
}

/**
 * Map a vendor `finish_reason` to the closed set. An unknown spelling (`tool_calls`,
 * `repetition_truncation`, …) is `UNKNOWN`, never guessed.
 */
export function mapFinishReason(value: unknown): AiFinishReason {
  if (value === 'stop') return 'STOP';
  if (value === 'length') return 'LENGTH';
  if (value === 'content_filter') return 'CONTENT_FILTER';
  return 'UNKNOWN';
}

function finiteOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Map vendor token counts to `AiUsage`. Every field stays optional: absent means *unknown*, never
 * zero (ARCHITECTURE.md §5.1). `completion_tokens_details.reasoning_tokens` is projected as a
 * **count** only (DeepSeek and other chat dialects report it); reasoning **content** never leaves
 * `extractChatText`'s discard path.
 */
export function mapUsage(value: unknown): AiUsage {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {};
  }
  const record = value as Record<string, unknown>;
  const details = record['prompt_tokens_details'];
  const cached = typeof details === 'object' && details !== null && !Array.isArray(details)
    ? finiteOrUndefined((details as Record<string, unknown>)['cached_tokens'])
    : undefined;
  const completionDetails = record['completion_tokens_details'];
  const reasoning =
    typeof completionDetails === 'object' && completionDetails !== null && !Array.isArray(completionDetails)
      ? finiteOrUndefined((completionDetails as Record<string, unknown>)['reasoning_tokens'])
      : undefined;
  const inputTokens = finiteOrUndefined(record['prompt_tokens']);
  const outputTokens = finiteOrUndefined(record['completion_tokens']);
  const totalTokens = finiteOrUndefined(record['total_tokens']);
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(cached === undefined ? {} : { cachedTokens: cached }),
    ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
  };
}

/** The chat-completion body fields this adapter reads. Provider-shaped on purpose. */
export type VendorChatCompletion = {
  readonly choices?: readonly {
    readonly message?: { readonly content?: unknown };
    readonly delta?: { readonly content?: unknown };
    readonly finish_reason?: unknown;
  }[];
  readonly usage?: unknown;
  readonly error?: unknown;
};

export function parseVendorJson(text: string): VendorChatCompletion | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    return parsed as VendorChatCompletion;
  } catch {
    return null;
  }
}

/**
 * An incremental SSE parser for the vendor's `data:` framing.
 *
 * Frame boundaries and `[DONE]` are provider conventions and stay here; what escapes is a list of
 * raw `data:` payloads, ready to be mapped to `ProviderStreamEvent`s.
 */
export class SseStreamParser {
  #buffer = '';
  readonly #decoder = new TextDecoder();

  /** Feed a chunk; returns the payloads of every event completed by it. */
  push(chunk: Uint8Array): readonly string[] {
    this.#buffer += this.#decoder.decode(chunk, { stream: true });
    return this.#drain();
  }

  /** Flush the trailing event, if the stream ended without a final blank line. */
  flush(): readonly string[] {
    this.#buffer += this.#decoder.decode();
    const payloads = this.#drain();
    if (this.#buffer.trim().length > 0) {
      const trailing = extractData(this.#buffer);
      this.#buffer = '';
      return trailing.length > 0 ? [...payloads, trailing] : payloads;
    }
    return payloads;
  }

  #drain(): readonly string[] {
    const payloads: string[] = [];
    for (;;) {
      const separator = /\r?\n\r?\n/.exec(this.#buffer);
      if (separator === null || separator.index === undefined) {
        break;
      }
      const rawEvent = this.#buffer.slice(0, separator.index);
      this.#buffer = this.#buffer.slice(separator.index + separator[0].length);
      const data = extractData(rawEvent);
      if (data.length > 0) {
        payloads.push(data);
      }
    }
    return payloads;
  }
}

function extractData(rawEvent: string): string {
  const dataLines = rawEvent
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).replace(/^ /, ''));
  return dataLines.join('\n');
}
