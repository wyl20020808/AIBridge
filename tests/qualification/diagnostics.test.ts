/**
 * Safe operator diagnostics + qualification/health separation (Stage 8, Phases 30, 31, 32, 33, 50).
 *
 * Qualification is a historical claim; health is a live signal. These tests prove the two never
 * merge and that diagnostics never leak a credential or raw response.
 */
import {
  DEFAULT_QUALIFICATION_POLICY,
  getQualificationStatus,
  InMemoryQualificationStore,
  statusSatisfiesPolicy,
  type CurrentQualificationContext,
} from '@aibridge/qualification';
import { describe, expect, it } from 'vitest';

import { testIdentity, testRecord } from './helpers.js';

function context(overrides: Parameters<typeof testIdentity>[0] = {}): CurrentQualificationContext {
  return {
    identity: testIdentity(overrides),
    adapterVersion: '1.0.0',
    contractVersion: '1.1',
    declaredFeatures: ['text', 'streaming', 'usage'],
  };
}

describe('getQualificationStatus', () => {
  it('reports DECLARED when no record exists (never a fabricated PASS)', async () => {
    const store = new InMemoryQualificationStore();
    const views = await getQualificationStatus({ store, contexts: [context()] });
    expect(views).toHaveLength(1);
    expect(views[0]?.models[0]?.features[0]?.status).toBe('DECLARED');
    expect(views[0]?.models[0]?.features[0]?.stale).toBe(false);
  });

  it('reports LIVE_QUALIFIED with safe latency/usage for a fresh record', async () => {
    const store = new InMemoryQualificationStore();
    const identity = testIdentity();
    await store.save(testRecord({ identity, latencyMs: 55, usageProjection: { inputTokens: 3, outputTokens: 1 } }));
    const views = await getQualificationStatus({ store, contexts: [context()] });
    const feature = views[0]?.models[0]?.features[0];
    expect(feature?.status).toBe('LIVE_QUALIFIED');
    expect(feature?.latencyMs).toBe(55);
    expect(feature?.usageProjection).toEqual({ inputTokens: 3, outputTokens: 1 });
  });

  it('demotes a record to STALE when the adapter version changed', async () => {
    const store = new InMemoryQualificationStore();
    await store.save(testRecord({ identity: testIdentity() }));
    const views = await getQualificationStatus({
      store,
      contexts: [{ ...context(), adapterVersion: '9.9.9' }],
    });
    const feature = views[0]?.models[0]?.features[0];
    expect(feature?.status).toBe('STALE');
    expect(feature?.stale).toBe(true);
    expect(feature?.stalenessReasons).toContain('ADAPTER_VERSION_CHANGED');
  });

  it('never leaks a credential or raw response through diagnostics', async () => {
    const store = new InMemoryQualificationStore();
    await store.save(testRecord({ identity: testIdentity() }));
    const views = await getQualificationStatus({ store, contexts: [context()] });
    const serialized = JSON.stringify(views);
    expect(serialized).not.toContain('secret://');
    expect(serialized).not.toContain('Bearer ');
    expect(serialized).not.toContain('apiKey');
  });

  it('groups features per provider and model, sorted by feature', async () => {
    const store = new InMemoryQualificationStore();
    const views = await getQualificationStatus({
      store,
      contexts: [context({ feature: 'streaming' }), context({ feature: 'text' })],
    });
    expect(views).toHaveLength(1);
    expect(views[0]?.models[0]?.features.map((feature) => feature.feature)).toEqual([
      'streaming',
      'text',
    ]);
  });
});

describe('qualification policy (Phase 33)', () => {
  it('defaults to ALLOW_DECLARED so dev is never blocked', () => {
    expect(DEFAULT_QUALIFICATION_POLICY).toBe('ALLOW_DECLARED');
  });

  it('never lets REQUIRE_LIVE accept a merely declared feature', () => {
    expect(statusSatisfiesPolicy('DECLARED', 'REQUIRE_LIVE')).toBe(false);
    expect(statusSatisfiesPolicy('DETERMINISTIC_TESTED', 'REQUIRE_LIVE')).toBe(false);
    expect(statusSatisfiesPolicy('LIVE_QUALIFIED', 'REQUIRE_LIVE')).toBe(true);
    expect(statusSatisfiesPolicy('STALE', 'REQUIRE_LIVE')).toBe(false);
  });

  it('allows a declared feature under the default policy', () => {
    expect(statusSatisfiesPolicy('DECLARED', 'ALLOW_DECLARED')).toBe(true);
    expect(statusSatisfiesPolicy('LIVE_NOT_RUN', 'ALLOW_DECLARED')).toBe(false);
  });
});
