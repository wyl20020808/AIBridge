/**
 * Reliability policy units (ROADMAP Stage 5 Phase 4–10, 55–56): the failure classifier, the
 * fallback policy, the bounded retry policy with deterministic backoff, terminal error selection
 * and fallback-chain compilation.
 *
 * Every decision reads the closed code/reason/stage vocabulary — a test proves it by making the
 * same classification hold for two errors whose *messages* differ entirely.
 */
import {
  makeAiError,
  type AiError,
  type AiErrorReason,
} from '@aibridge/contracts';
import {
  backoffDelayMs,
  classifyFailure,
  classifyRetryPhase,
  decideFallback,
  decideRetry,
  resolveRetryPolicy,
  selectTerminalError,
  breakerImpact,
} from '@aibridge/governance';
import { nextFallback, validateFallbackChain } from '@aibridge/runtime';
import { describe, expect, it } from 'vitest';

function errorWith(reason: AiErrorReason, overrides: Partial<AiError> = {}): AiError {
  return { ...makeAiError({ reason, message: `synthetic ${reason}` }), ...overrides };
}

describe('failure classification — stable vocabulary only, never provider prose', () => {
  it('classifies the closed reasons into the ten failure classes', () => {
    expect(classifyFailure(errorWith('MALFORMED_ENVELOPE'))).toBe('REQUEST');
    expect(classifyFailure(errorWith('PROVIDER_CONTENT_FILTER'))).toBe('CONTENT');
    expect(classifyFailure(errorWith('SCHEMA_VALIDATION_FAILED'))).toBe('CONTENT');
    expect(classifyFailure(errorWith('CALLER_NOT_PERMITTED'))).toBe('PERMISSION');
    expect(classifyFailure(errorWith('RATE_LIMIT_SUBJECT'))).toBe('GOVERNANCE');
    expect(classifyFailure(errorWith('QUOTA_SUBJECT'))).toBe('GOVERNANCE');
    expect(classifyFailure(errorWith('COST_BUDGET_EXHAUSTED'))).toBe('GOVERNANCE');
    expect(classifyFailure(errorWith('MODEL_UNAVAILABLE'))).toBe('ROUTING');
    expect(classifyFailure(errorWith('PROVIDER_UNAVAILABLE'))).toBe('PROVIDER_TRANSIENT');
    expect(classifyFailure(errorWith('PROVIDER_AUTH_FAILED'))).toBe('PROVIDER_PERMANENT');
    expect(classifyFailure(errorWith('BUDGET_EXHAUSTED'))).toBe('DEADLINE');
    expect(classifyFailure(errorWith('CANCELLED_BY_CALLER'))).toBe('CANCELLED');
    expect(classifyFailure(errorWith('INTERNAL_ERROR'))).toBe('INTERNAL');
  });

  it('is immune to provider wording: same reason, totally different messages, one verdict', () => {
    const a = errorWith('PROVIDER_UNAVAILABLE', { message: 'upstream exploded in region eu-1' });
    const b = errorWith('PROVIDER_UNAVAILABLE', { message: 'the service is having a moment' });
    expect(classifyFailure(a)).toBe(classifyFailure(b));
    expect(decideFallback(a).eligible).toBe(decideFallback(b).eligible);
  });

  it('counts only provider transient failure against a breaker (Phase 12)', () => {
    expect(breakerImpact(errorWith('PROVIDER_UNAVAILABLE'))).toBe(true);
    expect(breakerImpact(errorWith('PROVIDER_OVERLOADED'))).toBe(true);
    expect(breakerImpact(errorWith('PROVIDER_TIMEOUT'))).toBe(true);
    expect(breakerImpact(errorWith('PROVIDER_REQUEST_REJECTED'))).toBe(false);
    expect(breakerImpact(errorWith('POLICY_VIOLATION'))).toBe(false);
    expect(breakerImpact(errorWith('CALLER_NOT_PERMITTED'))).toBe(false);
    expect(breakerImpact(errorWith('CANCELLED_BY_CALLER'))).toBe(false);
  });
});

