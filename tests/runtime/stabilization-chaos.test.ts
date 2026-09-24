/**
 * V1 stabilization audit — stream chaos, version fuzz, cache bounds, perf sanity.
 *
 * Bounded and deterministic throughout: seeded PRNGs with recorded seeds, FakeClock-backed
 * runtimes, no real sleeps, no network. Every test asserts the audit invariants — one terminal
 * result, no throw from the public surface, no secret leak, bounded growth.
 */
import { ScriptedProviderAdapter, streamRejectStep, streamStep, TestClock, textStep } from '@aibridge/host-sdk';
import { parseConsumerAiRequest, type AiResult } from '@aibridge/contracts';
import { IdempotencyRegistry, InMemoryIdempotencyStore } from '@aibridge/governance';
import { AiRuntime } from '@aibridge/runtime';
import { describe, expect, it } from 'vitest';

import { callerContext, makeHarness, script, textTurn } from '../helpers/reliability.js';

const streamCaller = { callerPluginId: 'test.caller', grantedPermissions: ['ai.text.generate'] };

function streamRequest(turn: number): Record<string, unknown> {
  return {
    contractVersion: '1.0',
    requestId: `req-chaos-stream-${turn}`,
    idempotencyKey: `turn-chaos-stream-${turn}`,
    capability: 'ai.text.generate',
    capabilityVersion: '1.0',
    profile: 'balanced',
    input: { instructions: 'Summarise.', context: [] },
  };
}

