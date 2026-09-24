/**
 * V1 stabilization audit regressions — the streaming governance gap (P0) and its neighbours.
 *
 * `AiRuntime.stream` used to call the adapter directly: no idempotency, no quota, no rate
 * limit, no ledger, no breaker record. These tests pin the governed behaviour, plus the
 * zero-dispatch quota release (F8), the raced idempotency join (F7), and dispose (F19).
 */
import { ScriptedProviderAdapter, TestClock, hangStep, streamStep, textStep } from '@aibridge/host-sdk';
import { AiRuntime } from '@aibridge/runtime';
import type { AiStreamEvent, CancellationToken } from '@aibridge/contracts';
import { describe, expect, it } from 'vitest';

const callerContext = { callerPluginId: 'test.caller', grantedPermissions: ['ai.text.generate'] };

function subjectContext(subjectToken: string): Record<string, unknown> {
  return { ...callerContext, subjectToken };
}

function textRequest(turn: number): Record<string, unknown> {
  return {
    contractVersion: '1.0',
    requestId: `req-stream-${turn}`,
    idempotencyKey: `turn-stream-${turn}`,
    capability: 'ai.text.generate',
    capabilityVersion: '1.0',
    profile: 'balanced',
    input: { instructions: 'Summarise.', context: [] },
  };
}

