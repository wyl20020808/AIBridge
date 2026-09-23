/**
 * `XiaomiTokenPlanAdapter` — **Xiaomi MiMo Token Plan** (ROADMAP Stage 4 §12–16).
 *
 * Token Plan is the subscription product (`tp-…` keys, regional clusters), **not** the generic
 * pay-as-you-go MiMo API (`sk-…` keys, different endpoint) — the two are independent and cannot
 * be mixed (official FAQ). The architecture keeps them separable: a future PAYG adapter would be a
 * different preset and endpoint set over the same wire layer, without touching any contract.
 *
 * Official facts this adapter encodes (mimo.mi.com docs, OpenAI Chat Completions compatibility):
 *  - protocol: OpenAI-compatible `POST {base}/chat/completions` (the documented Anthropic protocol
 *    and the newer Responses surface are **deferred** — see the Stage 4 report);
 *  - authentication: the documented `api-key: <key>` header (Bearer is also documented and
 *    selectable), key format `tp-xxxxx`;
 *  - clusters: China / Singapore / Europe with dedicated Token Plan base URLs — the endpoint comes
 *    from trusted operator configuration or the cluster preset. A consumer can never choose it;
 *  - `max_completion_tokens` carries the output cap (not `max_tokens`);
 *  - `thinking: { type: 'enabled' | 'disabled' }` with `reasoning_content` beside `content` —
 *    chain-of-thought is discarded by the wire layer, never output;
 *  - `response_format` is `text` or `json_object` in the base contract (Structured Output is a
 *    separate documented capability): nothing is advertised as strict schema adherence unless the
 *    operator declares it, and the AI Bridge validator decides success regardless.
 *
 * The `tp-` prefix is used for **safe diagnostics and obvious config validation only** — it is
 * documented product trivia, never a permanent API contract of this repository.
 */
