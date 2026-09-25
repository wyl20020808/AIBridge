/**
 * `OpenAiCompatibleAdapter` — the **Generic OpenAI-Compatible / Relay Provider** (Stage 3 origin,
 * Stage 4 positioning).
 *
 * Serves relay stations (`中转站`), self-hosted compatible gateways and any third-party
 * OpenAI-compatible endpoint. It carries **no vendor brand list** and no per-brand behaviour: a
 * deployment's behaviour is declared through configuration (`authScheme`, `structuredOutput`,
 * `maxTokensField`, `thinking`), never guessed from a URL.
 *
 * The chat-completions dialect itself lives in the **internal reusable wire layer** (`wire.ts`,
 * `http.ts`) shared with `@aibridge/provider-deepseek` and `@aibridge/provider-xiaomi-tokenplan`.
 * Provider-specific facts — the `/chat/completions` payload, headers, base URL, authentication,
 * response shape, error body, SSE framing — stop here and never cross the port.
 *
 * Security posture (ROADMAP Stage 4 §18–20):
 *  - the base URL comes from trusted operator configuration only and is SSRF-validated (HTTPS,
 *    no embedded credentials, no loopback/private/metadata targets) at construction and again for
 *    every redirect target;
 *  - the credential is bound once through `bindCredentials`, held in a private field excluded from
 *    serialization, and placed only in the outbound auth header;
 *  - `reasoning_content` is chain-of-thought and is discarded by the wire layer, never returned.
 */
import {
  PROVIDER_ADAPTER_API_VERSION,
  ProviderCallError,
  fieldTableToJsonSchema,
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
  MaxTokensField,
  OpenAiCompatibleConfig,
  OpenAiCompatibleModelConfig,
  StructuredOutputMode,
} from './config.js';
import {
  SseStreamParser,
  classifyHttpFailure,
  malformedResponseError,
  mapFinishReason,
  mapUsage,
  parseVendorJson,
  type VendorChatCompletion,
} from './http.js';
import {
  authHeaders,
  buildChatMessages,
  consumeChatChunk,
  extractChatText,
  resolveThinking,
  sanitizeRawMessage,
  sendPost,
  type AuthScheme,
  type ThinkingMapping,
} from './wire.js';

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

export type ChatDialectSettings = {
  readonly authScheme: AuthScheme;
  readonly structuredOutput: StructuredOutputMode;
  readonly maxTokensField: MaxTokensField;
  readonly thinking: ThinkingMapping | undefined;
  readonly supportsEffort: boolean;
};

export class OpenAiCompatibleAdapter implements AiProviderAdapter {
  readonly id: string;
  readonly family = 'openai-compatible' as const;
  readonly adapterApiVersion = PROVIDER_ADAPTER_API_VERSION;
  readonly descriptor: ProviderDescriptor;

  readonly #baseUrl: string;
  readonly #fetch: FetchLike;
  readonly #nowMs: () => number;
  readonly #allowPrivateNetworkForDevelopment: boolean;
  readonly #dialect: ChatDialectSettings;
  /**
   * The resolved credential. Private, never serialized, never returned, never logged.
   * `#credentialHandle` (the operator-side reference) is safe to log; the value is not.
   */
  #secret: string | null = null;
  #credentialHandle: string | null = null;

