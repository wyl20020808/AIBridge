/**
 * Governance ordering in execution (ROADMAP Stage 5 Phase 51–54, 17–26).
 *
 * The order itself is the contract: identity and fingerprint **before** governance, governance
 * **before** dispatch. A replayed turn consumes no quota and no rate budget; a caller's own limit is
 * never silently routed around; a provider-scoped quota may move the call when the route says so.
 */
import { describe, expect, it } from 'vitest';

import {
  callerContext,
  codeDebugCallerContext,
  codeDebugTurn,
  makeHarness,
  script,
  subjectContext,
  textTurn,
  type FakeStep,
} from '../helpers/reliability.js';

const served: FakeStep = { kind: 'text', text: 'served', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
const unavailable: FakeStep = {
  kind: 'rawError',
  rawError: { category: 'UPSTREAM', reason: 'PROVIDER_UNAVAILABLE', dispatched: true },
};

describe('idempotency in execution (Phase 17–20, 51)', () => {
  it('replays a stored result with IDEMPOTENT_REPLAY and dispatches nothing', async () => {
    const harness = makeHarness({ providers: [{ id: 'relay', behavior: script(served) }] });
    const first = await harness.runtime.executeObserved(textTurn(1), callerContext);
    expect(first.result.status).toBe('SUCCEEDED');

    const replay = await harness.runtime.executeObserved(textTurn(1), callerContext);
    expect(replay.result.status).toBe('SUCCEEDED');
    expect(replay.result.warnings.map((warning) => warning.code)).toContain('IDEMPOTENT_REPLAY');
    expect(harness.providers['relay']?.callCount).toBe(1);
    expect(replay.provenance.idempotencyOutcome).toBe('REPLAYED');
  });

  it('replays the original prompt provenance when an equal request carries a different label', async () => {
    const harness = makeHarness({ providers: [{ id: 'relay', behavior: script(served) }] });
    await harness.runtime.executeObserved(
      textTurn(31, { promptApplied: true, promptVersion: 'consumer.prompt.v1' }),
      callerContext,
    );

    const replay = await harness.runtime.executeObserved(
      textTurn(31, { requestId: 'req-32', promptApplied: true, promptVersion: 'consumer.prompt.v2' }),
      callerContext,
    );

    expect(replay.provenance).toMatchObject({ promptApplied: true, promptVersion: 'consumer.prompt.v1' });
    const usage = await harness.ledger.requests(replay.provenance.logicalRequestId);
    expect(usage[0]).toMatchObject({ promptApplied: true, promptVersion: 'consumer.prompt.v1', idempotencyOutcome: 'REPLAYED' });
    expect(harness.providers['relay']?.callCount).toBe(1);
  });

  it('replays debug provenance under logical identity while dispatching the structured primitive once', async () => {
    const output = {
      issueCategories: ['SYNTAX'],
      diagnosticContextRefs: ['sourceCode:1'],
      limitations: [],
    };
    const harness = makeHarness({
      providers: [{ id: 'relay', behavior: script({ kind: 'structured', text: JSON.stringify(output) }) }],
    });

    const first = await harness.runtime.executeObserved(
      codeDebugTurn(32, { promptVersion: 'consumer.debug.v1' }),
      codeDebugCallerContext,
    );
    const replay = await harness.runtime.executeObserved(
      codeDebugTurn(32, { requestId: 'req-33', promptVersion: 'consumer.debug.v2' }),
      codeDebugCallerContext,
    );

    expect(first.result.status).toBe('SUCCEEDED');
    expect(first.result.capability).toBe('code.debug.analyze');
    expect(replay.result.capability).toBe('code.debug.analyze');
    expect(replay.result.warnings.map((warning) => warning.code)).toContain('IDEMPOTENT_REPLAY');
    expect(replay.provenance).toMatchObject({ promptApplied: true, promptVersion: 'consumer.debug.v1' });
    const usage = await harness.ledger.requests(replay.provenance.logicalRequestId);
    expect(usage[0]).toMatchObject({
      capability: 'code.debug.analyze',
      promptApplied: true,
      promptVersion: 'consumer.debug.v1',
      idempotencyOutcome: 'REPLAYED',
    });
    expect(harness.providers['relay']?.requests[0]?.capability).toBe('ai.structured.generate');
    expect(harness.providers['relay']?.callCount).toBe(1);
  });

  it('suppresses a concurrent duplicate — one execution chain serves both callers', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const harness = makeHarness({
      providers: [
        {
          id: 'relay',
          behavior: async () => {
            await gate;
            return served;
          },
        },
      ],
    });
    const first = harness.runtime.executeObserved(
      textTurn(1, { promptApplied: true, promptVersion: 'winner.prompt.v1' }),
      callerContext,
    );
    const second = harness.runtime.executeObserved(
      textTurn(1, { promptApplied: true, promptVersion: 'joiner.prompt.v2' }),
      callerContext,
    );
    release?.();
    const [firstOutcome, secondOutcome] = await Promise.all([first, second]);

    expect(firstOutcome.result.status).toBe('SUCCEEDED');
    expect(secondOutcome.result.status).toBe('SUCCEEDED');
    expect(harness.providers['relay']?.callCount).toBe(1);
    expect([firstOutcome.provenance.idempotencyOutcome, secondOutcome.provenance.idempotencyOutcome].sort()).toEqual(['EXECUTED', 'JOINED']);
    const executed = [firstOutcome, secondOutcome].find((outcome) => outcome.provenance.idempotencyOutcome === 'EXECUTED');
    const joined = [firstOutcome, secondOutcome].find((outcome) => outcome.provenance.idempotencyOutcome === 'JOINED');
    expect(joined?.provenance).toMatchObject({ promptApplied: true, promptVersion: executed?.provenance.promptVersion });
    const usage = await harness.ledger.requests(joined?.provenance.logicalRequestId);
    expect(usage[0]).toMatchObject({ promptApplied: true, promptVersion: executed?.provenance.promptVersion, idempotencyOutcome: 'JOINED' });
  });

  it('is IDEMPOTENCY_CONFLICT for one key with a different body — never a stale answer (Phase 20)', async () => {
    const harness = makeHarness({ providers: [{ id: 'relay', behavior: script(served) }] });
    await harness.runtime.executeObserved(textTurn(1), callerContext);
    const conflicting = await harness.runtime.executeObserved(
      textTurn(1, { input: { instructions: 'Different instructions entirely.', context: [] } }),
      callerContext,
    );
    expect(conflicting.result.status).toBe('FAILED');
    expect(conflicting.result.error?.reason).toBe('IDEMPOTENCY_CONFLICT');
    expect(JSON.stringify(conflicting.result)).not.toContain('turn-1');
    expect(harness.providers['relay']?.callCount).toBe(1);
  });

  it('a replay consumes no quota and no rate budget (Phase 51)', async () => {
    const harness = makeHarness({
      providers: [{ id: 'relay', behavior: script(served) }],
      governance: {
        quotas: [{ scope: 'subject', meter: 'REQUESTS', period: 'DAY', limit: 1 }],
        rateLimits: [{ dimension: 'subject', limit: 1, windowMs: 60_000 }],
      },
    });
    const context = subjectContext('subtok-beta');
    const first = await harness.runtime.executeObserved(textTurn(1), context);
    expect(first.result.status).toBe('SUCCEEDED');

    // The quota and the rate window are both exhausted — yet the replay still answers…
    const replay = await harness.runtime.executeObserved(textTurn(1), context);
    expect(replay.result.status).toBe('SUCCEEDED');
    expect(replay.result.warnings.map((warning) => warning.code)).toContain('IDEMPOTENT_REPLAY');

    // …while a fresh turn is correctly refused with zero dispatch.
    const refused = await harness.runtime.executeObserved(textTurn(2), context);
    expect(refused.result.error?.reason).toBe('QUOTA_SUBJECT');
    expect(harness.providers['relay']?.callCount).toBe(1);
  });
});