import {
  PROVIDER_ADAPTER_API_VERSION,
  ProviderCallError,
  fieldTableToJsonSchema,
  type AiProviderAdapter,
  type CancellationToken,
  type ModelProfile,
  type ProviderDescriptor,
  type ProviderFeature,
  type ProviderHealth,
  type ProviderPricing,
  type ProviderRequest,
  type ProviderStreamEvent,
  type ProviderStructuredResult,
  type ProviderTextResult,
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

/** The regional Token Plan clusters. Endpoint selection is operator-side; consumers never see it. */
export const XIAOMI_TOKEN_PLAN_CLUSTERS = ['CN', 'SGP', 'EU'] as const;

export type XiaomiTokenPlanCluster = (typeof XIAOMI_TOKEN_PLAN_CLUSTERS)[number];

/**
 * The documented Token Plan cluster endpoints (OpenAI-compatibility protocol).
 *
 * Public vendor endpoints, not secrets — but still operator-overridable, because "the Base URL is
 * subject to the display on the Token Plan page" (official docs).
 */
export const XIAOMI_TOKEN_PLAN_ENDPOINTS: Readonly<Record<XiaomiTokenPlanCluster, string>> = {
  CN: 'https://token-plan-cn.xiaomimimo.com/v1',
  SGP: 'https://token-plan-sgp.xiaomimimo.com/v1',
  EU: 'https://token-plan-ams.xiaomimimo.com/v1',
};

/** The thinking default: the documented default is enabled, so the toggle is sent explicitly. */
export const DEFAULT_XIAOMI_THINKING: ThinkingMapping = {
  effortByProfile: { reasoning: 'default', 'high-context': 'default' },
};

/** The Xiaomi Token Plan preset: wire and safe-auth defaults only. Never a business policy. */
export const XIAOMI_TOKENPLAN_PRESET = {
  preset: 'XIAOMI_TOKENPLAN',
  authScheme: 'API_KEY_HEADER' as AuthScheme,
  wireProtocol: 'OPENAI_CHAT_COMPLETIONS' as const,
  maxTokensField: 'max_completion_tokens' as const,
  structuredOutput: 'JSON_OBJECT' as const,
  thinking: DEFAULT_XIAOMI_THINKING,
  clusters: XIAOMI_TOKEN_PLAN_ENDPOINTS,
};

/**
 * Diagnostic hint only: does this secret *look* like a Token Plan key (`tp-…`)?
 *
 * Never a hard contract and never used for authorization — a mismatch is a warning-shaped fact in
 * provider diagnostics, not a rejection (ROADMAP Stage 4 §13).
 */
export function looksLikeTokenPlanKey(secret: string): boolean {
  return /^tp-[A-Za-z0-9_-]{8,}$/.test(secret);
}

export type XiaomiTokenPlanModelConfig = {
  readonly modelRef: string;
  readonly displayName?: string;
  readonly features: readonly ProviderFeature[];
  readonly maxContextTokens: number;
  readonly maxOutputTokens: number;
  readonly profiles?: readonly ModelProfile[];
  readonly pricing?: ProviderPricing;
};

export type XiaomiTokenPlanConfig = {
  readonly id: string;
  /** The regional cluster preset. Ignored when `baseUrl` is supplied. */
  readonly cluster?: XiaomiTokenPlanCluster;
  /** Trusted operator override ("Base URL is subject to the Token Plan page"). SSRF-validated. */
  readonly baseUrl?: string;
  readonly models: readonly XiaomiTokenPlanModelConfig[];
  readonly features?: readonly ProviderFeature[];
  readonly maxConcurrency?: number;
  readonly fetch?: FetchLike;
  readonly nowMs?: () => number;
  /** Default `API_KEY_HEADER` (the documented `api-key` header). `BEARER` is also documented. */
  readonly authScheme?: AuthScheme;
  readonly thinking?: ThinkingMapping;
  /** Default `JSON_OBJECT`. `JSON_SCHEMA` requires an operator declaration and is still validated. */
  readonly structuredOutput?: 'JSON_OBJECT' | 'JSON_SCHEMA' | 'PROMPT_ONLY';
  readonly allowPrivateNetworkForDevelopment?: boolean;
};

export class XiaomiTokenPlanAdapter implements AiProviderAdapter {
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
  readonly #structuredOutput: 'JSON_OBJECT' | 'JSON_SCHEMA' | 'PROMPT_ONLY';
  #secret: string | null = null;
  #credentialHandle: string | null = null;
  #credentialShape: 'TOKEN_PLAN_LIKE' | 'OTHER' | null = null;

  constructor(config: XiaomiTokenPlanConfig) {
    this.id = config.id;
    const presetEndpoint = config.cluster === undefined ? XIAOMI_TOKEN_PLAN_ENDPOINTS.CN : XIAOMI_TOKEN_PLAN_ENDPOINTS[config.cluster];
    this.#baseUrl = (config.baseUrl ?? presetEndpoint).replace(/\/+$/, '');
    this.#fetch = config.fetch ?? (globalThis as unknown as { fetch: FetchLike }).fetch;
    this.#nowMs = config.nowMs ?? ((): number => Date.now());
    this.#allowPrivateNetworkForDevelopment = config.allowPrivateNetworkForDevelopment === true;
    this.#thinking = config.thinking ?? DEFAULT_XIAOMI_THINKING;
    this.#authScheme = config.authScheme ?? 'API_KEY_HEADER';
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
    this.#credentialShape = looksLikeTokenPlanKey(credentials.secret) ? 'TOKEN_PLAN_LIKE' : 'OTHER';
  }

  get credentialHandle(): string | null {
    return this.#credentialHandle;
  }

  /** Diagnostic hint only: whether the bound secret looks like a `tp-…` Token Plan key. */
  get credentialShape(): 'TOKEN_PLAN_LIKE' | 'OTHER' | null {
    return this.#credentialShape;
  }

  toJSON(): { readonly kind: string; readonly id: string; readonly credential: string } {
    return {
      kind: 'XiaomiTokenPlanAdapter',
      id: this.id,
      credential: this.#secret === null ? 'unbound' : '[REDACTED]',
    };
  }

  toString(): string {
    return `[REDACTED] XiaomiTokenPlanAdapter(${this.id})`;
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

  /** Non-generative connectivity + credential probe (`GET /models`, the documented List Models). */
  async probe(signal: CancellationToken): Promise<ProviderHealth> {
    try {
      const response = await sendGet({
        fetch: this.#fetch,
        url: `${this.#baseUrl}/models`,
        headers: this.#authHeaders(),
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
   * Token Plan wire
   * ---------------------------------------------------------------------------------------- */

  #authHeaders(): Record<string, string> {
    return {
      'content-type': 'application/json',
      ...(this.#secret === null ? {} : authHeaders(this.#authScheme, this.#secret)),
    };
  }

  async #send(request: ProviderRequest, options: { readonly structured?: boolean; readonly stream?: boolean }): Promise<FetchResponseLike> {
    const thinking = resolveThinking(this.#thinking, request.profile, {});
    const payload: Record<string, unknown> = {
      model: request.modelRef,
      messages: buildChatMessages(request.instructions, request.outputFormatInstruction, request.context),
      // The documented field is `max_completion_tokens` (range [1, 131072]).
      ...(request.maxOutputTokens === undefined ? {} : { max_completion_tokens: request.maxOutputTokens }),
      ...(thinking.kind === 'omit'
        ? {}
        : { thinking: { type: thinking.kind === 'enabled' ? 'enabled' : 'disabled' } }),
      ...(options.structured === true ? this.#responseFormat(request) : {}),
      ...(options.stream === true ? { stream: true } : {}),
    };
    return sendPost({
      fetch: this.#fetch,
      url: `${this.#baseUrl}/chat/completions`,
      body: JSON.stringify(payload),
      headers: this.#authHeaders(),
      deadlineAtMs: request.deadlineAtMs,
      nowMs: this.#nowMs,
      ...(request.cancellation === undefined ? {} : { cancellation: request.cancellation }),
      allowPrivateNetworkForDevelopment: this.#allowPrivateNetworkForDevelopment,
    });
  }

  #responseFormat(request: ProviderRequest): Record<string, unknown> {
    if (this.#structuredOutput === 'PROMPT_ONLY') {
      return {};
    }
    if (this.#structuredOutput === 'JSON_OBJECT') {
      return { response_format: { type: 'json_object' } };
    }
    const schema = request.outputSchema;
    if (schema !== undefined && schema.kind === 'INLINE') {
      const jsonSchema = fieldTableToJsonSchema(schema);
      if (jsonSchema !== null) {
        return {
          response_format: {
            type: 'json_schema',
            json_schema: { name: schema.schemaId, strict: true, schema: jsonSchema },
          },
        };
      }
    }
    return { response_format: { type: 'json_object' } };
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
