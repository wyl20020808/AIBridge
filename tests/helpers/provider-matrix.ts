/**
 * The provider matrix harness — one neutral script vocabulary, four real adapters
 * (ROADMAP Stage 4 §28).
 *
 * The Phase 28 base checklist runs **unchanged** against OpenAI Official (Responses dialect),
 * DeepSeek Official, Xiaomi Token Plan and the generic relay (chat dialect): the same behaviours
 * are translated per dialect into fake HTTP, executed through one `AiRuntime`, and asserted on the
 * same generic results. Provider-specific behaviour lives in each provider's own suite.
 */
import type { ConformanceBehavior } from '@aibridge/host-sdk';
import { InMemorySecretStore, TestClock } from '@aibridge/host-sdk';
import { AiRuntime } from '@aibridge/runtime';
import { OpenAiAdapter } from '@aibridge/provider-openai';
import { DeepSeekAdapter } from '@aibridge/provider-deepseek';
import { XiaomiTokenPlanAdapter } from '@aibridge/provider-xiaomi-tokenplan';
import { OpenAiCompatibleAdapter } from '@aibridge/provider-openai-compatible';
import type { AiProviderAdapter, ProviderStreamEvent } from '@aibridge/contracts';
import type { FetchRequestInitLike, FetchResponseLike, OpenAiCompatibleModelConfig } from '@aibridge/provider-openai-compatible';

export const MATRIX_PROVIDERS = ['openai', 'deepseek', 'xiaomi-tokenplan', 'relay'] as const;

export type MatrixProviderName = (typeof MATRIX_PROVIDERS)[number];

export type MatrixCall = {
  readonly url: string;
  readonly init: FetchRequestInitLike;
  readonly payload: Record<string, unknown>;
};

export type MatrixProvider = {
  readonly name: MatrixProviderName;
  readonly adapter: AiProviderAdapter;
  readonly runtime: AiRuntime;
  readonly calls: MatrixCall[];
  readonly syntheticSecret: string;
  push(behavior: ConformanceBehavior): void;
  /** A 200 with a body that is not JSON at all — the malformed-response row. */
  pushMalformed(): void;
  aborts(): number;
  /** Collect provider stream events through the adapter (raw layer). */
  collectStream(modelRef: string): Promise<ProviderStreamEvent[]>;
};

type Scripted = { readonly status?: number; readonly json?: unknown; readonly text?: string; readonly sse?: readonly string[]; readonly headers?: Record<string, string>; readonly hang?: boolean };

function finishReasonToChat(finishReason: string | undefined): string {
  return finishReason === 'LENGTH' ? 'length' : finishReason === 'CONTENT_FILTER' ? 'content_filter' : 'stop';
}

/** Translate neutral behaviours into the chat-completions dialect (relay, DeepSeek, Xiaomi). */
function chatScript(behavior: ConformanceBehavior): Scripted {
  switch (behavior.kind) {
    case 'text':
    case 'structured':
      return {
        json: {
          choices: [{ message: { content: behavior.text }, finish_reason: finishReasonToChat(behavior.finishReason) }],
          ...(behavior.usage === undefined || Object.keys(behavior.usage).length === 0
            ? {}
            : {
                usage: {
                  ...(behavior.usage.inputTokens === undefined ? {} : { prompt_tokens: behavior.usage.inputTokens }),
                  ...(behavior.usage.outputTokens === undefined ? {} : { completion_tokens: behavior.usage.outputTokens }),
                  ...(behavior.usage.totalTokens === undefined ? {} : { total_tokens: behavior.usage.totalTokens }),
                },
              }),
        },
      };
    case 'failure':
      return {
        status: statusForFailure(behavior.rawError),
        text: JSON.stringify({
          error: { type: typeForFailure(behavior.rawError), message: behavior.rawError.rawMessage ?? 'synthetic vendor failure' },
        }),
        ...(behavior.rawError.retryAfterMs === undefined
          ? {}
          : { headers: { 'retry-after': String(behavior.rawError.retryAfterMs / 1000) } }),
      };
    case 'hang':
      return { hang: true };
    case 'stream':
      return {
        sse: [
          ...behavior.deltas.map((text) => JSON.stringify({ choices: [{ delta: { content: text } }] })),
          JSON.stringify({ choices: [{ delta: {}, finish_reason: finishReasonToChat(behavior.finishReason) }], usage: {} }),
          '[DONE]',
        ],
      };
    case 'stream-failure':
      return {
        sse: [
          ...behavior.deltas.map((text) => JSON.stringify({ choices: [{ delta: { content: text } }] })),
          JSON.stringify({ error: { type: typeForFailure(behavior.rawError), message: behavior.rawError.rawMessage ?? 'x' } }),
        ],
      };
    default: {
      const exhaustive: never = behavior;
      void exhaustive;
      return {};
    }
  }
}

