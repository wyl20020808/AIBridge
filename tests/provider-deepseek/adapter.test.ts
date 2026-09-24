/**
 * DeepSeek Official adapter — provider-specific tests (ROADMAP Stage 4 §30).
 *
 * Thinking disabled / reasoning profile / effort mapping (never a silent high), final-content-only
 * with reasoning isolation, JSON Output semantics (valid JSON ≠ schema adherence), empty and
 * malformed structured content, 429 and overload — all mapped into the Stage 3 generic vocabulary.
 */
import { DEFAULT_DEEPSEEK_THINKING, DeepSeekAdapter, type DeepSeekConfig, type FetchLike, type FetchRequestInitLike } from '@aibridge/provider-deepseek';
import type { ProviderRequest, ProviderStreamEvent } from '@aibridge/contracts';
import { describe, expect, it } from 'vitest';

const syntheticSecret = `ds-${'H'.repeat(32)}`;

type Pushed = {
  readonly status?: number;
  readonly json?: unknown;
  readonly text?: string;
  readonly sse?: readonly string[];
  readonly headers?: Record<string, string>;
};

function makeFake(config: Partial<DeepSeekConfig> = {}) {
  const queue: Pushed[] = [];
  const calls: Array<{ url: string; init: FetchRequestInitLike; payload: Record<string, unknown> }> = [];
  const fetch: FetchLike = (url: string, init: FetchRequestInitLike) => {
    calls.push({ url, init, payload: init.body === undefined ? {} : (JSON.parse(init.body) as Record<string, unknown>) });
    const next = queue.shift();
    if (next === undefined) {
      return Promise.reject(new Error('fakeDeepSeek: no scripted response remains'));
    }
    const status = next.status ?? 200;
    const headers = next.headers ?? {};
    const encoder = new TextEncoder();
    const chunks = (next.sse ?? []).map((payload) => encoder.encode(`data: ${payload}\n\n`));
    let index = 0;
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
  const adapter = new DeepSeekAdapter({
    id: 'deepseek',
    baseUrl: 'https://api.example.invalid',
    fetch,
    nowMs: () => 0,
    models: [
      {
        modelRef: 'MODEL_FROM_CONFIG',
        features: ['text', 'structuredJson', 'reasoning', 'streaming', 'usage'],
        maxContextTokens: 8_192,
        maxOutputTokens: 4_096,
        profiles: ['fast', 'balanced', 'reasoning', 'cheap', 'high-context'],
      },
    ],
    ...config,
  });
  adapter.bindCredentials({ handle: 'secret://deepseek/api-key', secret: syntheticSecret });
  return { adapter, calls, push: (response: Pushed) => queue.push(response) };
}

function request(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    capability: 'ai.text.generate',
    profile: 'balanced',
    instructions: 'Answer with one word.',
    context: [{ name: 'probe', label: 'Probe', untrusted: true, value: 'ping' }],
    modelRef: 'MODEL_FROM_CONFIG',
    deadlineAtMs: 1_000_000,
    ...overrides,
  };
}

