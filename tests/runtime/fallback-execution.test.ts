/**
 * Automatic fallback execution (ROADMAP Stage 5 Phase 4–7, 52–58, 68).
 *
 * Every case runs through `AiRuntime` against fake adapters: no network, no real sleeps. What is
 * asserted is the *shape* of reliability — one overall deadline, no silent capability degrade,
 * consumer limits that cannot be dodged by switching providers, and one stable terminal error.
 */
import { KillSwitchRegistry } from '@aibridge/core';
import { describe, expect, it } from 'vitest';

import {
  callerContext,
  makeHarness,
  script,
  structuredTurn,
  subjectContext,
  textTurn,
  type FakeStep,
} from '../helpers/reliability.js';

const unavailable: FakeStep = {
  kind: 'rawError',
  rawError: { category: 'UPSTREAM', reason: 'PROVIDER_UNAVAILABLE', dispatched: true },
};
const overloaded: FakeStep = {
  kind: 'rawError',
  rawError: { category: 'OVERLOADED', reason: 'PROVIDER_OVERLOADED', dispatched: true },
};
const throttled: FakeStep = {
  kind: 'rawError',
  rawError: { category: 'RATE_LIMIT', reason: 'PROVIDER_THROTTLED', dispatched: true, retryAfterMs: 500 },
};
const contentBlocked: FakeStep = {
  kind: 'rawError',
  rawError: { category: 'CONTENT_FILTER', reason: 'PROVIDER_CONTENT_FILTER', dispatched: true },
};
const timeoutUnknown: FakeStep = {
  kind: 'rawError',
  rawError: { category: 'UPSTREAM', reason: 'PROVIDER_TIMEOUT' },
};
const balanceExhausted: FakeStep = {
  kind: 'rawError',
  rawError: { category: 'AUTH', reason: 'PROVIDER_BALANCE_EXHAUSTED', dispatched: true },
};