/** Translate neutral behaviours into the Responses dialect (OpenAI Official). */
function responsesScript(behavior: ConformanceBehavior): Scripted {
  switch (behavior.kind) {
    case 'text':
    case 'structured':
      return {
        json: {
          status: behavior.finishReason === 'LENGTH' ? 'incomplete' : 'completed',
          ...(behavior.finishReason === 'LENGTH' ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
          output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: behavior.text }] }],
          ...(behavior.usage === undefined || Object.keys(behavior.usage).length === 0
            ? {}
            : {
                usage: {
                  ...(behavior.usage.inputTokens === undefined ? {} : { input_tokens: behavior.usage.inputTokens }),
                  ...(behavior.usage.outputTokens === undefined ? {} : { output_tokens: behavior.usage.outputTokens }),
                  ...(behavior.usage.totalTokens === undefined ? {} : { total_tokens: behavior.usage.totalTokens }),
                },
              }),
        },
      };
    case 'failure':
      return {
        status: statusForFailure(behavior.rawError),
        text: JSON.stringify({
          error: { type: typeForFailure(behavior.rawError), code: typeForFailure(behavior.rawError), message: behavior.rawError.rawMessage ?? 'x' },
        }),
        ...(behavior.rawError.retryAfterMs === undefined
          ? {}
          : { headers: { 'retry-after': String(behavior.rawError.retryAfterMs / 1000) } }),
      };
    case 'hang':
      return { hang: true };
    case 'stream':
      return {
        sse: [
          ...behavior.deltas.map((text) => JSON.stringify({ type: 'response.output_text.delta', delta: text })),
          JSON.stringify({
            type: 'response.completed',
            response: { status: 'completed', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
          }),
        ],
      };
    case 'stream-failure':
      return {
        sse: [
          ...behavior.deltas.map((text) => JSON.stringify({ type: 'response.output_text.delta', delta: text })),
          JSON.stringify({ type: 'error', code: typeForFailure(behavior.rawError), message: behavior.rawError.rawMessage ?? 'x' }),
        ],
      };
    default: {
      const exhaustive: never = behavior;
      void exhaustive;
      return {};
    }
  }
}

function statusForFailure(rawError: { readonly category: string; readonly reason?: string }): number {
  if (rawError.reason === 'MODEL_UNAVAILABLE') return 404;
  switch (rawError.category) {
    case 'AUTH':
      return 401;
    case 'RATE_LIMIT':
      return 429;
    case 'OVERLOADED':
      return 503;
    case 'BAD_REQUEST':
      return 400;
    default:
      return 500;
  }
}

function typeForFailure(rawError: { readonly category: string; readonly reason?: string }): string {
  if (rawError.reason === 'MODEL_UNAVAILABLE') return 'model_not_found';
  switch (rawError.category) {
    case 'AUTH':
      return 'authentication_error';
    case 'RATE_LIMIT':
      return 'rate_limit_error';
    case 'OVERLOADED':
      return 'overloaded_error';
    case 'CONTENT_FILTER':
      return 'content_filter';
    case 'BAD_REQUEST':
      return 'invalid_request_error';
    default:
      return 'server_error';
  }
}

function makeTransport(dialect: (behavior: ConformanceBehavior) => Scripted, baseUrl: string, calls: MatrixCall[], counter: { aborts: number }) {
  const queue: Scripted[] = [];
  const encoder = new TextEncoder();
  const fetch = (url: string, init: FetchRequestInitLike): Promise<FetchResponseLike> => {
    calls.push({ url, init, payload: init.body === undefined ? {} : (JSON.parse(init.body) as Record<string, unknown>) });
    const next = queue.shift();
    if (next === undefined) {
      return Promise.reject(new Error('matrix: no scripted response remains'));
    }
    if (next.hang === true) {
      return new Promise<FetchResponseLike>((_resolve, reject) => {
        const signal = init.signal as { addEventListener?: (type: string, callback: () => void) => void } | undefined;
        signal?.addEventListener?.('abort', () => {
          counter.aborts += 1;
          reject(new Error('matrix: aborted'));
        });
      });
    }
    const status = next.status ?? 200;
    const headers = next.headers ?? {};
    const chunks = (next.sse ?? []).map((payload) => encoder.encode(`data: ${payload}\n\n`));
    let index = 0;
    void baseUrl;
    return Promise.resolve({
      status,
      ok: status < 400,
      headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
      text: () => Promise.resolve(next.text ?? (next.json === undefined ? '' : JSON.stringify(next.json))),
      body:
        next.sse === undefined
          ? null
          : {
              getReader: () => ({
                async read(): Promise<{ done: boolean; value?: Uint8Array }> {
                  if (index >= chunks.length) return { done: true };
                  const value = chunks[index];
                  index += 1;
                  return { done: false, ...(value === undefined ? {} : { value }) };
                },
                async cancel(): Promise<void> {
                  index = chunks.length;
                },
                releaseLock(): void {
                  // nothing to release
                },
              }),
            },
    });
  };
  return { fetch, queue, dialect };
}