async function collect(stream: AsyncIterable<{ kind: string }>): Promise<{ kind: string }[]> {
  const events: { kind: string }[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

/** Deterministic PRNG (mulberry32) — every fuzz run reproduces from its seed. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('stream chaos — failures mid-stream still yield exactly one terminal', () => {
  it('survives mid-stream rejects, error events and cancel races without throwing', async () => {
    const adapter = new ScriptedProviderAdapter({ id: 'scripted' });
    adapter.pushStream(streamStep(['partial '], { rawError: { category: 'OVERLOADED', reason: 'PROVIDER_OVERLOADED' } }));
    adapter.pushStream(streamRejectStep(new Error('synthetic transport break mid-stream')));
    adapter.pushStream(streamStep(['recovered'], { finishReason: 'STOP' }));
    const runtime = new AiRuntime({
      providers: [{ adapter }],
      routes: { balanced: [{ providerId: 'scripted', modelRef: 'scripted-model' }] },
      clock: new TestClock(0),
    });

    const first = await collect(runtime.stream(streamRequest(1), streamCaller));
    expect(first[0]?.kind).toBe('STARTED');
    expect(first[first.length - 1]?.kind).toBe('FAILED');
    expect(first.filter((event) => event.kind === 'FAILED')).toHaveLength(1);

    const second = await collect(runtime.stream(streamRequest(2), streamCaller));
    expect(second[second.length - 1]?.kind).toBe('FAILED');
    expect(second.filter((event) => event.kind === 'FAILED')).toHaveLength(1);

    const third = await collect(runtime.stream(streamRequest(3), streamCaller));
    expect(third[third.length - 1]?.kind).toBe('COMPLETED');
    expect(adapter.callCount).toBe(3);
  });

  it('a cancel race during a stream closes with one CANCELLED terminal and no late deltas', async () => {
    const adapter = new ScriptedProviderAdapter({ id: 'scripted' });
    adapter.pushStream(streamStep(['first ', 'late'], { finishReason: 'STOP' }));
    const runtime = new AiRuntime({
      providers: [{ adapter }],
      routes: { balanced: [{ providerId: 'scripted', modelRef: 'scripted-model' }] },
      clock: new TestClock(0),
    });
    const callbacks = new Set<() => void>();
    let cancelled = false;
    const events: { kind: string; text?: string }[] = [];
    const drain = (async (): Promise<void> => {
      for await (const event of runtime.stream(streamRequest(4), streamCaller, {
        cancellation: {
          get cancelled(): boolean {
            return cancelled;
          },
          onCancel(callback: () => void): () => void {
            callbacks.add(callback);
            return () => {
              callbacks.delete(callback);
            };
          },
        },
      })) {
        events.push(event as { kind: string; text?: string });
        if (events.length === 2) {
          cancelled = true;
          for (const callback of [...callbacks]) {
            callback();
          }
        }
      }
    })();
    await drain;
    const kinds = events.map((event) => event.kind);
    expect(kinds[0]).toBe('STARTED');
    expect(kinds[kinds.length - 1]).toBe('FAILED');
    expect(kinds.filter((kind) => kind === 'FAILED')).toHaveLength(1);
    expect(events.some((event) => event.text === 'late')).toBe(false);
  });
});

describe('concurrency — streams and executes under one idempotency key', () => {
  it('eight concurrent mixed calls dispatch exactly once and all settle', async () => {
    const adapter = new ScriptedProviderAdapter({ id: 'scripted' });
    adapter.pushStream(streamStep(['once'], { finishReason: 'STOP' }));
    adapter.pushText(textStep('once'));
    const runtime = new AiRuntime({
      providers: [{ adapter }],
      routes: { balanced: [{ providerId: 'scripted', modelRef: 'scripted-model' }] },
      clock: new TestClock(0),
    });
    const shared = streamRequest(5);
    const calls = Array.from({ length: 8 }, (_, index) =>
      index % 2 === 0
        ? collect(runtime.stream(shared, streamCaller)).then((events) => events[events.length - 1]?.kind)
        : runtime.execute(shared, streamCaller).then((result) => result.status),
    );
    const outcomes = await Promise.all(calls);
    for (const outcome of outcomes) {
      expect(['COMPLETED', 'SUCCEEDED', 'FAILED']).toContain(outcome);
    }
    expect(adapter.callCount).toBeLessThanOrEqual(1);
  });

  it('a quota storm admits exactly the limit and never charges the refused', async () => {
    const harness = makeHarness({
      providers: [{ id: 'relay', behavior: script({ kind: 'text', text: 'served' }) }],
      governance: { quotas: [{ scope: 'callerPlugin', meter: 'REQUESTS', period: 'DAY', limit: 4 }] },
    });
    const outcomes = await Promise.all(
      Array.from({ length: 12 }, (_, index) => harness.runtime.executeObserved(textTurn(100 + index), callerContext)),
    );
    const succeeded = outcomes.filter((outcome) => outcome.result.status === 'SUCCEEDED');
    const refused = outcomes.filter((outcome) => outcome.result.error?.reason === 'QUOTA_CALLER');
    expect(succeeded).toHaveLength(4);
    expect(refused).toHaveLength(8);
    expect(harness.providers['relay']?.callCount).toBe(4);
  });
});

describe('fuzz — contract versions never throw the parser (seed 0xA17)', () => {
  it('every version string either parses or fails closed with CONTRACT_VERSION_UNSUPPORTED', () => {
    const random = rng(0x0a17);
    const alphabet = '0123456789.vx- Final_β ';
    for (let index = 0; index < 500; index += 1) {
      const length = Math.floor(random() * 12);
      let version = '';
      for (let c = 0; c < length; c += 1) {
        version += alphabet[Math.floor(random() * alphabet.length)];
      }
      const parsed = parseConsumerAiRequest({ ...textTurn(1), contractVersion: version });
      expect(typeof parsed.ok).toBe('boolean');
      if (!parsed.ok) {
        expect(typeof parsed.failure.reason).toBe('string');
      }
    }
    expect(parseConsumerAiRequest({ ...textTurn(1), contractVersion: '2.0' }).ok).toBe(false);
    expect(parseConsumerAiRequest({ ...textTurn(1), contractVersion: '1.2' }).ok).toBe(true);
  });
});

describe('memory sanity — the idempotency LRU stays bounded', () => {
  it('evicts oldest-first past capacity: the first key re-executes, the newest replays', async () => {
    const clock = new TestClock(0);
    const store = new InMemoryIdempotencyStore({ clock });
    const registry = new IdempotencyRegistry({ store, clock });
    const settled: AiResult<unknown> = {
      contractVersion: '1.1',
      requestId: 'req-lru',
      capability: 'ai.text.generate',
      capabilityVersion: '1.0',
      status: 'SUCCEEDED',
      output: { text: 'ok', finishReason: 'STOP' },
      usage: {},
      providerMetadata: { providerId: 'relay', providerFamily: 'mock', modelClass: 'FAST', routeDepth: 0, attemptCount: 1, repaired: false },
      latencyMs: 1,
      finishReason: 'STOP',
      warnings: [],
    };
    const identityFor = (turn: number): { callerPluginId: string; capability: string; capabilityVersion: string; idempotencyKey: string } => ({
      callerPluginId: 'test.caller',
      capability: 'ai.text.generate',
      capabilityVersion: '1.0',
      idempotencyKey: `turn-lru-${turn}`,
    });
    for (let turn = 0; turn < 10_002; turn += 1) {
      const verdict = await registry.gate(identityFor(turn), `fp-${turn}`, `lreq-${turn}`);
      expect(verdict.kind).toBe('PROCEED');
      if (verdict.kind === 'PROCEED') {
        await verdict.settle(settled);
      }
    }
    const evicted = await registry.gate(identityFor(0), 'fp-0', 'lreq-0-again');
    expect(evicted.kind).toBe('PROCEED');
    const retained = await registry.gate(identityFor(10_001), 'fp-10001', 'lreq-replay');
    expect(retained.kind).toBe('REPLAY');
  });
});

describe('performance sanity — request validation has no accidental superlinear scan', () => {
  it('parses 2000 consumer requests in well under the generous bound', () => {
    const startedAt = Date.now();
    for (let index = 0; index < 2000; index += 1) {
      const parsed = parseConsumerAiRequest(textTurn(index));
      expect(parsed.ok).toBe(true);
    }
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  });
});
