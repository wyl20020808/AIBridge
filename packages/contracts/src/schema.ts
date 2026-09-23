/**
 * The structured output schema — `aibridge.fields/v1` (ARCHITECTURE.md §4.3, §11).
 *
 * A small **field table**, not a free-form JSON schema document: "which variables may a prompt
 * mention" has exactly one answer, and candidate validation is deterministic and
 * dependency-free.
 *
 * The field table is deliberately shaped like AlgoQuest's `AiFieldSpec` (same keys, same types,
 * same lowerCamelCase name rule) so a future adapter is a zero-translation mapping. Aligned by
 * specification, never by import.
 *
 * `integer` and `enum` are **not** part of `aibridge.fields/v1`: the dialect is frozen, and a
 * consumer (AlgoQuest) already parses the six types below. They are recorded as a proposed
 * `aibridge.fields/v2` extension in the compatibility note, not added here.
 */
import { describe, isRecord, unknownKeys, isPositiveInteger } from './guards.js';
import type { ValidationIssue, ValidationResult } from './issue.js';
import { at, createIssue, invalid, valid } from './issue.js';
import { AIBRIDGE_FIELD_DIALECT, STRUCTURED_OUTPUT_SCHEMA_MAJOR, parseMajor } from './versions.js';

/** The six frozen field types. */
export const FIELD_TYPES = ['STRING', 'NUMBER', 'BOOLEAN', 'STRING_ARRAY', 'OBJECT', 'OBJECT_ARRAY'] as const;

export type FieldType = (typeof FIELD_TYPES)[number];

export function isFieldType(value: unknown): value is FieldType {
  return typeof value === 'string' && (FIELD_TYPES as readonly string[]).includes(value);
}

/** lowerCamelCase. */
export const FIELD_NAME_PATTERN = /^[a-z][a-zA-Z0-9]*$/;

export type FieldSpec = {
  readonly name: string;
  readonly type: FieldType;
  readonly required: boolean;
  /** Rendered into the output-format instruction only. Never a data channel. */
  readonly description: string;
  readonly untrusted?: boolean;
  /** Hard bound in characters for a `STRING` field. */
  readonly maxLength?: number;
};

export type OutputSchemaRef = {
  readonly schemaId: string;
  readonly version: string;
};

export type OutputSchema =
  | { readonly kind: 'REF'; readonly ref: OutputSchemaRef }
  | {
      readonly kind: 'INLINE';
      readonly schemaId: string;
      readonly version: string;
      readonly dialect: typeof AIBRIDGE_FIELD_DIALECT;
      readonly fields: readonly FieldSpec[];
    };

export const OUTPUT_SCHEMA_KINDS = ['REF', 'INLINE'] as const;

export type OutputSchemaKind = (typeof OUTPUT_SCHEMA_KINDS)[number];

const FIELD_SPEC_KEYS = ['name', 'type', 'required', 'description', 'untrusted', 'maxLength'] as const;
const REF_KEYS = ['schemaId', 'version'] as const;

