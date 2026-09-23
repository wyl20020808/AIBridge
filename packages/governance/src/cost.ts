/**
 * Cost estimation and versioned pricing (ROADMAP Stage 5 Phase 30–33, ARCHITECTURE.md §16.2).
 *
 * Cost honesty, restated as rules:
 *
 *  - **Unknown cost is not zero.** An absent amount is the honest answer for "we do not know"
 *    (Phase 31). `projectCostToUsage` returns `undefined` for it — an absent `estimatedCost`, which
 *    the frozen `AiUsage` contract already reads as *unknown*.
 *  - **The price is pinned when the call starts** (Phase 32). A later price change never rewrites
 *    a historical record: every estimate carries its `pricingId` + `pricingVersion`.
 *  - **No invented precision** (Phase 33). Known usage + known price ⇒ an estimate. Anything
 *    missing ⇒ unknown, or a clearly-marked *partial* estimate.
 *
 * The three bases answer "who says so": `PROVIDER_REPORTED` (the provider billed it),
 * `ESTIMATED_FROM_PRICING` (our price table, pinned), `UNKNOWN` (nobody knows).
 */
import type { AiUsage, EstimatedCost, ValidationIssue } from '@aibridge/contracts';
import { CURRENCY_PATTERN, createIssue } from '@aibridge/contracts';

export const GOVERNANCE_COST_BASES = ['PROVIDER_REPORTED', 'ESTIMATED_FROM_PRICING', 'UNKNOWN'] as const;

export type GovernanceCostBasis = (typeof GOVERNANCE_COST_BASES)[number];

export const PRICING_UNITS = ['PER_1K_TOKENS', 'PER_1M_TOKENS'] as const;

export type PricingUnit = (typeof PRICING_UNITS)[number];

export type PricingRecord = {
  /** Stable operator-side id. The provenance anchor for every estimate. */
  readonly pricingId: string;
  /** Bumped whenever the numbers change. History keeps its own version (Phase 32). */
  readonly version: string;
  readonly providerId: string;
  /** Model alias and/or operator-side model ref. At least one must be present. */
  readonly modelAlias?: string;
  readonly modelRef?: string;
  /** Inclusive validity start. */
  readonly validFromMs: number;
  /** Exclusive validity end. Absent = still current. */
  readonly validUntilMs?: number;
  readonly currency: string;
  /** Price per `unit` of tokens. Absent means "not priced separately", not zero. */
  readonly inputTokenPrice?: number;
  readonly outputTokenPrice?: number;
  readonly cachedInputPrice?: number;
  /** Only when reasoning tokens are priced materially differently. */
  readonly reasoningTokenPrice?: number;
  readonly unit: PricingUnit;
  /** Where the numbers come from: a URL, a contract, an operator note. Free text, operator-side. */
  readonly source: string;
};

/** The pinned price of one request (Phase 32). */
export type PricingSnapshot = {
  readonly pricingId: string;
  readonly version: string;
  readonly currency: string;
  readonly unit: PricingUnit;
  readonly inputTokenPrice?: number;
  readonly outputTokenPrice?: number;
  readonly cachedInputPrice?: number;
  readonly reasoningTokenPrice?: number;
  readonly pinnedAtMs: number;
};

export type CostEstimate = {
  /** Absent means **unknown** — never zero, never "free" (Phase 31). */
  readonly amount?: number;
  readonly currency?: string;
  readonly basis: GovernanceCostBasis;
  readonly pricingId?: string;
  readonly pricingVersion?: string;
  /** True when only part of the usage was known and the amount is a lower bound. */
  readonly partial?: boolean;
};

export const UNKNOWN_COST: CostEstimate = { basis: 'UNKNOWN' };

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function unitDivisor(unit: PricingUnit): number {
  return unit === 'PER_1K_TOKENS' ? 1_000 : 1_000_000;
}

/** The pinned price table. Strictly validated: an ambiguous price is a config error, not a guess. */
export class PricingTable {
  readonly #records: readonly PricingRecord[];

  constructor(records: readonly PricingRecord[] = []) {
    this.#records = [...records];
  }

  get records(): readonly PricingRecord[] {
    return this.#records;
  }

