/**
 * `OpenAiCompatibleAdapter` — the Stage 3 **reference provider adapter**.
 *
 * Exactly one adapter ships this stage: enough to prove the adapter architecture against a real
 * provider, not a provider marketplace (ROADMAP Stage 3 §2).
 *
 * Provider-specific facts — the `/chat/completions` payload, the `Authorization` header, the base
 * URL, the vendor response shape and the vendor error body — are confined to this file and
 * `http.ts`. What crosses back is AI Bridge's own shape (`ProviderTextResult`,
 * `ProviderStreamEvent`, `ProviderRawError`), and the credential never crosses at all: it is
 * bound once through `bindCredentials`, held in a private field, excluded from serialization, and
 * placed only in the outbound `Authorization` header (SECURITY.md §2).
 */
import {
  PROVIDER_ADAPTER_API_VERSION,
  ProviderCallError,
  renderContextBlock,
  type AiProviderAdapter,
  type AiFinishReason,
  type AiUsage,
  type ProviderDescriptor,
  type ProviderRawError,
  type ProviderRequest,
  type ProviderStreamEvent,
  type ProviderStructuredResult,
  type ProviderTextResult,
  type TrustedCredentials,
} from '@aibridge/contracts';
import type {
  FetchLike,
  FetchRequestInitLike,
  FetchResponseLike,
  OpenAiCompatibleConfig,
  OpenAiCompatibleModelConfig,
} from './config.js';
import {
  SseStreamParser,
  classifyHttpFailure,
  malformedResponseError,
  mapFinishReason,
  mapUsage,
  parseRetryAfterMs,
  parseVendorJson,
  type VendorChatCompletion,
} from './http.js';

const DONE_PAYLOAD = '[DONE]';

function buildDescriptor(config: OpenAiCompatibleConfig): ProviderDescriptor {
  return {
    id: config.id,
    family: 'openai-compatible',
    features: [...(config.features ?? ['text', 'usage'])],
    models: config.models.map((model: OpenAiCompatibleModelConfig) => ({
      providerId: config.id,
      modelRef: model.modelRef,
      displayName: model.displayName ?? model.modelRef,
      features: [...model.features],
      maxContextTokens: model.maxContextTokens,
      maxOutputTokens: model.maxOutputTokens,
      profiles: [...(model.profiles ?? ['balanced'])],
      ...(model.pricing === undefined ? {} : { pricing: model.pricing }),
    })),
    maxConcurrency: config.maxConcurrency ?? 4,
    supportsIdempotency: false,
  };
}

/** Mutable per-stream state. Deliberately local to one `streamText` call. */
type StreamState = {
  usage: AiUsage;
  finishReason: AiFinishReason;
  finished: boolean;
};

export class OpenAiCompatibleAdapter implements AiProviderAdapter {
  readonly id: string;
  readonly family = 'openai-compatible' as const;
  readonly adapterApiVersion = PROVIDER_ADAPTER_API_VERSION;
  readonly descriptor: ProviderDescriptor;

  readonly #baseUrl: string;
  readonly #fetch: FetchLike;
  readonly #nowMs: () => number;
  /**
   * The resolved credential. Private, never serialized, never returned, never logged.
   * `#credentialHandle` (the operator-side reference) is safe to log; the value is not.
   */
  #secret: string | null = null;
  #credentialHandle: string | null = null;

  constructor(config: OpenAiCompatibleConfig) {
    this.id = config.id;
    this.#baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.#fetch = config.fetch ?? (globalThis as unknown as { fetch: FetchLike }).fetch;
    this.#nowMs = config.nowMs ?? ((): number => Date.now());
    this.descriptor = buildDescriptor(config);
  }

  /**
   * Trusted credential binding — the only door a secret value enters through.
   *
   * The handle is kept for operator correlation; the value serves the outbound `Authorization`
   * header only and is excluded from every serialization.
   */
  bindCredentials(credentials: TrustedCredentials): void {
    this.#secret = credentials.secret;
    this.#credentialHandle = credentials.handle;
  }

