/**
 * Streaming (ROADMAP Stage 3 §6) — `Provider stream → Adapter → Generic stream events`.
 *
 * Order, finish, usage and error behaviour are asserted here **and** machine-checked through
 * `validateAiStreamSequence`: every stream this runtime produces is contract-valid, always
 * terminated, and never a second architecture — the same request, capability validation, route
 * resolution, deadlines and error model as the non-streaming path.
 */
import { ScriptedProviderAdapter, TestClock, streamStep } from '@aibridge/host-sdk';
import { AiRuntime } from '@aibridge/runtime';
import {
  validateAiStreamSequence,
  type AiProviderAdapter,
  type AiStreamCompleted,
  type AiStreamEvent,
  type AiStreamFailed,
  type CancellationToken,
  type ProviderDescriptor,
  type ProviderRequest,
  type ProviderStreamEvent,
} from '@aibridge/contracts';
import { describe, expect, it } from 'vitest';

import { makeFakeOpenAi } from '../helpers/openai-fake.js';

const context = { callerPluginId: 'test.caller', grantedPermissions: ['ai.text.generate', 'ai.structured.generate'] };

function textRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contractVersion: '1.0',
    requestId: 'req-stream-1',
    idempotencyKey: 'turn-stream.attempt-1',
    capability: 'ai.text.generate',
    capabilityVersion: '1.0',
    profile: 'balanced',
    input: { instructions: 'Summarise.', context: [] },
    ...overrides,
  };
}

