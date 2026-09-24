/**
 * The deterministic fallback chain contract (ROADMAP Stage 4 §25, Stage 5 Phase 4–6).
 *
 * Stage 5 applies this contract **automatically**, under the reason-aware `FallbackPolicy` in
 * `@aibridge/governance`: `decideFallback` answers "may this failure be chased at all?", this
 * module answers "which hop is next, and is the chain done?".
 *
 * The frozen eligibility rule (ARCHITECTURE.md §10.1–10.2):
 *
 * > if the failure is a property of the **request** or of the **content**, do not spend another
 * > provider's money on it. If it is a property of the **provider**, consider a different one.
 *
 * Never fall back on: `INVALID_REQUEST`, `SCHEMA_MISMATCH`, `CONTENT_BLOCKED`, permission denials,
 * secret/config errors (`INTERNAL`), or `CANCELLED`. `RATE_LIMITED` and `QUOTA_EXCEEDED` only when
 * a route explicitly opts in (default **off**) — and never to dodge the caller's *own* limits,
 * which `decideFallback` blocks by reason before this module is consulted.
 */
import {
  createIssue,
  fallbackEligibility,
  type AiError,
  type FallbackOptions,
  type ValidationIssue,
} from '@aibridge/contracts';

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
  // A depleted balance (`PROVIDER_BALANCE_EXHAUSTED`, Stage 6) is the one deliberate exception
  // to the non-retryable rules below: permanent for one wallet, but not for the next provider.
  const balanceChase = error.reason === 'PROVIDER_BALANCE_EXHAUSTED';
  // `PROVIDER_ERROR` is eligible only when the bridge marked it retryable (e.g. OVERLOADED) —
  // except a depleted balance, which is chased like an overload.
  if (error.code === 'PROVIDER_ERROR' && !error.retryable && !balanceChase) {
    return { kind: 'STOP', rule: 'NOT_RETRYABLE' };
  }
  // A non-retryable failure is never chased across providers, whatever its code — except where the
  // frozen classification table (§7.2) explicitly allows a **configured** chase: `RATE_LIMITED`
  // and `QUOTA_EXCEEDED` are retryable:false by nature and still configurable for fallback.
  const configuredChase = error.code === 'RATE_LIMITED' || error.code === 'QUOTA_EXCEEDED';
  if (!error.retryable && !configuredChase && !balanceChase && error.code !== 'UNAVAILABLE' && error.code !== 'TIMEOUT' && error.code !== 'MODEL_UNAVAILABLE') {
    return { kind: 'STOP', rule: 'NOT_RETRYABLE' };
  }
  const next = chain[1];
  if (next === undefined) {
    return { kind: 'STOP', rule: 'CHAIN_EXHAUSTED' };
  }
  return { kind: 'FALLBACK', next, remaining: chain.slice(2) };
}

/** A fallback chain is finite in V1. More hops than this is a config error, not a longer rope. */
export const MAX_FALLBACK_CHAIN_LENGTH = 8;

/**
 * Compile-time chain validation (Stage 5 Phase 6): **cycle, duplicate target and impossible target
 * are all rejected.** `keyOf` resolves one hop to its target identity, or `null` when the hop does
 * not resolve — an impossible target. A revisit of a target is a cycle in a linear chain.
 */
export function validateFallbackChain<THop>(
  chain: readonly THop[],
  keyOf: (hop: THop) => string | null,
  path = '$.chain',
): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (chain.length === 0) {
    issues.push(createIssue('INVALID_TYPE', path, 'must contain at least one hop'));
    return issues;
  }
  if (chain.length > MAX_FALLBACK_CHAIN_LENGTH) {
    issues.push(
      createIssue('OUT_OF_RANGE', path, `must contain at most ${MAX_FALLBACK_CHAIN_LENGTH} hops — a fallback chain is finite`),
    );
  }
  const seen = new Set<string>();
  chain.forEach((hop, index) => {
    const key = keyOf(hop);
    const hopPath = `${path}[${index}]`;
    if (key === null) {
      issues.push(createIssue('UNKNOWN_FIELD', hopPath, 'impossible target: the hop does not resolve'));
      return;
    }
    if (seen.has(key)) {
      // Revisiting a target in a linear chain is a cycle. Reject rather than loop (Phase 6).
      issues.push(createIssue('DUPLICATE_FIELD', hopPath, `duplicate/cyclic target "${key}" in one chain`));
      return;
    }
    seen.add(key);
  });
  return issues;
}
