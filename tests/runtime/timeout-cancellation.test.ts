/**
 * Timeout and cancellation (ROADMAP Stage 3 §5, ARCHITECTURE.md §12–13).
 *
 * The frozen arithmetic is reused, not reinvented: `clampTimeoutBudget` clamps **down**,
 * `providerDeadlineAt` reserves `VALIDATION_RESERVE_MS` and refuses a non-viable attempt. The
 * tests assert the two failure modes stay distinguishable — `BUDGET_EXHAUSTED` when nothing viable
 * can start, `PROVIDER_TIMEOUT` when one attempt overruns — and that cancellation is terminal.
 */
import { ScriptedProviderAdapter, TestClock, hangStep, textStep } from '@aibridge/host-sdk';
import { AiRuntime } from '@aibridge/runtime';
import type { AiProviderAdapter, AiResult, CancellationToken, ProviderRequest, ProviderTextResult } from '@aibridge/contracts';
import { PROVIDER_ADAPTER_API_VERSION, type ProviderDescriptor } from '@aibridge/contracts';
import { describe, expect, it } from 'vitest';

import { makeFakeOpenAi } from '../helpers/openai-fake.js';

function textRequest(budget?: { readonly totalMs: number; readonly providerMs?: number }): Record<string, unknown> {
  return {
    contractVersion: '1.0',
    requestId: 'req-timeout-1',
    idempotencyKey: 'turn-timeout.attempt-1',
    capability: 'ai.text.generate',
    capabilityVersion: '1.0',
    profile: 'balanced',
    input: { instructions: 'Summarise.', context: [] },
    ...(budget === undefined ? {} : { timeoutBudget: budget }),
  };
}

const context = { callerPluginId: 'test.caller', grantedPermissions: ['ai.text.generate'] };

