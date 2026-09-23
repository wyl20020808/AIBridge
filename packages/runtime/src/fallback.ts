/**
 * The deterministic fallback chain contract (ROADMAP Stage 4 §25).
 *
 * A complete, tested **contract**: given a route chain and a normalized failure, decide whether
 * the next hop may serve. Applying it automatically inside `AiRuntime` — bounded retry policy,
 * attempt accounting, budget inheritance across hops — is Stage 5 work and is deliberately *not*
 * half-implemented here.
 *
 * The frozen eligibility rule (ARCHITECTURE.md §10.1–10.2):
 *
 * > if the failure is a property of the **request** or of the **content**, do not spend another
 * > provider's money on it. If it is a property of the **provider**, consider a different one.
 *
 * Never fall back on: `INVALID_REQUEST`, `SCHEMA_MISMATCH`, `CONTENT_BLOCKED`, permission denials,
 * secret/config errors (`INTERNAL`), or `CANCELLED`. `RATE_LIMITED` and `QUOTA_EXCEEDED` only when
 * a route explicitly opts in (default **off**).
 */
import { fallbackEligibility, type AiError, type FallbackOptions } from '@aibridge/contracts';

export type FallbackVerdict<THop> =
  | { readonly kind: 'FALLBACK'; readonly next: THop; readonly remaining: readonly THop[] }
  | { readonly kind: 'STOP'; readonly rule: 'CHAIN_EXHAUSTED' | 'NOT_ELIGIBLE' | 'NOT_RETRYABLE' };

/**
 * Decide the next hop after the failure of `chain[0]` — the chain **includes the hop that just
 * failed**, so `chain[1]` is the proposed fallback and `chain.slice(2)` is what remains.
 *
 * Deterministic and pure: the same inputs always yield the same verdict, and the rule that
 * stopped the chain is named so a caller never has to guess.
 */
export function nextFallback<THop>(
  chain: readonly THop[],
  error: AiError,
  options: FallbackOptions = {},
): FallbackVerdict<THop> {
  if (!fallbackEligibility(error.code, options)) {
    return { kind: 'STOP', rule: 'NOT_ELIGIBLE' };
  }
  // `PROVIDER_ERROR` is eligible only when the bridge marked it retryable (e.g. OVERLOADED).
  if (error.code === 'PROVIDER_ERROR' && !error.retryable) {
    return { kind: 'STOP', rule: 'NOT_RETRYABLE' };
  }
  // A non-retryable failure is never chased across providers, whatever its code.
  if (!error.retryable && error.code !== 'UNAVAILABLE' && error.code !== 'TIMEOUT' && error.code !== 'MODEL_UNAVAILABLE') {
    return { kind: 'STOP', rule: 'NOT_RETRYABLE' };
  }
  const next = chain[1];
  if (next === undefined) {
    return { kind: 'STOP', rule: 'CHAIN_EXHAUSTED' };
  }
  return { kind: 'FALLBACK', next, remaining: chain.slice(2) };
}