export function parseFieldSpec(value: unknown, path = '$'): ValidationResult<FieldSpec> {
  if (!isRecord(value)) {
    return invalid('OUTPUT_SCHEMA_UNSUPPORTED', [createIssue('INVALID_TYPE', path, `must be an object, got ${describe(value)}`)]);
  }
  const issues: ValidationIssue[] = [];
  for (const key of unknownKeys(value, FIELD_SPEC_KEYS)) {
    issues.push(createIssue('UNKNOWN_FIELD', at(path, key), 'unknown field-spec key'));
  }
  const name = value['name'];
  if (typeof name !== 'string' || !FIELD_NAME_PATTERN.test(name)) {
    issues.push(createIssue('PATTERN_MISMATCH', at(path, 'name'), 'must match ^[a-z][a-zA-Z0-9]*$'));
  }
  if (!isFieldType(value['type'])) {
    issues.push(createIssue('INVALID_VALUE', at(path, 'type'), `must be one of ${FIELD_TYPES.join(', ')}`));
  }
  if (typeof value['required'] !== 'boolean') {
    issues.push(createIssue('INVALID_TYPE', at(path, 'required'), 'must be a boolean'));
  }
  if (typeof value['description'] !== 'string' || value['description'].length === 0) {
    issues.push(createIssue('INVALID_TYPE', at(path, 'description'), 'must be a non-empty string'));
  }
  const untrusted = value['untrusted'];
  if (untrusted !== undefined && typeof untrusted !== 'boolean') {
    issues.push(createIssue('INVALID_TYPE', at(path, 'untrusted'), 'must be a boolean'));
  }
  const maxLength = value['maxLength'];
  if (maxLength !== undefined && !isPositiveInteger(maxLength)) {
    issues.push(createIssue('INVALID_TYPE', at(path, 'maxLength'), 'must be a positive integer'));
  }
  if (issues.length > 0) {
    return invalid('OUTPUT_SCHEMA_UNSUPPORTED', issues);
  }
  return valid({
    name: name as string,
    type: value['type'] as FieldType,
    required: value['required'] as boolean,
    description: value['description'] as string,
    ...(typeof untrusted === 'boolean' ? { untrusted } : {}),
    ...(typeof maxLength === 'number' ? { maxLength } : {}),
  });
}

export function parseFieldSpecs(value: unknown, path = '$'): ValidationResult<readonly FieldSpec[]> {
  if (!Array.isArray(value)) {
    return invalid('OUTPUT_SCHEMA_UNSUPPORTED', [createIssue('INVALID_TYPE', path, `must be an array, got ${describe(value)}`)]);
  }
  const issues: ValidationIssue[] = [];
  const fields: FieldSpec[] = [];
  const seen = new Set<string>();
  value.forEach((entry, index) => {
    const parsed = parseFieldSpec(entry, at(path, index));
    if (!parsed.ok) {
      issues.push(...parsed.failure.issues);
      return;
    }
    if (seen.has(parsed.value.name)) {
      issues.push(createIssue('DUPLICATE_FIELD', at(path, index), `duplicate field name "${parsed.value.name}"`));
      return;
    }
    seen.add(parsed.value.name);
    fields.push(parsed.value);
  });
  if (fields.length === 0) {
    issues.push(createIssue('MISSING_FIELD', path, 'must declare at least one field'));
  }
  return issues.length > 0 ? invalid('OUTPUT_SCHEMA_UNSUPPORTED', issues) : valid(fields);
}

/** Parse a `REF` output schema. */
export function parseOutputSchemaRef(value: unknown, path = '$'): ValidationResult<OutputSchemaRef> {
  if (!isRecord(value)) {
    return invalid('OUTPUT_SCHEMA_UNSUPPORTED', [createIssue('INVALID_TYPE', path, `must be an object, got ${describe(value)}`)]);
  }
  const issues: ValidationIssue[] = [];
  for (const key of unknownKeys(value, REF_KEYS)) {
    issues.push(createIssue('UNKNOWN_FIELD', at(path, key), 'unknown schema ref key'));
  }
  for (const key of REF_KEYS) {
    if (typeof value[key] !== 'string' || (value[key] as string).length === 0) {
      issues.push(createIssue('INVALID_TYPE', at(path, key), 'must be a non-empty string'));
    }
  }
  if (issues.length > 0) {
    return invalid('OUTPUT_SCHEMA_UNSUPPORTED', issues);
  }
  return valid({ schemaId: value['schemaId'] as string, version: value['version'] as string });
}

/**
 * Parse an output schema.
 *
 * An unknown `dialect` or a non-major-compatible `version` is `OUTPUT_SCHEMA_UNSUPPORTED` — never
 * best-effort parsed.
 */