function manualCancellation(): { readonly token: CancellationToken; cancel(): void } {
  const callbacks = new Set<() => void>();
  let cancelled = false;
  return {
    token: {
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
    cancel(): void {
      cancelled = true;
      for (const callback of [...callbacks]) {
        callback();
      }
    },
  };
}

function scriptedRuntime(adapter: ScriptedProviderAdapter): AiRuntime {
  return new AiRuntime({
    providers: [{ adapter }],
    routes: { balanced: [{ providerId: adapter.id, modelRef: `${adapter.id}-model` }] },
    clock: new TestClock(0),
  });
}

describe('timeout', () => {
  it('reports BUDGET_EXHAUSTED before dispatch when no viable attempt can start', async () => {
    const adapter = new ScriptedProviderAdapter({ id: 'scripted' });
    const runtime = scriptedRuntime(adapter);
    const result = await runtime.execute(textRequest({ totalMs: 2_000 }), context);
    expect(result.status).toBe('FAILED');
    expect(result.error?.reason).toBe('BUDGET_EXHAUSTED');
    expect(result.error?.code).toBe('TIMEOUT');
    expect(result.error?.stage).toBe('DEADLINE');
    expect(result.error?.details?.['remainingMs']).toBe(2_000);
    expect(adapter.callCount).toBe(0);
  });

  it('abandons one attempt at the per-attempt deadline and reports PROVIDER_TIMEOUT', async () => {
    const adapter = new ScriptedProviderAdapter({ id: 'scripted' });
    adapter.pushText(hangStep());
    const runtime = scriptedRuntime(adapter);
    const result = await runtime.execute(textRequest({ totalMs: 5_000, providerMs: 50 }), context);
    expect(result.status).toBe('FAILED');
    expect(result.error?.reason).toBe('PROVIDER_TIMEOUT');
    expect(result.error?.retryable).toBe(true);
    expect(adapter.callCount).toBe(1);
  });

  it('clamps a caller budget down and never widens it', async () => {
    const adapter = new ScriptedProviderAdapter({ id: 'scripted' });
    adapter.pushText(textStep('fast'));
    const runtime = scriptedRuntime(adapter);
    const result = await runtime.execute(textRequest({ totalMs: 10 * 60 * 1000 }), context);
    // A 10-minute call cannot be bought: the capability cap (20 s) applies. The provider request
    // carries the clamped deadline, not the caller's wish.
    expect(result.status).toBe('SUCCEEDED');
    const dispatched = adapter.requests[0];
    expect(dispatched?.deadlineAtMs).toBeLessThanOrEqual(20_000);
  });

  it('propagates the deadline to the adapter, which abandons the outbound call', async () => {
    const fake = makeFakeOpenAi({ id: 'main', modelRef: 'fake-model' });
    fake.push({ hang: true });
    const runtime = new AiRuntime({
      providers: [{ adapter: fake.adapter }],
      routes: { balanced: [{ providerId: 'main', modelRef: 'fake-model' }] },
      clock: new TestClock(0),
    });
    const result = await runtime.execute(textRequest({ totalMs: 5_000, providerMs: 50 }), context);
    expect(result.error?.reason).toBe('PROVIDER_TIMEOUT');
    expect(fake.calls).toHaveLength(1);
    expect(fake.aborts()).toBeGreaterThan(0);
  });
});

describe('cancellation', () => {
  it('is terminal and charges nothing when cancelled before dispatch', async () => {
    const adapter = new ScriptedProviderAdapter({ id: 'scripted' });
    const runtime = scriptedRuntime(adapter);
    const cancellation = manualCancellation();
    cancellation.cancel();
    const result = await runtime.execute(textRequest(), context, { cancellation: cancellation.token });
    expect(result.status).toBe('FAILED');
    expect(result.error?.reason).toBe('CANCELLED_BY_CALLER');
    expect(result.error?.retryable).toBe(false);
    expect(result.usage).toEqual({});
    expect(adapter.callCount).toBe(0);
  });

  it('discards a late provider answer — CANCELLED is final', async () => {
    let release: (() => void) | undefined;
    const descriptor: ProviderDescriptor = {
      id: 'late',
      family: 'mock',
      features: ['text'],
      models: [
        {
          providerId: 'late',
          modelRef: 'late-model',
          displayName: 'late',
          features: ['text'],
          maxContextTokens: 1_000,
          maxOutputTokens: 1_000,
          profiles: ['balanced'],
        },
      ],
      maxConcurrency: 1,
      supportsIdempotency: false,
    };
    const late: AiProviderAdapter = {
      id: 'late',
      family: 'mock',
      adapterApiVersion: PROVIDER_ADAPTER_API_VERSION,
      descriptor,
      async generateText(_request: ProviderRequest): Promise<ProviderTextResult> {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { text: 'too late', usage: {}, finishReason: 'STOP' };
      },
      async generateStructured(): Promise<never> {
        throw new Error('not used');
      },
    };
    const runtime = new AiRuntime({
      providers: [{ adapter: late }],
      routes: { balanced: [{ providerId: 'late', modelRef: 'late-model' }] },
      clock: new TestClock(0),
    });

    const cancellation = manualCancellation();
    const pending: Promise<AiResult<unknown>> = runtime.execute(textRequest(), context, { cancellation: cancellation.token });
    await new Promise((resolve) => setTimeout(resolve, 5));
    cancellation.cancel();
    const result = await pending;
    expect(result.status).toBe('FAILED');
    expect(result.error?.reason).toBe('CANCELLED_BY_CALLER');

    // The provider answers late; the outcome must not change.
    release?.();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(result.error?.reason).toBe('CANCELLED_BY_CALLER');
  });

  it('aborts the outbound call on cancel', async () => {
    const fake = makeFakeOpenAi({ id: 'main', modelRef: 'fake-model' });
    fake.push({ hang: true });
    const runtime = new AiRuntime({
      providers: [{ adapter: fake.adapter }],
      routes: { balanced: [{ providerId: 'main', modelRef: 'fake-model' }] },
      clock: new TestClock(0),
    });
    const cancellation = manualCancellation();
    const pending = runtime.execute(textRequest({ totalMs: 30_000 }), context, { cancellation: cancellation.token });
    await new Promise((resolve) => setTimeout(resolve, 5));
    cancellation.cancel();
    const result = await pending;
    expect(result.error?.reason).toBe('CANCELLED_BY_CALLER');
    expect(fake.aborts()).toBeGreaterThan(0);
  });
});