function completion(content: string | null, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    choices: [{ message: { content, role: 'assistant', reasoning_content: 'chain of thought' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10, prompt_tokens_details: { cached_tokens: 2 } },
    ...extra,
  };
}

describe('thinking mapping — explicit, configurable, tested', () => {
  it('disables thinking for ordinary profiles (DeepSeek thinks by default server-side)', async () => {
    const fake = makeFake();
    fake.push({ json: completion('pong') });
    await fake.adapter.generateText(request({ profile: 'balanced' }));
    expect(fake.calls[0]?.payload['thinking']).toEqual({ type: 'disabled' });
    expect(fake.calls[0]?.payload['reasoning_effort']).toBeUndefined();
  });

  it('enables thinking at the documented default effort for the reasoning profile', async () => {
    const fake = makeFake();
    fake.push({ json: completion('pong') });
    await fake.adapter.generateText(request({ profile: 'reasoning' }));
    expect(fake.calls[0]?.payload['thinking']).toEqual({ type: 'enabled' });
    // `default` maps to the server default effort — no explicit effort field.
    expect(fake.calls[0]?.payload['reasoning_effort']).toBeUndefined();
  });

  it('maps explicit efforts and never upgrades an unmapped profile to high', async () => {
    const fake = makeFake({
      thinking: { effortByProfile: { reasoning: 'max', 'high-context': 'low' } },
    });
    fake.push({ json: completion('a') });
    await fake.adapter.generateText(request({ profile: 'reasoning' }));
    expect(fake.calls[0]?.payload['reasoning_effort']).toBe('max');

    fake.push({ json: completion('b') });
    await fake.adapter.generateText(request({ profile: 'high-context' }));
    expect(fake.calls[1]?.payload['reasoning_effort']).toBe('low');

    fake.push({ json: completion('c') });
    await fake.adapter.generateText(request({ profile: 'fast' }));
    expect(fake.calls[2]?.payload['thinking']).toEqual({ type: 'disabled' });
    expect(fake.calls[2]?.payload['reasoning_effort']).toBeUndefined();
  });

  it('exposes the default mapping as a documented constant', () => {
    expect(DEFAULT_DEEPSEEK_THINKING.effortByProfile['reasoning']).toBeDefined();
    expect(DEFAULT_DEEPSEEK_THINKING.effortByProfile['fast']).toBeUndefined();
  });
});

describe('reasoning isolation — final content only', () => {
  it('never returns reasoning_content as output', async () => {
    const fake = makeFake();
    fake.push({ json: completion('the final answer') });
    const result = await fake.adapter.generateText(request({ profile: 'reasoning' }));
    expect(result.text).toBe('the final answer');
    expect(JSON.stringify(result)).not.toContain('chain of thought');
  });

  it('drops reasoning deltas from the stream', async () => {
    const fake = makeFake();
    fake.push({
      sse: [
        JSON.stringify({ choices: [{ delta: { reasoning_content: 'thinking…' } }] }),
        JSON.stringify({ choices: [{ delta: { content: 'fi' } }] }),
        JSON.stringify({ choices: [{ delta: { content: 'nal' } }] }),
        JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { total_tokens: 4 } }),
        '[DONE]',
      ],
    });
    const events: ProviderStreamEvent[] = [];
    for await (const event of fake.adapter.streamText(request({ profile: 'reasoning' }))) {
      events.push(event);
    }
    expect(events.map((event) => event.kind)).toEqual(['TEXT_DELTA', 'TEXT_DELTA', 'FINISH']);
    expect(JSON.stringify(events)).not.toContain('thinking');
  });
});

describe('JSON handling — valid JSON, never schema adherence', () => {
  it('requests JSON Output and never claims jsonSchema', async () => {
    const fake = makeFake();
    fake.push({ json: completion('{"ok":true}') });
    await fake.adapter.generateStructured(request());
    expect(fake.calls[0]?.payload['response_format']).toEqual({ type: 'json_object' });
    expect(fake.adapter.descriptor.models[0]?.features).not.toContain('jsonSchema');
  });

  it('passes an empty-but-present JSON answer through for the validator to reject', async () => {
    const fake = makeFake();
    fake.push({ json: completion('') });
    const result = await fake.adapter.generateStructured(request());
    // Real empty content (documented): the strict validator downstream decides success.
    expect(result.text).toBe('');
  });

  it('reports a missing content field as malformed, not as an empty answer', async () => {
    const fake = makeFake();
    fake.push({ json: completion(null) });
    let caught: { rawError?: { reason?: string } } | undefined;
    try {
      await fake.adapter.generateStructured(request());
    } catch (error) {
      caught = error as { rawError?: { reason?: string } };
    }
    expect(caught?.rawError?.reason).toBe('PROVIDER_BAD_RESPONSE');
  });

  it('reports a non-JSON body as malformed', async () => {
    const fake = makeFake();
    fake.push({ text: 'Bad Gateway' });
    let caught: { rawError?: { reason?: string } } | undefined;
    try {
      await fake.adapter.generateText(request());
    } catch (error) {
      caught = error as { rawError?: { reason?: string } };
    }
    expect(caught?.rawError?.reason).toBe('PROVIDER_BAD_RESPONSE');
  });
});

