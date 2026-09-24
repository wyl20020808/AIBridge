/**
 * Xiaomi MiMo Token Plan adapter — provider-specific tests (ROADMAP Stage 4 §31).
 *
 * Token Plan auth header, cluster presets, provider config validation, model descriptor
 * projection, structured output, streaming, invalid credential, quota/rate errors and secret
 * masking. `tp-` prefix handling is diagnostic-only and is asserted as such.
 */
import {
  XiaomiTokenPlanAdapter,
  XIAOMI_TOKEN_PLAN_ENDPOINTS,
  looksLikeTokenPlanKey,
  type FetchLike,
  type FetchRequestInitLike,
  type XiaomiTokenPlanConfig,
} from '@aibridge/provider-xiaomi-tokenplan';
import type { ProviderRequest, ProviderStreamEvent } from '@aibridge/contracts';
import { describe, expect, it } from 'vitest';

const syntheticSecret = `tp-${'K'.repeat(32)}`;

type Pushed = {
  readonly status?: number;
  readonly json?: unknown;
  readonly text?: string;
  readonly sse?: readonly string[];
  readonly headers?: Record<string, string>;
};

function makeFake(config: Partial<XiaomiTokenPlanConfig> = {}) {
  const queue: Pushed[] = [];
  const calls: Array<{ url: string; init: FetchRequestInitLike; payload: Record<string, unknown> }> = [];
  const fetch: FetchLike = (url: string, init: FetchRequestInitLike) => {
    calls.push({ url, init, payload: init.body === undefined ? {} : (JSON.parse(init.body) as Record<string, unknown>) });
    const next = queue.shift();
    if (next === undefined) {
      return Promise.reject(new Error('fakeXiaomi: no scripted response remains'));
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
  const adapter = new XiaomiTokenPlanAdapter({
    id: 'xiaomi',
    cluster: 'CN',
    fetch,
    nowMs: () => 0,
    models: [
      {
        modelRef: 'MODEL_FROM_CONFIG',
        features: ['text', 'structuredJson', 'streaming', 'usage'],
        maxContextTokens: 1_048_576,
        maxOutputTokens: 131_072,
        profiles: ['fast', 'balanced', 'reasoning', 'cheap', 'high-context'],
      },
    ],
    ...config,
  });
  adapter.bindCredentials({ handle: 'secret://xiaomi/token-plan', secret: syntheticSecret });
  return { adapter, calls, push: (response: Pushed) => queue.push(response) };
}

function request(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    capability: 'ai.text.generate',
    profile: 'balanced',
    instructions: 'Reply with one word.',
    context: [{ name: 'probe', label: 'Probe', untrusted: true, value: 'ping' }],
    modelRef: 'MODEL_FROM_CONFIG',
    deadlineAtMs: 1_000_000,
    ...overrides,
  };
}

function completion(content: string | null, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    choices: [{ message: { content, role: 'assistant', reasoning_content: 'internal monologue' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7, prompt_tokens_details: { cached_tokens: 1 } },
    ...extra,
  };
}

describe('Token Plan auth and clusters', () => {
  it('authenticates with the documented api-key header by default', async () => {
    const fake = makeFake();
    fake.push({ json: completion('pong') });
    await fake.adapter.generateText(request());
    const call = fake.calls[0];
    expect(call?.init.headers?.['api-key']).toBe(syntheticSecret);
    expect(call?.init.headers?.['authorization']).toBeUndefined();
    expect(JSON.stringify(call?.payload ?? {})).not.toContain(syntheticSecret);
  });

  it('supports the documented Bearer alternative when declared', async () => {
    const fake = makeFake({ authScheme: 'BEARER' });
    fake.push({ json: completion('pong') });
    await fake.adapter.generateText(request());
    expect(fake.calls[0]?.init.headers?.['authorization']).toBe(`Bearer ${syntheticSecret}`);
  });

  it('resolves the regional cluster endpoints from the preset', () => {
    expect(XIAOMI_TOKEN_PLAN_ENDPOINTS.CN).toContain('token-plan-cn');
    expect(XIAOMI_TOKEN_PLAN_ENDPOINTS.SGP).toContain('token-plan-sgp');
    expect(XIAOMI_TOKEN_PLAN_ENDPOINTS.EU).toContain('token-plan-ams');
    for (const cluster of ['CN', 'SGP', 'EU'] as const) {
      const fake = makeFake({ cluster });
      expect(String(fake.adapter.credentialHandle)).toBe('secret://xiaomi/token-plan');
    }
  });

  it('lets trusted configuration override the endpoint and rejects an unsafe one', async () => {
    const captured: string[] = [];
    const fetch: FetchLike = (url: string) => {
      captured.push(url);
      return Promise.resolve({
        status: 200,
        ok: true,
        headers: { get: () => null },
        text: () => Promise.resolve(JSON.stringify(completion('ok'))),
        body: null,
      });
    };
    const adapter = new XiaomiTokenPlanAdapter({
      id: 'xiaomi',
      baseUrl: 'https://relay.example.invalid/v1',
      fetch,
      nowMs: () => 0,
      models: [{ modelRef: 'MODEL_FROM_CONFIG', features: ['text'], maxContextTokens: 1, maxOutputTokens: 1 }],
    });
    await adapter.generateText(request());
    expect(captured[0]).toBe('https://relay.example.invalid/v1/chat/completions');

    expect(
      () =>
        new XiaomiTokenPlanAdapter({
          id: 'xiaomi',
          baseUrl: 'https://metadata.google.internal/',
          models: [{ modelRef: 'MODEL_FROM_CONFIG', features: ['text'], maxContextTokens: 1, maxOutputTokens: 1 }],
        }),
    ).toThrow();
  });
});

describe('provider config and model descriptor', () => {
  it('projects operator-declared model descriptors verbatim', () => {
    const fake = makeFake();
    const model = fake.adapter.descriptor.models[0];
    expect(model?.modelRef).toBe('MODEL_FROM_CONFIG');
    expect(model?.maxContextTokens).toBe(1_048_576);
    expect(model?.maxOutputTokens).toBe(131_072);
    expect(model?.features).toContain('structuredJson');
    expect(model?.features).not.toContain('jsonSchema'); // never assumed
  });

  it('treats the tp- prefix as a diagnostic hint only', () => {
    expect(looksLikeTokenPlanKey(syntheticSecret)).toBe(true);
    expect(looksLikeTokenPlanKey(`sk-${'A'.repeat(24)}`)).toBe(false);
    const fake = makeFake();
    expect(fake.adapter.credentialShape).toBe('TOKEN_PLAN_LIKE');
    // …and a non-tp secret is still accepted: the hint never authorizes or rejects.
    const other = makeFake();
    other.adapter.bindCredentials({ handle: 'secret://xiaomi/other', secret: `zz-${'Q'.repeat(24)}` });
    expect(other.adapter.credentialShape).toBe('OTHER');
  });
});

describe('structured output and streaming', () => {
  it('requests JSON Output and only claims json_schema when declared', async () => {
    const fake = makeFake();
    fake.push({ json: completion('{"ok":true}') });
    await fake.adapter.generateStructured(request());
    expect(fake.calls[0]?.payload['response_format']).toEqual({ type: 'json_object' });
    expect(fake.calls[0]?.payload['max_completion_tokens']).toBeUndefined();

    const declared = makeFake({ structuredOutput: 'JSON_SCHEMA' });
    declared.push({ json: completion('{"ok":true}') });
    await declared.adapter.generateStructured(
      request({
        outputSchema: {
          kind: 'INLINE',
          schemaId: 'test.summary',
          version: '1.0',
          dialect: 'aibridge.fields/v1',
          fields: [{ name: 'summary', type: 'STRING', required: true, description: 'One line.' }],
        },
        maxOutputTokens: 256,
      }),
    );
    const format = declared.calls[0]?.payload['response_format'] as Record<string, unknown>;
    expect(format['type']).toBe('json_schema');
    expect(declared.calls[0]?.payload['max_completion_tokens']).toBe(256);
  });

  it('streams deltas with reasoning_content dropped and one FINISH', async () => {
    const fake = makeFake();
    fake.push({
      sse: [
        JSON.stringify({ choices: [{ delta: { reasoning_content: 'thinking…' } }] }),
        JSON.stringify({ choices: [{ delta: { content: 'po' } }] }),
        JSON.stringify({ choices: [{ delta: { content: 'ng' } }] }),
        JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { total_tokens: 3 } }),
        '[DONE]',
      ],
    });
    const events: ProviderStreamEvent[] = [];
    for await (const event of fake.adapter.streamText(request())) {
      events.push(event);
    }
    expect(events.map((event) => event.kind)).toEqual(['TEXT_DELTA', 'TEXT_DELTA', 'FINISH']);
    expect(JSON.stringify(events)).not.toContain('thinking');
  });

  it('maps the documented finish reasons, leaving unknown spellings unknown', async () => {
    const fake = makeFake();
    fake.push({ json: completion('x', { choices: [{ message: { content: 'x' }, finish_reason: 'repetition_truncation' }] }) });
    expect((await fake.adapter.generateText(request())).finishReason).toBe('UNKNOWN');
  });
});