export function parseOutputSchema(value: unknown, path = '$'): ValidationResult<OutputSchema> {
  if (!isRecord(value)) {
    return invalid('OUTPUT_SCHEMA_UNSUPPORTED', [createIssue('INVALID_TYPE', path, `must be an object, got ${describe(value)}`)]);
  }
  const kind = value['kind'];
  if (kind === 'REF') {
    const issues: ValidationIssue[] = [];
    for (const key of unknownKeys(value, ['kind', 'ref'])) {
      issues.push(createIssue('UNKNOWN_FIELD', at(path, key), 'unknown output-schema key'));
    }
    const ref = parseOutputSchemaRef(value['ref'], at(path, 'ref'));
    if (!ref.ok) {
      issues.push(...ref.failure.issues);
    }
    if (issues.length > 0 || !ref.ok) {
      return invalid('OUTPUT_SCHEMA_UNSUPPORTED', issues);
    }
    return valid({ kind: 'REF', ref: ref.value });
  }
  if (kind === 'INLINE') {
    const issues: ValidationIssue[] = [];
    for (const key of unknownKeys(value, ['kind', 'schemaId', 'version', 'dialect', 'fields'])) {
      issues.push(createIssue('UNKNOWN_FIELD', at(path, key), 'unknown output-schema key'));
    }
    for (const key of ['schemaId', 'version'] as const) {
      if (typeof value[key] !== 'string' || (value[key] as string).length === 0) {
        issues.push(createIssue('INVALID_TYPE', at(path, key), 'must be a non-empty string'));
      }
    }
    const dialect = value['dialect'];
    if (dialect !== AIBRIDGE_FIELD_DIALECT) {
      issues.push(createIssue('INVALID_VALUE', at(path, 'dialect'), `must be "${AIBRIDGE_FIELD_DIALECT}"`));
    }
    const version = value['version'];
    if (typeof version === 'string') {
      const schemaMajor = parseMajor(version);
      if (schemaMajor !== null && schemaMajor !== STRUCTURED_OUTPUT_SCHEMA_MAJOR) {
        issues.push(createIssue('UNSUPPORTED_VERSION', at(path, 'version'), 'schema version major is not supported'));
      }
    }
    const fields = parseFieldSpecs(value['fields'], at(path, 'fields'));
    if (!fields.ok) {
      issues.push(...fields.failure.issues);
    }
    if (issues.length > 0) {
      return invalid('OUTPUT_SCHEMA_UNSUPPORTED', issues);
    }
    return valid({
      kind: 'INLINE',
      schemaId: value['schemaId'] as string,
      version: value['version'] as string,
      dialect: AIBRIDGE_FIELD_DIALECT,
      fields: fields.ok ? fields.value : [],
    });
  }
  return invalid('OUTPUT_SCHEMA_UNSUPPORTED', [
    createIssue('INVALID_VALUE', at(path, 'kind'), 'must be REF or INLINE'),
  ]);
}

/** The declared field names of an inline schema; empty for a `REF` (unknown until resolved). */
export function outputSchemaFieldNames(schema: OutputSchema): readonly string[] {
  return schema.kind === 'INLINE' ? schema.fields.map((field) => field.name) : [];
}

/** Resolve a `REF` to an inline schema. A resolver that cannot resolve returns `null`. */
export function resolveOutputSchema(
  schema: OutputSchema,
  resolver: (ref: OutputSchemaRef) => OutputSchema | null,
): OutputSchema | null {
  if (schema.kind === 'INLINE') {
    return schema;
  }
  return resolver(schema.ref);
}

/** True when two output schemas describe the same field table and dialect. */
export function outputSchemasEqual(a: OutputSchema, b: OutputSchema): boolean {
  if (a.kind !== b.kind) {
    return false;
  }
  if (a.kind === 'REF' && b.kind === 'REF') {
    return a.ref.schemaId === b.ref.schemaId && a.ref.version === b.ref.version;
  }
  if (a.kind === 'INLINE' && b.kind === 'INLINE') {
    return a.schemaId === b.schemaId && a.version === b.version && JSON.stringify(a.fields) === JSON.stringify(b.fields);
  }
  return false;
}