  /** Every pricing problem in the table. An empty list means the table is safe to pin. */
  validate(path = '$'): readonly ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const seen = new Set<string>();
    this.#records.forEach((record, index) => {
      const at = `${path}[${index}]`;
      if (record.pricingId.length === 0) {
        issues.push(createIssue('MISSING_FIELD', `${at}.pricingId`, 'must be a non-empty id'));
      }
      if (record.version.length === 0) {
        issues.push(createIssue('MISSING_FIELD', `${at}.version`, 'must be a non-empty version'));
      }
      if (record.modelAlias === undefined && record.modelRef === undefined) {
        issues.push(createIssue('MISSING_FIELD', at, 'must name a modelAlias or a modelRef'));
      }
      if (!CURRENCY_PATTERN.test(record.currency)) {
        issues.push(createIssue('PATTERN_MISMATCH', `${at}.currency`, 'must be an ISO 4217 currency code, e.g. USD'));
      }
      for (const key of ['inputTokenPrice', 'outputTokenPrice', 'cachedInputPrice', 'reasoningTokenPrice'] as const) {
        const value = record[key];
        if (value !== undefined && !isNonNegativeFinite(value)) {
          issues.push(createIssue('INVALID_TYPE', `${at}.${key}`, 'must be a finite, non-negative number'));
        }
      }
      if (record.inputTokenPrice === undefined && record.outputTokenPrice === undefined) {
        issues.push(createIssue('MISSING_FIELD', at, 'must price at least input or output tokens'));
      }
      if (record.validUntilMs !== undefined && record.validUntilMs <= record.validFromMs) {
        issues.push(createIssue('INVALID_VALUE', `${at}.validUntilMs`, 'must be after validFromMs'));
      }
      // Overlapping records for one target would make a pin non-deterministic.
      const target = `${record.providerId}|${record.modelAlias ?? ''}|${record.modelRef ?? ''}`;
      const overlaps = this.#records.some(
        (other, otherIndex) =>
          otherIndex !== index &&
          `${other.providerId}|${other.modelAlias ?? ''}|${other.modelRef ?? ''}` === target &&
          other.version === record.version &&
          other.validFromMs < (record.validUntilMs ?? Number.POSITIVE_INFINITY) &&
          (other.validUntilMs ?? Number.POSITIVE_INFINITY) > record.validFromMs,
      );
      const identity = `${target}|${record.version}`;
      if (overlaps || seen.has(identity)) {
        issues.push(createIssue('DUPLICATE_FIELD', at, 'overlapping pricing for one target and version'));
      }
      seen.add(identity);
    });
    return issues;
  }

  /**
   * The price pinned at `atMs` for one model. `null` means **unknown pricing** — the caller must
   * report an unknown cost, never a zero one (Phase 33).
   */
  snapshotFor(
    providerId: string,
    target: { readonly modelAlias?: string; readonly modelRef?: string },
    atMs: number,
  ): PricingSnapshot | null {
    const candidates = this.#records.filter(
      (record) =>
        record.providerId === providerId &&
        record.validFromMs <= atMs &&
        (record.validUntilMs === undefined || atMs < record.validUntilMs) &&
        (record.modelAlias === undefined || target.modelAlias === undefined || record.modelAlias === target.modelAlias) &&
        (record.modelRef === undefined || target.modelRef === undefined || record.modelRef === target.modelRef),
    );
    if (candidates.length === 0) {
      return null;
    }
    // Most specific first (a model-alias record beats a provider-wide one), then newest.
    const sorted = [...candidates].sort((a, b) => {
      const specificityA = (a.modelAlias === undefined ? 0 : 2) + (a.modelRef === undefined ? 0 : 1);
      const specificityB = (b.modelAlias === undefined ? 0 : 2) + (b.modelRef === undefined ? 0 : 1);
      return specificityB - specificityA || b.validFromMs - a.validFromMs;
    });
    const record = sorted[0];
    if (record === undefined) {
      return null;
    }
    return {
      pricingId: record.pricingId,
      version: record.version,
      currency: record.currency,
      unit: record.unit,
      pinnedAtMs: atMs,
      ...(record.inputTokenPrice === undefined ? {} : { inputTokenPrice: record.inputTokenPrice }),
      ...(record.outputTokenPrice === undefined ? {} : { outputTokenPrice: record.outputTokenPrice }),
      ...(record.cachedInputPrice === undefined ? {} : { cachedInputPrice: record.cachedInputPrice }),
      ...(record.reasoningTokenPrice === undefined ? {} : { reasoningTokenPrice: record.reasoningTokenPrice }),
    };
  }
}

/**
 * Estimate one call's cost.
 *
 * Known usage + known price ⇒ an estimate; anything missing ⇒ `UNKNOWN`, or a **partial** lower
 * bound when only some counts arrived. A provider-reported cost wins over the price table.
 */
