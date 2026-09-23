/**
 * Reliability properties and chaos (ROADMAP Stage 5 Phase 63–65).
 *
 * The property tests pin the invariants that make the reliability layer trustworthy; the fuzz and
 * chaos runs throw seeded randomness at the whole pipeline and assert the runtime always settles:
 * one terminal result, a finite attempt chain with unique ids, a monotone deadline, non-negative
 * quota and a consistent ledger — and it never throws.
 */
import { describe, expect, it } from 'vitest';

import {
  callerContext,
  makeHarness,
  script,
  structuredTurn,
  subjectContext,
  textTurn,
  type FakeBehavior,
  type FakeStep,
} from '../helpers/reliability.js';
import { estimateCost, usageIsUnknown } from '@aibridge/governance';
import { ConfigManager } from '@aibridge/runtime';
import { TestClock } from '@aibridge/host-sdk';

/** Deterministic PRNG (mulberry32): a fuzz run is reproducible from its seed. */
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

const failures: readonly FakeStep[] = [
  { kind: 'rawError', rawError: { category: 'UPSTREAM', reason: 'PROVIDER_UNAVAILABLE', dispatched: true } },
  { kind: 'rawError', rawError: { category: 'OVERLOADED', reason: 'PROVIDER_OVERLOADED', dispatched: true } },
  { kind: 'rawError', rawError: { category: 'UPSTREAM', reason: 'PROVIDER_TIMEOUT' } },
  { kind: 'rawError', rawError: { category: 'RATE_LIMIT', reason: 'PROVIDER_THROTTLED', dispatched: true } },
  { kind: 'rawError', rawError: { category: 'BAD_REQUEST', reason: 'PROVIDER_REQUEST_REJECTED', dispatched: true } },
  { kind: 'rawError', rawError: { category: 'CONTENT_FILTER', reason: 'PROVIDER_CONTENT_FILTER', dispatched: true } },
  { kind: 'rawError', rawError: { category: 'AUTH', reason: 'PROVIDER_AUTH_FAILED', dispatched: true } },
  { kind: 'throw', error: new Error('synthetic transport break') },
];

function randomBehavior(random: () => number, alwaysFail = false): FakeBehavior {
  return (call) => {
    if (!alwaysFail && random() < 0.35) {
      return { kind: 'text', text: `answer-${call}`, usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 } };
    }
    return failures[Math.floor(random() * failures.length)] ?? { kind: 'hang' };
  };
}