describe('automatic fallback execution (Phase 68)', () => {
  it('DeepSeek unavailable → OpenAI succeeds, with provenance and a FALLBACK_USED warning', async () => {
    const harness = makeHarness({
      providers: [
        { id: 'deepseek', behavior: script(unavailable) },
        { id: 'openai', behavior: script({ kind: 'text', text: 'served by the fallback', usage: { totalTokens: 3 } }) },
      ],
    });
    const outcome = await harness.runtime.executeObserved(textTurn(1), callerContext);
    expect(outcome.result.status).toBe('SUCCEEDED');
    expect(outcome.result.output).toEqual({ text: 'served by the fallback', finishReason: 'STOP' });
    expect(outcome.result.warnings.map((warning) => warning.code)).toContain('FALLBACK_USED');
    expect(outcome.result.providerMetadata).toMatchObject({ providerId: 'openai', routeDepth: 1, attemptCount: 2 });

    expect(outcome.provenance.attempts).toHaveLength(2);
    expect(outcome.provenance.attempts[0]).toMatchObject({ providerId: 'deepseek', status: 'FAILED', errorReason: 'PROVIDER_UNAVAILABLE' });
    expect(outcome.provenance.attempts[1]).toMatchObject({ providerId: 'openai', status: 'SUCCEEDED' });
    expect(outcome.provenance.fallbackCount).toBe(1);
    // Both attempts are accounted in the ledger.
    expect(await harness.ledger.attempts(outcome.provenance.logicalRequestId)).toHaveLength(2);
  });

  it('chases a depleted balance to the next provider (PROVIDER_BALANCE_EXHAUSTED, Stage 6)', async () => {
    const harness = makeHarness({
      providers: [
        { id: 'deepseek', behavior: script(balanceExhausted) },
        { id: 'openai', behavior: script({ kind: 'text', text: 'served by the fallback' }) },
      ],
    });
    const outcome = await harness.runtime.executeObserved(textTurn(1), callerContext);
    expect(outcome.result.status).toBe('SUCCEEDED');
    expect(outcome.result.output).toEqual({ text: 'served by the fallback', finishReason: 'STOP' });
    expect(outcome.result.providerMetadata).toMatchObject({ providerId: 'openai', routeDepth: 1, attemptCount: 2 });
    // The first wallet's emptiness is fully accounted: not retryable, but chased once.
    expect(outcome.provenance.attempts[0]).toMatchObject({
      providerId: 'deepseek',
      status: 'FAILED',
      errorReason: 'PROVIDER_BALANCE_EXHAUSTED',
    });
    expect(outcome.provenance.fallbackCount).toBe(1);
  });

  it('does not chase CONTENT_BLOCKED — no content-policy shopping (Phase 4)', async () => {
    const harness = makeHarness({
      providers: [
        { id: 'deepseek', behavior: script(contentBlocked) },
        { id: 'openai', behavior: script({ kind: 'text', text: 'must not be reached' }) },
      ],
    });
    const outcome = await harness.runtime.executeObserved(textTurn(1), callerContext);
    expect(outcome.result.status).toBe('FAILED');
    expect(outcome.result.error?.reason).toBe('PROVIDER_CONTENT_FILTER');
    expect(harness.providers['openai']?.callCount).toBe(0);
  });

  it('a provider 429 falls back only when the route opts in (Phase 53)', async () => {
    const off = makeHarness({
      providers: [
        { id: 'relay', behavior: script(throttled) },
        { id: 'openai', behavior: script({ kind: 'text', text: 'fallback' }) },
      ],
    });
    const refused = await off.runtime.executeObserved(textTurn(1), callerContext);
    expect(refused.result.error?.reason).toBe('PROVIDER_THROTTLED');
    expect(off.providers['openai']?.callCount).toBe(0);

    const on = makeHarness({
      providers: [
        { id: 'relay', behavior: script(throttled) },
        { id: 'openai', behavior: script({ kind: 'text', text: 'fallback' }) },
      ],
      governance: { fallback: { fallbackOnRateLimit: true } },
    });
    const served = await on.runtime.executeObserved(textTurn(1), callerContext);
    expect(served.result.status).toBe('SUCCEEDED');
    expect(served.result.providerMetadata.routeDepth).toBe(1);
  });

  it('a timeout with an unknown outcome follows the route policy (Phase 4/8)', async () => {
    const defaultPolicy = makeHarness({
      providers: [
        { id: 'deepseek', behavior: script(timeoutUnknown) },
        { id: 'openai', behavior: script({ kind: 'text', text: 'served' }) },
      ],
    });
    const served = await defaultPolicy.runtime.executeObserved(textTurn(1), callerContext);
    expect(served.result.status).toBe('SUCCEEDED');

    const conservative = makeHarness({
      providers: [
        { id: 'deepseek', behavior: script(timeoutUnknown) },
        { id: 'openai', behavior: script({ kind: 'text', text: 'served' }) },
      ],
      governance: { fallback: { crossProviderFallbackOnUnknownOutcome: false } },
    });
    const stopped = await conservative.runtime.executeObserved(textTurn(1), callerContext);
    expect(stopped.result.status).toBe('FAILED');
    expect(stopped.result.error?.reason).toBe('PROVIDER_TIMEOUT');
    expect(conservative.providers['openai']?.callCount).toBe(0);
  });

  it('reports the terminal error of the whole chain when every candidate fails (Phase 55)', async () => {
    const harness = makeHarness({
      providers: [
        { id: 'deepseek', behavior: script(unavailable) },
        { id: 'openai', behavior: script(overloaded) },
      ],
    });
    const outcome = await harness.runtime.executeObserved(textTurn(1), callerContext);
    expect(outcome.result.status).toBe('FAILED');
    // The freshest provider evidence, not a generic INTERNAL.
    expect(outcome.result.error?.reason).toBe('PROVIDER_OVERLOADED');
    expect(outcome.provenance.attempts).toHaveLength(2);
    expect(outcome.governance.attemptCount).toBe(2);
  });

  it('skips a kill-switched provider and lands on the next hop (Phase 49/52)', async () => {
    const killSwitches = new KillSwitchRegistry();
    killSwitches.setProvider('deepseek', true); // switch the kill on
    const harness = makeHarness({
      providers: [
        { id: 'deepseek', behavior: script({ kind: 'text', text: 'must not run' }) },
        { id: 'openai', behavior: script({ kind: 'text', text: 'served' }) },
      ],
      killSwitches,
    });
    const outcome = await harness.runtime.executeObserved(textTurn(1), callerContext);
    expect(outcome.result.status).toBe('SUCCEEDED');
    expect(outcome.result.providerMetadata.providerId).toBe('openai');
    expect(harness.providers['deepseek']?.callCount).toBe(0);
    expect(outcome.provenance.skippedCount).toBe(1);
    expect(outcome.provenance.attempts.some((attempt) => attempt.skipReason === 'KILL_SWITCH')).toBe(true);
  });

  it('skips a candidate whose breaker is open and records why (Phase 52)', async () => {
    const harness = makeHarness({
      providers: [
        { id: 'deepseek', behavior: script(unavailable, unavailable, unavailable, unavailable, unavailable) },
        { id: 'openai', behavior: script({ kind: 'text', text: 'served' }) },
      ],
      governance: { breaker: { failureThreshold: 2, windowMs: 60_000 } },
    });
    // Two turns of transient failure open `deepseek`'s breaker (fallback keeps serving meanwhile).
    await harness.runtime.executeObserved(textTurn(1), callerContext);
    await harness.runtime.executeObserved(textTurn(2), callerContext);
    const before = harness.providers['deepseek']?.callCount ?? 0;
    const outcome = await harness.runtime.executeObserved(textTurn(3), callerContext);
    expect(outcome.result.status).toBe('SUCCEEDED');
    expect(outcome.result.providerMetadata.providerId).toBe('openai');
    expect(harness.providers['deepseek']?.callCount).toBe(before);
    expect(outcome.provenance.attempts.some((attempt) => attempt.skipReason === 'BREAKER_OPEN')).toBe(true);
  });

  it('never degrades capability silently: a hop that cannot meet the requirements is dropped (Phase 5)', async () => {
    const harness = makeHarness({
      providers: [
        { id: 'fast', behavior: script({ kind: 'text', text: 'fast answer' }), features: ['text', 'structuredJson', 'usage'] },
        { id: 'reasoning', behavior: script({ kind: 'text', text: 'thought-through answer' }), features: ['text', 'structuredJson', 'reasoning', 'usage'] },
      ],
    });
    const outcome = await harness.runtime.executeObserved(
      textTurn(1, { requirements: { reasoning: true } }),
      callerContext,
    );
    expect(outcome.result.status).toBe('SUCCEEDED');
    // The first hop cannot reason, so it was never a candidate: no fallback, no degrade warning.
    expect(outcome.result.output).toEqual({ text: 'thought-through answer', finishReason: 'STOP' });
    expect(harness.providers['fast']?.callCount).toBe(0);
    expect(outcome.provenance.fallbackCount).toBe(0);
  });

  it('shares one overall deadline across the chain (Phase 7)', async () => {
    // Each attempt gets only what is left: the chain of two hops can never cost 2 × provider budget.
    const harness = makeHarness({
      providers: [
        {
          id: 'deepseek',
          behavior: (call, request) => {
            expect(request.deadlineAtMs).toBeLessThanOrEqual(2_500);
            return call === 1 ? timeoutUnknown : { kind: 'text', text: 'never' };
          },
        },
        {
          id: 'openai',
          behavior: (_call, request) => {
            // The fallback inherits the remaining budget — its deadline cannot exceed the caller's.
            expect(request.deadlineAtMs).toBeLessThanOrEqual(2_500);
            return { kind: 'text', text: 'served within the shared deadline' };
          },
        },
      ],
    });
    const outcome = await harness.runtime.executeObserved(textTurn(1, { timeoutBudget: { totalMs: 2_500, providerMs: 1_500 } }), callerContext);
    expect(outcome.result.status).toBe('SUCCEEDED');
    expect(outcome.result.warnings.map((warning) => warning.code)).toContain('FALLBACK_USED');
  });

  it('never falls back for an invalid request or a caller-contract schema mismatch (Phase 4)', async () => {
    const harness = makeHarness({
      providers: [
        { id: 'deepseek', behavior: script({ kind: 'structured', text: '{"unexpected":"field"}' }) },
        { id: 'openai', behavior: script({ kind: 'structured', text: '{"summary":"never reached"}' }) },
      ],
      governance: { outputRepair: 'NONE' },
    });
    const outcome = await harness.runtime.executeObserved(structuredTurn(1), callerContext);
    expect(outcome.result.status).toBe('FAILED');
    expect(outcome.result.error?.reason).toBe('SCHEMA_VALIDATION_FAILED');
    expect(harness.providers['openai']?.callCount).toBe(0);
  });

  it('consumer quota exhaustion cannot be routed around (Phase 54)', async () => {
    const harness = makeHarness({
      providers: [
        { id: 'deepseek', behavior: script(unavailable) },
        { id: 'openai', behavior: script({ kind: 'text', text: 'served' }) },
      ],
      governance: { quotas: [{ scope: 'subject', meter: 'REQUESTS', period: 'DAY', limit: 5 }] },
    });
    const context = subjectContext('subtok-alpha');
    // Five logical requests (each dispatches two provider attempts and still counts once).
    for (let turn = 1; turn <= 5; turn += 1) {
      await harness.runtime.executeObserved(textTurn(turn), context);
    }
    // The next request is refused by the caller's own quota — the fallback chain cannot dodge it.
    const before = Object.values(harness.providers).reduce((sum, provider) => sum + provider.callCount, 0);
    const refused = await harness.runtime.executeObserved(textTurn(6), context);
    const after = Object.values(harness.providers).reduce((sum, provider) => sum + provider.callCount, 0);
    expect(refused.result.status).toBe('FAILED');
    expect(refused.result.error?.reason).toBe('QUOTA_SUBJECT');
    expect(after).toBe(before);
  });

  it('projects the frozen reliability fields and the safe warnings (Phase 56–58)', async () => {
    const harness = makeHarness({
      providers: [
        { id: 'deepseek', behavior: script(unavailable) },
        { id: 'openai', behavior: script({ kind: 'text', text: 'served', usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 } }) },
      ],
    });
    const outcome = await harness.runtime.executeObserved(textTurn(1), callerContext);
    expect(outcome.result.providerMetadata).toEqual({
      providerId: 'openai',
      providerFamily: 'mock',
      modelClass: 'FAST',
      routeDepth: 1,
      attemptCount: 2,
      repaired: false,
    });
    // The frozen `usage` stays the final result's usage; totals live in the governance summary.
    expect(outcome.result.usage.totalTokens).toBe(5);
    expect(outcome.governance.attemptCount).toBe(2);
    expect(outcome.governance.totalUsage.totalTokens).toBe(5);
  });
});