export function estimateCost(
  usage: AiUsage,
  snapshot: PricingSnapshot | null,
  reported?: EstimatedCost,
): CostEstimate {
  if (reported !== undefined && reported.basis === 'PROVIDER_REPORTED') {
    return {
      amount: reported.value,
      currency: reported.currency,
      basis: 'PROVIDER_REPORTED',
    };
  }
  if (snapshot === null) {
    return UNKNOWN_COST;
  }
  const hasInput = usage.inputTokens !== undefined;
  const hasOutput = usage.outputTokens !== undefined;
  if (!hasInput && !hasOutput) {
    // No token facts at all: an unknown cost, not a zero one (Phase 31).
    return { basis: 'UNKNOWN', pricingId: snapshot.pricingId, pricingVersion: snapshot.version };
  }

  const divisor = unitDivisor(snapshot.unit);
  const inputPrice = snapshot.inputTokenPrice ?? snapshot.cachedInputPrice ?? 0;
  const outputPrice = snapshot.outputTokenPrice ?? 0;
  const cachedPrice = snapshot.cachedInputPrice ?? inputPrice;
  const reasoningPrice = snapshot.reasoningTokenPrice ?? outputPrice;

  // Split counts the provider did not report are treated as zero — for cached tokens that is the
  // conservative (un-discounted) direction. A rate card should set `reasoningTokenPrice` only for
  // providers that report `reasoningTokens` (USAGE_AND_COST.md §cost basis).
  const cachedTokens = usage.cachedTokens ?? 0;
  const uncachedInput = Math.max(0, (usage.inputTokens ?? 0) - cachedTokens);
  const reasoningTokens = snapshot.reasoningTokenPrice === undefined ? 0 : usage.reasoningTokens ?? 0;
  const plainOutput = Math.max(0, (usage.outputTokens ?? 0) - reasoningTokens);

  const amount =
    (uncachedInput * inputPrice +
      cachedTokens * cachedPrice +
      plainOutput * outputPrice +
      reasoningTokens * reasoningPrice) /
    divisor;

  // Partial means "one of the two main counts never arrived" — no invented precision (Phase 33).
  const partial = !hasInput || !hasOutput;
  return {
    amount,
    currency: snapshot.currency,
    basis: 'ESTIMATED_FROM_PRICING',
    pricingId: snapshot.pricingId,
    pricingVersion: snapshot.version,
    ...(partial ? { partial: true } : {}),
  };
}

/**
 * Project a governance estimate into the frozen `AiUsage.estimatedCost`.
 *
 * `UNKNOWN` projects to **absent**, because the frozen contract already reads an absent cost as
 * *unknown* — and a zero would read as *free* (ARCHITECTURE.md §16.2).
 */
export function projectCostToUsage(cost: CostEstimate): EstimatedCost | undefined {
  if (cost.amount === undefined || cost.currency === undefined) {
    return undefined;
  }
  const basis = cost.basis === 'PROVIDER_REPORTED' ? 'PROVIDER_REPORTED' : cost.partial === true ? 'ESTIMATED' : 'PRICE_TABLE';
  return { value: cost.amount, currency: cost.currency, basis };
}

export type UsageAggregate = {
  /** Totals across attempts. A count nobody reported stays absent. */
  readonly usage: AiUsage;
  /** `false` when at least one attempt reported no usage at all (Phase 24). */
  readonly complete: boolean;
};

/**
 * Aggregate the usage of **every** attempt of a logical request (Phase 26/58).
 *
 * A count is summed only over the attempts that reported it, and `complete` is false whenever any
 * attempt reported nothing — so a fallback chain's total can never look smaller than reality.
 */
export function aggregateUsage(entries: readonly { readonly usage: AiUsage; readonly known: boolean }[]): UsageAggregate {
  const sums: Record<'inputTokens' | 'outputTokens' | 'totalTokens' | 'cachedTokens' | 'reasoningTokens', { value: number; seen: number }> = {
    inputTokens: { value: 0, seen: 0 },
    outputTokens: { value: 0, seen: 0 },
    totalTokens: { value: 0, seen: 0 },
    cachedTokens: { value: 0, seen: 0 },
    reasoningTokens: { value: 0, seen: 0 },
  };
  let complete = true;
  for (const entry of entries) {
    if (!entry.known) {
      complete = false;
    }
    for (const key of Object.keys(sums) as (keyof typeof sums)[]) {
      const value = entry.usage[key];
      if (typeof value === 'number') {
        sums[key].value += value;
        sums[key].seen += 1;
      }
    }
  }
  const usage: Record<string, number> = {};
  for (const key of Object.keys(sums) as (keyof typeof sums)[]) {
    if (sums[key].seen > 0) {
      usage[key] = sums[key].value;
    }
  }
  return { usage: usage as AiUsage, complete: entries.length > 0 && complete };
}

/** True when a usage record carries no token fact at all. */
export function usageIsUnknown(usage: AiUsage): boolean {
  return (
    usage.inputTokens === undefined &&
    usage.outputTokens === undefined &&
    usage.totalTokens === undefined &&
    usage.cachedTokens === undefined &&
    usage.reasoningTokens === undefined
  );
}
