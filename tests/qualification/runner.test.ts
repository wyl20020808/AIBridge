/**
 * ProviderQualificationRunner tests (Stage 8, Phases 27, 34, 43, 44, 50).
 *
 * The runner orchestrates probes; these tests use scripted probes only, so they are deterministic
 * and never touch a network or a credential.
 */
import {
  InMemoryQualificationStore,
  ProviderQualificationRunner,
  classifyQualificationFailure,
  identityKey,
  isFixableInAIBridge,
  validateQualificationRequest,
  type FeatureProbe,
  type ProbeResult,
  type QualificationFeature,
} from '@aibridge/qualification';
import { describe, expect, it } from 'vitest';

import { testIdentity } from './helpers.js';

const features: readonly QualificationFeature[] = ['text', 'structuredJson', 'streaming', 'reasoning', 'usage', 'cancellation'];

function okProbe(latencyMs = 12): FeatureProbe {
  return async (): Promise<ProbeResult> => ({
    ok: true,
    latencyMs,
    usageProjection: { inputTokens: 3, outputTokens: 1, totalTokens: 4 },
    finishReason: 'STOP',
  });
}

describe('runner orchestration', () => {
  it('qualifies each requested feature and saves records', async () => {
    const store = new InMemoryQualificationStore();
    const runner = new ProviderQualificationRunner({ store, clock: { nowMs: () => 5_000 } });
    const records = await runner.run({
      identity: testIdentity(),
      adapterVersion: '1.0.0',
      contractVersion: '1.1',
      features: ['text', 'structuredJson'],
      evidenceClass: 'LIVE',
      credentialAvailable: true,
      probe: okProbe(),
    });
    expect(records).toHaveLength(2);
    expect(records.every((record) => record.status === 'LIVE_QUALIFIED')).toBe(true);
    expect(records.map((record) => record.identity.feature)).toEqual(['text', 'structuredJson']);
    expect(await store.list()).toHaveLength(2);
  });

  it('runs probes in request order and isolates a failing feature', async () => {
    const runner = new ProviderQualificationRunner();
    const probe: FeatureProbe = async (feature) => {
      if (feature === 'streaming') {
        return { ok: false, reason: 'PROVIDER_FAILURE', latencyMs: 30, status: 'LIVE_FAILED' };
      }
      return { ok: true, latencyMs: 10 };
    };
    const records = await runner.run({
      identity: testIdentity(),
      adapterVersion: '1.0.0',
      contractVersion: '1.1',
      features,
      evidenceClass: 'LIVE',
      credentialAvailable: true,
      probe,
    });
    expect(records.map((record) => record.status)).toEqual([
      'LIVE_QUALIFIED',
      'LIVE_QUALIFIED',
      'LIVE_FAILED',
      'LIVE_QUALIFIED',
      'LIVE_QUALIFIED',
      'LIVE_QUALIFIED',
    ]);
  });
});

describe('missing credential (Phases 9, 43, 51)', () => {
  it('records LIVE_NOT_RUN, never LIVE_FAILED, and never calls the probe', async () => {
    let called = 0;
    const probe: FeatureProbe = async () => {
      called += 1;
      return { ok: true, latencyMs: 1 };
    };
    const runner = new ProviderQualificationRunner();
    const records = await runner.run({
      identity: testIdentity(),
      adapterVersion: '1.0.0',
      contractVersion: '1.1',
      features: ['text', 'streaming'],
      evidenceClass: 'LIVE',
      credentialAvailable: false,
      probe,
    });
    expect(called).toBe(0);
    expect(records.every((record) => record.status === 'LIVE_NOT_RUN')).toBe(true);
    expect(records.some((record) => record.status === 'LIVE_FAILED')).toBe(false);
  });
});