/** Build one matrix provider: its adapter over a fake transport, wired through one `AiRuntime`. */
export async function makeMatrixProvider(name: MatrixProviderName, modelRef = 'MATRIX_MODEL'): Promise<MatrixProvider> {
  const syntheticSecret = `sk-${'M'.repeat(32)}`;
  const calls: MatrixCall[] = [];
  const counter = { aborts: 0 };
  const baseUrl = `https://${name}.example.invalid/v1`;
  const models: readonly OpenAiCompatibleModelConfig[] = [
    {
      modelRef,
      features: ['text', 'structuredJson', 'jsonSchema', 'reasoning', 'streaming', 'usage'],
      maxContextTokens: 8_192,
      maxOutputTokens: 4_096,
      profiles: ['fast', 'balanced', 'reasoning', 'cheap', 'high-context'],
    },
  ];

  const dialect = name === 'openai' ? responsesScript : chatScript;
  const transport = makeTransport(dialect, baseUrl, calls, counter);
  let adapter: AiProviderAdapter;
  switch (name) {
    case 'openai':
      adapter = new OpenAiAdapter({
        id: 'matrix-openai',
        baseUrl,
        fetch: transport.fetch,
        nowMs: () => 0,
        reasoningEffortByProfile: { reasoning: 'high' },
        models,
      });
      break;
    case 'deepseek':
      adapter = new DeepSeekAdapter({
        id: 'matrix-deepseek',
        baseUrl,
        fetch: transport.fetch,
        nowMs: () => 0,
        models,
      });
      break;
    case 'xiaomi-tokenplan':
      adapter = new XiaomiTokenPlanAdapter({
        id: 'matrix-xiaomi',
        baseUrl,
        fetch: transport.fetch,
        nowMs: () => 0,
        models,
      });
      break;
    case 'relay':
    default:
      adapter = new OpenAiCompatibleAdapter({
        id: 'matrix-relay',
        baseUrl,
        fetch: transport.fetch,
        nowMs: () => 0,
        models,
      });
      break;
  }
  adapter.bindCredentials?.({ handle: `secret://matrix/${name}`, secret: syntheticSecret });

  const secrets = new InMemorySecretStore();
  secrets.put(`secret://matrix/${name}`, syntheticSecret);
  const runtime = new AiRuntime({
    providers: [{ adapter, credentialRef: `secret://matrix/${name}` }],
    routes: {
      balanced: [{ providerId: adapter.id, modelRef }],
      reasoning: [{ providerId: adapter.id, modelRef }],
      fast: [{ providerId: adapter.id, modelRef }],
      cheap: [{ providerId: adapter.id, modelRef }],
      'high-context': [{ providerId: adapter.id, modelRef }],
    },
    secrets,
    clock: new TestClock(0),
  });

  return {
    name,
    adapter,
    runtime,
    calls,
    syntheticSecret,
    push(behavior: ConformanceBehavior): void {
      transport.queue.push(transport.dialect(behavior));
    },
    pushMalformed(): void {
      transport.queue.push({ text: '<<<this body is not JSON at all>>>' });
    },
    aborts: () => counter.aborts,
    async collectStream(requestModelRef: string): Promise<ProviderStreamEvent[]> {
      const streamText = adapter.streamText;
      if (streamText === undefined) {
        return [];
      }
      const events: ProviderStreamEvent[] = [];
      for await (const event of streamText.call(adapter, {
        capability: 'ai.text.generate',
        profile: 'balanced',
        instructions: 'matrix',
        context: [],
        modelRef: requestModelRef,
        deadlineAtMs: 1_000_000,
      })) {
        events.push(event);
      }
      return events;
    },
  };
}

/** A minimal consumer request for the matrix runs. */
export function matrixRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contractVersion: '1.0',
    requestId: 'req-matrix-1',
    idempotencyKey: 'matrix.turn-1',
    capability: 'ai.text.generate',
    capabilityVersion: '1.0',
    profile: 'balanced',
    input: { instructions: 'Reply with one word.', context: [] },
    ...overrides,
  };
}

export const matrixContext = { callerPluginId: 'matrix.caller', grantedPermissions: ['ai.text.generate', 'ai.structured.generate'] };