describe('fallback policy — provider property vs request property', () => {
  it('allows chasing provider-shaped failures (Phase 4)', () => {
    expect(decideFallback(errorWith('PROVIDER_UNAVAILABLE')).eligible).toBe(true);
    expect(decideFallback(errorWith('PROVIDER_OVERLOADED')).eligible).toBe(true);
    expect(decideFallback(errorWith('MODEL_UNAVAILABLE')).eligible).toBe(true);
  });

  it('never chases request, content, permission, config or cancellation failures', () => {
    for (const reason of [
      'MALFORMED_ENVELOPE',
      'PROVIDER_REQUEST_REJECTED',
      'POLICY_VIOLATION',
      'PROVIDER_CONTENT_FILTER',
      'SCHEMA_VALIDATION_FAILED',
      'CALLER_NOT_PERMITTED',
      'PROVIDER_AUTH_FAILED',
      'INTERNAL_ERROR',
      'CANCELLED_BY_CALLER',
    ] as const) {
      const decision = decideFallback(errorWith(reason));
      expect(decision.eligible, reason).toBe(false);
    }
  });

  it('allows chasing a depleted provider balance but never a broken credential (Stage 6)', () => {
    // One wallet's emptiness is not the next provider's: the operator's fallback chain is their
    // statement of willingness, so balance exhaustion is chased like an overload.
    const balance = decideFallback(errorWith('PROVIDER_BALANCE_EXHAUSTED'));
    expect(balance.eligible).toBe(true);
    if (balance.eligible) {
      expect(balance.rule).toBe('PROVIDER_BALANCE');
    }
    // A broken credential is a deployment fault: never another provider's money.
    expect(decideFallback(errorWith('PROVIDER_AUTH_FAILED')).eligible).toBe(false);
  });

  it('rate limits and quotas fall back only when the route opts in — and never the caller\'s own', () => {
    // Provider-originated throttling: opt-in.
    const throttled = errorWith('PROVIDER_THROTTLED');
    expect(decideFallback(throttled).eligible).toBe(false);
    expect(decideFallback(throttled, { fallbackOnRateLimit: true }).eligible).toBe(true);

    // Our own limits are never dodged (Phase 53–54), whatever the policy says.
    for (const reason of ['RATE_LIMIT_SUBJECT', 'RATE_LIMIT_CALLER', 'RATE_LIMIT_CAPABILITY', 'RATE_LIMIT_PROVIDER'] as const) {
      expect(decideFallback(errorWith(reason), { fallbackOnRateLimit: true }).eligible, reason).toBe(false);
    }
    for (const reason of ['QUOTA_SUBJECT', 'QUOTA_CALLER', 'QUOTA_CAPABILITY', 'QUOTA_GLOBAL', 'COST_BUDGET_EXHAUSTED'] as const) {
      expect(decideFallback(errorWith(reason), { fallbackOnQuotaExceeded: true }).eligible, reason).toBe(false);
    }
    // A provider-scoped quota is a limit on one provider and may move — when configured.
    expect(decideFallback(errorWith('QUOTA_PROVIDER'), { fallbackOnQuotaExceeded: true }).eligible).toBe(true);
    expect(decideFallback(errorWith('QUOTA_PROVIDER')).eligible).toBe(false);
  });

  it('treats a timeout after dispatch as an unknown outcome governed by policy (Phase 4)', () => {
    const timeout = errorWith('PROVIDER_TIMEOUT');
    expect(decideFallback(timeout, {}, { unknownOutcome: true }).eligible).toBe(true);
    expect(decideFallback(timeout, { crossProviderFallbackOnUnknownOutcome: false }, { unknownOutcome: true }).eligible).toBe(false);
    expect(decideFallback(timeout, { crossProviderFallbackOnUnknownOutcome: false }, { unknownOutcome: false }).eligible).toBe(true);
  });
});