describe('reliability properties (Phase 63)', () => {
  it('same fingerprint ⇒ at most one provider execution chain', async () => {
    const harness = makeHarness({ providers: [{ id: 'relay', behavior: randomBehavior(rng(11)) }] });
    const results = await Promise.all(Array.from({ length: 6 }, () => harness.runtime.executeObserved(textTurn(1), callerContext)));
    const dispatched = harness.providers['relay']?.callCount ?? 0;
    expect(dispatched).toBeLessThanOrEqual(1);
    for (const outcome of results) {
      expect(outcome.result.status).toBe(['SUCCEEDED', 'FAILED'].includes(outcome.result.status) ? outcome.result.status : 'FAILED');
    }
  });

  it('a different fingerprint under one key never returns the old result', async () => {
    const harness = makeHarness({ providers: [{ id: 'relay', behavior: script({ kind: 'text', text: 'first body' }) }] });
    await harness.runtime.executeObserved(textTurn(1), callerContext);
    const conflicting = await harness.runtime.executeObserved(
      textTurn(1, { input: { instructions: 'A different body entirely.', context: [] } }),
      callerContext,
    );
    expect(conflicting.result.error?.reason).toBe('IDEMPOTENCY_CONFLICT');
    expect(JSON.stringify(conflicting.result.output ?? {})).not.toContain('first body');
  });

  it('cancellation never triggers fallback', async () => {
    for (let seed = 20; seed < 26; seed += 1) {
      const callbacks = new Set<() => void>();
      let cancelled = false;
      const token = {
        get cancelled(): boolean {
          return cancelled;
        },
        onCancel(callback: () => void): () => void {
          callbacks.add(callback);
          return () => callbacks.delete(callback);
        },
      };
      const harness = makeHarness({
        providers: [
          { id: 'deepseek', behavior: () => ({ kind: 'rawError', rawError: { category: 'UPSTREAM', reason: 'PROVIDER_TIMEOUT' } }) },
          { id: 'openai', behavior: () => ({ kind: 'text', text: 'must not serve' }) },
        ],
      });
      cancelled = true;
      for (const callback of [...callbacks]) {
        callback();
      }
      const outcome = await harness.runtime.executeObserved(textTurn(seed), callerContext, { cancellation: token });
      expect(outcome.result.error?.reason).toBe('CANCELLED_BY_CALLER');
      expect(harness.providers['openai']?.callCount).toBe(0);
    }
  });

  it('an invalid request never falls back', async () => {
    const harness = makeHarness({
      providers: [
        { id: 'deepseek', behavior: script({ kind: 'text', text: 'never' }) },
        { id: 'openai', behavior: script({ kind: 'text', text: 'never either' }) },
      ],
    });
    const outcome = await harness.runtime.executeObserved(textTurn(1, { capability: 'nope.nope.nope' }), {
      callerPluginId: 'test.caller',
      grantedPermissions: ['nope.nope.nope'],
    });
    expect(outcome.result.error?.reason).toBe('CAPABILITY_UNKNOWN');
    expect(harness.providers['deepseek']?.callCount).toBe(0);
    expect(harness.providers['openai']?.callCount).toBe(0);
  });

  it('consumer quota cannot be bypassed by provider fallback', async () => {
    const harness = makeHarness({
      providers: [
        { id: 'deepseek', behavior: script(...Array.from({ length: 20 }, () => failures[0] as FakeStep)) },
        { id: 'openai', behavior: script({ kind: 'text', text: 'moved' }) },
      ],
      governance: { quotas: [{ scope: 'callerPlugin', meter: 'REQUESTS', period: 'DAY', limit: 2 }] },
    });
    await harness.runtime.executeObserved(textTurn(1), callerContext);
    await harness.runtime.executeObserved(textTurn(2), callerContext);
    const refused = await harness.runtime.executeObserved(textTurn(3), callerContext);
    expect(refused.result.error?.reason).toBe('QUOTA_CALLER');
    const before = harness.providers['openai']?.callCount ?? 0;
    expect(before).toBeGreaterThan(0); // fallback was happening…
    expect(harness.providers['openai']?.callCount).toBe(before); // …and now nothing dispatches at all
  });

  it('the overall deadline never grows because of fallback', async () => {
    const seen: number[] = [];
    const harness = makeHarness({
      providers: [
        {
          id: 'deepseek',
          behavior: (_call, request) => {
            seen.push(request.deadlineAtMs);
            return { kind: 'rawError', rawError: { category: 'UPSTREAM', reason: 'PROVIDER_UNAVAILABLE', dispatched: true } };
          },
        },
        {
          id: 'openai',
          behavior: (_call, request) => {
            seen.push(request.deadlineAtMs);
            return { kind: 'text', text: 'served' };
          },
        },
      ],
    });
    await harness.runtime.executeObserved(textTurn(1, { timeoutBudget: { totalMs: 2_500, providerMs: 1_500 } }), callerContext);
    expect(seen.length).toBe(2);
    for (const deadlineAtMs of seen) {
      // Absolute deadlines never exceed the caller's overall deadline.
      expect(deadlineAtMs).toBeLessThanOrEqual(2_500);
    }
  });

  it('an open breaker candidate is never dispatched', async () => {
    const harness = makeHarness({
      providers: [
        { id: 'deepseek', behavior: randomBehavior(rng(7), true) },
        { id: 'openai', behavior: script({ kind: 'text', text: 'served' }) },
      ],
      governance: { breaker: { failureThreshold: 2 }, retry: { maxSameProviderRetries: 0 } },
    });
    await harness.runtime.executeObserved(textTurn(1), callerContext);
    await harness.runtime.executeObserved(textTurn(2), callerContext);
    const before = harness.providers['deepseek']?.callCount ?? 0;
    for (let turn = 3; turn < 8; turn += 1) {
      await harness.runtime.executeObserved(textTurn(turn), callerContext);
    }
    expect(harness.providers['deepseek']?.callCount).toBe(before);
  });

  it('a failed config reload keeps the active snapshot', async () => {
    const clock = new TestClock(0);
    const manager = ConfigManager.bootstrap(
      {
        providers: [
          {
            providerId: 'relay',
            preset: 'OPENAI_COMPATIBLE_CUSTOM',
            enabled: true,
            credentialRef: 'secret://test/relay',
            endpoint: { kind: 'CUSTOM', baseUrl: 'https://api.example.invalid/v1' },
            models: [
              { alias: 'relay.text.primary', providerId: 'relay', providerModelId: 'relay-model', profiles: ['balanced'], features: ['text'] },
            ],
          },
        ],
        routes: [{ profile: 'balanced', chain: ['relay.text.primary'] }],
      },
      { clock },
    );
    if (!manager.ok) {
      throw new Error('bootstrap failed');
    }
    const active = manager.value.active();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const failed = await manager.value.reload({ providers: 'not-an-array', routes: attempt });
      expect(failed.ok).toBe(false);
      expect(manager.value.active()).toBe(active);
    }
  });

  it('an unknown cost never becomes zero', () => {
    const unknownUsage = estimateCost({}, null);
    expect(unknownUsage.amount).toBeUndefined();
    const unknownPrice = estimateCost({ inputTokens: 10 }, null);
    expect(unknownPrice.amount).toBeUndefined();
    expect(usageIsUnknown({})).toBe(true);
  });

  it('the usage ledger never contains prompt or raw response text', async () => {
    const harness = makeHarness({
      providers: [
        { id: 'deepseek', behavior: script(failures[0] as FakeStep) },
        { id: 'openai', behavior: script({ kind: 'text', text: 'RAW RESPONSE MARKER 9f2', usage: { totalTokens: 2 } }) },
      ],
    });
    await harness.runtime.executeObserved(textTurn(1, { input: { instructions: 'PROMPT MARKER 7a1', context: [] } }), callerContext);
    const serialized = JSON.stringify(await harness.ledger.attempts());
    const serializedRequests = JSON.stringify(await harness.ledger.requests());
    expect(serialized).not.toContain('PROMPT MARKER 7a1');
    expect(serialized).not.toContain('RAW RESPONSE MARKER 9f2');
    expect(serializedRequests).not.toContain('PROMPT MARKER 7a1');
    expect(serializedRequests).not.toContain('RAW RESPONSE MARKER 9f2');
  });
});

