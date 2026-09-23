/**
 * `DeepSeekAdapter` — the **DeepSeek Official API** adapter (ROADMAP Stage 4 §7–11).
 *
 * DeepSeek speaks an OpenAI-compatible chat protocol, but its semantics are its own, so this is a
 * dedicated adapter over the internal wire layer — not a configuration of the relay:
 *
 *  - **Thinking** (official docs): `thinking: { type: 'enabled' | 'disabled' }` plus
 *    `reasoning_effort: 'low' | 'high' | 'max'`. The profile → thinking mapping is explicit,
 *    configurable and tested; a profile that is not mapped is **disabled**, never silently `high`.
 *  - **Reasoning isolation**: the chain-of-thought comes back as `reasoning_content` beside
 *    `content`. It is discarded by the wire layer — never output, never persisted, never sent to a
 *    consumer.
 *  - **Structured output**: Chat Completions offers `response_format: { type: 'json_object' }`,
 *    which guarantees *valid JSON*, **not** schema adherence. This adapter therefore never claims
 *    `jsonSchema`; the AI Bridge extractor + strict validator decide success.
 *  - **Errors** (official table): 400 invalid format, 401 auth, 402 insufficient balance,
 *    422 invalid parameters, 429 rate limit, 500 server error, 503 overloaded — mapped to the
 *    generic vocabulary.
 *
 * No model ID is hardcoded; model references come from trusted host configuration.
 */
import {
  PROVIDER_ADAPTER_API_VERSION,
  ProviderCallError,
  type AiProviderAdapter,
  type CancellationToken,
  type ProviderDescriptor,
  type ProviderHealth,
  type ProviderRequest,
  type ProviderStreamEvent,
  type ProviderStructuredResult,
  type ProviderTextResult,
  type ModelProfile,
  type ProviderFeature,
  type ProviderPricing,
  type TrustedCredentials,
} from '@aibridge/contracts';
import { checkEndpointSafety } from '@aibridge/core';
import {
  SseStreamParser,
  authHeaders,
  buildChatMessages,
  classifyHttpFailure,
  consumeChatChunk,
  extractChatText,
  malformedResponseError,
  mapFinishReason,
  mapUsage,
  parseVendorJson,
  resolveThinking,
  sanitizeRawMessage,
  sendGet,
  sendPost,
  type AuthScheme,
  type FetchLike,
  type FetchResponseLike,
  type ThinkingMapping,
  type VendorChatCompletion,
} from '@aibridge/provider-openai-compatible';

const DONE_PAYLOAD = '[DONE]';

/**
 * The documented default thinking mapping: `reasoning` and `high-context` profiles think at the
 * documented default effort; every other profile explicitly disables thinking (DeepSeek enables
 * thinking by default server-side, so "unset" would silently think). Operators override this.
 */
export const DEFAULT_DEEPSEEK_THINKING: ThinkingMapping = {
  effortByProfile: { reasoning: 'default', 'high-context': 'default' },
};

/** The DeepSeek Official preset: wire and safe-auth defaults only. Never a business policy. */
export const DEEPSEEK_PRESET = {
  preset: 'DEEPSEEK_OFFICIAL',
  defaultBaseUrl: 'https://api.deepseek.com',
  authScheme: 'BEARER' as AuthScheme,
  wireProtocol: 'OPENAI_CHAT_COMPLETIONS' as const,
  maxTokensField: 'max_tokens' as const,
  /** Chat Completions JSON Output is *valid JSON*, never strict schema adherence. */
  structuredOutput: 'JSON_OBJECT' as const,
  thinking: DEFAULT_DEEPSEEK_THINKING,
};

export type DeepSeekModelConfig = {
  readonly modelRef: string;
  readonly displayName?: string;
  readonly features: readonly ProviderFeature[];
  readonly maxContextTokens: number;
  readonly maxOutputTokens: number;
  readonly profiles?: readonly ModelProfile[];
  readonly pricing?: ProviderPricing;
};

