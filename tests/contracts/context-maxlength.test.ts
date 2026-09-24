/**
 * V1 stabilization audit regression — `ContextValue.maxLength` is a contract, not a comment.
 *
 * The parser accepted and stored `maxLength` but nothing enforced it; a caller-declared
 * per-value bound was silently ignored (`packages/contracts/src/input.ts`).
 */
import { parseContextValue } from '@aibridge/contracts';
import { describe, expect, it } from 'vitest';

describe('ContextValue.maxLength', () => {
  it('accepts a value within its declared bound', () => {
    const parsed = parseContextValue({
      name: 'body',
      label: 'Body',
      type: 'STRING',
      untrusted: true,
      value: 'short',
      maxLength: 500,
    });
    expect(parsed.ok).toBe(true);
  });

  it('rejects a value longer than its declared bound', () => {
    const parsed = parseContextValue({
      name: 'body',
      label: 'Body',
      type: 'STRING',
      untrusted: true,
      value: 'x'.repeat(501),
      maxLength: 500,
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.failure.issues[0]?.code).toBe('OUT_OF_RANGE');
    }
  });
});
