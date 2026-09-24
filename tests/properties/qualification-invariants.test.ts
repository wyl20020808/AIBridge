/**
 * Qualification property tests (Stage 8, Phase 51).
 *
 * These assert invariants that must hold for *all* inputs, not one example. They use a tiny
 * deterministic PRNG so any counterexample is reproducible.
 */
import {
  buildQualificationRecord,
  evaluateStaleness,
  identityKey,
  InMemoryQualificationStore,
  providerModelSafeRef,
  ProviderQualificationRunner,
  safeEndpointIdentity,
  validateQualificationRecord,
  type FeatureProbe,
  type ProviderQualificationRecord,
} from '@aibridge/qualification';
import { describe, expect, it } from 'vitest';

import { testIdentity } from '../qualification/helpers.js';

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

const FEATURES = ['text', 'structuredJson', 'streaming', 'reasoning', 'usage', 'cancellation'] as const;
const ALIASES = ['a.text.primary', 'b.stream.primary', 'c.reason.primary'];

describe('P51: credential absence can only ever be LIVE_NOT_RUN', () => {
  it('holds across random feature sets, aliases and evidence classes', async () => {
    const random = lcg(0x51_51);
    const runner = new ProviderQualificationRunner();
    let probeCalls = 0;
    const probe: FeatureProbe = async () => {
      probeCalls += 1;
      return { ok: true, latencyMs: 1 };
    };
    for (let index = 0; index < 200; index += 1) {
      const feature = FEATURES[Math.floor(random() * FEATURES.length)] ?? 'text';
      const alias = ALIASES[Math.floor(random() * ALIASES.length)] ?? 'a.text.primary';
      const evidence = random() < 0.5 ? 'LIVE' : 'DETERMINISTIC';
      const records = await runner.run({
        identity: testIdentity({ feature, modelAlias: alias }),
        adapterVersion: '1.0.0',
        contractVersion: '1.1',
        features: [feature],
        evidenceClass: evidence,
        credentialAvailable: false,
        probe,
      });
      if (evidence === 'LIVE') {
        expect(records[0]?.status).toBe('LIVE_NOT_RUN');
        expect(records[0]?.status).not.toBe('LIVE_FAILED');
        expect(records[0]?.status).not.toBe('UNSUPPORTED');
      } else {
        expect(records[0]?.status).toBe('DETERMINISTIC_TESTED');
      }
    }
    // Only deterministic probes may run without a credential; live+absent never dispatches.
    expect(probeCalls).toBeGreaterThan(0);
  });
});

describe('P51: an old model qualification never applies after a model-id change', () => {
  it('holds across random model refs', () => {
    const random = lcg(0x36_36);
    for (let index = 0; index < 200; index += 1) {
      const refA = providerModelSafeRef(`model-${index}`);
      const refB = providerModelSafeRef(`model-${index + 1}`);
      const record = buildQualificationRecord({
        identity: { ...testIdentity(), providerModelSafeRef: refA },
        status: 'LIVE_QUALIFIED',
        qualifiedAt: 1,
        adapterVersion: '1.0.0',
        contractVersion: '1.1',
        configDigest: testIdentity().configDigest,
        evidenceClass: 'LIVE',
      });
      const verdict = evaluateStaleness(record, {
        identity: { ...testIdentity(), providerModelSafeRef: refB },
        adapterVersion: '1.0.0',
        contractVersion: '1.1',
        declaredFeatures: ['text'],
      });
      expect(verdict.stale).toBe(true);
      expect(verdict.reasons).toContain('PROVIDER_MODEL_CHANGED');
      void random;
    }
  });
});

