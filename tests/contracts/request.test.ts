import {
  AIBRIDGE_CONTRACT_VERSION,
  TRUSTED_ONLY_FIELDS,
  parseAiRequestEnvelope,
  parseConsumerAiRequest,
} from '@aibridge/contracts';
import { describe, expect, it } from 'vitest';

import { unwrap, unwrapFailure } from '../helpers/assertions.js';

function validRequest(): Record<string, unknown> {
  return {
    contractVersion: AIBRIDGE_CONTRACT_VERSION,
    requestId: 'req-01J8Z0KQ7V00000000000099',
    idempotencyKey: 'algoquest.idea.turn-000042.attempt-1',
    capability: 'ai.structured.generate',
    capabilityVersion: '1.0',
    profile: 'balanced',
    input: { instructions: 'hello', context: [] },
    metadata: { locale: 'zh-CN', surface: 'idea-lab' },
  };
}

describe('consumer request — the untrusted half', () => {
  it('accepts a well-formed request and echoes its fields', () => {
    const request = unwrap(parseConsumerAiRequest(validRequest()));
    expect(request.requestId).toBe('req-01J8Z0KQ7V00000000000099');
    expect(request.capability).toBe('ai.structured.generate');
    expect(request.profile).toBe('balanced');
    expect(request.metadata).toEqual({ locale: 'zh-CN', surface: 'idea-lab' });
  });

  it('rejects every trusted-only field before reading any other field', () => {
    for (const field of TRUSTED_ONLY_FIELDS) {
      const failure = unwrapFailure(parseConsumerAiRequest({ ...validRequest(), [field]: 'forged' }));
      expect(failure.reason, field).toBe('TRUSTED_FIELD_IN_CONSUMER_REQUEST');
      expect(failure.issues.some((issue) => issue.code === 'TRUSTED_FIELD'), field).toBe(true);
    }
  });

  it('rejects provider-shaped or override-shaped fields as a malformed envelope', () => {
    for (const field of ['apiKey', 'baseUrl', 'endpoint', 'modelRef', 'providerId', 'systemPrompt', 'messages', 'token']) {
      const failure = unwrapFailure(parseConsumerAiRequest({ ...validRequest(), [field]: 'x' }));
      expect(failure.reason, field).toBe('MALFORMED_ENVELOPE');
      expect(failure.issues.some((issue) => issue.code === 'FORBIDDEN_FIELD'), field).toBe(true);
    }
  });

  it('rejects an unknown field rather than dropping it', () => {
    const failure = unwrapFailure(parseConsumerAiRequest({ ...validRequest(), surprise: 1 }));
    expect(failure.reason).toBe('MALFORMED_ENVELOPE');
    expect(failure.issues.some((issue) => issue.code === 'UNKNOWN_FIELD')).toBe(true);
  });

  it('rejects an unsupported major and never best-effort parses it', () => {
    expect(unwrapFailure(parseConsumerAiRequest({ ...validRequest(), contractVersion: '2.0' })).reason).toBe(
      'CONTRACT_VERSION_UNSUPPORTED',
    );
    // Major-compatible forms are accepted.
    expect(parseConsumerAiRequest({ ...validRequest(), contractVersion: '1' }).ok).toBe(true);
    expect(parseConsumerAiRequest({ ...validRequest(), contractVersion: '1.0.3' }).ok).toBe(true);
  });

  it('gives the most specific reason when several are wrong at once', () => {
    const failure = unwrapFailure(
      parseConsumerAiRequest({
        ...validRequest(),
        contractVersion: '2.0',
        metadata: { locale: 'zh-CN', unknownKey: 'x' },
      }),
    );
    expect(failure.reason).toBe('CONTRACT_VERSION_UNSUPPORTED');
  });

  it('rejects an unknown metadata key (closed allow-list)', () => {
    const failure = unwrapFailure(
      parseConsumerAiRequest({ ...validRequest(), metadata: { locale: 'zh-CN', userEmail: 'x@example.invalid' } }),
    );
    expect(failure.reason).toBe('METADATA_NOT_ALLOWED');
  });

  it('rejects an unsupported output schema but accepts a REF or a valid INLINE one', () => {
    const badDialect = unwrapFailure(
      parseConsumerAiRequest({
        ...validRequest(),
        outputSchema: { kind: 'INLINE', schemaId: 's', version: '1.0', dialect: 'json-schema', fields: [] },
      }),
    );
    expect(badDialect.reason).toBe('OUTPUT_SCHEMA_UNSUPPORTED');

    const ref = parseConsumerAiRequest({
      ...validRequest(),
      outputSchema: { kind: 'REF', ref: { schemaId: 'aibridge.summary', version: '1.0' } },
    });
    expect(ref.ok).toBe(true);
  });

  it('rejects the reserved `vision` profile with a message that says so', () => {
    const failure = unwrapFailure(parseConsumerAiRequest({ ...validRequest(), profile: 'vision' }));
    expect(failure.reason).toBe('MALFORMED_ENVELOPE');
    expect(failure.issues[0]?.message).toContain('reserved');
  });

  it('requires `input` to be present', () => {
    const withoutInput = validRequest();
    delete withoutInput['input'];
    const failure = unwrapFailure(parseConsumerAiRequest(withoutInput));
    expect(failure.issues.some((issue) => issue.path === '$.input')).toBe(true);
  });
});

describe('combined request envelope — the host-bound channel', () => {
  it('accepts the two host-bound fields on top of a consumer request', () => {
    const envelope = unwrap(
      parseAiRequestEnvelope({
        ...validRequest(),
        callerPluginId: 'algoquest.learning-quests',
        subjectToken: 'subtok_opaque_host_minted_0001',
      }),
    );
    expect(envelope.callerPluginId).toBe('algoquest.learning-quests');
    expect(envelope.subjectToken).toBe('subtok_opaque_host_minted_0001');
  });

  it('rejects a trusted-only field the envelope does not bind as forged', () => {
    const failure = unwrapFailure(
      parseAiRequestEnvelope({ ...validRequest(), callerPluginId: 'algoquest.learning-quests', permissions: ['ai.text.generate'] }),
    );
    expect(failure.reason).toBe('MALFORMED_ENVELOPE');
    expect(failure.issues.some((issue) => issue.code === 'UNKNOWN_FIELD' && issue.path === '$.permissions')).toBe(true);
  });

  it('rejects a malformed callerPluginId and a non-opaque subject token', () => {
    expect(unwrapFailure(parseAiRequestEnvelope({ ...validRequest(), callerPluginId: 'AlgoQuest' })).reason).toBe(
      'MALFORMED_ENVELOPE',
    );
    expect(
      unwrapFailure(
        parseAiRequestEnvelope({ ...validRequest(), callerPluginId: 'algoquest.learning-quests', subjectToken: 'learner@example.invalid' }),
      ).reason,
    ).toBe('MALFORMED_ENVELOPE');
  });

  it('rejects an unknown envelope field', () => {
    const failure = unwrapFailure(
      parseAiRequestEnvelope({ ...validRequest(), callerPluginId: 'algoquest.learning-quests', extra: 1 }),
    );
    expect(failure.reason).toBe('MALFORMED_ENVELOPE');
    expect(failure.issues.some((issue) => issue.code === 'UNKNOWN_FIELD')).toBe(true);
  });
});
