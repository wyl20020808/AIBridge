/**
 * OpenAI **Responses API** wire translation — provider-specific and contained.
 *
 * This is deliberately its own wire path (ROADMAP Stage 4 §3): request shape (`instructions` +
 * `input`), `text.format` structured outputs, semantic SSE events, the response object, usage
 * fields and the vendor error body all differ from the Chat-Completions dialect and none of them
 * may cross the provider port.
 *
 * Reference: OpenAI docs — Responses API, Structured Outputs (`text.format`), streaming semantic
 * events, error object `{ error: { message, type, param, code } }`, `Authorization: Bearer`.
 */
import { ProviderCallError, type AiFinishReason, type AiUsage, type ProviderRawError } from '@aibridge/contracts';
import { SECRET_PATTERNS, checkEndpointSafety } from '@aibridge/core';
import type {
  FetchLike,
  FetchRequestInitLike,
  FetchResponseLike,
  ResponsesReasoningEffort,
} from './config.js';

/** The minimal WHATWG URL surface. Type-only; erased at emit. */
type UrlLike = { readonly href: string };
declare const URL: { new (input: string, base?: string): UrlLike };

export const MAX_REDIRECTS = 3;
export const RAW_MESSAGE_MAX_LENGTH = 512;

/* -------------------------------------------------------------------------------------------------
 * Operator-only detail
 * ----------------------------------------------------------------------------------------------- */

export function sanitizeRawMessage(message: string, boundSecrets: readonly string[] = []): string {
  let redacted = message;
  for (const secret of boundSecrets) {
    if (secret.length > 0) {
      redacted = redacted.split(secret).join('[REDACTED]');
    }
  }
  for (const secret of SECRET_PATTERNS) {
    const flags = secret.pattern.flags.includes('g') ? secret.pattern.flags : `${secret.pattern.flags}g`;
    redacted = redacted.replace(new RegExp(secret.pattern.source, flags), `[REDACTED:${secret.id}]`);
  }
  return redacted.slice(0, RAW_MESSAGE_MAX_LENGTH);
}

/* -------------------------------------------------------------------------------------------------
 * Request
 * ----------------------------------------------------------------------------------------------- */

export type ResponsesRequestInput = {
  readonly modelRef: string;
  /** Trusted instruction channel → Responses `instructions` (developer role). */
  readonly instructions: string;
  /** The data channel, already rendered as fenced data text. */
  readonly dataBlock: string;
  readonly maxOutputTokens?: number;
  readonly reasoningEffort?: ResponsesReasoningEffort;
  /** Native strict JSON Schema, or JSON mode, or nothing. */
  readonly format?:
    | { readonly kind: 'JSON_SCHEMA'; readonly name: string; readonly schema: Record<string, unknown> }
    | { readonly kind: 'JSON_OBJECT' };
};

/**
 * Build the Responses payload. Two channels stay distinct on the wire: `instructions` is the
 * trusted channel and `input` carries the fenced data block as a user message.
 */
export function buildResponsesPayload(
  input: ResponsesRequestInput,
  options: { readonly stream: boolean },
): Record<string, unknown> {
  return {
    model: input.modelRef,
    instructions: input.instructions,
    input: input.dataBlock.length > 0 ? [{ role: 'user', content: input.dataBlock }] : [],
    ...(input.maxOutputTokens === undefined ? {} : { max_output_tokens: input.maxOutputTokens }),
    ...(input.reasoningEffort === undefined ? {} : { reasoning: { effort: input.reasoningEffort } }),
    ...(input.format === undefined
      ? {}
      : input.format.kind === 'JSON_OBJECT'
        ? { text: { format: { type: 'json_object' } } }
        : {
            text: {
              format: { type: 'json_schema', name: input.format.name, strict: true, schema: input.format.schema },
            },
          }),
    ...(options.stream ? { stream: true } : {}),
  };
}

/* -------------------------------------------------------------------------------------------------
 * Transport (self-declared; independent of the chat dialect by design)
 * ----------------------------------------------------------------------------------------------- */

export type SendOptions = {
  readonly fetch: FetchLike;
  readonly url: string;
  readonly method: 'POST' | 'GET';
  readonly body?: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly deadlineAtMs: number;
  readonly nowMs: () => number;
  readonly cancellation?: { readonly cancelled: boolean; readonly onCancel: (callback: () => void) => () => void };
  readonly allowPrivateNetworkForDevelopment?: boolean;
};

