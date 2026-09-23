/**
 * Output shaping — the structural half of response normalization (ARCHITECTURE.md §11.4).
 *
 * Shared by the execution coordinator (non-streaming) and the stream path, so both enforce exactly
 * the same size cap and the same extraction/validation rules. A model's answer is candidate text
 * until it has passed these checks; it is never trusted because it looked like JSON.
 *
 * A structured failure also reports the **issue list** (paths and codes only — never the offending
 * values), the raw candidate (for a bounded repair dispatch — it goes back to the provider and
 * nowhere else) and whether the failure is *repairable*: repair exists for "the model answered but
 * the payload did not conform", not for a size breach or a missing schema (Phase 37).
 */
import {
  extractStructuredCandidate,
  validateStructuredOutput,
  type AiError,
  type OutputSchema,
  type ValidationIssue,
} from '@aibridge/contracts';
import { guardStructuredOutput, utf8ByteLength } from '@aibridge/core';
import { validationFailureToAiError } from './errors.js';

export type ShapedOutput =
  | { readonly ok: true; readonly value: unknown }
  | {
      readonly ok: false;
      readonly error: AiError;
      /** Feedback for a bounded repair attempt: rooted paths and issue codes, never values. */
      readonly issues: readonly ValidationIssue[];
      /** The candidate that failed. Provider-bound on a repair dispatch; never logged, never stored. */
      readonly rawText: string;
      readonly repairable: boolean;
    };

export type ValueOutcome = ShapedOutput;

/** Text answer with the declared output size cap enforced. */
export function textOutputOutcome(text: string, maxOutputBytes: number): ShapedOutput {
  const bytes = utf8ByteLength(text);
  if (bytes > maxOutputBytes) {
    return {
      ok: false,
      repairable: false,
      rawText: text,
      issues: [{ code: 'SIZE_EXCEEDED', path: '$.text', message: 'output exceeded the cap' }],
      error: validationFailureToAiError(
        {
          reason: 'OUTPUT_TOO_LARGE',
          code: 'SCHEMA_MISMATCH',
          stage: 'EXTRACTION',
          issues: [{ code: 'SIZE_EXCEEDED', path: '$.text', message: 'output exceeded the cap' }],
        },
        'The generated answer exceeds the declared output size cap.',
      ),
    };
  }
  return { ok: true, value: { text, finishReason: 'STOP' } };
}

/**
 * Extract and validate a structured answer against the caller-owned inline schema.
 *
 * Extraction failure (`EXTRACTION_FAILED` / `JSON_PARSE_FAILED`) and schema failure
 * (`SCHEMA_VALIDATION_FAILED`) are **repairable**: the model produced content that did not conform.
 * A missing schema and a size breach are not (Phase 37).
 */
export function structuredOutputOutcome(
  text: string,
  schema: OutputSchema | undefined,
  maxOutputBytes: number,
): ShapedOutput {
  if (schema === undefined || schema.kind !== 'INLINE') {
    const issues: readonly ValidationIssue[] = [{ code: 'MISSING_FIELD', path: '$.outputSchema', message: 'no inline schema resolved' }];
    return {
      ok: false,
      repairable: false,
      rawText: text,
      issues,
      error: validationFailureToAiError(
        {
          reason: 'OUTPUT_SCHEMA_UNSUPPORTED',
          code: 'INVALID_REQUEST',
          stage: 'ENVELOPE',
          issues: [...issues],
        },
        'The structured output schema could not be resolved.',
      ),
    };
  }
  const extracted = extractStructuredCandidate(text);
  if (!extracted.ok) {
    return {
      ok: false,
      repairable: true,
      rawText: text,
      issues: extracted.failure.issues,
      error: validationFailureToAiError(extracted.failure, 'The provider payload could not be read as structured output.'),
    };
  }
  const guarded = guardStructuredOutput(extracted.value.parsed, schema.fields, { maxBytes: maxOutputBytes });
  if (guarded.ok) {
    return { ok: true, value: guarded.output };
  }
  const revalidated = validateStructuredOutput(extracted.value.parsed, schema.fields, { maxBytes: maxOutputBytes }, '$');
  return {
    ok: false,
    repairable: guarded.error.reason === 'SCHEMA_VALIDATION_FAILED',
    rawText: text,
    issues: revalidated.ok ? [] : revalidated.failure.issues,
    error: guarded.error,
  };
}

/** The repair-exhaustion error (contract §5.3): `VALIDATION / OUTPUT_REPAIR_EXHAUSTED`. */
export function repairExhaustedError(issues: readonly ValidationIssue[]): AiError {
  return validationFailureToAiError(
    {
      reason: 'OUTPUT_REPAIR_EXHAUSTED',
      code: 'SCHEMA_MISMATCH',
      stage: 'VALIDATION',
      issues: [...issues],
    },
    'The generated answer did not conform to the declared output schema.',
  );
}
