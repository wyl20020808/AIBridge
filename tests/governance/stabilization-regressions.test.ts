/**
 * V1 stabilization audit regressions — governance defects (Batch B).
 *
 * Each test pins a real defect: mixed-currency cost totals, zero-token usage reports,
 * dead budget-currency checks, partial rate-limit consumption, inert idempotency tuning,
 * stale in-flight takeover, and dead breaker retuning.
 */
import { makeAiError, type AiErrorReason, type AiResult } from '@aibridge/contracts';
import { TestClock } from '@aibridge/host-sdk';
import {
  BudgetTracker,
  CircuitBreakerRegistry,
  IdempotencyRegistry,
  InMemoryIdempotencyStore,
  InMemoryQuotaStore,
  InMemoryRateLimitStore,
  InMemoryUsageLedger,
  QuotaManager,
  RateLimiter,
  checkRequestBudget,
  mergeCosts,
  rateBucketKey,
  summarize,
  type ProviderAttemptProvenance,
  type ReliabilityProvenance,
} from '@aibridge/governance';
import { describe, expect, it } from 'vitest';

function errorWith(reason: AiErrorReason) {
  return makeAiError({ reason, message: `synthetic ${reason}` });
}

const minimalProvenance = {
  logicalRequestId: 'lreq-1',
  requestId: 'req-1',
  callerPluginId: 'test.caller',
  capability: 'ai.text.generate',
  capabilityVersion: '1.0',
  profile: 'balanced',
  configVersion: 'cfg-1',
  configDigest: 'digest-1',
  startedAtMs: 0,
  finishedAtMs: 1,
  status: 'SUCCEEDED',
  fallbackCount: 0,
  retryCount: 0,
  repairCount: 0,
  skippedCount: 0,
  idempotencyOutcome: 'EXECUTED',
} as const;

function attempt(overrides: Partial<ProviderAttemptProvenance>): ProviderAttemptProvenance {
  return {
    attemptId: 'att-1',
    logicalRequestId: 'lreq-1',
    sequence: 1,
    attemptKind: 'PRIMARY',
    providerId: 'relay',
    modelAlias: 'relay.text.primary',
    providerModelId: 'relay-model',
    modelClass: 'FAST',
    routeDepth: 0,
    routeConfigVersion: 'cfg-1',
    startedAtMs: 0,
    finishedAtMs: 1,
    status: 'SUCCEEDED',
    usage: {},
    usageKnown: true,
    ...overrides,
  };
}

function provenanceWith(attempts: readonly ProviderAttemptProvenance[]): ReliabilityProvenance {
  return { ...minimalProvenance, attempts } as ReliabilityProvenance;
}

describe('cost — cross-currency totals are unknown, never a summed fiction', () => {
  it('returns UNKNOWN with no amount when currencies disagree', () => {
    const total = mergeCosts([
      { amount: 1, currency: 'USD', basis: 'PROVIDER_REPORTED' },
      { amount: 100, currency: 'EUR', basis: 'PROVIDER_REPORTED' },
    ]);
    expect(total.basis).toBe('UNKNOWN');
    expect(total.partial).toBe(true);
    expect(total.amount).toBeUndefined();
  });

  it('still sums honest same-currency attempts', () => {
    const total = mergeCosts([
      { amount: 1, currency: 'USD', basis: 'PROVIDER_REPORTED' },
      { amount: 2, currency: 'USD', basis: 'PROVIDER_REPORTED' },
    ]);
    expect(total).toMatchObject({ amount: 3, currency: 'USD', basis: 'PROVIDER_REPORTED' });
  });
});

describe('usage — a real zero-token report is a fact, not an absence', () => {
  it('keeps a reported zero total in the governance summary', () => {
    const summary = summarize(
      provenanceWith([attempt({ usage: { totalTokens: 0 }, usageKnown: true })]),
    );
    expect(summary.totalUsageComplete).toBe(true);
    expect(summary.totalUsage.totalTokens).toBe(0);
  });

  it('marks genuinely unknown usage incomplete', () => {
    const summary = summarize(provenanceWith([attempt({ usage: {}, usageKnown: false })]));
    expect(summary.totalUsageComplete).toBe(false);
    expect(summary.totalUsage.totalTokens).toBeUndefined();
  });
});