  /** The operator-side credential handle, or `null`. Safe to log; the value never is. */
  get credentialHandle(): string | null {
    return this.#credentialHandle;
  }

  toJSON(): { readonly kind: string; readonly id: string; readonly credential: string } {
    return {
      kind: 'OpenAiCompatibleAdapter',
      id: this.id,
      credential: this.#secret === null ? 'unbound' : '[REDACTED]',
    };
  }

  toString(): string {
    return `[REDACTED] OpenAiCompatibleAdapter(${this.id})`;
  }

  async generateText(request: ProviderRequest): Promise<ProviderTextResult> {
    const response = await this.#send(request, false);
    return this.#toTextResult(await this.#readCompletion(response));
  }

  async generateStructured(request: ProviderRequest): Promise<ProviderStructuredResult> {
    const response = await this.#send(request, false);
    const result = this.#toTextResult(await this.#readCompletion(response));
    return { text: result.text, usage: result.usage, finishReason: result.finishReason };
  }

  /**
   * SSE in, AI Bridge's own `ProviderStreamEvent`s out. Exactly one terminal event (`FINISH` xor
   * `ERROR`): a mapped failure is an `ERROR` event, never a vendor frame.
   */
  async *streamText(request: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
    let response: FetchResponseLike;
    try {
      response = await this.#send(request, true);
    } catch (error) {
      if (error instanceof ProviderCallError) {
        yield { kind: 'ERROR', error: error.rawError };
        return;
      }
      throw error;
    }

    const body = response.body;
    if (body === undefined || body === null) {
      yield { kind: 'ERROR', error: malformedResponseError('the streaming response had no body') };
      return;
    }

    const parser = new SseStreamParser();
    const state: StreamState = { usage: {}, finishReason: 'UNKNOWN', finished: false };
    const reader = body.getReader();
    try {
      for (;;) {
        const chunk = await reader.read();
        const payloads = chunk.done ? parser.flush() : parser.push(chunk.value ?? new Uint8Array());
        for (const payload of payloads) {
          const outcome = consumePayload(payload, state);
          if (outcome.event !== null) {
            yield outcome.event;
          }
          if (outcome.terminal) {
            return;
          }
        }
        if (chunk.done) {
          break;
        }
      }
    } finally {
      reader.releaseLock?.();
    }

    if (!state.finished) {
      yield { kind: 'ERROR', error: malformedResponseError('the stream ended without a finish event') };
      return;
    }
    yield { kind: 'FINISH', usage: state.usage, finishReason: state.finishReason };
  }

  /* -------------------------------------------------------------------------------------------
   * Provider-specific internals
   * ---------------------------------------------------------------------------------------- */