async function collect(stream: AsyncIterable<AiStreamEvent>): Promise<AiStreamEvent[]> {
  const events: AiStreamEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

function expectValidSequence(events: readonly AiStreamEvent[]): void {
  const validated = validateAiStreamSequence(events);
  expect(validated.ok, JSON.stringify(validated.ok ? [] : validated.failure.issues)).toBe(true);
}

function failedTerminal(events: readonly AiStreamEvent[]): AiStreamFailed {
  const terminal = events[events.length - 1];
  if (terminal === undefined || terminal.kind !== 'FAILED') {
    throw new Error(`expected a FAILED terminal, got ${terminal === undefined ? 'nothing' : terminal.kind}`);
  }
  return terminal;
}

describe('streaming through the reference adapter', () => {
  it('delivers STARTED → deltas → COMPLETED with usage, finish and full text', async () => {
    const fake = makeFakeOpenAi({ id: 'main', modelRef: 'fake-model' });
    fake.push({
      sse: [
        JSON.stringify({ choices: [{ delta: { content: 'Hel' } }] }),
        JSON.stringify({ choices: [{ delta: { content: 'lo' } }] }),
        JSON.stringify({
          choices: [{ delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        }),
        '[DONE]',
      ],
    });
    const runtime = new AiRuntime({
      providers: [{ adapter: fake.adapter }],
      routes: { balanced: [{ providerId: 'main', modelRef: 'fake-model' }] },
      clock: new TestClock(0),
    });

    const events = await collect(runtime.stream(textRequest(), context));
    expectValidSequence(events);
    expect(events.map((event) => event.kind)).toEqual(['STARTED', 'TEXT_DELTA', 'TEXT_DELTA', 'COMPLETED']);

    const started = events[0];
    expect(started).toMatchObject({ kind: 'STARTED', requestId: 'req-stream-1', capability: 'ai.text.generate' });

    const terminal = events[events.length - 1] as AiStreamCompleted;
    expect(terminal.text).toBe('Hello');
    expect(terminal.text).toBe(
      events
        .filter((event) => event.kind === 'TEXT_DELTA')
        .map((event) => (event.kind === 'TEXT_DELTA' ? event.text : ''))
        .join(''),
    );
    expect(terminal.usage.totalTokens).toBe(5);
    expect(terminal.finishReason).toBe('STOP');
    expect(terminal.providerMetadata.providerFamily).toBe('openai-compatible');

    // The vendor framing never crosses: no `data:` frame, no `choices`, no `[DONE]`.
    expect(JSON.stringify(events)).not.toContain('[DONE]');
    expect(JSON.stringify(events)).not.toContain('delta');
  });

  it('maps a mid-stream vendor error to one FAILED terminal, keeping the deltas honest', async () => {
    const fake = makeFakeOpenAi({ id: 'main', modelRef: 'fake-model' });
    fake.push({
      sse: [
        JSON.stringify({ choices: [{ delta: { content: 'partial ' } }] }),
        JSON.stringify({ error: { type: 'overloaded_error', message: 'vendor stream prose' } }),
      ],
    });
    const runtime = new AiRuntime({
      providers: [{ adapter: fake.adapter }],
      routes: { balanced: [{ providerId: 'main', modelRef: 'fake-model' }] },
      clock: new TestClock(0),
    });

    const events = await collect(runtime.stream(textRequest(), context));
    expectValidSequence(events);
    const terminal = failedTerminal(events);
    expect(terminal.error.code).toBe('PROVIDER_ERROR');
    expect(terminal.error.details?.['providerCategory']).toBe('OVERLOADED');
    expect(JSON.stringify(events)).not.toContain('vendor stream prose');
  });

  it('fails the stream deterministically when the endpoint itself fails', async () => {
    const fake = makeFakeOpenAi({ id: 'main', modelRef: 'fake-model' });
    fake.push({ status: 500, json: { error: { type: 'server_error', message: 'boom' } } });
    const runtime = new AiRuntime({
      providers: [{ adapter: fake.adapter }],
      routes: { balanced: [{ providerId: 'main', modelRef: 'fake-model' }] },
      clock: new TestClock(0),
    });

    const events = await collect(runtime.stream(textRequest(), context));
    expectValidSequence(events);
    expect(events.map((event) => event.kind)).toEqual(['STARTED', 'FAILED']);
  });
});

describe('streaming — local failures, never a quiet downgrade', () => {
  it('refuses to stream a structured judgement', async () => {
    const fake = makeFakeOpenAi({ id: 'main', modelRef: 'fake-model' });
    const runtime = new AiRuntime({
      providers: [{ adapter: fake.adapter }],
      routes: { balanced: [{ providerId: 'main', modelRef: 'fake-model' }] },
      clock: new TestClock(0),
    });
    const events = await collect(
      runtime.stream(
        textRequest({
          capability: 'ai.structured.generate',
          outputSchema: {
            kind: 'INLINE',
            schemaId: 'test.summary',
            version: '1.0',
            dialect: 'aibridge.fields/v1',
            fields: [{ name: 'summary', type: 'STRING', required: true, description: 'x' }],
          },
        }),
        context,
      ),
    );
    expectValidSequence(events);
    const terminal = failedTerminal(events);
    expect(terminal.error.reason).toBe('NO_ROUTE');
    expect(terminal.error.retryable).toBe(false);
    expect(fake.calls).toHaveLength(0);
  });

  it('refuses streaming delivery when the route cannot stream', async () => {
    const descriptor: ProviderDescriptor = {
      id: 'mute',
      family: 'mock',
      features: ['text'],
      models: [
        {
          providerId: 'mute',
          modelRef: 'mute-model',
          displayName: 'mute',
          features: ['text'],
          maxContextTokens: 1_000,
          maxOutputTokens: 1_000,
          profiles: ['balanced'],
        },
      ],
      maxConcurrency: 1,
      supportsIdempotency: false,
    };
    let called = 0;
    const mute: AiProviderAdapter = {
      id: 'mute',
      family: 'mock',
      adapterApiVersion: 1,
      descriptor,
      async generateText(_request: ProviderRequest) {
        called += 1;
        return { text: 'x', usage: {}, finishReason: 'STOP' };
      },
      async generateStructured(): Promise<never> {
        throw new Error('not used');
      },
    };
    const runtime = new AiRuntime({
      providers: [{ adapter: mute }],
      routes: { balanced: [{ providerId: 'mute', modelRef: 'mute-model' }] },
      clock: new TestClock(0),
    });
    const events = await collect(runtime.stream(textRequest(), context));
    expectValidSequence(events);
    const terminal = failedTerminal(events);
    expect(terminal.error.reason).toBe('NO_ROUTE');
    expect(called).toBe(0);
  });
});

describe('streaming — cancellation and scripted behaviour', () => {
  it('closes a cancelled stream with one FAILED terminal and discards later deltas', async () => {
    const callbacks = new Set<() => void>();
    let cancelled = false;
    const token: CancellationToken = {
      get cancelled(): boolean {
        return cancelled;
      },
      onCancel(callback: () => void): () => void {
        callbacks.add(callback);
        return () => {
          callbacks.delete(callback);
        };
      },
    };

    let release: (() => void) | undefined;
    const descriptor: ProviderDescriptor = {
      id: 'slow',
      family: 'mock',
      features: ['text', 'streaming'],
      models: [
        {
          providerId: 'slow',
          modelRef: 'slow-model',
          displayName: 'slow',
          features: ['text', 'streaming'],
          maxContextTokens: 1_000,
          maxOutputTokens: 1_000,
          profiles: ['balanced'],
        },
      ],
      maxConcurrency: 1,
      supportsIdempotency: false,
    };
    const slow: AiProviderAdapter = {
      id: 'slow',
      family: 'mock',
      adapterApiVersion: 1,
      descriptor,
      async generateText(): Promise<never> {
        throw new Error('not used');
      },
      async generateStructured(): Promise<never> {
        throw new Error('not used');
      },
      async *streamText(_request: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
        yield { kind: 'TEXT_DELTA', text: 'first ' };
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        yield { kind: 'TEXT_DELTA', text: 'late' };
        yield { kind: 'FINISH', usage: {}, finishReason: 'STOP' };
      },
    };
    const runtime = new AiRuntime({
      providers: [{ adapter: slow }],
      routes: { balanced: [{ providerId: 'slow', modelRef: 'slow-model' }] },
      clock: new TestClock(0),
    });

    const events: AiStreamEvent[] = [];
    const drain = (async (): Promise<void> => {
      for await (const event of runtime.stream(textRequest(), context, { cancellation: token })) {
        events.push(event);
      }
    })();

    // Cancel while the generator is parked between deltas.
    await new Promise((resolve) => setTimeout(resolve, 5));
    cancelled = true;
    for (const callback of [...callbacks]) {
      callback();
    }
    await drain;
    release?.();

    expectValidSequence(events);
    const terminal = failedTerminal(events);
    expect(terminal.error.reason).toBe('CANCELLED_BY_CALLER');
    expect(events.some((event) => event.kind === 'TEXT_DELTA' && event.text === 'late')).toBe(false);
  });

  it('translates scripted provider events one-to-one', async () => {
    const adapter = new ScriptedProviderAdapter({ id: 'scripted' });
    adapter.pushStream(streamStep(['a', 'b'], { usage: { totalTokens: 2 }, finishReason: 'STOP' }));
    const runtime = new AiRuntime({
      providers: [{ adapter }],
      routes: { balanced: [{ providerId: 'scripted', modelRef: 'scripted-model' }] },
      clock: new TestClock(0),
    });
    const events = await collect(runtime.stream(textRequest(), context));
    expectValidSequence(events);
    expect(events.map((event) => event.kind)).toEqual(['STARTED', 'TEXT_DELTA', 'TEXT_DELTA', 'COMPLETED']);
  });
});
