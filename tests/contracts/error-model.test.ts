import {
  AI_ERROR_CODES,
  AI_ERROR_REASONS,
  AI_ERROR_STAGES,
  DETAIL_KEYS_BY_REASON,
  REASON_META,
  RETRYABLE_BY_CODE,
  allowedDetailKeys,
  defaultRetryable,
  fallbackEligibility,
  isAiErrorCode,
  isAiErrorReason,
  isAiErrorStage,
  isProviderCategory,
  makeAiError,
} from '@aibridge/contracts';
import { describe, expect, it } from 'vitest';

describe('error model — a closed vocabulary', () => {
  it('has exactly the twelve codes', () => {
    expect(AI_ERROR_CODES).toHaveLength(12);
    expect(new Set(AI_ERROR_CODES).size).toBe(12);
    expect(AI_ERROR_CODES).toContain('INVALID_REQUEST');
    expect(AI_ERROR_CODES).toContain('INTERNAL');
  });

  it('has unique, closed stages and reasons', () => {
    expect(new Set(AI_ERROR_STAGES).size).toBe(AI_ERROR_STAGES.length);
    expect(new Set(AI_ERROR_REASONS).size).toBe(AI_ERROR_REASONS.length);
    // Stage 2 added `INTERNAL` and three reasons; they are part of the closed set now.
    expect(AI_ERROR_STAGES).toContain('INTERNAL');
    expect(AI_ERROR_REASONS).toContain('TRUSTED_FIELD_IN_CONSUMER_REQUEST');
    expect(AI_ERROR_REASONS).toContain('OUTPUT_SCHEMA_OVERRIDE_FORBIDDEN');
    expect(AI_ERROR_REASONS).toContain('JSON_PARSE_FAILED');
  });

  it('gives every reason a canonical code, stage and retryability', () => {
    const reasonKeys = Object.keys(REASON_META).sort();
    expect(reasonKeys).toEqual([...AI_ERROR_REASONS].sort());
    for (const reason of AI_ERROR_REASONS) {
      const meta = REASON_META[reason];
      expect(isAiErrorCode(meta.code), reason).toBe(true);
      expect(isAiErrorStage(meta.stage), reason).toBe(true);
      expect(typeof meta.retryable, reason).toBe('boolean');
    }
  });

  it('maps the kill switches and rate limits to governance, never to a provider fault', () => {
    for (const reason of ['KILL_SWITCH_GLOBAL', 'KILL_SWITCH_PROVIDER', 'KILL_SWITCH_CAPABILITY'] as const) {
      expect(REASON_META[reason]).toEqual({ code: 'MODEL_UNAVAILABLE', stage: 'GOVERNANCE', retryable: false });
    }
    for (const reason of ['RATE_LIMIT_SUBJECT', 'RATE_LIMIT_CALLER', 'RATE_LIMIT_CAPABILITY', 'RATE_LIMIT_PROVIDER'] as const) {
      expect(REASON_META[reason].code).toBe('RATE_LIMITED');
      expect(REASON_META[reason].retryable).toBe(true);
    }
    for (const reason of ['QUOTA_SUBJECT', 'QUOTA_CALLER', 'QUOTA_GLOBAL'] as const) {
      expect(REASON_META[reason].code).toBe('QUOTA_EXCEEDED');
      expect(REASON_META[reason].retryable).toBe(false);
    }
  });

  it('prefers reason-level retryability over the code default', () => {
    expect(RETRYABLE_BY_CODE.PROVIDER_ERROR).toBe(false);
    expect(defaultRetryable('PROVIDER_ERROR', 'PROVIDER_OVERLOADED')).toBe(true);
    expect(defaultRetryable('PROVIDER_ERROR', 'PROVIDER_BAD_RESPONSE')).toBe(true);
    expect(defaultRetryable('PROVIDER_ERROR')).toBe(false);
    expect(defaultRetryable('QUOTA_EXCEEDED', 'QUOTA_GLOBAL')).toBe(false);
  });

  it('allows fallback only where a second provider could plausibly help', () => {
    expect(fallbackEligibility('UNAVAILABLE')).toBe(true);
    expect(fallbackEligibility('TIMEOUT')).toBe(true);
    expect(fallbackEligibility('MODEL_UNAVAILABLE')).toBe(true);
    expect(fallbackEligibility('RATE_LIMITED')).toBe(false);
    expect(fallbackEligibility('RATE_LIMITED', { fallbackOnRateLimit: true })).toBe(true);
    expect(fallbackEligibility('QUOTA_EXCEEDED')).toBe(false);
    expect(fallbackEligibility('QUOTA_EXCEEDED', { fallbackOnQuotaExceeded: true })).toBe(true);
    // Never fall back when the failure is a property of the request or the content.
    expect(fallbackEligibility('INVALID_REQUEST')).toBe(false);
    expect(fallbackEligibility('SCHEMA_MISMATCH')).toBe(false);
    expect(fallbackEligibility('CONTENT_BLOCKED')).toBe(false);
    expect(fallbackEligibility('CANCELLED')).toBe(false);
  });

  it('closes the detail keys per reason (deny by default)', () => {
    for (const reason of AI_ERROR_REASONS) {
      expect(DETAIL_KEYS_BY_REASON[reason], reason).toBeDefined();
    }
    expect(allowedDetailKeys(undefined)).toEqual([]);
    expect(allowedDetailKeys('SECRET_LIKE_INPUT')).toEqual(['pattern', 'field']);
    expect(allowedDetailKeys('POLICY_VIOLATION')).toEqual(['rule']);
  });

  it('builds an error from a reason with canonical defaults, and a reason-specific category', () => {
    const forbidden = makeAiError({ reason: 'SECRET_LIKE_INPUT', message: 'rejected', details: { pattern: 'OPENAI_STYLE_KEY' } });
    expect(forbidden.code).toBe('INVALID_REQUEST');
    expect(forbidden.stage).toBe('INPUT_SAFETY');
    expect(forbidden.retryable).toBe(false);

    const throttled = makeAiError({ reason: 'PROVIDER_THROTTLED', message: 'slow down' });
    expect(throttled.code).toBe('RATE_LIMITED');
    expect(throttled.retryable).toBe(true);

    const withRetryAfter = makeAiError({ reason: 'RATE_LIMIT_CALLER', message: 'slow down', retryAfterMs: 1500 });
    expect(withRetryAfter.retryAfterMs).toBe(1500);
  });

  it('exposes predicates for the closed sets', () => {
    expect(isAiErrorCode('TIMEOUT')).toBe(true);
    expect(isAiErrorCode('NOPE')).toBe(false);
    expect(isAiErrorStage('INTERNAL')).toBe(true);
    expect(isAiErrorReason('JSON_PARSE_FAILED')).toBe(true);
    expect(isProviderCategory('UPSTREAM')).toBe(true);
    expect(isProviderCategory('not-a-category')).toBe(false);
  });
});
