/**
 * `OpenAiAdapter` — the **OpenAI Official API** adapter (ROADMAP Stage 4 §3–6).
 *
 * Wire path: the **Responses API** (`POST {base}/responses`) — independent of the Chat-Completions
 * dialect on purpose. The two prompt channels map to `instructions` (trusted) and `input` (the
 * fenced data channel); native Structured Outputs via `text.format` are used only when the
 * configured model descriptor declares `jsonSchema`, and even then the AI Bridge deterministic
 * validator remains the final contract boundary.
 *
 * No model ID is hardcoded: model references and declared features come from trusted host
 * configuration. Authentication is `Authorization: Bearer` with a credential bound through
 * `bindCredentials` — never serialized, never returned.
 *
 * **Auth note (ROADMAP Stage 4 addendum):** this adapter speaks the official *API* only. A
 * ChatGPT/subscription web login is not an API credential and is deliberately not supported — no
 * cookie, session or internal token handling exists in this package. A future official
 * account-authorization (OAuth) flow would be a separate credential type
 * (`HOST_OAUTH_REF`, reserved, not implemented).
 */
import {
  PROVIDER_ADAPTER_API_VERSION,
  ProviderCallError,
  fieldTableToJsonSchema,
  renderContextBlock,
  type AiProviderAdapter,
  type CancellationToken,
  type ProviderDescriptor,
  type ProviderHealth,
  type ProviderRequest,
  type ProviderStreamEvent,
  type ProviderStructuredResult,
  type ProviderTextResult,
  type TrustedCredentials,
} from '@aibridge/contracts';
import { checkEndpointSafety } from '@aibridge/core';
import type {
  FetchLike,
  FetchResponseLike,
  OpenAiConfig,
  OpenAiModelConfig,
  ResponsesReasoningEffort,
} from './config.js';
import {
  SseFrameParser,
  buildResponsesPayload,
  classifyOpenAiFailure,
  consumeResponsesEvent,
  extractResponseText,
  malformedResponseError,
  mapResponsesFinish,
  mapResponsesUsage,
  parseOpenAiJson,
  sanitizeRawMessage,
  sendRequest,
  type StreamState,
} from './responses.js';

export class OpenAiAdapter implements AiProviderAdapter {
  readonly id: string;
  readonly family = 'openai-compatible' as const;
  readonly adapterApiVersion = PROVIDER_ADAPTER_API_VERSION;
  readonly descriptor: ProviderDescriptor;

  readonly #baseUrl: string;
  readonly #fetch: FetchLike;
  readonly #nowMs: () => number;
  readonly #allowPrivateNetworkForDevelopment: boolean;
  readonly #reasoningEffortByProfile: Readonly<Partial<Record<string, ResponsesReasoningEffort>>>;
  #secret: string | null = null;
  #credentialHandle: string | null = null;