/** POST/GET with an abort scope and bounded, re-validated redirects. Non-2xx is classified. */
export async function sendRequest(options: SendOptions): Promise<FetchResponseLike> {
  const safety = checkEndpointSafety(options.url, {
    ...(options.allowPrivateNetworkForDevelopment === undefined
      ? {}
      : { allowPrivateNetworkForDevelopment: options.allowPrivateNetworkForDevelopment }),
  });
  if (!safety.safe) {
    // `dispatched: false` — provably nothing left this process.
    throw new ProviderCallError({
      category: 'BAD_REQUEST',
      reason: 'PROVIDER_REQUEST_REJECTED',
      dispatched: false,
      rawMessage: `unsafe endpoint (${safety.rejection})`,
    });
  }

  const controller = new AbortController();
  let abortedByDeadline = false;
  const unsubscribe = options.cancellation?.onCancel(() => controller.abort()) ?? ((): void => undefined);
  const timer = setTimeout(() => {
    abortedByDeadline = true;
    controller.abort();
  }, Math.max(0, options.deadlineAtMs - options.nowMs()));

  try {
    let url = options.url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const init: FetchRequestInitLike = {
        method: options.method,
        headers: options.headers,
        ...(options.body === undefined ? {} : { body: options.body }),
        signal: controller.signal,
        redirect: 'manual',
      };
      let response: FetchResponseLike;
      try {
        response = await options.fetch(url, init);
      } catch {
        // No `dispatched` marker: an unknown outcome is never assumed safe to repeat.
        throw new ProviderCallError(
          abortedByDeadline
            ? { category: 'UPSTREAM', reason: 'PROVIDER_TIMEOUT', rawMessage: 'the outbound call was abandoned at its deadline' }
            : { category: 'UPSTREAM', reason: 'PROVIDER_UNAVAILABLE', rawMessage: 'transport failure' },
        );
      }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (location === null || location.length === 0) {
          throw new ProviderCallError({ category: 'UPSTREAM', reason: 'PROVIDER_BAD_RESPONSE', dispatched: true, rawMessage: 'redirect without a Location header' });
        }
        let target: string;
        try {
          target = new URL(location, url).href;
        } catch {
          throw new ProviderCallError({ category: 'UPSTREAM', reason: 'PROVIDER_BAD_RESPONSE', dispatched: true, rawMessage: 'unparseable redirect target' });
        }
        const next = checkEndpointSafety(target, {
          ...(options.allowPrivateNetworkForDevelopment === undefined
            ? {}
            : { allowPrivateNetworkForDevelopment: options.allowPrivateNetworkForDevelopment }),
        });
        if (!next.safe) {
          throw new ProviderCallError({
            category: 'BAD_REQUEST',
            reason: 'PROVIDER_REQUEST_REJECTED',
            dispatched: true,
            rawMessage: `unsafe redirect target (${next.rejection})`,
          });
        }
        url = target;
        continue;
      }
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        const body = parseOpenAiJson(text) ?? {};
        const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
        throw new ProviderCallError(
          classifyOpenAiFailure({
            status: response.status,
            body: body as { error?: { message?: unknown; type?: unknown; code?: unknown } },
            ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
          }),
        );
      }
      return response;
    }
    throw new ProviderCallError({ category: 'UPSTREAM', reason: 'PROVIDER_BAD_RESPONSE', dispatched: true, rawMessage: 'too many redirects' });
  } finally {
    clearTimeout(timer);
    unsubscribe();
  }
}

export function parseRetryAfterMs(headerValue: string | null): number | undefined {
  if (headerValue === null) {
    return undefined;
  }
  const seconds = Number(headerValue.trim());
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : undefined;
}

/* -------------------------------------------------------------------------------------------------
 * Errors — OpenAI error object → mapped facts. Vendor prose stays operator-only.
 * ----------------------------------------------------------------------------------------------- */