describe('official error table → generic errors', () => {
  it('maps 401, 429, 402 and 503 exactly as documented', async () => {
    const cases: ReadonlyArray<readonly [number, string, string]> = [
      [401, '{"error":{"message":"Authentication Fails","type":"invalid_request_error"}}', 'PROVIDER_AUTH_FAILED'],
      [429, '{"error":{"message":"Rate Limit Reached","type":"rate_limit_error"}}', 'PROVIDER_THROTTLED'],
      [402, '{"error":{"message":"Insufficient Balance","type":"insufficient_balance"}}', 'PROVIDER_BALANCE_EXHAUSTED'],
      [503, '{"error":{"message":"Server Overloaded","type":"server_error"}}', 'PROVIDER_OVERLOADED'],
      [422, '{"error":{"message":"Invalid Parameters","type":"invalid_request_error"}}', 'PROVIDER_REQUEST_REJECTED'],
      [500, '{"error":{"message":"Server Error","type":"server_error"}}', 'PROVIDER_UNAVAILABLE'],
    ];
    for (const [status, body, reason] of cases) {
      const fake = makeFake();
      fake.push({ status, text: body });
      let caught: { rawError?: { reason?: string; rawMessage?: string }; message?: string } | undefined;
      try {
        await fake.adapter.generateText(request());
      } catch (error) {
        caught = error as { rawError?: { reason?: string; rawMessage?: string }; message?: string };
      }
      expect(caught?.rawError?.reason, `status ${status}`).toBe(reason);
      // Vendor prose stays operator-only; the thrown message is fixed and sanitized.
      expect(caught?.message).toBe('provider call failed');
    }
  });

  it('maps a model-not-found body to MODEL_UNAVAILABLE', async () => {
    const fake = makeFake();
    fake.push({ status: 400, text: '{"error":{"message":"Model Not Exist","type":"invalid_request_error","code":"model_not_found"}}' });
    let caught: { rawError?: { reason?: string } } | undefined;
    try {
      await fake.adapter.generateText(request());
    } catch (error) {
      caught = error as { rawError?: { reason?: string } };
    }
    expect(caught?.rawError?.reason).toBe('MODEL_UNAVAILABLE');
  });
});

describe('wire basics', () => {
  it('sends Bearer auth, max_tokens and the two prompt channels', async () => {
    const fake = makeFake();
    fake.push({ json: completion('ok') });
    await fake.adapter.generateText(request({ maxOutputTokens: 64 }));
    const call = fake.calls[0];
    expect(call?.url).toBe('https://api.example.invalid/chat/completions');
    expect(call?.init.headers?.['authorization']).toBe(`Bearer ${syntheticSecret}`);
    const payload = call?.payload ?? {};
    expect(payload['model']).toBe('MODEL_FROM_CONFIG');
    expect(payload['max_tokens']).toBe(64);
    const messages = payload['messages'] as Array<Record<string, unknown>>;
    expect(messages[0]?.['role']).toBe('system');
    expect(String(messages[0]?.['content'])).not.toContain('ping');
    expect(String(messages[1]?.['content'])).toContain('<<<aibridge-data');
    expect(JSON.stringify(payload)).not.toContain(syntheticSecret);
  });

  it('normalizes usage and keeps absent facts absent', async () => {
    const fake = makeFake();
    fake.push({ json: completion('ok') });
    const result = await fake.adapter.generateText(request());
    expect(result.usage).toEqual({ inputTokens: 7, outputTokens: 3, totalTokens: 10, cachedTokens: 2 });
    expect(JSON.stringify(result.usage)).not.toContain('reasoning');
  });

  it('keeps the credential out of every serialization', () => {
    const fake = makeFake();
    const serialized = `${JSON.stringify(fake.adapter)}\n${String(fake.adapter)}`;
    expect(serialized).not.toContain(syntheticSecret);
    expect(serialized).toContain('[REDACTED]');
    expect(fake.adapter.credentialHandle).toBe('secret://deepseek/api-key');
  });
});
