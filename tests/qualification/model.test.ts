/**
 * Qualification core model tests (Stage 8, Phase 50).
 *
 * Covers the status vocabulary, secret-free identity, record safety, staleness/model/config drift and
 * the bounded store. These are deterministic and need no network.
 */
import {
  buildQualificationRecord,
  canReplaceEvidence,
  configDigest,
  evaluateStaleness,
  evidenceRank,
  fnv1a64,
  identityKey,
  InMemoryQualificationStore,
  isQualificationStatus,
  providerModelSafeRef,
  safeEndpointIdentity,
  sameIdentity,
  serializeQualificationDocument,
  parseQualificationDocument,
  validateQualificationRecord,
  QUALIFICATION_STATUSES,
} from '@aibridge/qualification';
import { describe, expect, it } from 'vitest';

import { testIdentity, testRecord } from './helpers.js';

describe('qualification status vocabulary', () => {
  it('exposes the closed status set', () => {
    expect([...QUALIFICATION_STATUSES]).toEqual([
      'DECLARED',
      'DETERMINISTIC_TESTED',
      'LIVE_QUALIFIED',
      'LIVE_FAILED',
      'LIVE_NOT_RUN',
      'UNSUPPORTED',
      'STALE',
    ]);
  });

  it('guards unknown statuses', () => {
    expect(isQualificationStatus('LIVE_QUALIFIED')).toBe(true);
    expect(isQualificationStatus('PASS')).toBe(false);
    expect(isQualificationStatus(42)).toBe(false);
  });

  it('ranks evidence monotonically and never weakens it', () => {
    expect(evidenceRank('LIVE')).toBeGreaterThan(evidenceRank('DETERMINISTIC'));
    expect(evidenceRank('DETERMINISTIC')).toBeGreaterThan(evidenceRank('DECLARED'));
    expect(canReplaceEvidence('LIVE', 'DETERMINISTIC')).toBe(false);
    expect(canReplaceEvidence('DETERMINISTIC', 'LIVE')).toBe(true);
    expect(canReplaceEvidence('LIVE', 'LIVE')).toBe(true);
  });
});

describe('secret-free identity', () => {
  it('projects only scheme/host/port and drops path, query, userinfo and fragment', () => {
    const safe = safeEndpointIdentity('https://user:pass@api.example.invalid:8443/v1?key=SECRET#frag');
    expect(safe).toEqual({ scheme: 'https', host: 'api.example.invalid', port: 8443 });
    expect(JSON.stringify(safe)).not.toContain('SECRET');
    expect(JSON.stringify(safe)).not.toContain('pass');
  });

  it('never echoes an unparseable URL', () => {
    const safe = safeEndpointIdentity('not a url token=supersecret');
    expect(safe).toEqual({ scheme: 'unknown', host: 'unknown' });
  });

  it('derives a stable safe model ref', () => {
    const ref = providerModelSafeRef('vendor-model-one');
    expect(ref).toBe(providerModelSafeRef('vendor-model-one'));
    expect(ref).not.toBe(providerModelSafeRef('vendor-model-two'));
  });

  it('is deterministic for the same digest inputs and changes when any input changes', () => {
    const endpoint = safeEndpointIdentity('https://api.example.invalid/v1');
    const base = configDigest({
      preset: 'OPENAI_COMPATIBLE_CUSTOM',
      endpointKind: 'CUSTOM',
      endpoint,
      providerModelSafeRef: 'm#1',
      declaredFeatures: ['text', 'streaming'],
    });
    const reordered = configDigest({
      preset: 'OPENAI_COMPATIBLE_CUSTOM',
      endpointKind: 'CUSTOM',
      endpoint,
      providerModelSafeRef: 'm#1',
      declaredFeatures: ['streaming', 'text'],
    });
    expect(base).toBe(reordered);
    const changed = configDigest({
      preset: 'OPENAI_COMPATIBLE_CUSTOM',
      endpointKind: 'CUSTOM',
      endpoint,
      providerModelSafeRef: 'm#2',
      declaredFeatures: ['text', 'streaming'],
    });
    expect(changed).not.toBe(base);
  });

  it('fnv1a64 is stable and hex', () => {
    expect(fnv1a64('hello')).toBe(fnv1a64('hello'));
    expect(fnv1a64('hello')).toMatch(/^[0-9a-f]{16}$/);
  });

  it('compares identities by key', () => {
    const a = testIdentity();
    const b = testIdentity();
    expect(sameIdentity(a, b)).toBe(true);
    expect(identityKey(a)).toBe(identityKey(b));
    expect(sameIdentity(a, testIdentity({ modelAlias: 'other.text.primary' }))).toBe(false);
  });
});

