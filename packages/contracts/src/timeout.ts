/**
 * Timeout semantics (ARCHITECTURE.md §12, INTEGRATION_CONTRACT_V1.md §9).
 *
 * Frozen defaults. Pure arithmetic only: the routing engine belongs to Stage 5.
 *
 * The chain must not multiply the wait: a fallback inherits the **remaining** budget, so a caller
 * waits one budget, not `n × budget`. The bridge clamps a caller's budget **down**, never up.
 */
import { describe, isRecord, isPositiveInteger, unknownKeys } from './guards.js';
import type { ValidationIssue, ValidationResult } from './issue.js';
import { at, createIssue, invalid, valid } from './issue.js';

export const DEFAULT_TOTAL_MS = 20_000;
export const DEFAULT_PROVIDER_MS = 15_000;
export const VALIDATION_RESERVE_MS = 1_000;
export const MIN_VIABLE_PROVIDER_MS = 1_500;
/** The server-side ceiling a caller's budget can never widen. */
export const MAX_TOTAL_TIMEOUT_MS = 30_000;

export type TimeoutBudget = {
  readonly totalMs: number;
  readonly providerMs?: number;
};

export const TIMEOUT_BUDGET_KEYS = ['totalMs', 'providerMs'] as const;

export function parseTimeoutBudget(value: unknown, path = '$'): ValidationResult<TimeoutBudget> {
  if (!isRecord(value)) {
    return invalid('MALFORMED_ENVELOPE', [createIssue('INVALID_TYPE', path, `must be an object, got ${describe(value)}`)]);
  }
  const issues: ValidationIssue[] = [];
  for (const key of unknownKeys(value, TIMEOUT_BUDGET_KEYS)) {
    issues.push(createIssue('UNKNOWN_FIELD', at(path, key), 'unknown timeout-budget field'));
  }
  if (!isPositiveInteger(value['totalMs'])) {
    issues.push(createIssue('INVALID_TYPE', at(path, 'totalMs'), 'must be a positive integer of milliseconds'));
  }
  const providerMs = value['providerMs'];
  if (providerMs !== undefined && !isPositiveInteger(providerMs)) {
    issues.push(createIssue('INVALID_TYPE', at(path, 'providerMs'), 'must be a positive integer of milliseconds'));
  }
  if (issues.length > 0) {
    return invalid('MALFORMED_ENVELOPE', issues);
  }
  return valid({
    totalMs: value['totalMs'] as number,
    ...(typeof providerMs === 'number' ? { providerMs } : {}),
  });
}

/**
 * Clamp a caller budget to the effective ceiling: `min(caller, capability cap, server cap)`.
 * Never widens. `providerMs` is clamped to leave `VALIDATION_RESERVE_MS` free.
 */
export function clampTimeoutBudget(
  caller: TimeoutBudget | undefined,
  capabilityCapMs: number = DEFAULT_TOTAL_MS,
  serverCapMs: number = MAX_TOTAL_TIMEOUT_MS,
): TimeoutBudget {
  const requested = caller?.totalMs ?? DEFAULT_TOTAL_MS;
  const totalMs = Math.max(1, Math.min(requested, capabilityCapMs, serverCapMs));
  const requestedProvider = caller?.providerMs ?? DEFAULT_PROVIDER_MS;
  const providerCeiling = Math.max(1, totalMs - VALIDATION_RESERVE_MS);
  const providerMs = Math.max(1, Math.min(requestedProvider, providerCeiling));
  return { totalMs, providerMs };
}

/** Milliseconds remaining until `deadlineAtMs`, never negative. */
export function remainingMs(deadlineAtMs: number, nowMs: number): number {
  return Math.max(0, deadlineAtMs - nowMs);
}

/** An attempt must not start with less than `MIN_VIABLE_PROVIDER_MS` left. */
export function isBudgetViable(remaining: number, reserveMs: number = VALIDATION_RESERVE_MS): boolean {
  return remaining - reserveMs >= MIN_VIABLE_PROVIDER_MS;
}

/**
 * The per-attempt deadline: `min(provider budget, remaining − reserve)`.
 * `null` when no viable attempt can start (the caller reports `TIMEOUT / BUDGET_EXHAUSTED`).
 */
export function providerDeadlineAt(
  deadlineAtMs: number,
  nowMs: number,
  providerMs: number = DEFAULT_PROVIDER_MS,
): number | null {
  const remaining = remainingMs(deadlineAtMs, nowMs);
  const usable = remaining - VALIDATION_RESERVE_MS;
  if (usable < MIN_VIABLE_PROVIDER_MS) {
    return null;
  }
  return nowMs + Math.min(providerMs, usable);
}