export function parseOpenAiJson(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function malformedResponseError(rawMessage: string): ProviderRawError {
  return { category: 'UPSTREAM', reason: 'PROVIDER_BAD_RESPONSE', dispatched: true, rawMessage };
}

export function classifyOpenAiFailure(input: {
  readonly status: number;
  readonly body: { readonly error?: { readonly message?: unknown; readonly type?: unknown; readonly code?: unknown } };
  readonly retryAfterMs?: number;
}): ProviderRawError {
  const type = typeof input.body.error?.type === 'string' ? input.body.error.type : '';
  const code = typeof input.body.error?.code === 'string' ? input.body.error.code : '';
  const message = typeof input.body.error?.message === 'string' ? input.body.error.message : undefined;
  const shape = `${type} ${code}`.toLowerCase();
  // A response arrived: the outcome is **known** (not accepted).
  const base = {
    dispatched: true,
    ...(message === undefined ? {} : { rawMessage: message }),
    ...(input.retryAfterMs === undefined ? {} : { retryAfterMs: input.retryAfterMs }),
  };
  if (shape.includes('model_not_found') || shape.includes('invalid_model')) {
    return { category: 'BAD_REQUEST', reason: 'MODEL_UNAVAILABLE', ...base };
  }
  if (shape.includes('insufficient')) {
    return { category: 'AUTH', reason: 'PROVIDER_AUTH_FAILED', ...base };
  }
  if (shape.includes('rate_limit') || shape.includes('over_rate')) {
    return { category: 'RATE_LIMIT', reason: 'PROVIDER_THROTTLED', ...base };
  }
  if (shape.includes('overloaded')) {
    return { category: 'OVERLOADED', reason: 'PROVIDER_OVERLOADED', ...base };
  }
  if (shape.includes('content_filter')) {
    return { category: 'CONTENT_FILTER', reason: 'PROVIDER_CONTENT_FILTER', ...base };
  }

  const status = input.status;
  if (status === 401 || status === 403) {
    return { category: 'AUTH', reason: 'PROVIDER_AUTH_FAILED', ...base };
  }
  if (status === 429) {
    return { category: 'RATE_LIMIT', reason: 'PROVIDER_THROTTLED', ...base };
  }
  if (status === 408 || status === 504) {
    return { category: 'UPSTREAM', reason: 'PROVIDER_TIMEOUT', ...base };
  }
  if (status === 503) {
    return { category: 'OVERLOADED', reason: 'PROVIDER_OVERLOADED', ...base };
  }
  if (status >= 500) {
    return { category: 'UPSTREAM', reason: 'PROVIDER_UNAVAILABLE', ...base };
  }
  return { category: 'BAD_REQUEST', reason: 'PROVIDER_REQUEST_REJECTED', ...base };
}

/* -------------------------------------------------------------------------------------------------
 * Response
 * ----------------------------------------------------------------------------------------------- */

export type ResponsesTextOutcome = {
  readonly text: string;
  readonly refused: boolean;
  /** False when the response carried no `output_text` item at all — malformed, not empty. */
  readonly hasText: boolean;
};

/**
 * Extract the final answer from a Responses object.
 *
 * **Reasoning isolation**: `output` items of type `reasoning` (chain-of-thought / summaries) are
 * skipped — only `output_text` content crosses. A refusal is a signal, not an error.
 */
export function extractResponseText(response: {
  readonly output?: readonly {
    readonly type?: unknown;
    readonly content?: readonly { readonly type?: unknown; readonly text?: unknown; readonly refusal?: unknown }[];
  }[];
}): ResponsesTextOutcome {
  let text = '';
  let hasText = false;
  let refused = false;
  for (const item of response.output ?? []) {
    if (item.type !== 'message') {
      // `reasoning` (and tool) items are never output.
      continue;
    }
    for (const part of item.content ?? []) {
      if (part.type === 'output_text' && typeof part.text === 'string') {
        text += part.text;
        hasText = true;
      } else if (part.type === 'output_refusal') {
        refused = true;
      }
    }
  }
  return { text, refused, hasText };
}

export function mapResponsesUsage(value: unknown): AiUsage {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {};
  }
  const record = value as Record<string, unknown>;
  const details = record['input_tokens_details'];
  const cached =
    typeof details === 'object' && details !== null && !Array.isArray(details)
      ? finiteOrUndefined((details as Record<string, unknown>)['cached_tokens'])
      : undefined;
  const outputDetails = record['output_tokens_details'];
  const reasoning =
    typeof outputDetails === 'object' && outputDetails !== null && !Array.isArray(outputDetails)
      ? finiteOrUndefined((outputDetails as Record<string, unknown>)['reasoning_tokens'])
      : undefined;
  const inputTokens = finiteOrUndefined(record['input_tokens']);
  const outputTokens = finiteOrUndefined(record['output_tokens']);
  const totalTokens = finiteOrUndefined(record['total_tokens']);
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(cached === undefined ? {} : { cachedTokens: cached }),
    ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
  };
}

function finiteOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Map the Responses lifecycle to the closed finish set. `incomplete_details.reason` decides
 * between `LENGTH` and `CONTENT_FILTER`; an unknown spelling is `UNKNOWN`, never guessed.
 */
export function mapResponsesFinish(input: {
  readonly status?: unknown;
  readonly incompleteReason?: unknown;
  readonly refused: boolean;
}): AiFinishReason {
  if (input.refused) {
    return 'CONTENT_FILTER';
  }
  if (input.status === 'completed') {
    return 'STOP';
  }
  if (input.status === 'incomplete') {
    if (input.incompleteReason === 'max_output_tokens') return 'LENGTH';
    if (input.incompleteReason === 'content_filter') return 'CONTENT_FILTER';
    return 'UNKNOWN';
  }
  return 'UNKNOWN';
}

