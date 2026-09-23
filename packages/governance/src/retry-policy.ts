/**
 * The bounded retry policy (ROADMAP Stage 5 Phase 8–10, ARCHITECTURE.md §10.3).
 *
 * Retry is **same provider**. Fallback is **another provider**. They are different decisions and
 * this module owns only the first one.
 *
 * The load-bearing distinction is *what is known about the outcome*:
 *
 * | Phase | Example | Safe to repeat? |
 * | --- | --- | --- |
 * | `BEFORE_DISPATCH` | local connection setup failed; nothing left this process | **yes** |
 * | `KNOWN_NOT_ACCEPTED` | the provider answered, with a transient refusal | per policy |
 * | `UNKNOWN_OUTCOME_AFTER_DISPATCH` | sent, then timed out — it may already be billed | only with reliable idempotency |
 *
 * The default honours the frozen rule: **no same-provider automatic retry after an unknown
 * outcome**, unless `ProviderDescriptor.supportsReliableIdempotency` is true *and* the adapter
 * really implements it. V1 allows at most **one** same-provider retry — no 3/5/10 exponential
 * storms (Phase 9).
 */
import type { AiError } from '@aibridge/contracts';
import { classifyFailure } from './failure-class.js';

export const RETRY_PHASES = ['BEFORE_DISPATCH', 'KNOWN_NOT_ACCEPTED', 'UNKNOWN_OUTCOME_AFTER_DISPATCH'] as const;

export type RetryPhase = (typeof RETRY_PHASES)[number];

export const RETRY_STOP_RULES = [
  'NOT_RETRYABLE_FAILURE',
  'RATE_LIMITED_NO_IN_PROCESS_RETRY',
  'RETRY_LIMIT',
  'POLICY_DISABLED',
  'UNKNOWN_OUTCOME_WITHOUT_RELIABLE_IDEMPOTENCY',
  'NO_TIME_LEFT',
] as const;

export type RetryStopRule = (typeof RETRY_STOP_RULES)[number];

export type RetryPolicy = {
  /** V1 cap: **1**. A configuration above the cap is clamped, never obeyed blindly (Phase 9). */
  readonly maxSameProviderRetries?: number;
  /** Retry a provably pre-dispatch failure. Default **true** — nothing was spent. */
  readonly retryBeforeDispatch?: boolean;
  /**
   * Retry a transient failure the provider explicitly reported (outcome known). Default **false**:
   * a provider that answered "not accepted" is not re-asked automatically — the fallback chain is
   * the recovery path, and a route that wants a second chance opts in.
   */
  readonly retryKnownNotAccepted?: boolean;
  /**
   * Retry after an unknown outcome. Default **true**, but only effective when the provider
   * descriptor declares `supportsReliableIdempotency` — the double-billing guard.
   */
  readonly retryUnknownOutcome?: boolean;
  /** Deterministic backoff base. Default 250 ms (ARCHITECTURE.md §10.3). */
  readonly baseBackoffMs?: number;
  /** Backoff ceiling. Default 2 000 ms. */
  readonly maxBackoffMs?: number;
};

export const MAX_SAME_PROVIDER_RETRIES = 1;
export const DEFAULT_BASE_BACKOFF_MS = 250;
export const DEFAULT_MAX_BACKOFF_MS = 2_000;

export type ResolvedRetryPolicy = {
  readonly maxSameProviderRetries: number;
  readonly retryBeforeDispatch: boolean;
  readonly retryKnownNotAccepted: boolean;
  readonly retryUnknownOutcome: boolean;
  readonly baseBackoffMs: number;
  readonly maxBackoffMs: number;
};

export function resolveRetryPolicy(policy: RetryPolicy = {}): ResolvedRetryPolicy {
  const requested = policy.maxSameProviderRetries ?? MAX_SAME_PROVIDER_RETRIES;
  return {
    maxSameProviderRetries: Math.max(0, Math.min(requested, MAX_SAME_PROVIDER_RETRIES)),
    retryBeforeDispatch: policy.retryBeforeDispatch ?? true,
    retryKnownNotAccepted: policy.retryKnownNotAccepted ?? false,
    retryUnknownOutcome: policy.retryUnknownOutcome ?? true,
    baseBackoffMs: Math.max(1, policy.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS),
    maxBackoffMs: Math.max(1, policy.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS),
  };
}

/**
 * What is known about the failure's outcome.
 *
 * `dispatched === false` is the adapter's promise that nothing left this process;
 * `dispatched === true` is its promise that a response arrived. **Absent means unknown**, and an
 * unknown outcome is never assumed safe to repeat.
 */
export function classifyRetryPhase(
  error: AiError,
  dispatched: boolean | undefined,
): RetryPhase | null {
  const failureClass = classifyFailure(error);
  if (failureClass !== 'PROVIDER_TRANSIENT') {
    // Request, content, permission, governance, routing, deadline, cancellation and internal
    // faults are never repeated: the second copy would fail the same way and cost twice. A
    // `MODEL_UNAVAILABLE` is chased by *fallback*, never by re-asking the same model.
    return null;
  }
  if (error.code === 'INVALID_RESPONSE') {
    // A malformed answer is repaired (Phase 36), never blindly re-asked here.
    return null;
  }
  if (dispatched === false) {
    return 'BEFORE_DISPATCH';
  }
  if (dispatched === true) {
    return 'KNOWN_NOT_ACCEPTED';
  }
  return 'UNKNOWN_OUTCOME_AFTER_DISPATCH';
}