describe('bounded retry — three outcome phases, one retry maximum', () => {
  it('classifies the outcome phase from the adapter\'s dispatch marker', () => {
    const overloaded = errorWith('PROVIDER_OVERLOADED');
    expect(classifyRetryPhase(overloaded, false)).toBe('BEFORE_DISPATCH');
    expect(classifyRetryPhase(overloaded, true)).toBe('KNOWN_NOT_ACCEPTED');
    expect(classifyRetryPhase(overloaded, undefined)).toBe('UNKNOWN_OUTCOME_AFTER_DISPATCH');
    expect(classifyRetryPhase(errorWith('MALFORMED_ENVELOPE'), true)).toBeNull();
    expect(classifyRetryPhase(errorWith('MODEL_UNAVAILABLE'), true)).toBeNull();
  });

  it('repeats a provably pre-dispatch failure, and nothing else by default', () => {
    const overloaded = errorWith('PROVIDER_OVERLOADED');
    expect(decideRetry({ error: overloaded, dispatched: false, retriesUsed: 0 }).retry).toBe(true);
    expect(decideRetry({ error: overloaded, dispatched: true, retriesUsed: 0 }).retry).toBe(false);
    expect(decideRetry({ error: overloaded, dispatched: true, retriesUsed: 0, policy: { retryKnownNotAccepted: true } }).retry).toBe(true);
  });

  it('never repeats an unknown outcome without reliable idempotency (Phase 8)', () => {
    const timeout = errorWith('PROVIDER_TIMEOUT');
    expect(decideRetry({ error: timeout, retriesUsed: 0 }).retry).toBe(false);
    const withoutIdempotency = decideRetry({ error: timeout, retriesUsed: 0, policy: { retryUnknownOutcome: true } });
    expect(withoutIdempotency).toMatchObject({ retry: false, rule: 'UNKNOWN_OUTCOME_WITHOUT_RELIABLE_IDEMPOTENCY' });
    expect(decideRetry({ error: timeout, retriesUsed: 0, policy: { retryUnknownOutcome: true }, supportsReliableIdempotency: true }).retry).toBe(true);
  });

  it('caps same-provider retries at one — no exponential storm (Phase 9)', () => {
    expect(resolveRetryPolicy({ maxSameProviderRetries: 10 }).maxSameProviderRetries).toBe(1);
    const beforeDispatch = errorWith('PROVIDER_OVERLOADED');
    expect(decideRetry({ error: beforeDispatch, dispatched: false, retriesUsed: 1 }).retry).toBe(false);
    expect(decideRetry({ error: beforeDispatch, dispatched: false, retriesUsed: 1 })).toMatchObject({ rule: 'RETRY_LIMIT' });
  });

  it('never retries RATE_LIMITED in process — retryAfterMs is the honest answer', () => {
    const throttled = errorWith('PROVIDER_THROTTLED');
    expect(decideRetry({ error: throttled, dispatched: true, retriesUsed: 0, policy: { retryKnownNotAccepted: true } })).toMatchObject({
      retry: false,
      rule: 'RATE_LIMITED_NO_IN_PROCESS_RETRY',
    });
  });

  it('backs off deterministically, honouring a projected Retry-After (Phase 10)', () => {
    expect(backoffDelayMs(1)).toBe(250);
    expect(backoffDelayMs(2)).toBe(500);
    expect(backoffDelayMs(3)).toBe(1_000);
    expect(backoffDelayMs(8)).toBe(2_000);
    expect(backoffDelayMs(1, {}, 750)).toBe(750);
    // A hostile header is capped, not obeyed blindly.
    expect(backoffDelayMs(1, {}, 3_600_000)).toBe(8_000);
  });

  it('refuses a retry that cannot fit in the remaining overall budget (Phase 7)', () => {
    const overloaded = errorWith('PROVIDER_OVERLOADED');
    expect(decideRetry({ error: overloaded, dispatched: false, retriesUsed: 0, remainingMs: 100 })).toMatchObject({
      retry: false,
      rule: 'NO_TIME_LEFT',
    });
    expect(decideRetry({ error: overloaded, dispatched: false, retriesUsed: 0, remainingMs: 5_000 }).retry).toBe(true);
  });
});