export type DeepSeekConfig = {
  readonly id: string;
  /** Trusted base URL (the preset default is `https://api.deepseek.com`). SSRF-validated. */
  readonly baseUrl: string;
  readonly models: readonly DeepSeekModelConfig[];
  readonly features?: readonly ProviderFeature[];
  readonly maxConcurrency?: number;
  readonly fetch?: FetchLike;
  readonly nowMs?: () => number;
  /** Explicit profile → thinking mapping. Defaults to `DEFAULT_DEEPSEEK_THINKING`. */
  readonly thinking?: ThinkingMapping;
  readonly authScheme?: AuthScheme;
  /** JSON Output mode or prompt-only. `JSON_SCHEMA` is rejected — DeepSeek does not offer it here. */
  readonly structuredOutput?: 'JSON_OBJECT' | 'PROMPT_ONLY';
  readonly allowPrivateNetworkForDevelopment?: boolean;
};

export class DeepSeekAdapter implements AiProviderAdapter {
  readonly id: string;
  readonly family = 'openai-compatible' as const;
  readonly adapterApiVersion = PROVIDER_ADAPTER_API_VERSION;
  readonly descriptor: ProviderDescriptor;

  readonly #baseUrl: string;
  readonly #fetch: FetchLike;
  readonly #nowMs: () => number;
  readonly #allowPrivateNetworkForDevelopment: boolean;
  readonly #thinking: ThinkingMapping;
  readonly #authScheme: AuthScheme;
  readonly #structuredOutput: 'JSON_OBJECT' | 'PROMPT_ONLY';
  #secret: string | null = null;
  #credentialHandle: string | null = null;