describe('qualification record safety', () => {
  it('validates a clean record', () => {
    expect(validateQualificationRecord(testRecord())).toEqual([]);
  });

  it('rejects forbidden secret-bearing keys anywhere in the shape', () => {
    const record = { ...testRecord(), apiKey: 'leak' } as unknown as ReturnType<typeof testRecord>;
    const issues = validateQualificationRecord(record);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]?.message).toContain('forbidden');
  });

  it('drops unknown note codes at build time', () => {
    const record = buildQualificationRecord({
      ...testRecord(),
      notes: ['free form provider prose', 'REPAIR_USED'] as unknown as readonly never[],
    });
    expect(record.notes).toEqual(['REPAIR_USED']);
    expect(validateQualificationRecord(record)).toEqual([]);
  });

  it('rejects unknown note codes when validating a hand-built record', () => {
    const record = { ...testRecord(), notes: ['provider prose'] } as ReturnType<typeof testRecord>;
    const issues = validateQualificationRecord(record);
    expect(issues.some((issue) => issue.path === '$.notes')).toBe(true);
  });

  it('drops non-integer or negative usage counts', () => {
    const record = buildQualificationRecord({
      identity: testIdentity(),
      status: 'LIVE_QUALIFIED',
      qualifiedAt: 1,
      adapterVersion: '1.0.0',
      contractVersion: '1.1',
      configDigest: testIdentity().configDigest,
      evidenceClass: 'LIVE',
      usageProjection: { inputTokens: 10, outputTokens: -1, totalTokens: 3.5 },
    });
    expect(record.usageProjection).toEqual({ inputTokens: 10 });
  });
});