async function collect(stream: AsyncIterable<AiStreamEvent>): Promise<AiStreamEvent[]> {
  const events: AiStreamEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

function terminal(events: readonly AiStreamEvent[]): AiStreamEvent {
  const last = events[events.length - 1];
  if (last === undefined) {
    throw new Error('stream produced no events');
  }
  return last;
}

function failedReason(events: readonly AiStreamEvent[]): string {
  const last = terminal(events);
  if (last.kind !== 'FAILED') {
    throw new Error(`expected FAILED, got ${last.kind}`);
  }
  return last.error.reason ?? last.error.code;
}

describe('stream governance — the stream is a governed call, not a side channel', () => {
  it('charges quota on streams: the second stream is refused without dispatch', async () => {
    const adapter = new ScriptedProviderAdapter({ id: 'scripted' });
    adapter.pushStream(streamStep(['a'], { finishReason: 'STOP' }));
    adapter.pushStream(streamStep(['b'], { finishReason: 'STOP' }));
    const runtime = new AiRuntime({
      providers: [{ adapter }],
      routes: { balanced: [{ providerId: 'scripted', modelRef: 'scripted-model' }] },
      clock: new TestClock(0),
      governanceConfig: { quotas: [{ scope: 'subject', meter: 'REQUESTS', period: 'DAY', limit: 1 }] },
    });
    const context = subjectContext('subtok-stream-quota');

    const first = await collect(runtime.stream(textRequest(1), context));
    expect(terminal(first).kind).toBe('COMPLETED');

    const second = await collect(runtime.stream(textRequest(2), context));
    expect(terminal(second).kind).toBe('FAILED');
    expect(failedReason(second)).toBe('QUOTA_SUBJECT');
    expect(adapter.callCount).toBe(1);
  });

  it('applies the caller rate limit to streams', async () => {
    const adapter = new ScriptedProviderAdapter({ id: 'scripted' });
    adapter.pushStream(streamStep(['a'], { finishReason: 'STOP' }));
    adapter.pushStream(streamStep(['b'], { finishReason: 'STOP' }));
    const runtime = new AiRuntime({
      providers: [{ adapter }],
      routes: { balanced: [{ providerId: 'scripted', modelRef: 'scripted-model' }] },
      clock: new TestClock(0),
      governanceConfig: { rateLimits: [{ dimension: 'callerPlugin', limit: 1, windowMs: 60_000 }] },
    });

    expect(terminal(await collect(runtime.stream(textRequest(1), callerContext))).kind).toBe('COMPLETED');
    const second = await collect(runtime.stream(textRequest(2), callerContext));
    expect(terminal(second).kind).toBe('FAILED');
    expect(failedReason(second)).toBe('RATE_LIMIT_CALLER');
    expect(adapter.callCount).toBe(1);
  });

  it('replays an idempotent stream without a second dispatch', async () => {
    const adapter = new ScriptedProviderAdapter({ id: 'scripted' });
    adapter.pushStream(streamStep(['once'], { finishReason: 'STOP' }));
    const runtime = new AiRuntime({
      providers: [{ adapter }],
      routes: { balanced: [{ providerId: 'scripted', modelRef: 'scripted-model' }] },
      clock: new TestClock(0),
    });

    const first = await collect(runtime.stream(textRequest(1), callerContext));
    expect(terminal(first).kind).toBe('COMPLETED');
    const replay = await collect(runtime.stream({ ...textRequest(1), requestId: 'req-stream-1b' }, callerContext));
    expect(terminal(replay).kind).toBe('COMPLETED');
    expect(adapter.callCount).toBe(1);
  });

  it('writes the usage ledger for streams', async () => {
    const adapter = new ScriptedProviderAdapter({ id: 'scripted' });
    adapter.pushStream(streamStep(['a'], { usage: { totalTokens: 3 }, finishReason: 'STOP' }));
    const runtime = new AiRuntime({
      providers: [{ adapter }],
      routes: { balanced: [{ providerId: 'scripted', modelRef: 'scripted-model' }] },
      clock: new TestClock(0),
    });
    await collect(runtime.stream(textRequest(1), callerContext));
    const requests = await runtime.usageLedger.requests();
    expect(requests).toHaveLength(1);
    const attempts = await runtime.usageLedger.attempts();
    expect(attempts).toHaveLength(1);
  });

  it('refuses a kill-switched stream without dispatch', async () => {
    const adapter = new ScriptedProviderAdapter({ id: 'scripted' });
    adapter.pushStream(streamStep(['a'], { finishReason: 'STOP' }));
    const { KillSwitchRegistry } = await import('@aibridge/core');
    const killSwitches = new KillSwitchRegistry();
    killSwitches.apply({ global: true, providers: [], capabilities: [] });
    const runtime = new AiRuntime({
      providers: [{ adapter }],
      routes: { balanced: [{ providerId: 'scripted', modelRef: 'scripted-model' }] },
      clock: new TestClock(0),
      killSwitches,
    });
    const events = await collect(runtime.stream(textRequest(1), callerContext));
    expect(terminal(events).kind).toBe('FAILED');
    expect(adapter.callCount).toBe(0);
  });
});

describe('quota — a call cancelled before dispatch burns nothing', () => {
  it('releases the reservation when cancellation lands before any dispatch', async () => {
    const adapter = new ScriptedProviderAdapter({ id: 'scripted' });
    adapter.pushText(textStep('served'));
    adapter.pushText(textStep('served-again'));
    const runtime = new AiRuntime({
      providers: [{ adapter }],
      routes: { balanced: [{ providerId: 'scripted', modelRef: 'scripted-model' }] },
      clock: new TestClock(0),
      governanceConfig: { quotas: [{ scope: 'subject', meter: 'REQUESTS', period: 'DAY', limit: 1 }] },
    });
    const context = subjectContext('subtok-cancel-release');
    const cancelled: CancellationToken = { cancelled: true, onCancel: () => () => {} };

    const refused = await runtime.execute(textRequest(1), context, { cancellation: cancelled });
    expect(refused.status).toBe('FAILED');

    // The quota survived: the next real call still fits inside limit 1.
    const served = await runtime.execute(textRequest(2), context);
    expect(served.status).toBe('SUCCEEDED');
    expect(adapter.callCount).toBe(1);
  });
});

describe('idempotency join — a joiner is raced against its own deadline', () => {
  it('fails a joiner at its deadline instead of parking it on a hung leader', async () => {
    const adapter = new ScriptedProviderAdapter({ id: 'scripted' });
    adapter.pushText(hangStep());
    const runtime = new AiRuntime({
      providers: [{ adapter }],
      routes: { balanced: [{ providerId: 'scripted', modelRef: 'scripted-model' }] },
      clock: new TestClock(0),
    });
    const budget = { timeoutBudget: { totalMs: 5_000, providerMs: 200 } };
    const leader = runtime.execute({ ...textRequest(1), ...budget }, callerContext);
    const joiner = runtime.execute({ ...textRequest(1), requestId: 'req-stream-1-join', ...budget }, callerContext);
    const [leaderResult, joinerResult] = await Promise.all([leader, joiner]);
    expect(leaderResult.status).toBe('FAILED');
    expect(joinerResult.status).toBe('FAILED');
    expect(adapter.callCount).toBe(1);
  }, 15_000);
});

describe('dispose — shutdown is real and fail-closed', () => {
  it('runs adapter shutdown once and refuses new work afterwards', async () => {
    let shutdowns = 0;
    const inner = new ScriptedProviderAdapter({ id: 'scripted' });
    inner.pushText(textStep('served'));
    // Preserve the prototype (family/getters live there); only add a shutdown spy.
    const adapter = Object.assign(Object.create(Object.getPrototypeOf(inner)), inner, {
      shutdown: () => {
        shutdowns += 1;
        return Promise.resolve();
      },
    });
    const runtime = new AiRuntime({
      providers: [{ adapter }],
      routes: { balanced: [{ providerId: 'scripted', modelRef: 'scripted-model' }] },
      clock: new TestClock(0),
    });
    await runtime.dispose();
    await runtime.dispose();
    expect(shutdowns).toBe(1);

    const refused = await runtime.execute(textRequest(1), callerContext);
    expect(refused.status).toBe('FAILED');
    expect(refused.error?.reason).toBe('INTERNAL_ERROR');

    const events = await collect(runtime.stream(textRequest(2), callerContext));
    expect(events[0]?.kind).toBe('STARTED');
    expect(terminal(events).kind).toBe('FAILED');
    expect(failedReason(events)).toBe('INTERNAL_ERROR');
    expect(inner.callCount).toBe(0);
  });
});