describe('fallback chain — the Stage 4 contract, and chain compilation', () => {
  it('advances the chain and names the stop rule', () => {
    const unavailable = errorWith('PROVIDER_UNAVAILABLE');
    expect(nextFallback(['a'], unavailable)).toEqual({ kind: 'STOP', rule: 'CHAIN_EXHAUSTED' });
    expect(nextFallback(['a', 'b', 'c'], unavailable)).toEqual({ kind: 'FALLBACK', next: 'b', remaining: ['c'] });
    expect(nextFallback(['a', 'b'], errorWith('MALFORMED_ENVELOPE'))).toEqual({ kind: 'STOP', rule: 'NOT_ELIGIBLE' });
    // A configured quota chase passes the chain contract (frozen §7.2)…
    expect(nextFallback(['a', 'b'], errorWith('QUOTA_PROVIDER'), { fallbackOnQuotaExceeded: true }).kind).toBe('FALLBACK');
    // …and unconfigured it does not.
    expect(nextFallback(['a', 'b'], errorWith('QUOTA_PROVIDER')).kind).toBe('STOP');
  });

  it('rejects cycles, duplicate targets, impossible targets and unbounded chains (Phase 6)', () => {
    const key = (hop: string | null): string | null => hop;
    expect(validateFallbackChain(['a', 'b'], key)).toEqual([]);
    expect(validateFallbackChain(['a', 'a'], key).some((issue) => issue.code === 'DUPLICATE_FIELD')).toBe(true);
    expect(validateFallbackChain(['a', null], key).some((issue) => issue.code === 'UNKNOWN_FIELD')).toBe(true);
    expect(validateFallbackChain([], key).length).toBeGreaterThan(0);
    const long = Array.from({ length: 9 }, (_, index) => `hop-${index}`);
    expect(validateFallbackChain(long, key).some((issue) => issue.code === 'OUT_OF_RANGE')).toBe(true);
  });
});

describe('terminal error selection — one stable answer for the caller', () => {
  const cancelled = errorWith('CANCELLED_BY_CALLER');
  const request = errorWith('MALFORMED_ENVELOPE');
  const provider = errorWith('PROVIDER_UNAVAILABLE');
  const throttle = errorWith('PROVIDER_THROTTLED');
  const quota = errorWith('QUOTA_SUBJECT');

  it('prefers cancellation over everything', () => {
    const chosen = selectTerminalError({
      candidates: [
        { error: provider, sequence: 1 },
        { error: cancelled, sequence: 2 },
      ],
      fallbackError: provider,
    });
    expect(chosen.reason).toBe('CANCELLED_BY_CALLER');
  });

  it('reports the request/content root cause even when a later attempt failed differently', () => {
    const chosen = selectTerminalError({
      candidates: [
        { error: provider, sequence: 1 },
        { error: request, sequence: 2 },
      ],
      fallbackError: provider,
    });
    expect(chosen.reason).toBe('MALFORMED_ENVELOPE');
  });

  it('falls back to the freshest provider evidence and the most recent governance refusal', () => {
    const chosen = selectTerminalError({
      candidates: [
        { error: throttle, sequence: 1 },
        { error: provider, sequence: 2 },
      ],
      fallbackError: provider,
    });
    expect(chosen.reason).toBe('PROVIDER_UNAVAILABLE');

    // Our own limit outranks provider evidence — the caller can act on it…
    const governed = selectTerminalError({
      candidates: [
        { error: throttle, sequence: 1 },
        { error: quota, sequence: 2 },
      ],
      fallbackError: provider,
    });
    expect(governed.reason).toBe('QUOTA_SUBJECT');
    // …and among refusals the most recent one is the operative one.
    const latest = selectTerminalError({
      candidates: [
        { error: quota, sequence: 1 },
        { error: errorWith('QUOTA_CALLER'), sequence: 2 },
      ],
      fallbackError: provider,
    });
    expect(latest.reason).toBe('QUOTA_CALLER');
  });

  it('uses the supplied error when nothing was ever dispatched', () => {
    const fallbackError = makeAiError({ reason: 'ROUTE_EXHAUSTED', message: 'no route', details: { profile: 'balanced' } });
    expect(selectTerminalError({ candidates: [], fallbackError }).reason).toBe('ROUTE_EXHAUSTED');
  });
});
