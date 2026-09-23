/**
 * The generic capability **payloads** — `ContextValue`, `StructuredGenerateInput`,
 * `TextGenerateInput` (INTEGRATION_CONTRACT_V1.md §5.1, §5.5).
 *
 * These are the frozen input shapes of the two V1 generic primitives. They are parsed here with
 * the same closed-key discipline as every other wire type: an unknown field is rejected, never
 * dropped.
 *
 * The two channels (ARCHITECTURE.md §11.2) are visible in the type: `instructions` is the trusted,
 * authored instruction channel; `context[]` is the data channel, every value labelled and flagged
 * `untrusted`. A value flagged `untrusted` is rendered as delimited data and can never become an
 * instruction — structurally, not by scanning for the word "ignore".
 */
import { describe, isNonNegativeFiniteNumber, isRecord, unknownKeys } from './guards.js';
import type { ValidationIssue, ValidationResult } from './issue.js';
import { at, createIssue, invalid, valid } from './issue.js';
import { FIELD_NAME_PATTERN, isFieldType, type FieldType } from './schema.js';

/** The instruction channel is authored and versioned, so it is bounded. INTEGRATION_CONTRACT_V1.md §5.1. */
export const INSTRUCTIONS_MAX_LENGTH = 8_000;

/** A bound value on the data channel. */
export type ContextValue = {
  /** lowerCamelCase. */
  readonly name: string;
  /** Human-readable label for the prompt rendering. */
  readonly label: string;
  readonly type: FieldType;
  /** True for anything a learner typed. Rendered as delimited data, never as an instruction. */
  readonly untrusted: boolean;
  /** Already serialized as text by the caller. */
  readonly value: string;
  /** Hard bound in characters. */
  readonly maxLength?: number;
};

export type ContextBundle = readonly ContextValue[];

export type StructuredGenerateInput = {
  readonly instructions: string;
  readonly context: ContextBundle;
};

export type TextGenerateInput = {
  readonly instructions: string;
  readonly context: ContextBundle;
  readonly maxOutputTokens?: number;
};

export const CONTEXT_VALUE_KEYS = ['name', 'label', 'type', 'untrusted', 'value', 'maxLength'] as const;
export const STRUCTURED_GENERATE_INPUT_KEYS = ['instructions', 'context'] as const;
export const TEXT_GENERATE_INPUT_KEYS = ['instructions', 'context', 'maxOutputTokens'] as const;

export function parseContextValue(value: unknown, path = '$'): ValidationResult<ContextValue> {
  if (!isRecord(value)) {
    return invalid('MALFORMED_ENVELOPE', [createIssue('INVALID_TYPE', path, `must be an object, got ${describe(value)}`)]);
  }
  const issues: ValidationIssue[] = [];
  for (const key of unknownKeys(value, CONTEXT_VALUE_KEYS)) {
    issues.push(createIssue('UNKNOWN_FIELD', at(path, key), 'unknown context value field'));
  }
  const name = value['name'];
  if (typeof name !== 'string' || !FIELD_NAME_PATTERN.test(name)) {
    issues.push(createIssue('PATTERN_MISMATCH', at(path, 'name'), 'must match ^[a-z][a-zA-Z0-9]*$'));
  }
  const label = value['label'];
  if (typeof label !== 'string' || label.length === 0) {
    issues.push(createIssue('INVALID_TYPE', at(path, 'label'), 'must be a non-empty string'));
  }
  if (!isFieldType(value['type'])) {
    issues.push(createIssue('INVALID_VALUE', at(path, 'type'), 'must be a known context value type'));
  }
  if (typeof value['untrusted'] !== 'boolean') {
    issues.push(createIssue('INVALID_TYPE', at(path, 'untrusted'), 'must be a boolean'));
  }
  const contextValue = value['value'];
  if (typeof contextValue !== 'string') {
    issues.push(createIssue('INVALID_TYPE', at(path, 'value'), 'must be a string, serialized by the caller'));
  }
  const maxLength = value['maxLength'];
  if (maxLength !== undefined && (!Number.isInteger(maxLength) || !isNonNegativeFiniteNumber(maxLength) || maxLength < 1)) {
    issues.push(createIssue('INVALID_TYPE', at(path, 'maxLength'), 'must be a positive integer'));
  }
  if (issues.length > 0) {
    return invalid('MALFORMED_ENVELOPE', issues);
  }
  return valid({
    name: name as string,
    label: label as string,
    type: value['type'] as FieldType,
    untrusted: value['untrusted'] as boolean,
    value: contextValue as string,
    ...(typeof maxLength === 'number' ? { maxLength } : {}),
  });
}