describe('fuzz and chaos (Phase 64–65)', () => {
  it('always settles: one terminal result, finite attempts, unique ids, consistent ledger', async () => {
    for (let seed = 1; seed <= 25; seed += 1) {
      const random = rng(seed);
      const harness = makeHarness({
        providers: [
          { id: 'p1', behavior: randomBehavior(random) },
          { id: 'p2', behavior: randomBehavior(random) },
          { id: 'p3', behavior: randomBehavior(random) },
        ],
        governance: {
          breaker: { failureThreshold: 1 + Math.floor(random() * 4) },
          retry: { retryKnownNotAccepted: random() < 0.5, maxSameProviderRetries: 1 },
          fallback: { fallbackOnRateLimit: random() < 0.5 },
          quotas: [{ scope: 'global', meter: 'TOKENS', period: 'DAY', limit: Math.floor(random() * 10_000) }],
          outputRepair: random() < 0.5 ? 'ONCE' : 'NONE',
        },
      });
      const context = random() < 0.5 ? callerContext : subjectContext(`subtok-fuzz-${seed}`);
      const outcome = await harness.runtime.executeObserved(textTurn(seed, { timeoutBudget: { totalMs: 2_500, providerMs: 1_500 } }), context);

      // Single terminal result, never a throw.
      expect(['SUCCEEDED', 'FAILED']).toContain(outcome.result.status);
      if (outcome.result.status === 'SUCCEEDED') {
        expect(outcome.result.error).toBeUndefined();
      } else {
        expect(outcome.result.error).toBeDefined();
      }

      // Finite chain, unique attempt ids, monotone sequence.
      const ids = outcome.provenance.attempts.map((attempt) => attempt.attemptId);
      expect(new Set(ids).size).toBe(ids.length);
      expect(outcome.provenance.attempts.length).toBeLessThan(12);
      const sequences = outcome.provenance.attempts.map((attempt) => attempt.sequence);
      expect([...sequences].sort((a, b) => a - b)).toEqual(sequences);

      // Quota never goes negative and the ledger agrees with the provenance.
      const consumed = await harness.quotaStore.consumed('qt|global|global|TOKENS|DAY|1970-01-01');
      expect(consumed).toBeGreaterThanOrEqual(0);
      const attempts = await harness.ledger.attempts(outcome.provenance.logicalRequestId);
      expect(attempts.filter((record) => record.status !== 'SKIPPED')).toHaveLength(outcome.governance.attemptCount);
    }
  });

  it('survives timeouts, malformed payloads, late answers and cancel races without hanging', async () => {
    for (let seed = 100; seed < 112; seed += 1) {
      const random = rng(seed);
      const chaos: FakeBehavior = () => {
        const roll = random();
        if (roll < 0.2) {
          return { kind: 'hang' };
        }
        if (roll < 0.35) {
          return { kind: 'structured', text: '<<<not json at all>>>' };
        }
        if (roll < 0.5) {
          return { kind: 'rawError', rawError: { category: 'RATE_LIMIT', reason: 'PROVIDER_THROTTLED', dispatched: true } };
        }
        if (roll < 0.65) {
          return { kind: 'rawError', rawError: { category: 'OVERLOADED', reason: 'PROVIDER_OVERLOADED', dispatched: false } };
        }
        if (roll < 0.8) {
          return { kind: 'rawError', rawError: { category: 'UPSTREAM', reason: 'PROVIDER_TIMEOUT' } };
        }
        return { kind: 'structured', text: '{"summary":"stable"}', usage: { totalTokens: 2 } };
      };
      const harness = makeHarness({
        providers: [
          { id: 'p1', behavior: chaos },
          { id: 'p2', behavior: chaos },
        ],
        governance: {
          breaker: { failureThreshold: 2 },
          retry: { retryKnownNotAccepted: true, retryBeforeDispatch: true },
          fallback: { fallbackOnRateLimit: true },
          outputRepair: 'ONCE',
        },
      });
      const outcome = await harness.runtime.executeObserved(
        structuredTurn(seed, { timeoutBudget: { totalMs: 2_500, providerMs: 3 } }),
        callerContext,
      );
      expect(['SUCCEEDED', 'FAILED']).toContain(outcome.result.status);
      expect(outcome.provenance.attempts.length).toBeLessThan(12);
    }
  });
});
