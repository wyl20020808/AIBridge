/**
 * Budget enforcement (ROADMAP Stage 5 Phase 34–35).
 *
 * A budget is the deployment's own wallet: a per-request cost cap plus daily/monthly cost caps.
 * It is checked **before** any dispatch (Phase 34): when the request plainly cannot fit, the
 * answer is `COST_BUDGET_EXHAUSTED` and **zero** provider calls. A fallback chain shares one
 * logical request budget, and so does a repair attempt (Phase 34/38).
 *
 * Cost is governance data only. Stage 5 never routes *because* something is cheaper — cost
 * influences budget and observability, never provider choice (Phase 35).
 */
import { makeAiError, type AiError } from '@aibridge/contracts';
import type { Clock } from '@aibridge/host-sdk';
import type { CostEstimate } from './cost.js';
import type { QuotaManager, QuotaRequest, QuotaReservation } from './quota.js';

export const BUDGET_METERS = ['PER_REQUEST', 'PER_DAY', 'PER_MONTH'] as const;

export type BudgetMeter = (typeof BUDGET_METERS)[number];

export type BudgetPolicy = {
  /** Hard ceiling for one logical request, including every attempt (fallback + repair). */
  readonly maxEstimatedCostPerRequest?: number;
  readonly maxEstimatedCostPerDay?: number;
  readonly maxEstimatedCostPerMonth?: number;
  readonly currency?: string;
};

export type BudgetDecision =
  | { readonly ok: true; readonly reservations: readonly QuotaReservation[] }
  | { readonly ok: false; readonly error: AiError; readonly meter: BudgetMeter };

export type BudgetCheckInput = {
  readonly policy: BudgetPolicy;
  /** The conservative estimate of the whole logical request (every possible attempt). */
  readonly estimatedRequestCost?: number;
  /** Spent so far in the period, from the quota store's cost buckets. */
  readonly spentToday: number;
  readonly spentThisMonth: number;
  /** A currency mismatch is an unknown budget, never a silently-zero one. */
  readonly currencyMatches?: boolean;
};

/**
 * Pure pre-dispatch budget check (Phase 34). "Plainly cannot fit" is a conservative, deterministic
 * test: a request is refused only when its conservative estimate already exceeds what is left.
 */
export function checkRequestBudget(input: BudgetCheckInput): BudgetDecision {
  const policy = input.policy;
  const estimate = input.estimatedRequestCost;
  const fail = (meter: BudgetMeter, limit: number, period: 'DAY' | 'MONTH' | 'REQUEST'): BudgetDecision => ({
    ok: false,
    meter,
    error: makeAiError({
      reason: 'COST_BUDGET_EXHAUSTED',
      message: 'The cost budget for this deployment is exhausted; no provider was called.',
      details: { dimension: 'ESTIMATED_COST', period, limit },
    }),
  });

  if (policy.maxEstimatedCostPerRequest !== undefined && estimate !== undefined) {
    if (estimate > policy.maxEstimatedCostPerRequest) {
      return fail('PER_REQUEST', policy.maxEstimatedCostPerRequest, 'REQUEST');
    }
  }
  // A currency mismatch means the budget cannot be compared honestly (Phase 33): refuse to guess.
  if (input.currencyMatches !== false) {
    if (policy.maxEstimatedCostPerDay !== undefined && input.spentToday + (estimate ?? 0) > policy.maxEstimatedCostPerDay) {
      return fail('PER_DAY', policy.maxEstimatedCostPerDay, 'DAY');
    }
    if (policy.maxEstimatedCostPerMonth !== undefined && input.spentThisMonth + (estimate ?? 0) > policy.maxEstimatedCostPerMonth) {
      return fail('PER_MONTH', policy.maxEstimatedCostPerMonth, 'MONTH');
    }
  }
  return { ok: true, reservations: [] };
}

export type BudgetTrackerOptions = {
  readonly policy: BudgetPolicy;
  readonly quotas: QuotaManager;
  readonly clock: Clock;
};

/**
 * The budget's period accounting, backed by the quota store's `ESTIMATED_COST` buckets so budget
 * and quota can never disagree about what has been spent.
 */
export class BudgetTracker {
  readonly #policy: BudgetPolicy;
  readonly #quotas: QuotaManager;
  readonly #clock: Clock;

  constructor(options: BudgetTrackerOptions) {
    this.#policy = options.policy;
    this.#quotas = options.quotas;
    this.#clock = options.clock;
  }

  get policy(): BudgetPolicy {
    return this.#policy;
  }

  async spent(request: QuotaRequest): Promise<{ readonly today: number; readonly month: number }> {
    void this.#clock;
    const dayPolicy = { scope: 'global', meter: 'ESTIMATED_COST', period: 'DAY', limit: Number.MAX_SAFE_INTEGER } as const;
    const monthPolicy = { scope: 'global', meter: 'ESTIMATED_COST', period: 'MONTH', limit: Number.MAX_SAFE_INTEGER } as const;
    return {
      today: await this.#quotas.consumed(dayPolicy, request),
      month: await this.#quotas.consumed(monthPolicy, request),
    };
  }

  /** The pre-dispatch budget gate. `policy` overrides the construction-time policy (Phase 42). */
  async check(
    request: QuotaRequest,
    estimatedRequestCost?: number | CostEstimate,
    policy: BudgetPolicy = this.#policy,
  ): Promise<BudgetDecision> {
    const spent = await this.spent(request);
    const estimate: CostEstimate | undefined =
      estimatedRequestCost === undefined
        ? undefined
        : typeof estimatedRequestCost === 'number'
          ? { amount: estimatedRequestCost, basis: 'ESTIMATED_FROM_PRICING' as const }
          : estimatedRequestCost;
    // A definite currency mismatch is an unknown budget (GOVERNANCE.md §6): the numeric
    // comparison refuses to guess, so the estimate is dropped and only spent is enforced.
    const currencyMatches =
      policy.currency !== undefined && estimate?.currency !== undefined
        ? policy.currency === estimate.currency
        : undefined;
    return checkRequestBudget({
      policy,
      ...(estimate?.amount === undefined || currencyMatches === false ? {} : { estimatedRequestCost: estimate.amount }),
      ...(currencyMatches === undefined ? {} : { currencyMatches }),
      spentToday: spent.today,
      spentThisMonth: spent.month,
    });
  }
}
