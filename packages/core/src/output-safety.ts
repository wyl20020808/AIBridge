/**
 * Structural output safety (SECURITY.md §7.1, ARCHITECTURE.md §11.4).
 *
 * AI Bridge owns **structural** safety: schema conformance, size caps, malformed-output handling,
 * and the no-partial-results rule. It owns **no** business rule — "never give a child the complete
 * answer" belongs to a capability policy and the consumer's guard, not to the generic bridge.
 *
 * The wrapper exists so a caller gets an `AiError` (not a `ValidationResult`) and so a partially
 * valid payload can never be mistaken for a usable one: there is no "return what we managed to
 * read" branch.
 */
import {
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_MAX_OUTPUT_DEPTH,
  makeAiError,
  validateStructuredOutput,
  type AiError,
  type FieldSpec,
} from '@aibridge/contracts';
import { jsonByteLength } from './util.js';

export type OutputGuardOptions = {
  readonly maxBytes?: number;
  readonly maxDepth?: number;
  readonly path?: string;
};

export type OutputGuardSuccess = {
  readonly ok: true;
  readonly output: Record<string, unknown>;
};

export type OutputGuardFailure = {
  readonly ok: false;
  readonly error: AiError;
};

export type OutputGuardResult = OutputGuardSuccess | OutputGuardFailure;

/**
 * Validate a candidate against a declared field table.
 *
 * On failure the candidate is discarded entirely and exactly one `AiError` is produced:
 * `OUTPUT_TOO_LARGE` for a size breach, otherwise `VALIDATION / SCHEMA_VALIDATION_FAILED` with a
 * bounded issue summary (never the offending values).
 */
export function guardStructuredOutput(
  value: unknown,
  fields: readonly FieldSpec[],
  options: OutputGuardOptions = {},
): OutputGuardResult {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_OUTPUT_DEPTH;
  const path = options.path ?? '$';

  const result = validateStructuredOutput(value, fields, { maxBytes, maxDepth }, path);
  if (result.ok) {
    return { ok: true, output: result.value };
  }

  if (result.failure.reason === 'OUTPUT_TOO_LARGE') {
    const bytes = jsonByteLength(value);
    return {
      ok: false,
      error: makeAiError({
        reason: 'OUTPUT_TOO_LARGE',
        message: 'The candidate exceeds the declared output size cap.',
        details: { maxOutputBytes: maxBytes, actualBytes: bytes ?? maxBytes + 1 },
      }),
    };
  }

  const issues = result.failure.issues;
  const first = issues[0];
  return {
    ok: false,
    error: makeAiError({
      reason: 'SCHEMA_VALIDATION_FAILED',
      message: 'The candidate does not conform to the declared output schema.',
      details: {
        issueCount: issues.length,
        ...(first === undefined ? {} : { firstPath: first.path, firstIssueCode: first.code }),
      },
    }),
  };
}

/** True when the candidate would validate. Convenience for tests and policy checks. */
export function isStructurallySafe(
  value: unknown,
  fields: readonly FieldSpec[],
  options: OutputGuardOptions = {},
): boolean {
  return guardStructuredOutput(value, fields, options).ok;
}