  /** Build the vendor payload and perform the call. Everything vendor-shaped happens here. */
  async #send(request: ProviderRequest, stream: boolean): Promise<FetchResponseLike> {
    const controller = new AbortController();
    let abortedByDeadline = false;
    const unsubscribe = request.cancellation?.onCancel(() => controller.abort()) ?? ((): void => undefined);
    const timer = setTimeout(() => {
      abortedByDeadline = true;
      controller.abort();
    }, Math.max(0, request.deadlineAtMs - this.#nowMs()));
    try {
      const messages: ReadonlyArray<Record<string, unknown>> = [
        {
          role: 'system',
          content:
            request.outputFormatInstruction === undefined
              ? request.instructions
              : `${request.instructions}\n\n${request.outputFormatInstruction}`,
        },
        ...(request.context.length > 0 ? [{ role: 'user', content: renderContextBlock(request.context) }] : []),
      ];
      const payload: Record<string, unknown> = {
        model: request.modelRef,
        messages,
        ...(request.maxOutputTokens === undefined ? {} : { max_tokens: request.maxOutputTokens }),
        ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
      };
      const init: FetchRequestInitLike = {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.#secret === null ? {} : { authorization: `Bearer ${this.#secret}` }),
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      };

      let response: FetchResponseLike;
      try {
        response = await this.#fetch(`${this.#baseUrl}/chat/completions`, init);
      } catch {
        // Transport failure (DNS, TLS, socket, abort). The platform message never propagates.
        throw new ProviderCallError(
          abortedByDeadline
            ? { category: 'UPSTREAM', reason: 'PROVIDER_TIMEOUT', rawMessage: 'the outbound call was abandoned at its deadline' }
            : { category: 'UPSTREAM', reason: 'PROVIDER_UNAVAILABLE', rawMessage: 'transport failure' },
        );
      }
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        const body = parseVendorJson(text) ?? {};
        const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
        throw new ProviderCallError(
          classifyHttpFailure({
            status: response.status,
            body: body as { error?: { type?: unknown; code?: unknown; message?: unknown } },
            ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
          }),
        );
      }
      return response;
    } finally {
      clearTimeout(timer);
      unsubscribe();
    }
  }

  async #readCompletion(response: FetchResponseLike): Promise<VendorChatCompletion> {
    const text = await response.text().catch(() => '');
    const completion = parseVendorJson(text);
    if (completion === null) {
      throw new ProviderCallError(malformedResponseError('the response body was not JSON'));
    }
    return completion;
  }

  #toTextResult(completion: VendorChatCompletion): ProviderTextResult {
    const choice = completion.choices?.[0];
    const finishReason = mapFinishReason(choice?.finish_reason);
    const content = choice?.message?.content;
    if (typeof content === 'string') {
      return { text: content, usage: mapUsage(completion.usage), finishReason };
    }
    if (finishReason === 'CONTENT_FILTER') {
      // A filtered answer is a signal for the consumer's guard, not an error (ARCHITECTURE.md §5.3).
      return { text: '', usage: mapUsage(completion.usage), finishReason };
    }
    throw new ProviderCallError(malformedResponseError('the response carried no message content'));
  }
}

/**
 * Consume one SSE `data:` payload. Returns the event to emit (delta or terminal error) and
 * whether the stream is over. Vendor frames are read and discarded here.
 */
function consumePayload(
  payload: string,
  state: StreamState,
): { readonly event: ProviderStreamEvent | null; readonly terminal: boolean } {
  if (payload.trim() === DONE_PAYLOAD) {
    return { event: null, terminal: false };
  }
  const completion = parseVendorJson(payload);
  if (completion === null) {
    return { event: { kind: 'ERROR', error: malformedResponseError('a streamed frame was not JSON') }, terminal: true };
  }
  const vendorError = completion.error;
  if (vendorError !== undefined && vendorError !== null) {
    return {
      event: {
        kind: 'ERROR',
        error: classifyHttpFailure({
          status: 500,
          body: { error: vendorError as { type?: unknown; code?: unknown; message?: unknown } },
        }),
      },
      terminal: true,
    };
  }
  state.usage = { ...state.usage, ...mapUsage(completion.usage) };
  const choice = completion.choices?.[0];
  if (choice === undefined) {
    return { event: null, terminal: false };
  }
  const delta = choice.delta?.content;
  if (typeof delta === 'string' && delta.length > 0) {
    return { event: { kind: 'TEXT_DELTA', text: delta }, terminal: false };
  }
  if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
    state.finishReason = mapFinishReason(choice.finish_reason);
    state.finished = true;
  }
  return { event: null, terminal: false };
}

/** Exported for the conformance tests: the mapped failure a raw error body produces. */
export function classifyVendorErrorBody(body: unknown): ProviderRawError {
  return classifyHttpFailure({
    status: 400,
    body: body as { error?: { type?: unknown; code?: unknown; message?: unknown } },
  });
}