describe('invalid credential, quota/rate errors and secret masking', () => {
  it('maps an invalid credential and a quota/rate failure without leaking prose', async () => {
    const cases: ReadonlyArray<readonly [number, string, string]> = [
      [401, '{"error":{"message":"Invalid API Key","type":"invalid_request_error"}}', 'PROVIDER_AUTH_FAILED'],
      [429, '{"error":{"message":"Rate limit exceeded","type":"rate_limit_error"}}', 'PROVIDER_THROTTLED'],
      [429, '{"error":{"message":"Quota exhausted","type":"insufficient_quota"}}', 'PROVIDER_BALANCE_EXHAUSTED'],
    ];
    for (const [status, body, reason] of cases) {
      const fake = makeFake();
      fake.push({ status, text: body });
      let caught: { message?: string; rawError?: { reason?: string } } | undefined;
      try {
        await fake.adapter.generateText(request());
      } catch (error) {
        caught = error as { message?: string; rawError?: { reason?: string } };
      }
      expect(caught?.rawError?.reason, `status ${status} ${body}`).toBe(reason);
      expect(caught?.message).toBe('provider call failed');
    }
  });

  it('masks the credential in every serialization and keeps the handle loggable', () => {
    const fake = makeFake();
    const serialized = `${JSON.stringify(fake.adapter)}\n${String(fake.adapter)}`;
    expect(serialized).not.toContain(syntheticSecret);
    expect(serialized).toContain('[REDACTED]');
    expect(fake.adapter.credentialHandle).toBe('secret://xiaomi/token-plan');
    // The sanitized operator detail strips an echoed credential too.
    expect(fake.adapter.sanitizeForOperator(`upstream echoed ${syntheticSecret}`)).not.toContain(syntheticSecret);
  });

  it('never sends thinking fields for a profile without an explicit mapping', async () => {
    const fake = makeFake({ thinking: { effortByProfile: { reasoning: 'default' } } });
    fake.push({ json: completion('x') });
    await fake.adapter.generateText(request({ profile: 'fast' }));
    expect(fake.calls[0]?.payload['thinking']).toEqual({ type: 'disabled' });
  });
});
