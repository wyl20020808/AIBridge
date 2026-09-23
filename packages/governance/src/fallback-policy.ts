/**
 * The fallback policy (ROADMAP Stage 5 Phase 4–6, ARCHITECTURE.md §10.1–10.2).
 *
 * This is the **reason-aware** half of the Stage 4 `nextFallback` contract. `nextFallback` decides
 * chain arithmetic from the error *code*; this module decides whether the failure may be chased at
 * all, from the closed **reason** and its stage. Both are consulted, in this order:
 *
 * ```text
 * decideFallback(error, policy)  →  may this failure be chased at all?
 * nextFallback(chain, error, …)  →  which hop is next, and is the chain done?
 * ```
 *
 * The frozen rule (ARCHITECTURE.md §10.2):
 *
 * > if the failure is a property of the **request** or of the **content**, do not spend another
 * > provider's money on it. If it is a property of the **provider**, consider a different one.
 *
 * Two Stage 5 sharpenings, both stable-reason based, never string matching:
 *
 *  - **Own limits are never dodged.** `RATE_LIMIT_*`, `QUOTA_SUBJECT/CALLER/CAPABILITY/GLOBAL`,
 *    `COST_BUDGET_EXHAUSTED` and the kill switches are **our** governance. A provider with spare
 *    capacity is not a way around them (Phase 53–54).
 *  - **A provider-scoped quota may move, when the route says so.** `QUOTA_PROVIDER` is a limit on
 *    one provider, so `fallbackOnQuotaExceeded` may move the call to another one.
 */
import type { AiError, FallbackOptions } from '@aibridge/contracts';
import { classifyFailure, type FailureClass } from './failure-class.js';

export type FallbackPolicy = {
  /** A provider-originated throttle (`PROVIDER_THROTTLED`) may move the call. Default **false**. */
  readonly fallbackOnRateLimit?: boolean;
  /** A provider-scoped quota (`QUOTA_PROVIDER`) may move the call. Default **false**. */
  readonly fallbackOnQuotaExceeded?: boolean;
  /**
   * Allow a fallback target that does not meet the original capability/profile/requirement set.
   * Default **false**, and Stage 5 implements only `false`: a requirement is never quietly
   * downgraded (Phase 5).
   */
  readonly allowCapabilityDegrade?: boolean;
  /**
   * After an **unknown outcome** (a timeout after dispatch, where the provider may already have
   * generated and billed), the call may still move to another provider. Default **true** — the
   * frozen classification table already marks `TIMEOUT` as safe to fall back — and it is a route
   * policy precisely because the extra spend is real.
   */
  readonly crossProviderFallbackOnUnknownOutcome?: boolean;
};

export const FALLBACK_STOP_RULES = [
  'CANCELLED',
  'REQUEST_PROPERTY',
  'CONTENT_PROPERTY',
  'PERMISSION_PROPERTY',
  'CONFIG_OR_INTERNAL',
  'OWN_LIMIT_NOT_DODGED',
  'DEADLINE_EXHAUSTED',
  'UNKNOWN_OUTCOME',
  'RATE_LIMIT_NOT_CONFIGURED',
  'QUOTA_NOT_CONFIGURED',
  'NOT_RETRYABLE_CODE',
] as const;

export type FallbackStopRule = (typeof FALLBACK_STOP_RULES)[number];

export type FallbackDecision =
  | { readonly eligible: true; readonly rule: 'PROVIDER_TRANSIENT' | 'MODEL_UNAVAILABLE' | 'TIMEOUT' | 'RATE_LIMIT_POLICY' | 'PROVIDER_QUOTA_POLICY' }
  | { readonly eligible: false; readonly rule: FallbackStopRule; readonly failureClass: FailureClass };

/** The resolved policy, defaults filled in. */
export type ResolvedFallbackPolicy = Required<FallbackPolicy>;

