/**
 * The strict structured-output validator (ARCHITECTURE.md §11.4, INTEGRATION_CONTRACT_V1.md §5.2).
 *
 * Rules, all of which are mechanically tested:
 *  - unknown fields are **rejected**;
 *  - required fields are **strict**;
 *  - types are **never coerced** — `"3"` is not a `NUMBER`;
 *  - only finite numbers pass; integers stay integers (nothing is rounded into shape);
 *  - `maxLength` is enforced per `STRING`;
 *  - the serialized payload is size-bounded and depth-bounded;
 *  - binary / opaque data (control characters, non-JSON types) is rejected.
 *
 * There is no "return what we managed to read". A partially correct answer is a failure, not a
 * partial value: a plausible-looking wrong answer is the single worst outcome this system can
 * produce.
 */
import { describe, isRecord, utf8ByteLength } from '../guards.js';
import type { ValidationIssue, ValidationResult } from '../issue.js';
import { at, createIssue, invalid, valid } from '../issue.js';
import type { FieldSpec } from '../schema.js';

export const DEFAULT_MAX_OUTPUT_BYTES = 65_536;
export const DEFAULT_MAX_OUTPUT_DEPTH = 6;

export type StructuredValidationOptions = {
  /** Hard cap on the serialized payload size, in UTF-8 bytes. */
  readonly maxBytes?: number;
  /** Hard cap on value nesting depth. */
  readonly maxDepth?: number;
};

/** Count Unicode scalar values, so an emoji counts as one character. */
function characterCount(value: string): number {
  let count = 0;
  for (const _ of value) {
    count += 1;
  }
  return count;
}

// eslint-disable-next-line no-control-regex -- detecting control characters is the whole point here
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

/**
 * Walk a value looking for things JSON cannot carry or a bridge must not relay.
 * Pure and iterative-safe up to `maxDepth`.
 */
function collectStructuralIssues(value: unknown, path: string, maxDepth: number, issues: ValidationIssue[]): void {
  const stack: Array<{ readonly value: unknown; readonly path: string; readonly depth: number }> = [
    { value, path, depth: 0 },
  ];
  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) {
      break;
    }
    const { value: current, path: currentPath, depth } = frame;
    if (depth > maxDepth) {
      issues.push(createIssue('DEPTH_EXCEEDED', currentPath, `nesting exceeds the maximum depth of ${maxDepth}`));
      continue;
    }
    if (current === null || typeof current === 'boolean') {
      continue;
    }
    if (typeof current === 'string') {
      if (CONTROL_CHARS.test(current)) {
        issues.push(createIssue('INVALID_VALUE', currentPath, 'contains disallowed control characters (opaque/binary data)'));
      }
      continue;
    }
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) {
        issues.push(createIssue('INVALID_VALUE', currentPath, 'must be a finite number'));
      }
      continue;
    }
    if (Array.isArray(current)) {
      current.forEach((entry, index) => {
        stack.push({ value: entry, path: at(currentPath, index), depth: depth + 1 });
      });
      continue;
    }
    if (isRecord(current)) {
      for (const key of Object.keys(current)) {
        stack.push({ value: current[key], path: at(currentPath, key), depth: depth + 1 });
      }
      continue;
    }
    issues.push(
      createIssue('INVALID_TYPE', currentPath, `must be JSON data; got ${describe(current)}`),
    );
  }
}