describe('budget — a currency mismatch is an unknown budget', () => {
  const request = { callerPluginId: 'test.caller', capability: 'ai.text.generate' };

  function trackerWith(currency: string): BudgetTracker {
    const clock = new TestClock(0);
    return new BudgetTracker({
      policy: { currency, maxEstimatedCostPerRequest: 10 },
      quotas: new QuotaManager({ store: new InMemoryQuotaStore(), clock }),
      clock,
    });
  }

  it('drops a mismatched-currency estimate instead of comparing numerically', async () => {
    const tracker = trackerWith('USD');
    const decision = await tracker.check(request, { amount: 1_000_000, currency: 'EUR', basis: 'ESTIMATED_FROM_PRICING' });
    expect(decision.ok).toBe(true);
  });

  it('still refuses an over-budget estimate in the policy currency', async () => {
    const tracker = trackerWith('USD');
    const decision = await tracker.check(request, { amount: 1_000_000, currency: 'USD', basis: 'ESTIMATED_FROM_PRICING' });
    expect(decision.ok).toBe(false);
  });

  it('treats an explicit mismatch as unknown in the pure check', () => {
    const decision = checkRequestBudget({
      policy: { currency: 'USD', maxEstimatedCostPerDay: 1 },
      estimatedRequestCost: 1_000_000,
      spentToday: 0,
      spentThisMonth: 0,
      currencyMatches: false,
    });
    expect(decision.ok).toBe(true);
  });
});

describe('rate limit — a refused call consumes nothing anywhere', () => {
  const request = { callerPluginId: 'test.caller', capability: 'ai.text.generate' };
  const exhausted = { dimension: 'callerPlugin', limit: 1, windowMs: 60_000 } as const;
  const fresh = { dimension: 'global', limit: 100, windowMs: 60_000 } as const;

  it('leaves later policies untouched when an earlier policy refuses', async () => {
    const clock = new TestClock(0);
    const store = new InMemoryRateLimitStore();
    const limiter = new RateLimiter({ store, clock });
    // Exhaust the caller window first.
    expect((await limiter.consume(request, [exhausted])).allowed).toBe(true);
    const refused = await limiter.consume(request, [exhausted, fresh]);
    expect(refused.allowed).toBe(false);
    expect(store.hits(rateBucketKey(fresh, request))).toHaveLength(0);
  });
});