export function resolveFallbackPolicy(policy: FallbackPolicy = {}): ResolvedFallbackPolicy {
  return {
    fallbackOnRateLimit: policy.fallbackOnRateLimit ?? false,
    fallbackOnQuotaExceeded: policy.fallbackOnQuotaExceeded ?? false,
    allowCapabilityDegrade: policy.allowCapabilityDegrade ?? false,
    crossProviderFallbackOnUnknownOutcome: policy.crossProviderFallbackOnUnknownOutcome ?? true,
  };
}

/** The Stage 4 `FallbackOptions` a policy implies. */
export function fallbackOptionsOf(policy: ResolvedFallbackPolicy): FallbackOptions {
  return {
    fallbackOnRateLimit: policy.fallbackOnRateLimit,
    fallbackOnQuotaExceeded: policy.fallbackOnQuotaExceeded,
  };
}

/**
 * May this failure be chased to another provider at all?
 *
 * `unknownOutcome` is supplied by the executor: `true` when the attempt's outcome is unknown (a
 * timeout or transport break after dispatch). Every decision reads the closed code/reason/stage —
 * provider prose is not an input (AGENTS.md §4).
 */
export function decideFallback(
  error: AiError,
  policy: FallbackPolicy = {},
  context: { readonly unknownOutcome?: boolean } = {},
): FallbackDecision {
  const resolved = resolveFallbackPolicy(policy);
  const failureClass = classifyFailure(error);
  const deny = (rule: FallbackStopRule): FallbackDecision => ({ eligible: false, rule, failureClass });

  switch (failureClass) {
    case 'CANCELLED':
      return deny('CANCELLED');
    case 'REQUEST':
      return deny('REQUEST_PROPERTY');
    case 'CONTENT':
      return deny('CONTENT_PROPERTY');
    case 'PERMISSION':
      return deny('PERMISSION_PROPERTY');
    case 'INTERNAL':
    case 'PROVIDER_PERMANENT':
      // A broken credential or an internal fault is a deployment problem. Another provider's
      // money must not be spent papering over it (Phase 4: secret/config errors never fall back).
      return deny('CONFIG_OR_INTERNAL');
    case 'DEADLINE':
      return deny('DEADLINE_EXHAUSTED');
    case 'GOVERNANCE': {
      // Our own limits never move — except a provider-scoped quota, which limits one provider.
      if (error.reason === 'QUOTA_PROVIDER' && resolved.fallbackOnQuotaExceeded) {
        return { eligible: true, rule: 'PROVIDER_QUOTA_POLICY' };
      }
      return deny('OWN_LIMIT_NOT_DODGED');
    }
    case 'ROUTING':
      return error.reason === 'MODEL_UNAVAILABLE'
        ? { eligible: true, rule: 'MODEL_UNAVAILABLE' }
        : deny('NOT_RETRYABLE_CODE');
    case 'PROVIDER_TRANSIENT': {
      if (error.code === 'RATE_LIMITED') {
        return resolved.fallbackOnRateLimit
          ? { eligible: true, rule: 'RATE_LIMIT_POLICY' }
          : deny('RATE_LIMIT_NOT_CONFIGURED');
      }
      if (error.code === 'TIMEOUT' && context.unknownOutcome === true) {
        // The provider may already have generated and billed. Moving is a **policy** decision,
        // not an automatic one (Phase 4).
        return resolved.crossProviderFallbackOnUnknownOutcome
          ? { eligible: true, rule: 'TIMEOUT' }
          : deny('UNKNOWN_OUTCOME');
      }
      if (error.code === 'INVALID_RESPONSE') {
        // The frozen classification table says `INVALID_RESPONSE` is not chased across providers.
        return deny('NOT_RETRYABLE_CODE');
      }
      return { eligible: true, rule: 'PROVIDER_TRANSIENT' };
    }
    default: {
      const exhaustive: never = failureClass;
      void exhaustive;
      return deny('NOT_RETRYABLE_CODE');
    }
  }
}

/** `UNKNOWN` is what `AiResult.providerMetadata` reports when a degrade was allowed (Phase 5). */
export const CAPABILITY_DEGRADE_NOTE = 'capability requirements were degraded by explicit route policy';
