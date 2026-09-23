/**
 * Validation issues and results.
 *
 * Every parser in `@aibridge/contracts` returns a `ValidationResult`: either a value, or a
 * `ValidationFailure` carrying a closed issue list with **rooted paths** (`$.field[3].name`) and
 * the public error mapping. No parser ever throws for bad input, and none returns a bare boolean.
 *
 * A `reject` fixture asserts a `reason`; every parser failure therefore names one.
 */
import type { AiErrorCode, AiErrorReason, AiErrorStage } from './errors.js';
import { REASON_META } from './errors.js';

/** The closed set of machine-readable validation issue codes. */
export const VALIDATION_ISSUE_CODES = [
  'UNKNOWN_FIELD',
  'MISSING_FIELD',
  'FORBIDDEN_FIELD',
  'TRUSTED_FIELD',
  'INVALID_TYPE',
  'INVALID_VALUE',
  'OUT_OF_RANGE',
  'PATTERN_MISMATCH',
  'DUPLICATE_FIELD',
  'UNSUPPORTED_VERSION',
  'SCHEMA_VIOLATION',
  'SIZE_EXCEEDED',
  'DEPTH_EXCEEDED',
  'SECRET_LIKE',
  'EXTRACTION_FAILED',
  'JSON_PARSE_FAILED',
  'INVARIANT_VIOLATION',
  'PERMISSION_DENIED',
  'MISSING_SUBJECT',
  'UNKNOWN_CAPABILITY',
  'DUPLICATE_REGISTRATION',
  'CONFLICTING_REGISTRATION',
] as const;

export type ValidationIssueCode = (typeof VALIDATION_ISSUE_CODES)[number];

/** One machine-readable issue. `path` is rooted at `$`. */
export type ValidationIssue = {
  readonly code: ValidationIssueCode;
  readonly path: string;
  readonly message: string;
};

/** The public-error mapping a parser failure produces. */
export type ValidationFailure = {
  readonly reason: AiErrorReason;
  readonly code: AiErrorCode;
  readonly stage: AiErrorStage;
  readonly issues: readonly ValidationIssue[];
};

export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: ValidationFailure };

/** The root of every issue path. */
export const ROOT_PATH = '$';

/** Extend an issue path: `at('$', 'a')` → `$.a`, `at('$', 1)` → `$[1]`. */
export function at(path: string, key: string | number): string {
  return typeof key === 'number' ? `${path}[${key}]` : `${path}.${key}`;
}

export function createIssue(code: ValidationIssueCode, path: string, message: string): ValidationIssue {
  return { code, path, message };
}

export function valid<T>(value: T): ValidationResult<T> {
  return { ok: true, value };
}

export type FailureOverrides = {
  readonly code?: AiErrorCode;
  readonly stage?: AiErrorStage;
};

/** Build a failed result. `code` and `stage` default from the reason's canonical meta. */
export function invalid(reason: AiErrorReason, issues: readonly ValidationIssue[], overrides: FailureOverrides = {}): ValidationResult<never> {
  const meta = REASON_META[reason];
  return {
    ok: false,
    failure: {
      reason,
      code: overrides.code ?? meta.code,
      stage: overrides.stage ?? meta.stage,
      issues,
    },
  };
}

/** A single-issue failure. Convenience for the common case. */
export function fail(
  reason: AiErrorReason,
  code: ValidationIssueCode,
  path: string,
  message: string,
): ValidationResult<never> {
  return invalid(reason, [createIssue(code, path, message)]);
}