describe('idempotency — configured claim windows actually apply', () => {
  const identity = {
    callerPluginId: 'test.caller',
    capability: 'ai.text.generate',
    capabilityVersion: '1.0',
    idempotencyKey: 'turn-1',
  };

  function settledResult(): AiResult<unknown> {
    return {
      contractVersion: '1.1',
      requestId: 'req-1',
      capability: 'ai.text.generate',
      capabilityVersion: '1.0',
      status: 'SUCCEEDED' as const,
      output: { text: 'ok', finishReason: 'STOP' as const },
      usage: {},
      providerMetadata: { providerId: 'relay', providerFamily: 'mock', modelClass: 'FAST', routeDepth: 0, attemptCount: 1, repaired: false },
      latencyMs: 1,
      finishReason: 'UNKNOWN' as const,
      warnings: [],
    };
  }

  it('honours a short retentionMs: an expired claim executes again', async () => {
    const clock = new TestClock(0);
    const store = new InMemoryIdempotencyStore({ clock });
    const registry = new IdempotencyRegistry({ store, clock, retentionMs: 50 });
    const first = await registry.gate(identity, 'fp-1', 'lreq-1');
    expect(first.kind).toBe('PROCEED');
    if (first.kind === 'PROCEED') {
      await first.settle(settledResult());
    }
    clock.advance(60);
    expect((await registry.gate(identity, 'fp-1', 'lreq-2')).kind).toBe('PROCEED');
  });

  it('keeps the settled replay inside the default window', async () => {
    const clock = new TestClock(0);
    const store = new InMemoryIdempotencyStore({ clock });
    const registry = new IdempotencyRegistry({ store, clock });
    const first = await registry.gate(identity, 'fp-1', 'lreq-1');
    if (first.kind === 'PROCEED') {
      await first.settle(settledResult());
    }
    clock.advance(60);
    expect((await registry.gate(identity, 'fp-1', 'lreq-2')).kind).toBe('REPLAY');
  });

  it('reconfigure retunes the window for future turns', async () => {
    const clock = new TestClock(0);
    const store = new InMemoryIdempotencyStore({ clock });
    const registry = new IdempotencyRegistry({ store, clock });
    registry.reconfigure(50);
    const first = await registry.gate(identity, 'fp-1', 'lreq-1');
    if (first.kind === 'PROCEED') {
      await first.settle(settledResult());
    }
    clock.advance(60);
    expect((await registry.gate(identity, 'fp-1', 'lreq-2')).kind).toBe('PROCEED');
  });

  it('takes over a stale store IN_FLIGHT record instead of reporting CONFLICT', async () => {
    const clock = new TestClock(0);
    const store = new InMemoryIdempotencyStore({ clock });
    // A previous process claimed the turn and died holding it: the durable store still
    // says IN_FLIGHT, but this process has no live leader promise.
    const first = new IdempotencyRegistry({ store, clock });
    expect((await first.gate(identity, 'fp-1', 'lreq-1')).kind).toBe('PROCEED');
    const restarted = new IdempotencyRegistry({ store, clock });
    const takeover = await restarted.gate(identity, 'fp-1', 'lreq-2');
    expect(takeover.kind).toBe('PROCEED');
  });
});

describe('breaker — reload retuning reaches live breakers', () => {
  it('opens an existing breaker at the retuned threshold without resetting state', () => {
    const clock = new TestClock(0);
    const registry = new CircuitBreakerRegistry({ clock, config: { failureThreshold: 5, windowMs: 10_000 } });
    const breaker = registry.for('relay', 'relay.text.primary');
    breaker.recordFailure(errorWith('PROVIDER_UNAVAILABLE'));
    expect(breaker.state).toBe('CLOSED');
    registry.reconfigure({ failureThreshold: 2, windowMs: 10_000 });
    breaker.recordFailure(errorWith('PROVIDER_UNAVAILABLE'));
    expect(breaker.state).toBe('OPEN');
  });

  it('applies retuned thresholds to breakers created after the reload', () => {
    const clock = new TestClock(0);
    const registry = new CircuitBreakerRegistry({ clock, config: { failureThreshold: 5, windowMs: 10_000 } });
    registry.reconfigure({ failureThreshold: 1, windowMs: 10_000 });
    const breaker = registry.for('relay', 'relay.text.primary');
    breaker.recordFailure(errorWith('PROVIDER_UNAVAILABLE'));
    expect(breaker.state).toBe('OPEN');
  });
});

describe('usage ledger — bounded by design', () => {
  it('evicts oldest-first past capacity instead of growing forever', async () => {
    const ledger = new InMemoryUsageLedger({ capacity: 4 });
    for (let index = 0; index < 10; index += 1) {
      await ledger.appendRequest({
        usageRecordId: `urec-${index}`,
        logicalRequestId: `lreq-${index}`,
        requestId: `req-${index}`,
        callerPluginId: 'test.caller',
        capability: 'ai.text.generate',
        capabilityVersion: '1.0',
        profile: 'balanced',
        configVersion: 'cfg-1',
        configDigest: 'digest-1',
        startedAtMs: 0,
        finishedAtMs: 1,
        latencyMs: 1,
        status: 'SUCCEEDED',
        attemptCount: 1,
        fallbackCount: 0,
        retryCount: 0,
        repairCount: 0,
        finalUsage: {},
        totalUsage: {},
        totalUsageComplete: true,
        totalCost: { basis: 'UNKNOWN' },
        idempotencyOutcome: 'EXECUTED',
      });
    }
    const kept = await ledger.requests();
    expect(kept).toHaveLength(4);
    expect(kept[0]?.logicalRequestId).toBe('lreq-6');
  });
});