describe('staleness / drift', () => {
  const base = testIdentity();

  it('a matching context is not stale', () => {
    const record = testRecord();
    const verdict = evaluateStaleness(record, {
      identity: base,
      adapterVersion: '1.0.0',
      contractVersion: '1.1',
      declaredFeatures: ['text', 'streaming', 'usage'],
    });
    expect(verdict.stale).toBe(false);
    expect(verdict.reasons).toEqual([]);
  });

  it('detects provider-model drift (same alias, changed model id)', () => {
    const record = testRecord();
    const now = testIdentity({ providerModelSafeRef: providerModelSafeRef('vendor-model-two') });
    const verdict = evaluateStaleness(record, {
      identity: now,
      adapterVersion: '1.0.0',
      contractVersion: '1.1',
      declaredFeatures: ['text'],
    });
    expect(verdict.stale).toBe(true);
    expect(verdict.reasons).toContain('PROVIDER_MODEL_CHANGED');
  });

  it('detects adapter-version drift', () => {
    const verdict = evaluateStaleness(testRecord(), {
      identity: base,
      adapterVersion: '2.0.0',
      contractVersion: '1.1',
      declaredFeatures: ['text', 'streaming', 'usage'],
    });
    expect(verdict.reasons).toContain('ADAPTER_VERSION_CHANGED');
  });

  it('detects contract-version drift', () => {
    const verdict = evaluateStaleness(testRecord(), {
      identity: base,
      adapterVersion: '1.0.0',
      contractVersion: '2.0',
      declaredFeatures: ['text', 'streaming', 'usage'],
    });
    expect(verdict.reasons).toContain('CONTRACT_VERSION_CHANGED');
  });

  it('detects endpoint drift', () => {
    const now = testIdentity({ endpoint: safeEndpointIdentity('https://other.example.invalid/v1') });
    const verdict = evaluateStaleness(testRecord(), {
      identity: now,
      adapterVersion: '1.0.0',
      contractVersion: '1.1',
      declaredFeatures: ['text'],
    });
    expect(verdict.reasons).toContain('ENDPOINT_CHANGED');
  });

  it('detects cluster drift', () => {
    const record = testRecord({ identity: testIdentity({ cluster: 'CN' }) });
    const now = testIdentity({ cluster: 'SGP' });
    const verdict = evaluateStaleness(record, {
      identity: now,
      adapterVersion: '1.0.0',
      contractVersion: '1.1',
      declaredFeatures: ['text'],
    });
    expect(verdict.reasons).toContain('CLUSTER_CHANGED');
  });

  it('detects config-digest drift', () => {
    const record = testRecord();
    const now = testIdentity({ configDigest: 'cfg#0000000000000000' });
    const verdict = evaluateStaleness(record, {
      identity: now,
      adapterVersion: '1.0.0',
      contractVersion: '1.1',
      declaredFeatures: ['text'],
    });
    expect(verdict.reasons).toContain('CONFIG_DIGEST_CHANGED');
  });

  it('detects a removed feature declaration', () => {
    const record = testRecord({ feature: 'streaming' });
    const verdict = evaluateStaleness(record, {
      identity: testIdentity({ feature: 'streaming' }),
      adapterVersion: '1.0.0',
      contractVersion: '1.1',
      declaredFeatures: ['text'],
    });
    expect(verdict.reasons).toContain('MODEL_FEATURE_DECLARATION_CHANGED');
  });

  it('supports optional age-based staleness', () => {
    const record = testRecord({ qualifiedAt: 1_000 });
    const verdict = evaluateStaleness(record, {
      identity: base,
      adapterVersion: '1.0.0',
      contractVersion: '1.1',
      declaredFeatures: ['text', 'streaming', 'usage'],
      maxAgeMs: 500,
      nowMs: 2_000,
    });
    expect(verdict.reasons).toContain('AGE_EXCEEDED');
  });
});

describe('bounded store', () => {
  it('keeps newest-first history and enforces retention', async () => {
    const store = new InMemoryQualificationStore({ retention: 2 });
    const identity = testIdentity();
    for (const at of [1, 2, 3]) {
      await store.save(testRecord({ identity, qualifiedAt: at }));
    }
    const history = await store.history(identityKey(identity));
    expect(history.map((record) => record.qualifiedAt)).toEqual([3, 2]);
    expect((await store.latest(identityKey(identity)))?.qualifiedAt).toBe(3);
    expect(await store.list()).toHaveLength(2);
  });

  it('keeps unrelated identities separate', async () => {
    const store = new InMemoryQualificationStore();
    await store.save(testRecord({ identity: testIdentity({ modelAlias: 'a.text.primary' }) }));
    await store.save(testRecord({ identity: testIdentity({ modelAlias: 'b.text.primary' }) }));
    expect(await store.list()).toHaveLength(2);
    expect(
      await store.latest(identityKey(testIdentity({ modelAlias: 'a.text.primary' }))),
    ).not.toBeNull();
  });
});

describe('file store document', () => {
  it('round-trips records and rejects unknown format versions', async () => {
    const records = [testRecord()];
    const text = serializeQualificationDocument(records);
    expect(text).not.toContain('apiKey');
    expect(parseQualificationDocument(text)).toHaveLength(1);

    const bad = JSON.stringify({ formatVersion: 999, records });
    expect(parseQualificationDocument(bad)).toEqual([]);
    expect(parseQualificationDocument('not json')).toEqual([]);
  });
});
