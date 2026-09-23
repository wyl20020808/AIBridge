/**
 * Layer 1 — the Stage 3 additive error reasons and the category → reason table.
 *
 * The generic error model is **not** rebuilt here: `REASON_META` stays the single source of code,
 * stage and retryability. What Stage 3 adds is three reasons so every closed `ProviderCategory`
 * has exactly one home — a provider-side failure can never masquerade as a consumer bug or as
 * upstream garbage.
 */
import {
  AI_ERROR_REASONS,
  PROVIDER_CATEGORIES,
  ProviderCallError,
  REASON_BY_PROVIDER_CATEGORY,
  REASON_META,
  isProviderCallError,
  reasonForProviderCategory,
} from '@aibridge/contracts';
import { describe, expect, it } from 'vitest';

describe('Stage 3 additive reasons', () => {
  it('classifies the three provider-side additions exactly as documented', () => {
    expect(REASON_META.PROVIDER_AUTH_FAILED).toEqual({ code: 'PROVIDER_ERROR', stage: 'PROVIDER', retryable: false });
    expect(REASON_META.PROVIDER_REQUEST_REJECTED).toEqual({ code: 'INVALID_REQUEST', stage: 'PROVIDER', retryable: false });
    expect(REASON_META.PROVIDER_UNAVAILABLE).toEqual({ code: 'PROVIDER_ERROR', stage: 'PROVIDER', retryable: true });
  });

  it('gives every closed provider category exactly one reason', () => {
    for (const category of PROVIDER_CATEGORIES) {
      const reason = reasonForProviderCategory(category);
      expect(AI_ERROR_REASONS as readonly string[], category).toContain(reason);
      expect(REASON_BY_PROVIDER_CATEGORY[category]).toBe(reason);
    }
  });

  it('maps the frozen fallback rule onto the new reasons', () => {
    // An auth failure and a rejected request are not fixed by spending another provider's money.
    expect(REASON_META.PROVIDER_AUTH_FAILED.retryable).toBe(false);
    expect(REASON_META.PROVIDER_REQUEST_REJECTED.retryable).toBe(false);
    // An unavailable upstream may succeed on a later attempt.
    expect(REASON_META.PROVIDER_UNAVAILABLE.retryable).toBe(true);
  });
});

describe('ProviderCallError', () => {
  it('carries mapped facts and a fixed, sanitized message', () => {
    const error = new ProviderCallError({ category: 'AUTH', rawMessage: 'vendor prose sentinel' });
    expect(isProviderCallError(error)).toBe(true);
    expect(error.message).toBe('provider call failed');
    expect(error.message).not.toContain('vendor prose sentinel');
    expect(error.rawError.rawMessage).toBe('vendor prose sentinel');
  });

  it('recognizes a ProviderCallError by shape, not only by class', () => {
    expect(isProviderCallError(new Error('plain'))).toBe(false);
    expect(isProviderCallError({ name: 'ProviderCallError', rawError: { category: 'UNKNOWN' } })).toBe(true);
  });
});
