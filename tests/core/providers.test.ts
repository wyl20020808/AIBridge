import { ModelRegistry, ProviderRegistry } from '@aibridge/core';
import type { ModelDescriptor, ProviderDescriptor } from '@aibridge/contracts';
import { describe, expect, it } from 'vitest';

import { unwrap, unwrapFailure } from '../helpers/assertions.js';

const provider: ProviderDescriptor = {
  id: 'main',
  family: 'openai-compatible',
  features: ['text', 'structuredJson', 'usage'],
  models: [],
  maxConcurrency: 4,
  supportsIdempotency: false,
};

const model: ModelDescriptor = {
  providerId: 'main',
  modelRef: 'reasoner-large',
  displayName: 'Main reasoner (operator label)',
  features: ['text', 'structuredJson', 'usage', 'reasoning'],
  maxContextTokens: 128_000,
  maxOutputTokens: 8_192,
  profiles: ['reasoning', 'high-context'],
  pricing: { inputPerMTok: 1.5, outputPerMTok: 6, currency: 'USD', asOf: '2026-01-01' },
};

describe('provider and model registries — descriptions only, no adapters', () => {
  it('registers a provider and rejects a conflicting one', () => {
    const registry = new ProviderRegistry();
    expect(unwrap(registry.register(provider)).id).toBe('main');
    expect(unwrap(registry.register(provider)).id).toBe('main');
    const conflict = unwrapFailure(registry.register({ ...provider, maxConcurrency: 8 }));
    expect(conflict.issues.some((issue) => issue.code === 'CONFLICTING_REGISTRATION')).toBe(true);
  });

  it('validates the provider shape', () => {
    const registry = new ProviderRegistry();
    expect(unwrapFailure(registry.register({ ...provider, family: 'not-a-family' as never })).reason).toBe(
      'MALFORMED_ENVELOPE',
    );
    expect(unwrapFailure(registry.register({ ...provider, maxConcurrency: 0 })).reason).toBe('MALFORMED_ENVELOPE');
  });

  it('lists providers in a stable order and removes them', () => {
    const registry = new ProviderRegistry();
    unwrap(registry.register(provider));
    unwrap(registry.register({ ...provider, id: 'backup' }));
    expect(registry.list().map((entry) => entry.id)).toEqual(['backup', 'main']);
    expect(registry.remove('backup')).toBe(true);
    expect(registry.size).toBe(1);
  });

  it('registers models keyed by provider and modelRef, and finds them by profile', () => {
    const registry = new ModelRegistry();
    expect(unwrap(registry.register(model)).modelRef).toBe('reasoner-large');
    expect(unwrap(registry.register(model)).modelRef).toBe('reasoner-large');
    expect(unwrapFailure(registry.register({ ...model, displayName: 'different' })).issues.some(
      (issue) => issue.code === 'CONFLICTING_REGISTRATION',
    )).toBe(true);

    unwrap(registry.register({ ...model, modelRef: 'quick', profiles: ['fast'] }));
    expect(registry.findByProfile('reasoning').map((entry) => entry.modelRef)).toEqual(['reasoner-large']);
    expect(registry.listByProvider('main')).toHaveLength(2);
    expect(registry.get('main', 'quick')?.maxContextTokens).toBe(128_000);
    expect(registry.get('other', 'quick')).toBeNull();
  });
});
