import { findPii, findSecrets, firstSecretPath, screenAiInput } from '@aibridge/core';
import { describe, expect, it } from 'vitest';

import { syntheticSecrets } from '../helpers/synthetic.js';

describe('input safety — reject secrets, redact PII, cap size', () => {
  const secrets = syntheticSecrets();

  it.each(Object.entries(secrets))('rejects %s-shaped input with SECRET_LIKE_INPUT', (_id, value) => {
    const result = screenAiInput({ field: value });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('SECRET_LIKE_INPUT');
      expect(result.error.stage).toBe('INPUT_SAFETY');
      expect(result.error.code).toBe('INVALID_REQUEST');
      expect(typeof result.error.details?.['pattern']).toBe('string');
      // The offending value itself is never echoed back.
      expect(JSON.stringify(result.error)).not.toContain(value);
    }
  });

  it('reports where the secret was, rooted at $', () => {
    const findings = findSecrets({ context: [{ value: 'x' }, { value: secrets.OPENAI_STYLE_KEY }] });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.path).toBe('$.context[1].value');
    expect(firstSecretPath({ a: { b: secrets.GITHUB_TOKEN } })).toBe('$.a.b');
    expect(firstSecretPath({ a: 'clean' })).toBeNull();
  });

  it('redacts PII and warns, because rejecting a learner would be wrong', () => {
    const result = screenAiInput({ text: 'email learner@example.invalid or call +1 555 123 4567' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings.some((warning) => warning.code === 'INPUT_REDACTED')).toBe(true);
      const rendered = JSON.stringify(result.value);
      expect(rendered).toContain('[REDACTED:EMAIL]');
      expect(rendered).not.toContain('learner@example.invalid');
      expect(result.findings.some((finding) => finding.kind === 'PII' && finding.id === 'EMAIL')).toBe(true);
    }
  });

  it('can detect PII without rewriting it', () => {
    const result = screenAiInput({ text: 'learner@example.invalid' }, { redactPii: false });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(JSON.stringify(result.value)).toContain('learner@example.invalid');
      expect(result.warnings.some((warning) => warning.code === 'INPUT_REDACTED')).toBe(true);
    }
    expect(findPii({ text: 'learner@example.invalid' })[0]?.id).toBe('EMAIL');
  });

  it('checks size before content, so a limit is a limit', () => {
    const result = screenAiInput({ text: 'x'.repeat(100) }, { maxInputBytes: 20 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('INPUT_TOO_LARGE');
      expect(result.error.details?.['maxInputBytes']).toBe(20);
    }
  });

  it('rejects a value that cannot be measured', () => {
    const result = screenAiInput({ big: 1n });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('MALFORMED_ENVELOPE');
    }
  });

  it('accepts clean input unchanged', () => {
    const input = { text: 'a clean sentence', count: 2 };
    const result = screenAiInput(input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(input);
      expect(result.warnings).toEqual([]);
      expect(result.findings).toEqual([]);
    }
  });
});
