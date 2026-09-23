/**
 * Cost estimation and the usage ledger (ROADMAP Stage 5 Phase 27–33, 58–59, 66).
 *
 * The rules under test are the uncomfortable ones: **unknown cost is never zero**, a price is
 * pinned so history cannot move, a reasoning token count is a count and never reasoning content,
 * and a fallback chain's total counts every provider that was paid.
 */
import {
  InMemoryUsageLedger,
  PricingTable,
  aggregateUsage,
  estimateCost,
  mergeCosts,
  projectCostToUsage,
  summarize,
  usageIsUnknown,
  type PricingRecord,
  type ReliabilityProvenance,
} from '@aibridge/governance';
import { describe, expect, it } from 'vitest';

const PRICING: PricingRecord = {
  pricingId: 'price-relay-1',
  version: '1',
  providerId: 'relay',
  modelAlias: 'relay.text.primary',
  currency: 'USD',
  inputTokenPrice: 1,
  outputTokenPrice: 2,
  cachedInputPrice: 0.5,
  reasoningTokenPrice: 4,
  unit: 'PER_1K_TOKENS',
  validFromMs: 0,
  source: 'operator rate card',
};

describe('pricing table — validation and pinning (Phase 30–32)', () => {
  it('rejects ambiguous pricing and pins the most specific record', () => {
    const table = new PricingTable([
      PRICING,
      { ...PRICING, pricingId: 'price-relay-2', version: '2', validFromMs: 100_000 },
    ]);
    expect(table.validate()).toEqual([]);

    const overlapping = new PricingTable([PRICING, { ...PRICING, version: '1', validFromMs: 50 }]);
    expect(overlapping.validate().some((issue) => issue.code === 'DUPLICATE_FIELD')).toBe(true);

    const broken = new PricingTable([
      { ...PRICING, currency: 'usd' },
      { pricingId: 'p2', version: '1', providerId: 'relay', currency: 'USD', inputTokenPrice: 1, unit: 'PER_1K_TOKENS', validFromMs: 0, source: 'rate card' },
    ]);
    expect(broken.validate().length).toBeGreaterThan(0);
  });

  it('keeps history stable: a price change never rewrites an old estimate (Phase 32)', () => {
    const table = new PricingTable([
      PRICING,
      { ...PRICING, pricingId: 'price-relay-2', version: '2', validFromMs: 100_000, inputTokenPrice: 10, outputTokenPrice: 20 },
    ]);
    const early = table.snapshotFor('relay', { modelAlias: 'relay.text.primary' }, 1_000);
    const late = table.snapshotFor('relay', { modelAlias: 'relay.text.primary' }, 200_000);
    expect(early?.pricingId).toBe('price-relay-1');
    expect(late?.pricingId).toBe('price-relay-2');
  });

  it('returns null for an unpriced model — the caller must say "unknown", not "zero"', () => {
    const table = new PricingTable([PRICING]);
    expect(table.snapshotFor('other', { modelAlias: 'other.text.primary' }, 0)).toBeNull();
  });
});

describe('cost estimation (Phase 31–33, 66)', () => {
  const table = new PricingTable([PRICING]);
  const snapshot = table.snapshotFor('relay', { modelAlias: 'relay.text.primary' }, 0);

  it('computes from known usage and known pricing', () => {
    const cost = estimateCost({ inputTokens: 1_000, outputTokens: 500, totalTokens: 1_500 }, snapshot);
    expect(cost).toMatchObject({ basis: 'ESTIMATED_FROM_PRICING', currency: 'USD', pricingId: 'price-relay-1', pricingVersion: '1' });
    // 1000 input @1/1k + 500 output @2/1k = 1 + 1
    expect(cost.amount).toBeCloseTo(2);
    expect(cost.partial).toBeUndefined();
  });

  it('prices cached and reasoning tokens separately when the rate card says so', () => {
    const cost = estimateCost({ inputTokens: 1_000, cachedTokens: 400, outputTokens: 100, reasoningTokens: 60 }, snapshot);
    // 600 uncached @1 + 400 cached @0.5 + 40 plain output @2 + 60 reasoning @4, per 1k
    expect(cost.amount).toBeCloseTo((600 * 1 + 400 * 0.5 + 40 * 2 + 60 * 4) / 1_000);
  });

  it('treats unknown usage as unknown cost — never a zero (Phase 31)', () => {
    const cost = estimateCost({}, snapshot);
    expect(cost.amount).toBeUndefined();
    expect(cost.basis).toBe('UNKNOWN');
    expect(usageIsUnknown({})).toBe(true);
    // And it projects to an absent `estimatedCost`, which the frozen contract reads as *unknown*.
    expect(projectCostToUsage(cost)).toBeUndefined();
  });

  it('treats unknown pricing as unknown cost — no invented precision', () => {
    const cost = estimateCost({ inputTokens: 10 }, null);
    expect(cost.amount).toBeUndefined();
    expect(cost.basis).toBe('UNKNOWN');
    expect(projectCostToUsage(cost)).toBeUndefined();
  });

  it('marks a partial estimate and projects it as ESTIMATED', () => {
    const cost = estimateCost({ inputTokens: 1_000 }, snapshot);
    expect(cost.partial).toBe(true);
    const projected = projectCostToUsage(cost);
    expect(projected?.basis).toBe('ESTIMATED');
    expect(projected?.value).toBeGreaterThan(0);
  });

  it('prefers a provider-reported cost and projects it faithfully', () => {
    const cost = estimateCost({}, snapshot, { value: 0.42, currency: 'USD', basis: 'PROVIDER_REPORTED' });
    expect(cost).toMatchObject({ basis: 'PROVIDER_REPORTED', amount: 0.42 });
    expect(projectCostToUsage(cost)?.basis).toBe('PROVIDER_REPORTED');
  });
});

