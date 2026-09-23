import { guardStructuredOutput, isStructurallySafe } from '@aibridge/core';
import type { FieldSpec } from '@aibridge/contracts';
import { describe, expect, it } from 'vitest';

const fields: readonly FieldSpec[] = [
  { name: 'classification', type: 'STRING', required: true, description: 'x' },
  { name: 'confidence', type: 'NUMBER', required: true, description: 'y' },
  { name: 'conceptIds', type: 'STRING_ARRAY', required: false, description: 'z' },
];

describe('output safety — structural only, and never partial', () => {
  it('accepts a conforming candidate', () => {
    const result = guardStructuredOutput({ classification: 'PROMISING', confidence: 0.7, conceptIds: ['a'] }, fields);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output['classification']).toBe('PROMISING');
    }
  });

  it('rejects an unknown-field output', () => {
    const result = guardStructuredOutput({ classification: 'X', confidence: 1, extra: true }, fields);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('SCHEMA_VALIDATION_FAILED');
      expect(result.error.details?.['firstIssueCode']).toBe('UNKNOWN_FIELD');
      expect(result.error.details?.['firstPath']).toBe('$.extra');
    }
  });

  it('rejects a type-coerced output (`"3"` as NUMBER)', () => {
    const result = guardStructuredOutput({ classification: 'X', confidence: '3' }, fields);
    expect(result.ok).toBe(false);
    expect(isStructurallySafe({ classification: 'X', confidence: '3' }, fields)).toBe(false);
  });

  it('returns only an error on failure — no partial object', () => {
    const result = guardStructuredOutput({ classification: 'X' }, fields);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect('output' in result).toBe(false);
      expect(result.error.message).not.toContain('X');
    }
  });

  it('reports an oversized output as OUTPUT_TOO_LARGE', () => {
    const result = guardStructuredOutput({ classification: 'X', confidence: 1 }, fields, { maxBytes: 10 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('OUTPUT_TOO_LARGE');
      expect(result.error.details?.['maxOutputBytes']).toBe(10);
    }
  });
});
