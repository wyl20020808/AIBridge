/**
 * Qualification security tests (Stage 8, Phases 38, 39, 50).
 *
 * The threat: a provider's error body (or a misbehaving probe) deliberately contains a credential
 * sentinel, fake PII, a stack trace or the raw request. None of it may reach a qualification record,
 * the store on disk, or the operator diagnostics.
 */
import {
  buildQualificationRecord,
  FileQualificationStore,
  InMemoryQualificationStore,
  ProviderQualificationRunner,
  getQualificationStatus,
  parseQualificationDocument,
  serializeQualificationDocument,
  validateQualificationRecord,
  type FeatureProbe,
  type QualificationFileIo,
} from '@aibridge/qualification';
import { describe, expect, it } from 'vitest';

import { testIdentity, testRecord } from './helpers.js';

const API_KEY_SENTINEL = `sk-${'Q'.repeat(32)}`;
const PII_SENTINEL = 'learner@example.invalid';
const STACK_SENTINEL = 'at Object.<anonymous> (/tmp/secret-path.ts:1:1)';

function poisonedMessage(): string {
  return `provider said: Authorization: Bearer ${API_KEY_SENTINEL} for ${PII_SENTINEL}\n${STACK_SENTINEL}`;
}

describe('malicious provider error bodies never reach records (Phase 39)', () => {
  it('a probe that throws a poisoned message still yields a safe record', async () => {
    const probe: FeatureProbe = async () => {
      throw new Error(poisonedMessage());
    };
    const runner = new ProviderQualificationRunner();
    const records = await runner.run({
      identity: testIdentity(),
      adapterVersion: '1.0.0',
      contractVersion: '1.1',
      features: ['text'],
      evidenceClass: 'LIVE',
      credentialAvailable: true,
      probe,
    });
    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain(API_KEY_SENTINEL);
    expect(serialized).not.toContain(PII_SENTINEL);
    expect(serialized).not.toContain(STACK_SENTINEL);
    expect(serialized).not.toContain('Bearer ');
    expect(records[0]?.safeFailureReason).toBe('ADAPTER_BUG');
  });

  it('forbidden keys injected into a record are caught by the validator', () => {
    const poisoned = {
      ...testRecord(),
      rawMessage: poisonedMessage(),
      reasoning_content: 'chain of thought',
      prompt: 'the learner question',
    } as unknown as ReturnType<typeof testRecord>;
    const issues = validateQualificationRecord(poisoned);
    const paths = issues.map((issue) => issue.path);
    expect(paths).toContain('$.rawMessage');
    expect(paths).toContain('$.reasoning_content');
    expect(paths).toContain('$.prompt');
  });

  it('the file store never writes a record with a forbidden field', async () => {
    let written = '';
    const io: QualificationFileIo = {
      read: async () => null,
      write: async (contents) => {
        written = contents;
      },
    };
    const store = new FileQualificationStore({ io });
    await store.save(testRecord({ notes: ['REPAIR_USED'] }));
    expect(written).not.toContain('apiKey');
    expect(written).not.toContain(API_KEY_SENTINEL);
    expect(parseQualificationDocument(written)).toHaveLength(1);
  });
});

describe('safe serialization', () => {
  it('a serialized record and diagnostics contain no secret or raw-response field', async () => {
    const store = new InMemoryQualificationStore();
    await store.save(testRecord({ identity: testIdentity() }));
    const views = await getQualificationStatus({
      store,
      contexts: [
        {
          identity: testIdentity(),
          adapterVersion: '1.0.0',
          contractVersion: '1.1',
          declaredFeatures: ['text'],
        },
      ],
    });
    const serialized = JSON.stringify({ doc: serializeQualificationDocument(await store.list()), views });
    for (const forbidden of ['prompt', 'instructions', 'reasoning_content', 'apiKey', 'authorization']) {
      expect(serialized.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it('buildQualificationRecord strips a forbidden note but keeps the safe shape', () => {
    const record = buildQualificationRecord({
      identity: testIdentity(),
      status: 'LIVE_QUALIFIED',
      qualifiedAt: 1,
      adapterVersion: '1.0.0',
      contractVersion: '1.1',
      configDigest: testIdentity().configDigest,
      evidenceClass: 'LIVE',
      notes: ['DECLARATION_MISMATCH'],
    });
    expect(record.notes).toEqual(['DECLARATION_MISMATCH']);
    expect(validateQualificationRecord(record)).toEqual([]);
  });
});