describe('config validation (Phase 34)', () => {
  it('flags a missing provider/model/endpoint/features', () => {
    const issues = validateQualificationRequest({
      identity: { ...testIdentity(), endpoint: { scheme: 'unknown', host: 'unknown' } },
      adapterVersion: '1.0.0',
      contractVersion: '1.1',
      features: [],
      evidenceClass: 'LIVE',
      credentialAvailable: true,
      probe: okProbe(),
    });
    expect(issues.map((issue) => issue.reason)).toEqual(['CONFIG_INVALID', 'CONFIG_INVALID']);
  });

  it('produces a CONFIG_FAILURE record rather than a failed dispatch', async () => {
    const runner = new ProviderQualificationRunner();
    const records = await runner.run({
      identity: { ...testIdentity(), endpoint: { scheme: 'unknown', host: 'unknown' } },
      adapterVersion: '1.0.0',
      contractVersion: '1.1',
      features: ['text'],
      evidenceClass: 'LIVE',
      credentialAvailable: true,
      probe: okProbe(),
    });
    expect(records).toHaveLength(1);
    expect(records[0]?.safeFailureReason).toBe('CONFIG_FAILURE');
    expect(records[0]?.status).toBe('LIVE_NOT_RUN');
  });
});

describe('deterministic evidence (no network)', () => {
  it('records DETERMINISTIC_TESTED and never LIVE_QUALIFIED', async () => {
    const runner = new ProviderQualificationRunner();
    const records = await runner.run({
      identity: testIdentity(),
      adapterVersion: '1.0.0',
      contractVersion: '1.1',
      features: ['text'],
      evidenceClass: 'DETERMINISTIC',
      credentialAvailable: false,
      probe: okProbe(),
    });
    expect(records[0]?.status).toBe('DETERMINISTIC_TESTED');
    expect(records[0]?.evidenceClass).toBe('DETERMINISTIC');
  });
});

describe('probe throw isolation (Phase 43)', () => {
  it('turns a thrown probe into a safe ADAPTER_BUG failure without aborting other features', async () => {
    const probe: FeatureProbe = async (feature) => {
      if (feature === 'text') {
        throw new Error('boom sk-SECRET');
      }
      return { ok: true, latencyMs: 1 };
    };
    const runner = new ProviderQualificationRunner();
    const records = await runner.run({
      identity: testIdentity(),
      adapterVersion: '1.0.0',
      contractVersion: '1.1',
      features: ['text', 'streaming'],
      evidenceClass: 'LIVE',
      credentialAvailable: true,
      probe,
    });
    expect(records[0]?.status).toBe('LIVE_FAILED');
    expect(records[0]?.safeFailureReason).toBe('ADAPTER_BUG');
    expect(records[1]?.status).toBe('LIVE_QUALIFIED');
    expect(JSON.stringify(records)).not.toContain('SECRET');
  });
});

describe('failure classification (Phase 44)', () => {
  it('maps normalized signals to the closed vocabulary', () => {
    expect(classifyQualificationFailure({ kind: 'auth' })).toBe('CONFIG_FAILURE');
    expect(classifyQualificationFailure({ kind: 'balance' })).toBe('CONFIG_FAILURE');
    expect(classifyQualificationFailure({ kind: 'capability-mismatch' })).toBe('CAPABILITY_MISMATCH');
    expect(classifyQualificationFailure({ kind: 'bad-response' })).toBe('ADAPTER_BUG');
    expect(classifyQualificationFailure({ kind: 'network' })).toBe('NETWORK_ENVIRONMENT');
    expect(classifyQualificationFailure({ kind: 'throttled' })).toBe('PROVIDER_FAILURE');
    expect(classifyQualificationFailure({ kind: 'timeout' })).toBe('PROVIDER_FAILURE');
    expect(isFixableInAIBridge('ADAPTER_BUG')).toBe(true);
    expect(isFixableInAIBridge('CONFIG_FAILURE')).toBe(false);
  });
});

describe('record identity keying', () => {
  it('keeps one identity per feature', async () => {
    const store = new InMemoryQualificationStore();
    const runner = new ProviderQualificationRunner({ store });
    const records = await runner.run({
      identity: testIdentity(),
      adapterVersion: '1.0.0',
      contractVersion: '1.1',
      features: ['text', 'streaming'],
      evidenceClass: 'LIVE',
      credentialAvailable: true,
      probe: okProbe(),
    });
    const keys = records.map((record) => identityKey(record.identity));
    expect(new Set(keys).size).toBe(2);
  });
});
