/**
 * Reliability provenance (ROADMAP Stage 5 Phase 2–3, Phase 58).
 *
 * One **logical request** is one consumer call. Each real provider dispatch is one **provider
 * attempt** beneath it, and a consumer result may legitimately be the product of several attempts:
 *
 * ```text
 * Logical request #123
 *   Attempt 1  DeepSeek  TIMEOUT     (fallback: PROVIDER_TRANSIENT)
 *   Attempt 2  OpenAI    SUCCEEDED
 * ```
 *
 * Every attempt records what happened — ids, timing, generic error codes, the closed decision
 * rule that spawned it, usage and cost. Never content: no prompt, no learner data, no raw
 * response, no credential, no reasoning content (Phase 3).
 */
import type { AiErrorCode, AiErrorReason, AiUsage, ModelClass, ModelProfile } from '@aibridge/contracts';
import type { AttemptKind, AttemptSkipReason, AttemptStatus } from './usage-ledger.js';
import type { CostEstimate } from './cost.js';
import { aggregateUsage } from './cost.js';

export type ProviderAttemptProvenance = {
  readonly attemptId: string;
  readonly logicalRequestId: string;
  /** 1-based order across the whole logical request. */
  readonly sequence: number;
  /** A repair attempt is a child of the attempt whose output it repairs (Phase 36). */
  readonly parentAttemptId?: string;
  readonly attemptKind: AttemptKind;
  readonly providerId: string;
  readonly modelAlias: string;
  /** Operator-side real model id (safe projection: an id, never a credential or URL). */
  readonly providerModelId: string;
  readonly modelClass: ModelClass;
  /** 0 = first choice; > 0 = a fallback hop (frozen `routeDepth` semantics). */
  readonly routeDepth: number;
  /** The config snapshot version this attempt ran against (Phase 40). */
  readonly routeConfigVersion: string;
  readonly startedAtMs: number;
  readonly finishedAtMs: number;
  readonly status: AttemptStatus;
  readonly errorCode?: AiErrorCode;
  readonly errorReason?: AiErrorReason;
  /** The closed rule that spawned this attempt (e.g. `PROVIDER_TRANSIENT`). Never prose. */
  readonly retryRule?: string;
  readonly fallbackRule?: string;
  readonly skipReason?: AttemptSkipReason;
  readonly usage?: AiUsage;
  readonly usageKnown: boolean;
  readonly estimatedCost?: CostEstimate;
};

export type ReliabilityProvenance = {
  readonly logicalRequestId: string;
  /** The consumer's `requestId`, echoed. */
  readonly requestId: string;
  readonly callerPluginId: string;
  readonly capability: string;
  readonly capabilityVersion: string;
  /** Opaque consumer prompt labels for this logical request only; never prompt content. */
  readonly promptApplied?: boolean;
  readonly promptVersion?: string;
  readonly profile: ModelProfile;
  readonly configVersion: string;
  readonly configDigest: string;
  readonly startedAtMs: number;
  readonly finishedAtMs: number;
  readonly status: 'SUCCEEDED' | 'FAILED';
  readonly errorCode?: AiErrorCode;
  readonly errorReason?: AiErrorReason;
  readonly attempts: readonly ProviderAttemptProvenance[];
  readonly fallbackCount: number;
  readonly retryCount: number;
  readonly repairCount: number;
  /** Candidates that were skipped and why (Phase 52). */
  readonly skippedCount: number;
  readonly idempotencyOutcome: 'EXECUTED' | 'REPLAYED' | 'JOINED';
};

/** The total-cost view of one logical request — governance data, never a learning judgement. */
export type GovernanceSummary = {
  readonly logicalRequestId: string;
  readonly attemptCount: number;
  readonly fallbackCount: number;
  readonly retryCount: number;
  readonly repairCount: number;
  readonly skippedCount: number;
  /** Every attempt, not just the successful one (Phase 26/58). */
  readonly totalUsage: AiUsage;
  readonly totalUsageComplete: boolean;
  readonly totalCost: CostEstimate;
  readonly finalUsage: AiUsage;
};

export function summarize(provenance: ReliabilityProvenance): GovernanceSummary {
  const entries = provenance.attempts
    .filter((attempt) => attempt.status !== 'SKIPPED')
    .map((attempt) => ({ usage: attempt.usage ?? {}, known: attempt.usageKnown }));
  const last = [...provenance.attempts].reverse().find((attempt) => attempt.status !== 'SKIPPED');
  // Total usage shares one home with quota settlement (`aggregateUsage`): a real zero-token
  // report is a seen fact, never absent-as-unknown (Phase 26/58).
  const aggregate = aggregateUsage(entries);
  const totalCost = mergeCosts(provenance.attempts.map((attempt) => attempt.estimatedCost));
  return {
    logicalRequestId: provenance.logicalRequestId,
    attemptCount: provenance.attempts.filter((attempt) => attempt.status !== 'SKIPPED').length,
    fallbackCount: provenance.fallbackCount,
    retryCount: provenance.retryCount,
    repairCount: provenance.repairCount,
    skippedCount: provenance.skippedCount,
    totalUsage: aggregate.usage,
    totalUsageComplete: aggregate.complete,
    totalCost,
    finalUsage: last?.usage ?? {},
  };
}

/**
 * Total cost across attempts. Every attempt's cost is real money, so they are summed; when any
 * attempt's cost is unknown the total is a **partial** estimate, never a silently smaller number.
 */
export function mergeCosts(costs: readonly (CostEstimate | undefined)[]): CostEstimate {
  const present = costs.filter((cost): cost is CostEstimate => cost !== undefined);
  if (present.length === 0) {
    return { basis: 'UNKNOWN' };
  }
  const amounts = present.filter((cost) => cost.amount !== undefined);
  if (amounts.length === 0) {
    return { basis: 'UNKNOWN' };
  }
  const currency = amounts[0]?.currency;
  const mixedCurrency = amounts.some((cost) => cost.currency !== currency);
  if (mixedCurrency) {
    // Amounts in different currencies cannot be summed honestly: report unknown (partial),
    // never a meaningless cross-currency total (Phase 33).
    return { basis: 'UNKNOWN', partial: true };
  }
  const sum = amounts.reduce((total, cost) => total + (cost.amount ?? 0), 0);
  const partial = amounts.length < present.length || present.some((cost) => cost.partial === true);
  return {
    amount: sum,
    ...(currency === undefined ? {} : { currency }),
    basis: amounts.every((cost) => cost.basis === 'PROVIDER_REPORTED') ? 'PROVIDER_REPORTED' : 'ESTIMATED_FROM_PRICING',
    ...(partial ? { partial: true } : {}),
  };
}
