/**
 * Request metadata (ARCHITECTURE.md §4.2, SECURITY.md §3.4).
 *
 * A **closed allow-list** of exactly four keys. An unknown key is rejected
 * (`METADATA_NOT_ALLOWED`), never silently dropped: deny-by-default is testable, silent dropping
 * is not. The serialized form is capped at `METADATA_MAX_BYTES`.
 */
import { describe, isRecord, unknownKeys, utf8ByteLength } from './guards.js';
import type { ValidationIssue, ValidationResult } from './issue.js';
import { at, createIssue, invalid, valid } from './issue.js';

/** The four allowed keys. Nothing else may appear. */
export const REQUEST_METADATA_KEYS = ['locale', 'traceId', 'surface', 'correlationId'] as const;

export type RequestMetadataKey = (typeof REQUEST_METADATA_KEYS)[number];

export const METADATA_MAX_BYTES = 512;

/** BCP-47 in its common form: `zh-CN`, `en`, `pt-BR`. */
export const LOCALE_PATTERN = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

/** Opaque correlation identifiers. */
export const CORRELATION_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/** A UI surface name, e.g. `idea-lab`. */
export const SURFACE_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

export type RequestMetadata = {
  readonly locale?: string;
  readonly traceId?: string;
  readonly surface?: string;
  readonly correlationId?: string;
};

const PATTERNS: Readonly<Record<RequestMetadataKey, RegExp>> = {
  locale: LOCALE_PATTERN,
  traceId: CORRELATION_PATTERN,
  surface: SURFACE_PATTERN,
  correlationId: CORRELATION_PATTERN,
};

/**
 * Parse request metadata.
 *
 * Size is checked before value shape, because "this blob is too big" is more actionable than
 * "field five is a number".
 */
export function parseRequestMetadata(value: unknown, path = '$'): ValidationResult<RequestMetadata> {
  if (!isRecord(value)) {
    return invalid('MALFORMED_ENVELOPE', [createIssue('INVALID_TYPE', path, `must be an object, got ${describe(value)}`)]);
  }
  const size = utf8ByteLength(JSON.stringify(value));
  if (size > METADATA_MAX_BYTES) {
    return invalid('METADATA_NOT_ALLOWED', [
      createIssue('SIZE_EXCEEDED', path, `serialized metadata is ${size} bytes; the limit is ${METADATA_MAX_BYTES}`),
    ]);
  }
  const issues: ValidationIssue[] = [];
  for (const key of unknownKeys(value, REQUEST_METADATA_KEYS)) {
    issues.push(createIssue('UNKNOWN_FIELD', at(path, key), 'unknown metadata key; the allow-list is closed'));
  }
  for (const key of REQUEST_METADATA_KEYS) {
    const entry = value[key];
    if (entry === undefined) {
      continue;
    }
    if (typeof entry !== 'string') {
      issues.push(createIssue('INVALID_TYPE', at(path, key), `must be a string, got ${describe(entry)}`));
      continue;
    }
    const pattern = PATTERNS[key];
    if (!pattern.test(entry)) {
      issues.push(createIssue('PATTERN_MISMATCH', at(path, key), 'does not match the allowed pattern'));
    }
  }
  if (issues.length > 0) {
    return invalid('METADATA_NOT_ALLOWED', issues);
  }
  return valid({
    ...(typeof value['locale'] === 'string' ? { locale: value['locale'] } : {}),
    ...(typeof value['traceId'] === 'string' ? { traceId: value['traceId'] } : {}),
    ...(typeof value['surface'] === 'string' ? { surface: value['surface'] } : {}),
    ...(typeof value['correlationId'] === 'string' ? { correlationId: value['correlationId'] } : {}),
  });
}
