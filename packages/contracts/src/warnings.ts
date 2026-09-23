/**
 * Warning vocabulary (ARCHITECTURE.md §5.4, INTEGRATION_CONTRACT_V1.md §4.3).
 *
 * Closed code set. Warnings are additive and ignorable: a consumer that ignores every warning
 * still behaves safely. A provider never authors a warning string — the bridge does, from this
 * set.
 */
import { describe, isRecord, unknownKeys } from './guards.js';
import type { ValidationIssue, ValidationResult } from './issue.js';
import { at, createIssue, invalid, valid } from './issue.js';

export const AI_WARNING_CODES = [
  'IDEMPOTENT_REPLAY',
  'OUTPUT_REPAIRED',
  'FALLBACK_USED',
  'DEGRADED_ROUTE',
  'USAGE_ESTIMATED',
  'INPUT_REDACTED',
  'INPUT_TRUNCATED',
  'POLICY_NARROWED',
] as const;

export type AiWarningCode = (typeof AI_WARNING_CODES)[number];

export const WARNING_DETAIL_MAX_LENGTH = 512;

export type AiWarning = {
  readonly code: AiWarningCode;
  readonly detail?: string;
};

export function isAiWarningCode(value: unknown): value is AiWarningCode {
  return typeof value === 'string' && (AI_WARNING_CODES as readonly string[]).includes(value);
}

export function makeWarning(code: AiWarningCode, detail?: string): AiWarning {
  const bounded = detail === undefined ? undefined : detail.slice(0, WARNING_DETAIL_MAX_LENGTH);
  return bounded === undefined ? { code } : { code, detail: bounded };
}

export function parseAiWarning(value: unknown, path = '$'): ValidationResult<AiWarning> {
  if (!isRecord(value)) {
    return invalid('MALFORMED_ENVELOPE', [createIssue('INVALID_TYPE', path, `must be an object, got ${describe(value)}`)]);
  }
  const issues: ValidationIssue[] = [];
  for (const key of unknownKeys(value, ['code', 'detail'])) {
    issues.push(createIssue('UNKNOWN_FIELD', at(path, key), 'unknown warning field'));
  }
  if (!isAiWarningCode(value['code'])) {
    issues.push(createIssue('INVALID_VALUE', at(path, 'code'), `must be one of ${AI_WARNING_CODES.join(', ')}`));
  }
  const detail = value['detail'];
  if (detail !== undefined && typeof detail !== 'string') {
    issues.push(createIssue('INVALID_TYPE', at(path, 'detail'), `must be a string, got ${describe(detail)}`));
  }
  if (typeof detail === 'string' && detail.length > WARNING_DETAIL_MAX_LENGTH) {
    issues.push(createIssue('OUT_OF_RANGE', at(path, 'detail'), `must be at most ${WARNING_DETAIL_MAX_LENGTH} characters`));
  }
  if (issues.length > 0) {
    return invalid('MALFORMED_ENVELOPE', issues);
  }
  return valid({
    code: value['code'] as AiWarningCode,
    ...(typeof detail === 'string' ? { detail } : {}),
  });
}

export function parseAiWarnings(value: unknown, path = '$'): ValidationResult<readonly AiWarning[]> {
  if (!Array.isArray(value)) {
    return invalid('MALFORMED_ENVELOPE', [createIssue('INVALID_TYPE', path, `must be an array, got ${describe(value)}`)]);
  }
  const issues: ValidationIssue[] = [];
  const warnings: AiWarning[] = [];
  value.forEach((entry, index) => {
    const parsed = parseAiWarning(entry, at(path, index));
    if (parsed.ok) {
      warnings.push(parsed.value);
    } else {
      issues.push(...parsed.failure.issues);
    }
  });
  return issues.length > 0 ? invalid('MALFORMED_ENVELOPE', issues) : valid(warnings);
}

/** True when `warnings` contains the given code. */
export function hasWarning(warnings: readonly AiWarning[], code: AiWarningCode): boolean {
  return warnings.some((warning) => warning.code === code);
}