function checkFieldType(field: FieldSpec, value: unknown, path: string, issues: ValidationIssue[]): void {
  switch (field.type) {
    case 'STRING': {
      if (typeof value !== 'string') {
        issues.push(createIssue('INVALID_TYPE', path, `must be a string, got ${describe(value)}`));
        return;
      }
      if (field.maxLength !== undefined && characterCount(value) > field.maxLength) {
        issues.push(
          createIssue('OUT_OF_RANGE', path, `must be at most ${field.maxLength} characters`),
        );
      }
      return;
    }
    case 'NUMBER': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        issues.push(createIssue('INVALID_TYPE', path, `must be a finite number, got ${describe(value)}`));
      }
      return;
    }
    case 'BOOLEAN': {
      if (typeof value !== 'boolean') {
        issues.push(createIssue('INVALID_TYPE', path, `must be a boolean, got ${describe(value)}`));
      }
      return;
    }
    case 'STRING_ARRAY': {
      if (!Array.isArray(value)) {
        issues.push(createIssue('INVALID_TYPE', path, `must be an array of strings, got ${describe(value)}`));
        return;
      }
      value.forEach((entry, index) => {
        if (typeof entry !== 'string') {
          issues.push(createIssue('INVALID_TYPE', at(path, index), `must be a string, got ${describe(entry)}`));
        }
      });
      return;
    }
    case 'OBJECT': {
      if (!isRecord(value)) {
        issues.push(createIssue('INVALID_TYPE', path, `must be an object, got ${describe(value)}`));
      }
      return;
    }
    case 'OBJECT_ARRAY': {
      if (!Array.isArray(value)) {
        issues.push(createIssue('INVALID_TYPE', path, `must be an array of objects, got ${describe(value)}`));
        return;
      }
      value.forEach((entry, index) => {
        if (!isRecord(entry)) {
          issues.push(createIssue('INVALID_TYPE', at(path, index), `must be an object, got ${describe(entry)}`));
        }
      });
      return;
    }
    default: {
      const exhaustive: never = field.type;
      void exhaustive;
      return;
    }
  }
}

/**
 * Validate a candidate against a field table.
 *
 * Returns the validated record on success, or a rooted issue list. `code` is always
 * `SCHEMA_MISMATCH` / `SCHEMA_VALIDATION_FAILED`.
 */
export function validateStructuredOutput(
  value: unknown,
  fields: readonly FieldSpec[],
  options: StructuredValidationOptions = {},
  path = '$',
): ValidationResult<Record<string, unknown>> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_OUTPUT_DEPTH;
  const issues: ValidationIssue[] = [];

  const serialized = safeStringify(value);
  if (serialized === null) {
    return invalid('SCHEMA_VALIDATION_FAILED', [
      createIssue('INVALID_VALUE', path, 'is not serializable as JSON'),
    ]);
  }
  if (utf8ByteLength(serialized) > maxBytes) {
    return invalid('OUTPUT_TOO_LARGE', [
      createIssue('SIZE_EXCEEDED', path, `serialized output exceeds the ${maxBytes}-byte cap`),
    ]);
  }
  collectStructuralIssues(value, path, maxDepth, issues);

  if (!isRecord(value)) {
    issues.push(createIssue('INVALID_TYPE', path, `must be a JSON object, got ${describe(value)}`));
    return invalid('SCHEMA_VALIDATION_FAILED', issues);
  }

  const declared = new Map(fields.map((field) => [field.name, field]));
  for (const key of Object.keys(value).sort()) {
    if (!declared.has(key)) {
      issues.push(createIssue('UNKNOWN_FIELD', at(path, key), 'is not declared by the output schema'));
    }
  }
  for (const field of fields) {
    const present = Object.prototype.hasOwnProperty.call(value, field.name);
    const fieldPath = at(path, field.name);
    if (!present) {
      if (field.required) {
        issues.push(createIssue('MISSING_FIELD', fieldPath, 'is required and was not present'));
      }
      continue;
    }
    if (field.required && value[field.name] === undefined) {
      issues.push(createIssue('MISSING_FIELD', fieldPath, 'is required and must not be undefined'));
      continue;
    }
    checkFieldType(field, value[field.name], fieldPath, issues);
  }

  if (issues.length > 0) {
    return invalid('SCHEMA_VALIDATION_FAILED', issues);
  }
  return valid(value);
}

function safeStringify(value: unknown): string | null {
  try {
    const result: unknown = JSON.stringify(value);
    return typeof result === 'string' ? result : null;
  } catch {
    return null;
  }
}

/** True when the candidate would validate. Convenience for tests and policy checks. */
export function isValidStructuredOutput(
  value: unknown,
  fields: readonly FieldSpec[],
  options: StructuredValidationOptions = {},
): boolean {
  return validateStructuredOutput(value, fields, options).ok;
}