describe('rate limit and quota ordering (Phase 22, 51–54)', () => {
  it('a rate refusal happens before dispatch: provider call count stays zero', async () => {
    const harness = makeHarness({
      providers: [{ id: 'relay', behavior: script(served) }],
      governance: { rateLimits: [{ dimension: 'callerPlugin', limit: 1, windowMs: 60_000 }] },
    });
    expect((await harness.runtime.executeObserved(textTurn(1), callerContext)).result.status).toBe('SUCCEEDED');
    const refused = await harness.runtime.executeObserved(textTurn(2), callerContext);
    expect(refused.result.status).toBe('FAILED');
    expect(refused.result.error?.reason).toBe('RATE_LIMIT_CALLER');
    expect(refused.result.error?.retryAfterMs).toBeGreaterThan(0);
    expect(harness.providers['relay']?.callCount).toBe(1);
  });

  it('the caller\'s own rate limit never silently falls back to a richer provider (Phase 53)', async () => {
    const harness = makeHarness({
      providers: [
        { id: 'relay', behavior: script(served) },
        { id: 'openai', behavior: script(served) },
      ],
      governance: {
        rateLimits: [{ dimension: 'callerPlugin', limit: 1, windowMs: 60_000 }],
        fallback: { fallbackOnRateLimit: true },
      },
    });
    await harness.runtime.executeObserved(textTurn(1), callerContext);
    const refused = await harness.runtime.executeObserved(textTurn(2), callerContext);
    expect(refused.result.error?.reason).toBe('RATE_LIMIT_CALLER');
    expect(harness.providers['openai']?.callCount).toBe(0);
    expect(refused.provenance.fallbackCount).toBe(0);
  });

  it('a provider-scoped quota may move the call when the route opts in (Phase 54)', async () => {
    const harness = makeHarness({
      providers: [
        { id: 'deepseek', behavior: script({ kind: 'text', text: 'primary' }) },
        { id: 'openai', behavior: script({ kind: 'text', text: 'moved' }) },
      ],
      governance: {
        quotas: [{ scope: 'provider', meter: 'REQUESTS', period: 'DAY', limit: 1, scopeKey: 'deepseek' }],
        fallback: { fallbackOnQuotaExceeded: true },
      },
    });
    const first = await harness.runtime.executeObserved(textTurn(1), callerContext);
    expect(first.result.output).toEqual({ text: 'primary', finishReason: 'STOP' });

    const moved = await harness.runtime.executeObserved(textTurn(2), callerContext);
    expect(moved.result.output).toEqual({ text: 'moved', finishReason: 'STOP' });
    expect(moved.result.providerMetadata.providerId).toBe('openai');
  });

  it('a cost budget refuses before dispatch with COST_BUDGET_EXHAUSTED (Phase 34)', async () => {
    const harness = makeHarness({
      providers: [{ id: 'relay', behavior: script(served) }],
      governance: {
        budget: { maxEstimatedCostPerRequest: 0.000001, currency: 'USD' },
        pricing: [
          {
            pricingId: 'price-relay-1',
            version: '1',
            providerId: 'relay',
            modelAlias: 'relay.text.primary',
            currency: 'USD',
            inputTokenPrice: 100,
            outputTokenPrice: 100,
            unit: 'PER_1K_TOKENS',
            validFromMs: 0,
            source: 'operator rate card',
          },
        ],
      },
    });
    const refused = await harness.runtime.executeObserved(textTurn(1), callerContext);
    expect(refused.result.status).toBe('FAILED');
    expect(refused.result.error?.reason).toBe('COST_BUDGET_EXHAUSTED');
    expect(harness.providers['relay']?.callCount).toBe(0);
  });

  it('the shared request budget stops a chain before it can run away (Phase 34)', async () => {
    const harness = makeHarness({
      providers: [
        { id: 'deepseek', behavior: script(unavailable) },
        { id: 'openai', behavior: script(served) },
      ],
      governance: {
        budget: { maxEstimatedCostPerDay: 0.000001, currency: 'USD' },
        quotas: [],
        pricing: [
          {
            pricingId: 'price-1',
            version: '1',
            providerId: 'deepseek',
            currency: 'USD',
            inputTokenPrice: 1,
            outputTokenPrice: 1,
            unit: 'PER_1K_TOKENS',
            validFromMs: 0,
            source: 'rate card',
          },
          {
            pricingId: 'price-2',
            version: '1',
            providerId: 'openai',
            currency: 'USD',
            inputTokenPrice: 100,
            outputTokenPrice: 100,
            unit: 'PER_1K_TOKENS',
            validFromMs: 0,
            source: 'rate card',
          },
        ],
      },
    });
    const refused = await harness.runtime.executeObserved(textTurn(1), callerContext);
    expect(refused.result.status).toBe('FAILED');
    expect(refused.result.error?.reason).toBe('COST_BUDGET_EXHAUSTED');
    expect(harness.providers['deepseek']?.callCount).toBe(0);
    expect(harness.providers['openai']?.callCount).toBe(0);
  });
});

describe('cancellation stops everything (Phase 50)', () => {
  it('a cancelled turn never retries, falls back or repairs', async () => {
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
    const cancel = (): void => {
      cancelled = true;
      for (const callback of [...callbacks]) {
        callback();
      }
    };

    const harness = makeHarness({
      providers: [
        {
          id: 'deepseek',
          behavior: async () => {
            cancel();
            return unavailable;
          },
        },
        { id: 'openai', behavior: script({ kind: 'text', text: 'must not serve' }) },
      ],
    });

    const outcome = await harness.runtime.executeObserved(textTurn(1), callerContext, { cancellation: token });
    // The token fired before the behaviour returned: cancellation is terminal and the fallback,
    // a retry or a repair can never start (Phase 50).
    expect(outcome.result.status).toBe('FAILED');
    expect(outcome.result.error?.reason).toBe('CANCELLED_BY_CALLER');
    expect(outcome.provenance.fallbackCount).toBe(0);
    expect(outcome.provenance.retryCount).toBe(0);
    expect(harness.providers['openai']?.callCount).toBe(0);
  });
});
