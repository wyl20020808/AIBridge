/**
 * Layer 1 — the frozen generic capability payloads (INTEGRATION_CONTRACT_V1.md §5.1, §5.5).
 *
 * Closed key sets everywhere: an unknown input field is a rejection, never a silent drop.
 */
import {
  INSTRUCTIONS_MAX_LENGTH,
  parseContextBundle,
  parseContextValue,
  parseStructuredGenerateInput,
  parseTextGenerateInput,
} from '@aibridge/contracts';
import { describe, expect, it } from 'vitest';

import { unwrap, unwrapFailure } from '../helpers/assertions.js';

const contextValue = {
  name: 'learnerIdea',
  label: 'Learner idea',
  type: 'STRING',
  untrusted: true,
  value: 'A two-pass approach.',
  maxLength: 500,
} as const;

describe('context values', () => {
  it('parses the frozen shape and rejects unknown keys', () => {
    expect(unwrap(parseContextValue(contextValue)).name).toBe('learnerIdea');
    const failure = unwrapFailure(parseContextValue({ ...contextValue, tenant: 'x' }));
    expect(failure.issues.some((issue) => issue.code === 'UNKNOWN_FIELD')).toBe(true);
  });

  it('requires the lowerCamelCase name rule, a boolean untrusted flag and a string value', () => {
    expect(unwrapFailure(parseContextValue({ ...contextValue, name: 'Learner Idea' })).issues[0]?.code).toBe('PATTERN_MISMATCH');
    expect(unwrapFailure(parseContextValue({ ...contextValue, untrusted: 'yes' })).issues[0]?.code).toBe('INVALID_TYPE');
    expect(unwrapFailure(parseContextValue({ ...contextValue, value: 42 })).issues[0]?.code).toBe('INVALID_TYPE');
  });

  it('rejects duplicate names in a bundle', () => {
    const failure = unwrapFailure(parseContextBundle([contextValue, { ...contextValue, label: 'again' }]));
    expect(failure.issues.some((issue) => issue.code === 'DUPLICATE_FIELD')).toBe(true);
  });
});

describe('generate payloads', () => {
  it('parses the structured payload and bounds the instruction channel', () => {
    const parsed = unwrap(parseStructuredGenerateInput({ instructions: 'Evaluate.', context: [contextValue] }));
    expect(parsed.context).toHaveLength(1);

    const tooLong = unwrapFailure(
      parseStructuredGenerateInput({ instructions: 'x'.repeat(INSTRUCTIONS_MAX_LENGTH + 1), context: [] }),
    );
    expect(tooLong.issues[0]?.code).toBe('OUT_OF_RANGE');
  });

  it('rejects unknown keys on both payloads', () => {
    expect(
      unwrapFailure(parseStructuredGenerateInput({ instructions: 'x', context: [], systemPrompt: 'cheat' })).issues.some(
        (issue) => issue.code === 'UNKNOWN_FIELD',
      ),
    ).toBe(true);
    expect(
      unwrapFailure(parseTextGenerateInput({ instructions: 'x', context: [], providerId: 'main' })).issues.some(
        (issue) => issue.code === 'UNKNOWN_FIELD',
      ),
    ).toBe(true);
  });

  it('accepts maxOutputTokens only as a positive integer on the text payload', () => {
    expect(unwrap(parseTextGenerateInput({ instructions: 'x', context: [], maxOutputTokens: 256 })).maxOutputTokens).toBe(256);
    expect(
      unwrapFailure(parseTextGenerateInput({ instructions: 'x', context: [], maxOutputTokens: 0 })).issues[0]?.code,
    ).toBe('INVALID_TYPE');
  });
});
