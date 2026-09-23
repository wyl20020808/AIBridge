/**
 * A deterministic fake OpenAI-compatible transport for the Stage 3 tests.
 *
 * Ordinary CI never touches a real provider (ROADMAP Stage 3 §8): every adapter test scripts HTTP
 * responses here, including SSE streams, statuses and vendor error bodies. The captured calls are
 * what the request-translation assertions read — proving the wire shape stays inside the adapter.
 */
import { TextEncoder } from 'node:util';
import type {
  ByteStreamReaderLike,
  FetchLike,
  FetchRequestInitLike,
  FetchResponseLike,
  OpenAiCompatibleAdapter,
} from '@aibridge/provider-openai-compatible';
import { OpenAiCompatibleAdapter as Adapter } from '@aibridge/provider-openai-compatible';
import type { ConformanceBehavior, ConformanceTarget } from '@aibridge/host-sdk';
import type { ProviderRawError } from '@aibridge/contracts';

export type FakeHttpResponse = {
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
  /** A JSON body. Ignored when `sse` is given. */
  readonly json?: unknown;
  /** A literal text body (e.g. malformed JSON). */
  readonly text?: string;
  /** SSE `data:` payloads; each becomes one `data: <payload>\n\n` frame. */
  readonly sse?: readonly string[];
  /** Never resolve — for deadline and cancellation tests. */
  readonly hang?: boolean;
};

export type CapturedCall = {
  readonly url: string;
  readonly method: string | undefined;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly payload: Record<string, unknown>;
};

export type FakeOpenAiTransport = {
  readonly adapter: OpenAiCompatibleAdapter;
  readonly calls: CapturedCall[];
  /** How many outbound calls were aborted (deadline or cancellation). */
  readonly aborts: () => number;
  push(response: FakeHttpResponse): void;
  /** The conformance-kit target: enqueues neutral behaviors as HTTP responses. */
  target(): ConformanceTarget;
};

function sseBody(frames: readonly string[]): { getReader(): ByteStreamReaderLike } {
  const encoder = new TextEncoder();
  const chunks = frames.map((payload) => encoder.encode(`data: ${payload}\n\n`));
  let index = 0;
  return {
    getReader(): ByteStreamReaderLike {
      return {
        async read(): Promise<{ readonly done: boolean; readonly value?: Uint8Array }> {
          if (index >= chunks.length) {
            return { done: true };
          }
          const value = chunks[index];
          index += 1;
          return { done: false, ...(value === undefined ? {} : { value }) };
        },
        async cancel(): Promise<void> {
          index = chunks.length;
        },
        releaseLock(): void {
          // nothing to release on a fake
        },
      };
    },
  };
}

function toResponse(response: FakeHttpResponse): FetchResponseLike {
  const status = response.status ?? 200;
  const headers = response.headers ?? {};
  const body =
    response.sse === undefined
      ? null
      : sseBody(response.sse);
  return {
    status,
    ok: status < 400,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    text: (): Promise<string> =>
      Promise.resolve(response.text ?? (response.json === undefined ? '' : JSON.stringify(response.json))),
    body,
  };
}

/** Map a mapped provider error back to a vendor status + error body for the fake endpoint. */
function rawErrorToFakeResponse(rawError: ProviderRawError): FakeHttpResponse {
  const statusByCategory: Readonly<Record<string, number>> = {
    AUTH: 401,
    RATE_LIMIT: 429,
    OVERLOADED: 503,
    BAD_REQUEST: 400,
    CONTENT_FILTER: 400,
    UPSTREAM: 500,
    UNKNOWN: 500,
  };
  const status = rawError.reason === 'MODEL_UNAVAILABLE' ? 404 : (statusByCategory[rawError.category] ?? 500);
  const type = rawError.reason === 'MODEL_UNAVAILABLE' ? 'model_not_found' : 'invalid_request_error';
  return {
    status,
    ...(rawError.retryAfterMs === undefined ? {} : { headers: { 'retry-after': String(rawError.retryAfterMs / 1000) } }),
    json: { error: { type, code: type, message: rawError.rawMessage ?? 'synthetic vendor failure' } },
  };
}