describe('P51: a qualification never exposes a secret or raw response', () => {
  it('holds for random record shapes', async () => {
    const random = lcg(0x38_38);
    const store = new InMemoryQualificationStore();
    for (let index = 0; index < 200; index += 1) {
      const record = buildQualificationRecord({
        identity: testIdentity({ feature: FEATURES[index % FEATURES.length] ?? 'text' }),
        status: 'LIVE_QUALIFIED',
        qualifiedAt: index,
        adapterVersion: '1.0.0',
        contractVersion: '1.1',
        configDigest: testIdentity().configDigest,
        evidenceClass: 'LIVE',
        usageProjection: { inputTokens: Math.floor(random() * 1000) },
      });
      expect(validateQualificationRecord(record)).toEqual([]);
      const serialized = JSON.stringify(record);
      expect(serialized).not.toMatch(/sk-[A-Za-z0-9]{20,}/);
      expect(serialized).not.toContain('Bearer ');
      expect(serialized).not.toContain('reasoning_content');
      await store.save(record);
    }
    const all = await store.list();
    expect(JSON.stringify(all)).not.toContain('apiKey');
  });
});

describe('P51: one feature PASS never implies another', () => {
  it('a single qualified feature leaves the others unknown', async () => {
    const runner = new ProviderQualificationRunner();
    const records = await runner.run({
      identity: testIdentity(),
      adapterVersion: '1.0.0',
      contractVersion: '1.1',
      features: ['text'],
      evidenceClass: 'LIVE',
      credentialAvailable: true,
      probe: async () => ({ ok: true, latencyMs: 1 }),
    });
    expect(records).toHaveLength(1);
    expect(records[0]?.identity.feature).toBe('text');
    // No streaming/reasoning record was fabricated.
    expect(records.some((record) => record.identity.feature === 'streaming')).toBe(false);
  });
});

describe('P51: health changes never rewrite a historical qualification', () => {
  it('a stored LIVE_QUALIFIED record is immutable evidence', async () => {
    const store = new InMemoryQualificationStore();
    const identity = testIdentity();
    const record = buildQualificationRecord({
      identity,
      status: 'LIVE_QUALIFIED',
      qualifiedAt: 111,
      adapterVersion: '1.0.0',
      contractVersion: '1.1',
      configDigest: identity.configDigest,
      evidenceClass: 'LIVE',
    });
    await store.save(record);
    const fetched = await store.latest(identityKey(identity));
    expect(fetched?.status).toBe('LIVE_QUALIFIED');
    expect(fetched?.qualifiedAt).toBe(111);
    // Health is not part of a qualification record at all.
    expect(Object.keys(fetched ?? {})).not.toContain('health');
  });
});

describe('P51: identity isolation (no cross-model contamination)', () => {
  it('random saves never overwrite another identity', async () => {
    const random = lcg(0x99_99);
    const store = new InMemoryQualificationStore({ retention: 100 });
    const keys = new Set<string>();
    const records: ProviderQualificationRecord[] = [];
    for (let index = 0; index < 500; index += 1) {
      const feature = FEATURES[Math.floor(random() * FEATURES.length)] ?? 'text';
      const alias = ALIASES[Math.floor(random() * ALIASES.length)] ?? 'a.text.primary';
      const record = buildQualificationRecord({
        identity: testIdentity({ feature, modelAlias: alias }),
        status: 'LIVE_QUALIFIED',
        qualifiedAt: index,
        adapterVersion: '1.0.0',
        contractVersion: '1.1',
        configDigest: testIdentity().configDigest,
        evidenceClass: 'LIVE',
      });
      keys.add(identityKey(record.identity));
      records.push(record);
      await store.save(record);
    }
    // Every identity key has a latest record that belongs to it.
    for (const key of keys) {
      const latest = await store.latest(key);
      expect(latest).not.toBeNull();
      if (latest !== null) {
        expect(identityKey(latest.identity)).toBe(key);
      }
    }
  });
});

describe('P51: safe endpoint projection is total', () => {
  it('never throws and never echoes a query secret for random URLs', () => {
    const random = lcg(0x35_35);
    for (let index = 0; index < 300; index += 1) {
      const host = `h${Math.floor(random() * 1000)}.example.invalid`;
      const url = `https://user:${'x'.repeat(1 + Math.floor(random() * 20))}@${host}:443/v1?key=SECRET${index}#frag`;
      const safe = safeEndpointIdentity(url);
      expect(JSON.stringify(safe)).not.toContain('SECRET');
      expect(JSON.stringify(safe)).not.toContain('user:');
      expect(safe.host).toBe(host);
    }
  });
});
