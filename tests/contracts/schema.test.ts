import {
  AIBRIDGE_FIELD_DIALECT,
  FIELD_TYPES,
  parseFieldSpec,
  parseFieldSpecs,
  parseOutputSchema,
  outputSchemaFieldNames,
  outputSchemasEqual,
  resolveOutputSchema,
} from '@aibridge/contracts';
import { describe, expect, it } from 'vitest';

import { unwrap, unwrapFailure } from '../helpers/assertions.js';

function inlineSchema(fields: readonly unknown[]): Record<string, unknown> {
  return {
    kind: 'INLINE',
    schemaId: 'aibridge.summary',
    version: '1.0',
    dialect: AIBRIDGE_FIELD_DIALECT,
    fields,
  };
}

describe('output schema — the frozen `aibridge.fields/v1` dialect', () => {
  it('supports exactly the six frozen field types and rejects anything else', () => {
    expect(FIELD_TYPES).toEqual(['STRING', 'NUMBER', 'BOOLEAN', 'STRING_ARRAY', 'OBJECT', 'OBJECT_ARRAY']);
    // `INTEGER`/`ENUM` are a proposed v2 extension, not part of the frozen v1 dialect.
    expect(unwrapFailure(parseFieldSpec({ name: 'count', type: 'INTEGER', required: true, description: 'x' })).reason).toBe(
      'OUTPUT_SCHEMA_UNSUPPORTED',
    );
  });

  it('enforces the lowerCamelCase field-name rule', () => {
    expect(unwrap(parseFieldSpec({ name: 'nextQuestion', type: 'STRING', required: true, description: 'x' })).name).toBe(
      'nextQuestion',
    );
    expect(unwrapFailure(parseFieldSpec({ name: 'NextQuestion', type: 'STRING', required: true, description: 'x' })).reason).toBe(
      'OUTPUT_SCHEMA_UNSUPPORTED',
    );
    expect(unwrapFailure(parseFieldSpec({ name: 'next_question', type: 'STRING', required: true, description: 'x' })).reason).toBe(
      'OUTPUT_SCHEMA_UNSUPPORTED',
    );
  });

  it('requires a boolean `required`, a non-empty description and a positive maxLength', () => {
    const noDescription = unwrapFailure(parseFieldSpec({ name: 'a', type: 'STRING', required: true, description: '' }));
    expect(noDescription.reason).toBe('OUTPUT_SCHEMA_UNSUPPORTED');
    const badMaxLength = unwrapFailure(
      parseFieldSpec({ name: 'a', type: 'STRING', required: false, description: 'x', maxLength: 0 }),
    );
    expect(badMaxLength.reason).toBe('OUTPUT_SCHEMA_UNSUPPORTED');
    const ok = unwrap(parseFieldSpec({ name: 'a', type: 'STRING', required: false, description: 'x', maxLength: 10 }));
    expect(ok.maxLength).toBe(10);
  });

  it('rejects duplicate field names and an empty field table', () => {
    const duplicate = unwrapFailure(
      parseFieldSpecs([
        { name: 'a', type: 'STRING', required: true, description: 'x' },
        { name: 'a', type: 'STRING', required: false, description: 'y' },
      ]),
    );
    expect(duplicate.reason).toBe('OUTPUT_SCHEMA_UNSUPPORTED');
    expect(duplicate.issues.some((issue) => issue.code === 'DUPLICATE_FIELD')).toBe(true);
    expect(unwrapFailure(parseFieldSpecs([])).reason).toBe('OUTPUT_SCHEMA_UNSUPPORTED');
  });

  it('accepts a REF and an INLINE schema and reports field names', () => {
    const ref = unwrap(parseOutputSchema({ kind: 'REF', ref: { schemaId: 's', version: '1.0' } }));
    expect(ref.kind).toBe('REF');
    expect(outputSchemaFieldNames(ref)).toEqual([]);

    const inline = unwrap(
      parseOutputSchema(inlineSchema([{ name: 'summary', type: 'STRING', required: true, description: 'x' }])),
    );
    expect(inline.kind).toBe('INLINE');
    expect(outputSchemaFieldNames(inline)).toEqual(['summary']);
  });

  it('rejects an unknown dialect and an unsupported schema major', () => {
    expect(unwrapFailure(parseOutputSchema({ ...inlineSchema([]), dialect: 'json-schema' })).reason).toBe(
      'OUTPUT_SCHEMA_UNSUPPORTED',
    );
    const fields = [{ name: 'a', type: 'STRING', required: true, description: 'x' }];
    expect(unwrapFailure(parseOutputSchema({ ...inlineSchema(fields), version: '2.0' })).reason).toBe(
      'OUTPUT_SCHEMA_UNSUPPORTED',
    );
  });

  it('resolves a REF through a resolver and compares schemas structurally', () => {
    const ref = unwrap(parseOutputSchema({ kind: 'REF', ref: { schemaId: 's', version: '1.0' } }));
    const inline = unwrap(parseOutputSchema(inlineSchema([{ name: 'a', type: 'STRING', required: true, description: 'x' }])));
    expect(resolveOutputSchema(ref, () => inline)).toEqual(inline);
    expect(resolveOutputSchema(ref, () => null)).toBeNull();
    expect(resolveOutputSchema(inline, () => null)).toEqual(inline);
    expect(outputSchemasEqual(ref, ref)).toBe(true);
    expect(outputSchemasEqual(ref, inline)).toBe(false);
  });
});
