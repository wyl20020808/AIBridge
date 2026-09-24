/**
 * Qualification fuzz tests (Stage 8, Phase 52).
 *
 * Random provider/model aliases, feature declarations, records, config/adapter versions and stale
 * transitions. The assertions are structural: the status machine must stay valid, no impossible
 * promotion may happen, no cross-model contamination, and no secret field may ever appear.
 */
import {
  buildQualificationRecord,
  canReplaceEvidence,
  EVIDENCE_CLASSES,
  evaluateStaleness,
  identityKey,
  InMemoryQualificationStore,
  isQualificationStatus,
  providerModelSafeRef,
  QUALIFICATION_FEATURES,
  QUALIFICATION_STATUSES,
  safeEndpointIdentity,
  validateQualificationRecord,
  type EvidenceClass,
  type ProviderQualificationRecord,
  type QualificationFeature,
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

const FEATURE_POOL = [...QUALIFICATION_FEATURES];
const STATUS_POOL = [...QUALIFICATION_STATUSES];
const EVIDENCE_POOL = [...EVIDENCE_CLASSES];

function pick<T>(random: () => number, pool: readonly T[]): T {
  return pool[Math.floor(random() * pool.length)] as T;
}

describe('fuzz: random qualification records stay structurally valid', () => {
  it('produces only known statuses/features/evidence and a secret-free shape', () => {
    const random = lcg(0xf0_0d);
    const store = new InMemoryQualificationStore({ retention: 50 });
    for (let index = 0; index < 1000; index += 1) {
      const feature = pick<QualificationFeature>(random, FEATURE_POOL);
      const status = pick(random, STATUS_POOL);
      const evidence = pick<EvidenceClass>(random, EVIDENCE_POOL);
      const record = buildQualificationRecord({
        identity: testIdentity({
          feature,
          modelAlias: `p${Math.floor(random() * 5)}.${feature}.primary`,
          providerId: `provider-${Math.floor(random() * 4)}`,
          providerModelSafeRef: providerModelSafeRef(`model-${Math.floor(random() * 50)}`),
        }),
        status,
        qualifiedAt: Math.floor(random() * 1_000_000),
        adapterVersion: `1.${Math.floor(random() * 10)}.0`,
        contractVersion: '1.1',
        configDigest: `cfg#${Math.floor(random() * 1e12)}`,
        evidenceClass: evidence,
        usageProjection: { inputTokens: Math.floor(random() * 1000) },
      });
      expect(isQualificationStatus(record.status)).toBe(true);
      expect(FEATURE_POOL).toContain(record.identity.feature);
      expect(validateQualificationRecord(record)).toEqual([]);
      void store.save(record);
    }
  });
});

describe('fuzz: no impossible evidence promotion', () => {
  it('canReplaceEvidence never lets a stronger record be replaced by a weaker one', () => {
    const random = lcg(0xbad_d);
    for (let index = 0; index < 1000; index += 1) {
      const existing = pick<EvidenceClass>(random, EVIDENCE_POOL);
      const incoming = pick<EvidenceClass>(random, EVIDENCE_POOL);
      const order = { DECLARED: 0, DETERMINISTIC: 1, LIVE: 2 } as const;
      if (order[incoming] >= order[existing]) {
        expect(canReplaceEvidence(existing, incoming)).toBe(true);
      } else {
        expect(canReplaceEvidence(existing, incoming)).toBe(false);
      }
    }
  });
});

describe('fuzz: stale transitions are consistent', () => {
  it('a record evaluated against an identical context is never stale', () => {
    const random = lcg(0x57_a1);
    for (let index = 0; index < 500; index += 1) {
      const feature = pick<QualificationFeature>(random, FEATURE_POOL);
      const identity = testIdentity({
        feature,
        adapterVersion: `1.${Math.floor(random() * 10)}.0`,
        contractVersion: '1.1',
        providerModelSafeRef: providerModelSafeRef(`model-${Math.floor(random() * 20)}`),
      });
      const record: ProviderQualificationRecord = buildQualificationRecord({
        identity,
        status: 'LIVE_QUALIFIED',
        qualifiedAt: 1,
        adapterVersion: identity.adapterVersion,
        contractVersion: identity.contractVersion,
        configDigest: identity.configDigest,
        evidenceClass: 'LIVE',
      });
      const verdict = evaluateStaleness(record, {
        identity,
        adapterVersion: identity.adapterVersion,
        contractVersion: identity.contractVersion,
        declaredFeatures: [feature],
      });
      expect(verdict.stale).toBe(false);
    }
  });

  it('any single drifted axis always marks the record stale', () => {
    const random = lcg(0xd1_f7);
    for (let index = 0; index < 500; index += 1) {
      const feature = pick<QualificationFeature>(random, FEATURE_POOL);
      const base = testIdentity({ feature, providerModelSafeRef: providerModelSafeRef(`model-${index}`) });
      const record: ProviderQualificationRecord = buildQualificationRecord({
        identity: base,
        status: 'LIVE_QUALIFIED',
        qualifiedAt: 1,
        adapterVersion: '1.0.0',
        contractVersion: '1.1',
        configDigest: base.configDigest,
        evidenceClass: 'LIVE',
      });
      const axis = Math.floor(random() * 5);
      const now = testIdentity({
        feature,
        ...(axis === 0 ? { providerModelSafeRef: providerModelSafeRef(`other-${index}`) } : {}),
        ...(axis === 1 ? { endpoint: safeEndpointIdentity(`https://h${index}.example.invalid/v1`) } : {}),
        ...(axis === 2 ? { modelAlias: `m${index}.${feature}.primary` } : {}),
        ...(axis === 3 ? { configDigest: `cfg#${index}` } : {}),
        ...(axis === 4 ? { adapterVersion: '2.0.0' } : {}),
      });
      const verdict = evaluateStaleness(record, {
        identity: now,
        adapterVersion: axis === 4 ? '2.0.0' : '1.0.0',
        contractVersion: '1.1',
        declaredFeatures: [feature],
      });
      expect(verdict.stale).toBe(true);
    }
  });
});

describe('fuzz: no cross-model contamination', () => {
  it('a record is only retrievable under its own identity key', async () => {
    const random = lcg(0xc0_11);
    const store = new InMemoryQualificationStore({ retention: 200 });
    const byKey = new Map<string, Set<string>>();
    for (let index = 0; index < 500; index += 1) {
      const feature = pick<QualificationFeature>(random, FEATURE_POOL);
      const identity = testIdentity({
        feature,
        providerId: `provider-${Math.floor(random() * 3)}`,
        modelAlias: `m${Math.floor(random() * 4)}.${feature}.primary`,
      });
      const record = buildQualificationRecord({
        identity,
        status: 'LIVE_QUALIFIED',
        qualifiedAt: index,
        adapterVersion: '1.0.0',
        contractVersion: '1.1',
        configDigest: identity.configDigest,
        evidenceClass: 'LIVE',
      });
      const key = identityKey(identity);
      const set = byKey.get(key) ?? new Set<string>();
      set.add(record.qualificationId);
      byKey.set(key, set);
      await store.save(record);
    }
    for (const [key, ids] of byKey) {
      const history = await store.history(key);
      for (const record of history) {
        expect(ids.has(record.qualificationId)).toBe(true);
        expect(identityKey(record.identity)).toBe(key);
      }
    }
  });
});