  constructor(config: DeepSeekConfig) {
    this.id = config.id;
    this.#baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.#fetch = config.fetch ?? (globalThis as unknown as { fetch: FetchLike }).fetch;
    this.#nowMs = config.nowMs ?? ((): number => Date.now());
    this.#allowPrivateNetworkForDevelopment = config.allowPrivateNetworkForDevelopment === true;
    this.#thinking = config.thinking ?? DEFAULT_DEEPSEEK_THINKING;
    this.#authScheme = config.authScheme ?? 'BEARER';
    this.#structuredOutput = config.structuredOutput ?? 'JSON_OBJECT';
    const safety = checkEndpointSafety(this.#baseUrl, {
      allowPrivateNetworkForDevelopment: this.#allowPrivateNetworkForDevelopment,
    });
    if (!safety.safe) {
      throw new ProviderCallError({
        category: 'BAD_REQUEST',
        reason: 'PROVIDER_REQUEST_REJECTED',
        rawMessage: `unsafe endpoint (${safety.rejection})`,
      });
    }
    this.descriptor = {
      id: config.id,
      family: 'openai-compatible',
      features: [...(config.features ?? ['text', 'usage'])],
      models: config.models.map((model) => ({
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

  bindCredentials(credentials: TrustedCredentials): void {
    this.#secret = credentials.secret;
    this.#credentialHandle = credentials.handle;
  }

  get credentialHandle(): string | null {
    return this.#credentialHandle;
  }

  toJSON(): { readonly kind: string; readonly id: string; readonly credential: string } {
    return { kind: 'DeepSeekAdapter', id: this.id, credential: this.#secret === null ? 'unbound' : '[REDACTED]' };
  }

  toString(): string {
    return `[REDACTED] DeepSeekAdapter(${this.id})`;
  }

  async generateText(request: ProviderRequest): Promise<ProviderTextResult> {
    const response = await this.#send(request, { structured: false });
    return this.#toTextResult(await this.#readCompletion(response));
  }

  async generateStructured(request: ProviderRequest): Promise<ProviderStructuredResult> {
    const response = await this.#send(request, { structured: true });
    const result = this.#toTextResult(await this.#readCompletion(response));
    return { text: result.text, usage: result.usage, finishReason: result.finishReason };
  }

  /** Chat-dialect SSE. `delta.reasoning_content` is dropped by the wire layer. */
  async *streamText(request: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
    let response: FetchResponseLike;
    try {
      response = await this.#send(request, { stream: true });
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
    let usage = {};
    let finishReason = mapFinishReason(undefined);
    let finished = false;
    const reader = body.getReader();
    try {
      for (;;) {
        const chunk = await reader.read();
        const payloads = chunk.done ? parser.flush() : parser.push(chunk.value ?? new Uint8Array());
        for (const payload of payloads) {
          if (payload.trim() === DONE_PAYLOAD) {
            continue;
          }
          const parsed = parseVendorJson(payload);
          if (parsed === null) {
            yield { kind: 'ERROR', error: malformedResponseError('a streamed frame was not JSON') };
            return;
          }
          if (parsed.error !== undefined && parsed.error !== null) {
            const errorBody = parsed as unknown as { error?: { type?: unknown; code?: unknown; message?: unknown } };
            yield { kind: 'ERROR', error: classifyHttpFailure({ status: 500, body: errorBody }) };
            return;
          }
          usage = { ...usage, ...mapUsage(parsed.usage) };
          const outcome = consumeChatChunk(parsed, mapFinishReason);
          if (outcome.kind === 'DELTA') {
            yield { kind: 'TEXT_DELTA', text: outcome.text };
          } else if (outcome.kind === 'FINISH') {
            finishReason = outcome.finishReason;
            finished = true;
          }
        }
        if (chunk.done) {
          break;
        }
      }
    } finally {
      reader.releaseLock?.();
    }
    if (!finished) {
      yield { kind: 'ERROR', error: malformedResponseError('the stream ended without a finish event') };
      return;
    }
    yield { kind: 'FINISH', usage, finishReason };
  }

  /** Non-generative connectivity + credential probe. Never runs at startup. */
  async probe(signal: CancellationToken): Promise<ProviderHealth> {
    try {
      const response = await sendGet({
        fetch: this.#fetch,
        url: `${this.#baseUrl}/models`,
        headers: authHeaders(this.#authScheme, this.#secret ?? ''),
        deadlineAtMs: this.#nowMs() + 5_000,
        nowMs: this.#nowMs,
        cancellation: signal,
        allowPrivateNetworkForDevelopment: this.#allowPrivateNetworkForDevelopment,
      });
      return { status: response.ok ? 'HEALTHY' : 'DEGRADED', checkedAtMs: this.#nowMs() };
    } catch {
      return { status: 'UNAVAILABLE', checkedAtMs: this.#nowMs() };
    }
  }

  /* -------------------------------------------------------------------------------------------
   * DeepSeek-specific wire
   * ---------------------------------------------------------------------------------------- */

  async #send(request: ProviderRequest, options: { readonly structured?: boolean; readonly stream?: boolean }): Promise<FetchResponseLike> {
    const thinking = resolveThinking(this.#thinking, request.profile, {});
    const payload: Record<string, unknown> = {
      model: request.modelRef,
      messages: buildChatMessages(request.instructions, request.outputFormatInstruction, request.context),
      ...(request.maxOutputTokens === undefined ? {} : { max_tokens: request.maxOutputTokens }),
      // DeepSeek defaults to thinking ON server-side, so the toggle is sent explicitly either way.
      ...(thinking.kind === 'omit'
        ? {}
        : {
            thinking: { type: thinking.kind === 'enabled' ? 'enabled' : 'disabled' },
            ...(thinking.kind === 'enabled' && thinking.effort !== undefined ? { reasoning_effort: thinking.effort } : {}),
          }),
      // Valid-JSON mode only — never labelled as schema adherence (ROADMAP Stage 4 §10).
      ...(options.structured === true && this.#structuredOutput === 'JSON_OBJECT'
        ? { response_format: { type: 'json_object' } }
        : {}),
      ...(options.stream === true ? { stream: true, stream_options: { include_usage: true } } : {}),
    };
    return sendPost({
      fetch: this.#fetch,
      url: `${this.#baseUrl}/chat/completions`,
      body: JSON.stringify(payload),
      headers: {
        'content-type': 'application/json',
        ...(this.#secret === null ? {} : authHeaders(this.#authScheme, this.#secret)),
      },
      deadlineAtMs: request.deadlineAtMs,
      nowMs: this.#nowMs,
      ...(request.cancellation === undefined ? {} : { cancellation: request.cancellation }),
      allowPrivateNetworkForDevelopment: this.#allowPrivateNetworkForDevelopment,
    });
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
    // `reasoning_content` is discarded here — chain of thought is never output.
    const outcome = extractChatText(completion, mapFinishReason);
    const usage = mapUsage(completion.usage);
    if (outcome.hasContent) {
      // An empty-but-present content is real (JSON Output documents empty content); the
      // structured pipeline turns it into an extraction failure, never a silent success.
      return { text: outcome.text, usage, finishReason: outcome.finishReason };
    }
    if (outcome.finishReason === 'CONTENT_FILTER') {
      return { text: '', usage, finishReason: 'CONTENT_FILTER' };
    }
    throw new ProviderCallError(malformedResponseError('the response carried no message content'));
  }

  sanitizeForOperator(message: string): string {
    return sanitizeRawMessage(message, this.#secret === null ? [] : [this.#secret]);
  }
}