describe('usage aggregation across attempts (Phase 26/58)', () => {
  it('totals every attempt and stays honest about gaps', () => {
    const total = aggregateUsage([
      { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, known: true },
      { usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 }, known: true },
    ]);
    expect(total.usage).toEqual({ inputTokens: 30, outputTokens: 10, totalTokens: 40 });
    expect(total.complete).toBe(true);

    const withGap = aggregateUsage([
      { usage: { inputTokens: 10 }, known: true },
      { usage: {}, known: false },
    ]);
    expect(withGap.complete).toBe(false);
  });

  it('sums costs across attempts and flags the total partial when one is unknown', () => {
    const known = { amount: 1, currency: 'USD', basis: 'ESTIMATED_FROM_PRICING' as const };
    const unknown = { basis: 'UNKNOWN' as const };
    const merged = mergeCosts([known, known]);
    expect(merged.amount).toBe(2);
    const withUnknown = mergeCosts([known, unknown]);
    // The known part is summed; the unknown part is flagged, never silently zeroed into "2 of 2".
    expect(withUnknown.amount).toBe(1);
    expect(withUnknown.partial).toBe(true);
    expect(mergeCosts([unknown]).amount).toBeUndefined();
  });
});

describe('usage ledger (Phase 27–29)', () => {
  it('is append-only and separates logical request records from attempt records', async () => {
    const ledger = new InMemoryUsageLedger();
    const provenance: ReliabilityProvenance = {
      logicalRequestId: 'lreq-1',
      requestId: 'req-1',
      callerPluginId: 'test.caller',
      capability: 'ai.text.generate',
      capabilityVersion: '1.0',
      profile: 'balanced',
      configVersion: 'cfg-1',
      configDigest: 'dgst-0',
      startedAtMs: 0,
      finishedAtMs: 10,
      status: 'SUCCEEDED',
      attempts: [
        {
          attemptId: 'att-1',
          logicalRequestId: 'lreq-1',
          sequence: 1,
          attemptKind: 'FALLBACK',
          providerId: 'deepseek',
          modelAlias: 'deepseek.text.primary',
          providerModelId: 'ds-model',
          modelClass: 'FAST',
          routeDepth: 0,
          routeConfigVersion: 'cfg-1',
          startedAtMs: 0,
          finishedAtMs: 4,
          status: 'FAILED',
          errorCode: 'PROVIDER_ERROR',
          errorReason: 'PROVIDER_UNAVAILABLE',
          usage: { inputTokens: 7 },
          usageKnown: true,
        },
        {
          attemptId: 'att-2',
          logicalRequestId: 'lreq-1',
          sequence: 2,
          attemptKind: 'FALLBACK',
          providerId: 'openai',
          modelAlias: 'openai.text.primary',
          providerModelId: 'oa-model',
          modelClass: 'FAST',
          routeDepth: 1,
          routeConfigVersion: 'cfg-1',
          startedAtMs: 5,
          finishedAtMs: 9,
          status: 'SUCCEEDED',
          usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
          usageKnown: true,
        },
      ],
      fallbackCount: 1,
      retryCount: 0,
      repairCount: 0,
      skippedCount: 0,
      idempotencyOutcome: 'EXECUTED',
    };
    const summary = summarize(provenance);
    // Both providers are paid for; the total is the sum, the final result's usage is the last one.
    expect(summary.attemptCount).toBe(2);
    expect(summary.totalUsage.totalTokens).toBe(5);
    expect(summary.totalUsage.inputTokens).toBe(10);
    expect(summary.finalUsage.totalTokens).toBe(5);
    expect(summary.fallbackCount).toBe(1);

    await ledger.appendAttempt({
      usageRecordId: 'use-1',
      logicalRequestId: 'lreq-1',
      attemptId: 'att-1',
      sequence: 1,
      attemptKind: 'FALLBACK',
      callerPluginId: 'test.caller',
      capability: 'ai.text.generate',
      capabilityVersion: '1.0',
      profile: 'balanced',
      providerId: 'deepseek',
      modelAlias: 'deepseek.text.primary',
      providerModelId: 'ds-model',
      routeConfigVersion: 'cfg-1',
      startedAtMs: 0,
      finishedAtMs: 4,
      latencyMs: 4,
      status: 'FAILED',
      usage: { inputTokens: 7 },
      usageKnown: true,
    });
    expect(await ledger.attempts('lreq-1')).toHaveLength(1);
    expect(await ledger.attempts('lreq-2')).toHaveLength(0);
    expect(ledger.size).toBe(1);
  });

  it('keeps reasoning tokens as a count and nothing else (Phase 59)', () => {
    const table = new PricingTable([PRICING]);
    const cost = estimateCost({ reasoningTokens: 42 }, table.snapshotFor('relay', { modelAlias: 'relay.text.primary' }, 0));
    // No input/output facts: an unknown cost even though a reasoning count is present.
    expect(cost.amount).toBeUndefined();
  });
});