export type RetryDecision =
  | { readonly retry: true; readonly delayMs: number; readonly phase: RetryPhase; readonly reason: 'SAFE_PRE_DISPATCH' | 'KNOWN_TRANSIENT' | 'RELIABLE_IDEMPOTENCY' }
  | { readonly retry: false; readonly rule: RetryStopRule; readonly phase: RetryPhase | null };

export type RetryDecisionInput = {
  readonly error: AiError;
  /** `true` / `false` / `undefined` (unknown), straight from the mapped provider error. */
  readonly dispatched?: boolean;
  readonly retriesUsed: number;
  readonly policy?: RetryPolicy;
  /** `ProviderDescriptor.supportsReliableIdempotency`. Default false. */
  readonly supportsReliableIdempotency?: boolean;
  /** A provider-reported `Retry-After`, already projected to milliseconds. */
  readonly retryAfterMs?: number;
  /** Time left in the **overall** request budget. A retry never extends it (Phase 7). */
  readonly remainingMs?: number;
  readonly cancellation?: { readonly cancelled: boolean };
};

/**
 * Decide a same-provider retry. Deterministic and pure.
 *
 * A `RATE_LIMITED` failure is deliberately **not** retried in process: the provider said "slow
 * down", and the honest answer is `retryAfterMs` to the caller (ARCHITECTURE.md §10.3).
 */
export function decideRetry(input: RetryDecisionInput): RetryDecision {
  const policy = resolveRetryPolicy(input.policy);
  const retryPhase = classifyRetryPhase(input.error, input.dispatched);
  const stop = (rule: RetryStopRule): RetryDecision => ({ retry: false, rule, phase: retryPhase });

  if (retryPhase === null) {
    return stop('NOT_RETRYABLE_FAILURE');
  }
  if (input.error.code === 'RATE_LIMITED') {
    return stop('RATE_LIMITED_NO_IN_PROCESS_RETRY');
  }
  if (input.cancellation?.cancelled === true) {
    return stop('NOT_RETRYABLE_FAILURE');
  }
  if (input.retriesUsed >= policy.maxSameProviderRetries) {
    return stop('RETRY_LIMIT');
  }

  switch (retryPhase) {
    case 'BEFORE_DISPATCH':
      if (!policy.retryBeforeDispatch) {
        return stop('POLICY_DISABLED');
      }
      break;
    case 'KNOWN_NOT_ACCEPTED':
      if (!policy.retryKnownNotAccepted) {
        return stop('POLICY_DISABLED');
      }
      break;
    case 'UNKNOWN_OUTCOME_AFTER_DISPATCH':
      if (!policy.retryUnknownOutcome) {
        return stop('POLICY_DISABLED');
      }
      if (input.supportsReliableIdempotency !== true) {
        // The provider may already have generated and billed. Without reliable idempotency a
        // repeat is a second charge (Phase 8).
        return stop('UNKNOWN_OUTCOME_WITHOUT_RELIABLE_IDEMPOTENCY');
      }
      break;
    default: {
      const exhaustive: never = retryPhase;
      void exhaustive;
      return stop('NOT_RETRYABLE_FAILURE');
    }
  }

  const delayMs = backoffDelayMs(input.retriesUsed + 1, input.policy, input.retryAfterMs);
  const remaining = input.remainingMs ?? Number.POSITIVE_INFINITY;
  if (delayMs + MIN_RETRY_VIABLE_MS > remaining) {
    return stop('NO_TIME_LEFT');
  }
  return {
    retry: true,
    delayMs,
    phase: retryPhase,
    reason:
      retryPhase === 'BEFORE_DISPATCH'
        ? 'SAFE_PRE_DISPATCH'
        : retryPhase === 'KNOWN_NOT_ACCEPTED'
          ? 'KNOWN_TRANSIENT'
          : 'RELIABLE_IDEMPOTENCY',
  };
}

/** An attempt must keep this much of the overall budget to be worth starting (Phase 7). */
export const MIN_RETRY_VIABLE_MS = 1_500;

/**
 * Bounded deterministic backoff.
 *
 * A provider-reported `Retry-After` wins when present — the provider knows its own window — but is
 * still capped, so a hostile or broken header cannot park a request. Otherwise the delay is
 * `min(base × 2^(retryNumber − 1), max)`, exactly reproducible under a fake clock (Phase 10).
 */
export function backoffDelayMs(
  retryNumber: number,
  policy: RetryPolicy = {},
  retryAfterMs?: number,
): number {
  const resolved = resolveRetryPolicy(policy);
  if (retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs >= 0) {
    return Math.min(Math.round(retryAfterMs), resolved.maxBackoffMs * 4);
  }
  const exponent = Math.max(0, retryNumber - 1);
  const exponential = resolved.baseBackoffMs * 2 ** Math.min(exponent, 16);
  return Math.min(exponential, resolved.maxBackoffMs);
}