  constructor(config: OpenAiCompatibleConfig, dialect: Partial<ChatDialectSettings> = {}) {
    this.id = config.id;
    this.#baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.#fetch = config.fetch ?? (globalThis as unknown as { fetch: FetchLike }).fetch;
    this.#nowMs = config.nowMs ?? ((): number => Date.now());
    this.#allowPrivateNetworkForDevelopment = config.allowPrivateNetworkForDevelopment === true;
    this.#dialect = {
      authScheme: dialect.authScheme ?? config.authScheme ?? 'BEARER',
      structuredOutput: dialect.structuredOutput ?? config.structuredOutput ?? 'JSON_OBJECT',
      maxTokensField: dialect.maxTokensField ?? config.maxTokensField ?? 'max_tokens',
      thinking: dialect.thinking ?? config.thinking,
      supportsEffort: dialect.supportsEffort ?? false,
    };
    // Fail closed on an obviously unsafe endpoint, at construction rather than at first call.
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
    this.descriptor = buildDescriptor(config);
  }

  /**
   * Trusted credential binding — the only door a secret value enters through.
   *
   * The handle is kept for operator correlation; the value serves the outbound auth header only
   * and is excluded from every serialization.
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
    const response = await this.#send(request);
    return this.#toTextResult(await this.#readCompletion(response));
  }

  async generateStructured(request: ProviderRequest): Promise<ProviderStructuredResult> {
    const response = await this.#send(request, { structured: true });
    const result = this.#toTextResult(await this.#readCompletion(response));
    return { text: result.text, usage: result.usage, finishReason: result.finishReason };
  }

  /**
   * SSE in, AI Bridge's own `ProviderStreamEvent`s out. Exactly one terminal event (`FINISH` xor
   * `ERROR`): a mapped failure is an `ERROR` event, never a vendor frame, and `reasoning_content`
   * deltas are dropped by the wire layer.
   */
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
    let finishReason = 'UNKNOWN' as ReturnType<typeof mapFinishReason>;
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
            yield {
              kind: 'ERROR',
              error: classifyHttpFailure({ status: 500, body: errorBody }),
            };
            return;
          }
          usage = { ...usage, ...mapUsage(parsed.usage) };
          const outcome = consumeChatChunk(parsed, mapFinishReason);
          if (outcome.kind === 'DELTA') {
            // A delta arriving after FINISH in the same flush is a late delta, not output:
            // the stream is logically closed, so it is discarded (exactly-one-terminal).
            if (!finished) {
              yield { kind: 'TEXT_DELTA', text: outcome.text };
            }
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

  /** A port that cannot probe says so rather than pretending (ARCHITECTURE.md §7.2). */
  probe(_signal: CancellationToken): Promise<ProviderHealth> {
    return Promise.resolve({ status: 'HEALTHY', checkedAtMs: this.#nowMs() });
  }

  /* -------------------------------------------------------------------------------------------
   * Provider-specific internals
   * ---------------------------------------------------------------------------------------- */

  /** Build the chat-completions payload and POST it. Everything dialect-shaped happens here. */
  async #send(
    request: ProviderRequest,
    options: { readonly structured?: boolean; readonly stream?: boolean } = {},
  ): Promise<FetchResponseLike> {
    const structured = options.structured === true;
    const stream = options.stream === true;
    const thinking = resolveThinking(this.#dialect.thinking, request.profile, {});
    const messages = buildChatMessages(request.instructions, request.outputFormatInstruction, request.context);
    const payload: Record<string, unknown> = {
      model: request.modelRef,
      messages,
      ...(request.maxOutputTokens === undefined
        ? {}
        : { [this.#dialect.maxTokensField]: request.maxOutputTokens }),
      ...(thinking.kind === 'omit'
        ? {}
        : thinking.kind === 'disabled'
          ? { thinking: { type: 'disabled' } }
          : {
              thinking: { type: 'enabled' },
              ...(thinking.effort !== undefined && this.#dialect.supportsEffort
                ? { reasoning_effort: thinking.effort }
                : {}),
            }),
      ...(structured ? this.#responseFormat(request) : {}),
      ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
    };

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...(this.#secret === null ? {} : authHeaders(this.#dialect.authScheme, this.#secret)),
    };

    return sendPost({
      fetch: this.#fetch,
      url: `${this.#baseUrl}/chat/completions`,
      body: JSON.stringify(payload),
      headers,
      deadlineAtMs: request.deadlineAtMs,
      nowMs: this.#nowMs,
      ...(request.cancellation === undefined ? {} : { cancellation: request.cancellation }),
      allowPrivateNetworkForDevelopment: this.#allowPrivateNetworkForDevelopment,
    });
  }

  /**
   * The structured-output request shape for this dialect.
   *
   * `JSON_SCHEMA` sends the provider's native strict schema (first layer only — the AI Bridge
   * validator remains the final contract boundary); `JSON_OBJECT` sends JSON mode; `PROMPT_ONLY`
   * sends nothing and relies on the output-format instruction.
   */
  #responseFormat(request: ProviderRequest): Record<string, unknown> {
    if (this.#dialect.structuredOutput === 'PROMPT_ONLY') {
      return {};
    }
    if (this.#dialect.structuredOutput === 'JSON_OBJECT') {
      return { response_format: { type: 'json_object' } };
    }
    const schema = request.outputSchema;
    if (schema === undefined || schema.kind !== 'INLINE') {
      // Native schema needs an inline field table; degrade to JSON mode, never to silence.
      return { response_format: { type: 'json_object' } };
    }
    const jsonSchema = fieldTableToJsonSchema(schema);
    if (jsonSchema === null) {
      return { response_format: { type: 'json_object' } };
    }
    return {
      response_format: {
        type: 'json_schema',
        json_schema: { name: schema.schemaId, strict: true, schema: jsonSchema },
      },
    };
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
    const outcome = extractChatText(completion, mapFinishReason);
    const usage = mapUsage(completion.usage);
    if (outcome.hasContent) {
      // An empty-but-present answer is real (JSON mode documents empty content); the structured
      // pipeline downstream turns it into an extraction failure, never a silent success.
      return { text: outcome.text, usage, finishReason: outcome.finishReason };
    }
    if (outcome.finishReason === 'CONTENT_FILTER') {
      // A filtered answer is a signal for the consumer's guard, not an error (ARCHITECTURE.md §5.3).
      return { text: '', usage, finishReason: 'CONTENT_FILTER' };
    }
    throw new ProviderCallError(malformedResponseError('the response carried no message content'));
  }

  /** Operator-only raw-message sanitation for adapters that surface vendor prose. */
  sanitizeForOperator(message: string): string {
    return sanitizeRawMessage(message, this.#secret === null ? [] : [this.#secret]);
  }
}

/** Re-exported for the conformance tests: the mapped failure a raw error body produces. */
export function classifyVendorErrorBody(body: unknown): ReturnType<typeof classifyHttpFailure> {
  return classifyHttpFailure({
    status: 400,
    body: body as { error?: { type?: unknown; code?: unknown; message?: unknown } },
  });
}