  constructor(config: OpenAiConfig) {
    this.id = config.id;
    this.#baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.#fetch = config.fetch ?? (globalThis as unknown as { fetch: FetchLike }).fetch;
    this.#nowMs = config.nowMs ?? ((): number => Date.now());
    this.#allowPrivateNetworkForDevelopment = config.allowPrivateNetworkForDevelopment === true;
    this.#reasoningEffortByProfile = config.reasoningEffortByProfile ?? {};
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
      // The Responses API sits on the OpenAI-compatible family for reporting purposes; the wire
      // path is provider-specific and lives entirely in this package.
      family: 'openai-compatible',
      features: [...(config.features ?? ['text', 'usage'])],
      models: config.models.map((model: OpenAiModelConfig) => ({
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
    return {
      kind: 'OpenAiAdapter',
      id: this.id,
      credential: this.#secret === null ? 'unbound' : '[REDACTED]',
    };
  }

  toString(): string {
    return `[REDACTED] OpenAiAdapter(${this.id})`;
  }

  async generateText(request: ProviderRequest): Promise<ProviderTextResult> {
    const response = await this.#send(request, { stream: false });
    return this.#toTextResult(await this.#readResponse(response));
  }

  async generateStructured(request: ProviderRequest): Promise<ProviderStructuredResult> {
    const response = await this.#send(request, { stream: false, structured: true });
    const result = this.#toTextResult(await this.#readResponse(response));
    return { text: result.text, usage: result.usage, finishReason: result.finishReason };
  }

  /** Semantic SSE events → AI Bridge stream events. Vendor event types never cross. */
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

    const parser = new SseFrameParser();
    const state: StreamState = { usage: {}, finishReason: 'UNKNOWN', finished: false, refused: false };
    const reader = body.getReader();
    try {
      for (;;) {
        const chunk = await reader.read();
        const payloads = chunk.done ? parser.flush() : parser.push(chunk.value ?? new Uint8Array());
        for (const payload of payloads) {
          const outcome = consumeResponsesEvent(payload, state);
          if (outcome.kind === 'DELTA') {
            yield { kind: 'TEXT_DELTA', text: outcome.text };
          } else if (outcome.kind === 'ERROR') {
            yield { kind: 'ERROR', error: outcome.rawError };
            return;
          } else if (outcome.kind === 'FINISH') {
            break;
          }
        }
        if (chunk.done || state.finished) {
          break;
        }
      }
    } finally {
      reader.releaseLock?.();
    }

    if (!state.finished) {
      yield { kind: 'ERROR', error: malformedResponseError('the stream ended without a terminal event') };
      return;
    }
    yield { kind: 'FINISH', usage: state.usage, finishReason: state.finishReason };
  }

  /**
   * Non-generative connectivity + credential probe (`GET /models`). A generative probe costs
   * money and is **never** run automatically — capability qualification is the opt-in live
   * harness only (ROADMAP Stage 4 §26).
   */
  async probe(signal: CancellationToken): Promise<ProviderHealth> {
    try {
      const response = await sendRequest({
        fetch: this.#fetch,
        url: `${this.#baseUrl}/models`,
        method: 'GET',
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
   * Provider-specific internals
   * ---------------------------------------------------------------------------------------- */

  #authHeaders(): Record<string, string> {
    return {
      'content-type': 'application/json',
      ...(this.#secret === null ? {} : { authorization: `Bearer ${this.#secret}` }),
    };
  }

  #featuresFor(modelRef: string): readonly string[] {
    return this.descriptor.models.find((model) => model.modelRef === modelRef)?.features ?? [];
  }

  async #send(
    request: ProviderRequest,
    options: { readonly stream: boolean; readonly structured?: boolean },
  ): Promise<FetchResponseLike> {
    const features = this.#featuresFor(request.modelRef);
    const effort = this.#reasoningEffortByProfile[request.profile];
    const dataBlock = renderContextBlock(request.context);
    const format = options.structured !== true
      ? undefined
      : this.#structuredFormat(request, features);

    return sendRequest({
      fetch: this.#fetch,
      url: `${this.#baseUrl}/responses`,
      method: 'POST',
      body: JSON.stringify(
        buildResponsesPayload(
          {
            modelRef: request.modelRef,
            // The trusted channel: instructions (plus the output-format instruction).
            instructions:
              request.outputFormatInstruction === undefined
                ? request.instructions
                : `${request.instructions}\n\n${request.outputFormatInstruction}`,
            // The data channel: fenced, quoted, never merged into instructions.
            dataBlock,
            ...(request.maxOutputTokens === undefined ? {} : { maxOutputTokens: request.maxOutputTokens }),
            ...(effort === undefined ? {} : { reasoningEffort: effort }),
            ...(format === undefined ? {} : { format }),
          },
          { stream: options.stream },
        ),
      ),
      headers: this.#authHeaders(),
      deadlineAtMs: request.deadlineAtMs,
      nowMs: this.#nowMs,
      ...(request.cancellation === undefined ? {} : { cancellation: request.cancellation }),
      allowPrivateNetworkForDevelopment: this.#allowPrivateNetworkForDevelopment,
    });
  }

  /**
   * Native structured output, gated on the **declared** model features:
   * `jsonSchema` ⇒ strict `text.format` JSON Schema (first layer), `structuredJson` ⇒ JSON mode,
   * otherwise nothing — generic extraction + validation decide success either way.
   */
  #structuredFormat(
    request: ProviderRequest,
    features: readonly string[],
  ): { readonly kind: 'JSON_SCHEMA'; readonly name: string; readonly schema: Record<string, unknown> } | { readonly kind: 'JSON_OBJECT' } | undefined {
    const schema = request.outputSchema;
    if (features.includes('jsonSchema') && schema !== undefined && schema.kind === 'INLINE') {
      const jsonSchema = fieldTableToJsonSchema(schema);
      if (jsonSchema !== null) {
        return { kind: 'JSON_SCHEMA', name: schema.schemaId, schema: jsonSchema };
      }
    }
    return features.includes('structuredJson') || features.includes('jsonSchema') ? { kind: 'JSON_OBJECT' } : undefined;
  }

  async #readResponse(response: FetchResponseLike): Promise<Record<string, unknown>> {
    const text = await response.text().catch(() => '');
    const record = parseOpenAiJson(text);
    if (record === null) {
      throw new ProviderCallError(malformedResponseError('the response body was not JSON'));
    }
    const error = record['error'];
    if (record['status'] === 'failed' || (error !== undefined && error !== null)) {
      throw new ProviderCallError(
        classifyOpenAiFailure({
          status: 500,
          body: { error: (typeof error === 'object' && error !== null ? error : {}) as { message?: unknown; type?: unknown; code?: unknown } },
        }),
      );
    }
    return record;
  }

  #toTextResult(record: Record<string, unknown>): ProviderTextResult {
    const outcome = extractResponseText(record as Parameters<typeof extractResponseText>[0]);
    const usage = mapResponsesUsage(record['usage']);
    const incomplete = record['incomplete_details'];
    const incompleteReason =
      typeof incomplete === 'object' && incomplete !== null && !Array.isArray(incomplete)
        ? (incomplete as Record<string, unknown>)['reason']
        : undefined;
    const finishReason = mapResponsesFinish({
      status: record['status'],
      incompleteReason,
      refused: outcome.refused,
    });
    if (outcome.hasText || outcome.refused || finishReason === 'LENGTH') {
      return { text: outcome.text, usage, finishReason };
    }
    throw new ProviderCallError(malformedResponseError('the response carried no output text'));
  }

  /** Operator-only raw-message sanitation. */
  sanitizeForOperator(message: string): string {
    return sanitizeRawMessage(message, this.#secret === null ? [] : [this.#secret]);
  }
}