/* -------------------------------------------------------------------------------------------------
 * Streaming — semantic SSE events → generic outcomes. Vendor event types stop here.
 * ----------------------------------------------------------------------------------------------- */

/** Incremental SSE frame parser (`data:` payloads). Independent of the chat dialect on purpose. */
export class SseFrameParser {
  #buffer = '';
  readonly #decoder = new TextDecoder();

  push(chunk: Uint8Array): readonly string[] {
    this.#buffer += this.#decoder.decode(chunk, { stream: true });
    const payloads: string[] = [];
    for (;;) {
      const separator = /\r?\n\r?\n/.exec(this.#buffer);
      if (separator === null || separator.index === undefined) {
        break;
      }
      const rawEvent = this.#buffer.slice(0, separator.index);
      this.#buffer = this.#buffer.slice(separator.index + separator[0].length);
      const data = rawEvent
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, ''))
        .join('\n');
      if (data.length > 0) {
        payloads.push(data);
      }
    }
    return payloads;
  }

  flush(): readonly string[] {
    this.#buffer += this.#decoder.decode();
    const trailing = this.#buffer.trim().length > 0
      ? this.#buffer
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).replace(/^ /, ''))
          .join('\n')
      : '';
    this.#buffer = '';
    return trailing.length > 0 ? [trailing] : [];
  }
}

export type StreamState = {
  usage: AiUsage;
  finishReason: AiFinishReason;
  finished: boolean;
  refused: boolean;
};

export type ResponsesEventOutcome =
  | { readonly kind: 'DELTA'; readonly text: string }
  | { readonly kind: 'FINISH' }
  | { readonly kind: 'ERROR'; readonly rawError: ProviderRawError }
  | { readonly kind: 'IGNORED' };

/**
 * Consume one semantic stream event. Only `response.output_text.delta` produces text —
 * `response.reasoning_text.delta` (chain-of-thought) is deliberately dropped. Terminal events are
 * `response.completed` / `response.incomplete` / `response.failed` / `error`.
 */
export function consumeResponsesEvent(payload: string, state: StreamState): ResponsesEventOutcome {
  const event = parseOpenAiJson(payload);
  if (event === null) {
    return { kind: 'ERROR', rawError: malformedResponseError('a streamed frame was not JSON') };
  }
  const type = event['type'];
  if (typeof type !== 'string') {
    return { kind: 'IGNORED' };
  }
  if (type === 'response.output_text.delta') {
    const delta = event['delta'];
    return typeof delta === 'string' && delta.length > 0 ? { kind: 'DELTA', text: delta } : { kind: 'IGNORED' };
  }
  if (type === 'response.refusal.delta') {
    state.refused = true;
    return { kind: 'IGNORED' };
  }
  if (type === 'response.reasoning_text.delta' || type === 'response.reasoning_summary_text.delta') {
    // Chain-of-thought is never forwarded.
    return { kind: 'IGNORED' };
  }
  if (type === 'response.completed' || type === 'response.incomplete') {
    const response = event['response'];
    const record = (typeof response === 'object' && response !== null && !Array.isArray(response)
      ? response
      : {}) as Record<string, unknown>;
    const incomplete = record['incomplete_details'];
    const incompleteReason =
      typeof incomplete === 'object' && incomplete !== null && !Array.isArray(incomplete)
        ? (incomplete as Record<string, unknown>)['reason']
        : undefined;
    state.usage = { ...state.usage, ...mapResponsesUsage(record['usage']) };
    state.finishReason = mapResponsesFinish({
      status: record['status'] ?? type.slice('response.'.length),
      incompleteReason,
      refused: state.refused,
    });
    state.finished = true;
    return { kind: 'FINISH' };
  }
  if (type === 'response.failed') {
    const response = event['response'];
    const record = (typeof response === 'object' && response !== null && !Array.isArray(response)
      ? response
      : {}) as Record<string, unknown>;
    const error = record['error'];
    return {
      kind: 'ERROR',
      rawError: classifyOpenAiFailure({
        status: 500,
        body: { error: (typeof error === 'object' && error !== null ? error : {}) as { message?: unknown; type?: unknown; code?: unknown } },
      }),
    };
  }
  if (type === 'error') {
    return {
      kind: 'ERROR',
      rawError: classifyOpenAiFailure({
        status: 500,
        body: { error: { message: event['message'], type: event['code'], code: event['code'] } },
      }),
    };
  }
  return { kind: 'IGNORED' };
}
