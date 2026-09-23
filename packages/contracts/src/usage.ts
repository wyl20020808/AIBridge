/**
 * Usage and cost (ARCHITECTURE.md §5.1, §16; INTEGRATION_CONTRACT_V1.md §4.1).
 *
 * Usage is cost and capacity evidence only. Nothing in it may influence a learning judgement.
 *
 * **`estimatedCost` is optional and stays optional.** Absent means *unknown*, not *zero*. When a
 * cost is present, `basis` is mandatory so a consumer can never mistake a price-table guess for a
 * provider invoice.
 */
import { describe, isNonNegativeFiniteNumber, isRecord, unknownKeys } from './guards.js';
import type { ValidationIssue, ValidationResult } from './issue.js';
import { at, createIssue, invalid, valid } from './issue.js';

export const COST_BASES = ['PROVIDER_REPORTED', 'PRICE_TABLE', 'ESTIMATED'] as const;

export type CostBasis = (typeof COST_BASES)[number];

/**
 * `reasoningTokens` is additive, Stage 5 — see the compatibility note in
 * INTEGRATION_CONTRACT_V1.md. Absent means *unknown*, never zero: it is projected only when a
 * provider safely reports a reasoning token count. Reasoning **content** never crosses the
 * boundary; only the count does.
 */
export const USAGE_TOKEN_KEYS = ['inputTokens', 'outputTokens', 'totalTokens', 'cachedTokens', 'reasoningTokens'] as const;

export type UsageTokenKey = (typeof USAGE_TOKEN_KEYS)[number];

/** ISO 4217, upper-case. */
export const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export type EstimatedCost = {
  readonly value: number;
  readonly currency: string;
  readonly basis: CostBasis;
};

export type AiUsage = {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly cachedTokens?: number;
  /** Additive, Stage 5. A count only — reasoning **content** is never projected. */
  readonly reasoningTokens?: number;
  readonly estimatedCost?: EstimatedCost;
};

export function isCostBasis(value: unknown): value is CostBasis {
  return typeof value === 'string' && (COST_BASES as readonly string[]).includes(value);
}

/** A usage record with no facts in it. `{}` is a valid, honest answer. */
export function emptyUsage(): AiUsage {
  return {};
}

/** True when no usage fact at all is present. */
export function isEmptyUsage(usage: AiUsage): boolean {
  return (
    usage.inputTokens === undefined &&
    usage.outputTokens === undefined &&
    usage.totalTokens === undefined &&
    usage.cachedTokens === undefined &&
    usage.reasoningTokens === undefined &&
    usage.estimatedCost === undefined
  );
}

export function parseEstimatedCost(value: unknown, path = '$'): ValidationResult<EstimatedCost> {
  if (!isRecord(value)) {
    return invalid('MALFORMED_ENVELOPE', [createIssue('INVALID_TYPE', path, `must be an object, got ${describe(value)}`)]);
  }
  const issues: ValidationIssue[] = [];
  for (const key of unknownKeys(value, ['value', 'currency', 'basis'])) {
    issues.push(createIssue('UNKNOWN_FIELD', at(path, key), 'unknown cost field'));
  }
  if (!isNonNegativeFiniteNumber(value['value'])) {
    issues.push(createIssue('INVALID_TYPE', at(path, 'value'), 'must be a finite, non-negative number'));
  }
  if (typeof value['currency'] !== 'string' || !CURRENCY_PATTERN.test(value['currency'])) {
    issues.push(createIssue('PATTERN_MISMATCH', at(path, 'currency'), 'must be an ISO 4217 currency code, e.g. USD'));
  }
  if (!isCostBasis(value['basis'])) {
    issues.push(createIssue('INVALID_VALUE', at(path, 'basis'), `must be one of ${COST_BASES.join(', ')}`));
  }
  if (issues.length > 0) {
    return invalid('MALFORMED_ENVELOPE', issues);
  }
  return valid({
    value: value['value'] as number,
    currency: value['currency'] as string,
    basis: value['basis'] as CostBasis,
  });
}

export function parseAiUsage(value: unknown, path = '$'): ValidationResult<AiUsage> {
  if (!isRecord(value)) {
    return invalid('MALFORMED_ENVELOPE', [createIssue('INVALID_TYPE', path, `must be an object, got ${describe(value)}`)]);
  }
  const issues: ValidationIssue[] = [];
  const allowed = [...USAGE_TOKEN_KEYS, 'estimatedCost'];
  for (const key of unknownKeys(value, allowed)) {
    issues.push(createIssue('UNKNOWN_FIELD', at(path, key), 'unknown usage field'));
  }
  for (const key of USAGE_TOKEN_KEYS) {
    const entry = value[key];
    if (entry !== undefined && !isNonNegativeFiniteNumber(entry)) {
      issues.push(createIssue('INVALID_TYPE', at(path, key), 'must be a finite, non-negative number'));
    }
  }
  let estimatedCost: EstimatedCost | undefined;
  if (value['estimatedCost'] !== undefined) {
    const parsed = parseEstimatedCost(value['estimatedCost'], at(path, 'estimatedCost'));
    if (parsed.ok) {
      estimatedCost = parsed.value;
    } else {
      issues.push(...parsed.failure.issues);
    }
  }
  if (issues.length > 0) {
    return invalid('MALFORMED_ENVELOPE', issues);
  }
  return valid({
    ...(typeof value['inputTokens'] === 'number' ? { inputTokens: value['inputTokens'] } : {}),
    ...(typeof value['outputTokens'] === 'number' ? { outputTokens: value['outputTokens'] } : {}),
    ...(typeof value['totalTokens'] === 'number' ? { totalTokens: value['totalTokens'] } : {}),
    ...(typeof value['cachedTokens'] === 'number' ? { cachedTokens: value['cachedTokens'] } : {}),
    ...(typeof value['reasoningTokens'] === 'number' ? { reasoningTokens: value['reasoningTokens'] } : {}),
    ...(estimatedCost === undefined ? {} : { estimatedCost }),
  });
}