export function parseContextBundle(value: unknown, path = '$'): ValidationResult<ContextBundle> {
  if (!Array.isArray(value)) {
    return invalid('MALFORMED_ENVELOPE', [createIssue('INVALID_TYPE', path, `must be an array, got ${describe(value)}`)]);
  }
  const issues: ValidationIssue[] = [];
  const bundle: ContextValue[] = [];
  const seen = new Set<string>();
  value.forEach((entry, index) => {
    const parsed = parseContextValue(entry, at(path, index));
    if (!parsed.ok) {
      issues.push(...parsed.failure.issues);
      return;
    }
    if (seen.has(parsed.value.name)) {
      issues.push(createIssue('DUPLICATE_FIELD', at(at(path, index), 'name'), `duplicate context name "${parsed.value.name}"`));
      return;
    }
    seen.add(parsed.value.name);
    bundle.push(parsed.value);
  });
  return issues.length > 0 ? invalid('MALFORMED_ENVELOPE', issues) : valid(bundle);
}

function parseInstructions(value: unknown, path: string, issues: ValidationIssue[]): string | null {
  const instructions = value;
  if (typeof instructions !== 'string' || instructions.length === 0) {
    issues.push(createIssue('INVALID_TYPE', path, 'must be a non-empty string'));
    return null;
  }
  if (instructions.length > INSTRUCTIONS_MAX_LENGTH) {
    issues.push(
      createIssue('OUT_OF_RANGE', path, `must be at most ${INSTRUCTIONS_MAX_LENGTH} characters`),
    );
    return null;
  }
  return instructions;
}

/** Parse `ai.structured.generate`'s payload. */
export function parseStructuredGenerateInput(value: unknown, path = '$'): ValidationResult<StructuredGenerateInput> {
  if (!isRecord(value)) {
    return invalid('MALFORMED_ENVELOPE', [createIssue('INVALID_TYPE', path, `must be an object, got ${describe(value)}`)]);
  }
  const issues: ValidationIssue[] = [];
  for (const key of unknownKeys(value, STRUCTURED_GENERATE_INPUT_KEYS)) {
    issues.push(createIssue('UNKNOWN_FIELD', at(path, key), 'unknown structured-generate input field'));
  }
  const instructions = parseInstructions(value['instructions'], at(path, 'instructions'), issues);
  const context = parseContextBundle(value['context'], at(path, 'context'));
  if (!context.ok) {
    issues.push(...context.failure.issues);
  }
  if (issues.length > 0) {
    return invalid('MALFORMED_ENVELOPE', issues);
  }
  return valid({ instructions: instructions as string, context: context.ok ? context.value : [] });
}

/** Parse `ai.text.generate`'s payload. */
export function parseTextGenerateInput(value: unknown, path = '$'): ValidationResult<TextGenerateInput> {
  if (!isRecord(value)) {
    return invalid('MALFORMED_ENVELOPE', [createIssue('INVALID_TYPE', path, `must be an object, got ${describe(value)}`)]);
  }
  const issues: ValidationIssue[] = [];
  for (const key of unknownKeys(value, TEXT_GENERATE_INPUT_KEYS)) {
    issues.push(createIssue('UNKNOWN_FIELD', at(path, key), 'unknown text-generate input field'));
  }
  const instructions = parseInstructions(value['instructions'], at(path, 'instructions'), issues);
  const context = parseContextBundle(value['context'], at(path, 'context'));
  if (!context.ok) {
    issues.push(...context.failure.issues);
  }
  const maxOutputTokens = value['maxOutputTokens'];
  if (maxOutputTokens !== undefined && (!Number.isInteger(maxOutputTokens) || !isNonNegativeFiniteNumber(maxOutputTokens) || maxOutputTokens < 1)) {
    issues.push(createIssue('INVALID_TYPE', at(path, 'maxOutputTokens'), 'must be a positive integer'));
  }
  if (issues.length > 0) {
    return invalid('MALFORMED_ENVELOPE', issues);
  }
  return valid({
    instructions: instructions as string,
    context: context.ok ? context.value : [],
    ...(typeof maxOutputTokens === 'number' ? { maxOutputTokens } : {}),
  });
}
