import {
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_MAX_REPAIR_ATTEMPTS,
  EXTRACTION_STRATEGIES,
  buildRepairRequest,
  extractStructuredCandidate,
  findBalancedSpan,
  isValidStructuredOutput,
  makeRepaired,
  makeRepairExhausted,
  repairAttemptsFor,
  validateStructuredOutput,
  type FieldSpec,
} from '@aibridge/contracts';
import { describe, expect, it } from 'vitest';

import { unwrap, unwrapFailure } from '../helpers/assertions.js';

const summaryFields: readonly FieldSpec[] = [
  { name: 'summary', type: 'STRING', required: true, description: 'x', maxLength: 20 },
  { name: 'confidence', type: 'NUMBER', required: false, description: 'y' },
  { name: 'concepts', type: 'STRING_ARRAY', required: false, description: 'z' },
];

describe('structured extraction — extraction is evidence, not a promise', () => {
  it('prefers a fenced JSON block', () => {
    const candidate = unwrap(extractStructuredCandidate('noise\n```json\n{"a":1}\n```\nmore'));
    expect(candidate.strategy).toBe('FENCED_JSON');
    expect(candidate.parsed).toEqual({ a: 1 });
  });

  it('finds the outermost balanced span when prose surrounds the JSON', () => {
    const candidate = unwrap(extractStructuredCandidate('Here you go: {"a":{"b":1}} thanks'));
    expect(candidate.strategy).toBe('BALANCED_SPAN');
    expect(candidate.parsed).toEqual({ a: { b: 1 } });
    expect(candidate.text).toBe('{"a":{"b":1}}');
  });

  it('is string-aware: a brace inside a string does not end the span', () => {
    expect(findBalancedSpan('prefix {"a":"}"} suffix')).toBe('{"a":"}"}');
    expect(findBalancedSpan('prefix [1,2,3] suffix')).toBe('[1,2,3]');
    expect(findBalancedSpan('no structure here')).toBeNull();
  });

  it('treats broken JSON in a fence as a parse failure, not a reason to try the next strategy', () => {
    const failure = unwrapFailure(extractStructuredCandidate('```json\n{broken}\n```'));
    expect(failure.reason).toBe('JSON_PARSE_FAILED');
  });

  it('reports EXTRACTION_FAILED when there is nothing to extract', () => {
    expect(unwrapFailure(extractStructuredCandidate('just prose, no JSON')).reason).toBe('EXTRACTION_FAILED');
    expect(EXTRACTION_STRATEGIES).toEqual(['FENCED_JSON', 'BALANCED_SPAN', 'PLAIN_JSON']);
  });
});

describe('structured validation — strict, never coercing, never partial', () => {
  it('accepts a conforming record', () => {
    const validated = unwrap(validateStructuredOutput({ summary: 'ok', confidence: 0.5 }, summaryFields));
    expect(validated).toEqual({ summary: 'ok', confidence: 0.5 });
  });

  it('rejects an unknown field', () => {
    const failure = unwrapFailure(validateStructuredOutput({ summary: 'ok', surprise: true }, summaryFields));
    expect(failure.reason).toBe('SCHEMA_VALIDATION_FAILED');
    expect(failure.issues.some((issue) => issue.code === 'UNKNOWN_FIELD')).toBe(true);
  });

  it('never coerces a type', () => {
    const failure = unwrapFailure(validateStructuredOutput({ summary: 'ok', confidence: '0.5' }, summaryFields));
    expect(failure.issues.some((issue) => issue.path === '$.confidence')).toBe(true);
    // `"3"` is not a NUMBER.
    expect(isValidStructuredOutput({ summary: 'ok', confidence: '3' }, summaryFields)).toBe(false);
  });

  it('enforces required fields and maxLength, counting Unicode scalars', () => {
    expect(unwrapFailure(validateStructuredOutput({}, summaryFields)).issues.some((i) => i.code === 'MISSING_FIELD')).toBe(
      true,
    );
    expect(unwrapFailure(validateStructuredOutput({ summary: 'x'.repeat(21) }, summaryFields)).issues.some(
      (i) => i.code === 'OUT_OF_RANGE',
    )).toBe(true);
    expect(isValidStructuredOutput({ summary: '😀'.repeat(20) }, summaryFields)).toBe(true);
  });

  it('validates array element types', () => {
    expect(isValidStructuredOutput({ summary: 'ok', concepts: ['a', 'b'] }, summaryFields)).toBe(true);
    expect(isValidStructuredOutput({ summary: 'ok', concepts: ['a', 2] }, summaryFields)).toBe(false);
  });

  it('rejects an oversized payload as OUTPUT_TOO_LARGE', () => {
    const failure = unwrapFailure(validateStructuredOutput({ summary: 'ok' }, summaryFields, { maxBytes: 5 }));
    expect(failure.reason).toBe('OUTPUT_TOO_LARGE');
  });

  it('rejects excessive depth and control characters', () => {
    const deep = { summary: 'ok', extra: { a: { b: { c: { d: { e: { f: 1 } } } } } } };
    expect(unwrapFailure(validateStructuredOutput(deep, summaryFields, { maxDepth: 2 })).reason).toBe(
      'SCHEMA_VALIDATION_FAILED',
    );
    expect(isValidStructuredOutput({ summary: 'bad\u0000value' }, summaryFields)).toBe(false);
  });

  it('rejects a non-object candidate', () => {
    expect(unwrapFailure(validateStructuredOutput([1, 2], summaryFields)).reason).toBe('SCHEMA_VALIDATION_FAILED');
    expect(DEFAULT_MAX_OUTPUT_BYTES).toBe(65_536);
  });
});

describe('repair — bounded, same provider, reported', () => {
  it('runs at most once in V1', () => {
    expect(DEFAULT_MAX_REPAIR_ATTEMPTS).toBe(1);
    expect(repairAttemptsFor('NONE')).toBe(0);
    expect(repairAttemptsFor('ONCE')).toBe(1);
  });

  it('builds a repair request bound to the same idempotency key and provider', () => {
    const request = buildRepairRequest({
      idempotencyKey: 'key-1',
      providerId: 'main',
      modelRef: 'm',
      capability: 'ai.structured.generate',
      issues: [{ code: 'SCHEMA_VIOLATION', path: '$.summary', message: 'bad' }],
      rawCandidate: '{"summary":1}',
    });
    expect(request.attempt).toBe(1);
    expect(request.maxAttempts).toBe(1);
    expect(request.providerId).toBe('main');
  });

  it('reports OUTPUT_REPAIRED on success and OUTPUT_REPAIR_EXHAUSTED on give-up', () => {
    const repaired = makeRepaired('{"summary":"ok"}');
    expect(repaired.outcome).toBe('REPAIRED');
    expect(repaired.warnings[0]?.code).toBe('OUTPUT_REPAIRED');

    const exhausted = makeRepairExhausted([{ code: 'SCHEMA_VIOLATION', path: '$.summary', message: 'bad' }]);
    expect(exhausted.outcome).toBe('EXHAUSTED');
    expect(exhausted.error.reason).toBe('OUTPUT_REPAIR_EXHAUSTED');
    expect(exhausted.error.code).toBe('SCHEMA_MISMATCH');
    expect(exhausted.error.details).toEqual({ issueCount: 1, firstPath: '$.summary', firstIssueCode: 'SCHEMA_VIOLATION' });
  });
});