export function makeFakeOpenAi(options: { readonly id?: string; readonly modelRef?: string } = {}): FakeOpenAiTransport {
  const modelRef = options.modelRef ?? 'fake-model';
  const queue: FakeHttpResponse[] = [];
  const calls: CapturedCall[] = [];
  let abortCount = 0;

  const fetch: FetchLike = (url: string, init: FetchRequestInitLike): Promise<FetchResponseLike> => {
    const body = typeof init.body === 'string' ? init.body : '';
    calls.push({
      url,
      method: init.method,
      headers: { ...(init.headers ?? {}) },
      body,
      payload: JSON.parse(body) as Record<string, unknown>,
    });
    const next = queue.shift();
    if (next === undefined) {
      return Promise.reject(new Error('fakeOpenAi: no scripted response remains'));
    }
    if (next.hang === true) {
      // Respects the abort signal, so deadline and cancellation tests observe a real abandoned
      // outbound call rather than a forever-pending promise.
      return new Promise<FetchResponseLike>((_resolve, reject) => {
        const signal = init.signal as { addEventListener?: (type: string, callback: () => void) => void } | undefined;
        signal?.addEventListener?.('abort', () => {
          abortCount += 1;
          reject(new Error('fakeOpenAi: request aborted'));
        });
      });
    }
    return Promise.resolve(toResponse(next));
  };

  const adapter = new Adapter({
    id: options.id ?? 'fake',
    baseUrl: 'https://fake.example.invalid/v1',
    fetch,
    models: [
      {
        modelRef,
        features: ['text', 'structuredJson', 'streaming', 'usage'],
        maxContextTokens: 8_192,
        maxOutputTokens: 4_096,
        profiles: ['fast', 'balanced', 'reasoning', 'cheap', 'high-context'],
      },
    ],
    features: ['text', 'structuredJson', 'streaming', 'usage'],
    maxConcurrency: 1,
    nowMs: () => 0,
  });

  const pushBehavior = (behavior: ConformanceBehavior): void => {
    switch (behavior.kind) {
      case 'text':
      case 'structured':
        queue.push({
          json: {
            choices: [
              {
                message: { content: behavior.text },
                finish_reason: behavior.finishReason === 'LENGTH' ? 'length' : behavior.finishReason === 'CONTENT_FILTER' ? 'content_filter' : 'stop',
              },
            ],
            ...(behavior.usage === undefined
              ? {}
              : {
                  usage: {
                    ...(behavior.usage.inputTokens === undefined ? {} : { prompt_tokens: behavior.usage.inputTokens }),
                    ...(behavior.usage.outputTokens === undefined ? {} : { completion_tokens: behavior.usage.outputTokens }),
                    ...(behavior.usage.totalTokens === undefined ? {} : { total_tokens: behavior.usage.totalTokens }),
                  },
                }),
          },
        });
        return;
      case 'failure':
        queue.push(rawErrorToFakeResponse(behavior.rawError));
        return;
      case 'hang':
        queue.push({ hang: true });
        return;
      case 'stream': {
        const frames = [
          ...behavior.deltas.map((text) => JSON.stringify({ choices: [{ delta: { content: text } }] })),
          JSON.stringify({
            choices: [{ delta: {}, finish_reason: behavior.finishReason === 'LENGTH' ? 'length' : 'stop' }],
            ...(behavior.usage === undefined
              ? {}
              : { usage: { total_tokens: behavior.usage.totalTokens ?? 0 } }),
          }),
          '[DONE]',
        ];
        queue.push({ sse: frames });
        return;
      }
      case 'stream-failure': {
        const frames = [
          ...behavior.deltas.map((text) => JSON.stringify({ choices: [{ delta: { content: text } }] })),
          JSON.stringify({
            error: {
              type: behavior.rawError.category === 'OVERLOADED' ? 'overloaded_error' : 'invalid_request_error',
              message: behavior.rawError.rawMessage ?? 'synthetic vendor stream failure',
            },
          }),
        ];
        queue.push({ sse: frames });
        return;
      }
      default: {
        const exhaustive: never = behavior;
        void exhaustive;
      }
    }
  };

  return {
    adapter,
    calls,
    aborts: () => abortCount,
    push(response: FakeHttpResponse): void {
      queue.push(response);
    },
    target(): ConformanceTarget {
      return { adapter, enqueue: pushBehavior };
    },
  };
}
