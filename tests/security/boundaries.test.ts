/**
 * Layer 2 — security tests, mechanically asserted (TESTING.md §2).
 *
 * These are the checks whose failure is a security incident. They assert the boundary as code, not
 * as policy: a forged identity is rejected, provider prose cannot be expressed, the usage record
 * has no content channel, and the provider projection is a closed set.
 */
import {
  AI_ERROR_REASONS,
  EXCLUDED_PROVIDER_METADATA_KEYS,
  allowedDetailKeys,
  composeAiRequest,
  isCapabilityGranted,
  makeAiError,
  makeSuccessResult,
  makeWarning,
  parseAiError,
  parseConsumerAiRequest,
  parseProviderMetadataProjection,
  parseRequestMetadata,
} from '@aibridge/contracts';
import { InMemoryPermissionPort } from '@aibridge/host-sdk';
import { describe, expect, it } from 'vitest';

import { unwrap, unwrapFailure } from '../helpers/assertions.js';
import { syntheticKey } from '../helpers/synthetic.js';

const synthetic = syntheticKey();

function consumerRequest(): Record<string, unknown> {
  return {
    contractVersion: '1.0',
    requestId: 'req-1',
    idempotencyKey: 'key-1',
    capability: 'ai.text.generate',
    capabilityVersion: '1.0',
    profile: 'balanced',
    input: { instructions: 'hi', context: [] },
  };
}

const projection = {
  providerId: 'main',
  providerFamily: 'local',
  modelClass: 'LOCAL',
  routeDepth: 0,
  attemptCount: 1,
  repaired: false,
} as const;

describe('§2.1 / §2.5 — identity is unforgeable and credentials do not cross', () => {
  it('rejects a caller-supplied callerPluginId as a trusted-field violation', () => {
    const failure = unwrapFailure(parseConsumerAiRequest({ ...consumerRequest(), callerPluginId: 'algoquest.learning-quests' }));
    expect(failure.reason).toBe('TRUSTED_FIELD_IN_CONSUMER_REQUEST');
  });

  it('refuses to compose a request with no host-bound identity', () => {
    const request = unwrap(parseConsumerAiRequest(consumerRequest()));
    const failure = unwrapFailure(composeAiRequest(request, { callerPluginId: '', grantedPermissions: [] }));
    expect(failure.reason).toBe('CALLER_NOT_PERMITTED');
  });

  it('requires a subject token only when the deployment declares one', () => {
    const request = unwrap(parseConsumerAiRequest(consumerRequest()));
    expect(
      unwrapFailure(composeAiRequest(request, { callerPluginId: 'caller.plugin', grantedPermissions: [] }, { subjectRequired: true }))
        .reason,
    ).toBe('SUBJECT_MISSING');
    expect(
      composeAiRequest(
        request,
        { callerPluginId: 'caller.plugin', subjectToken: 'subtok_opaque_0001', grantedPermissions: [] },
        { subjectRequired: true },
      ).ok,
    ).toBe(true);
  });

  it('denies a capability by default, and caller A cannot use caller B’s grant', () => {
    const permissions = new InMemoryPermissionPort();
    permissions.grant('caller.b', 'ai.text.generate@1');
    expect(permissions.isCapabilityGranted('caller.a', 'ai.text.generate', '1.0')).toBe(false);
    expect(isCapabilityGranted([], 'ai.text.generate', '1.0')).toBe(false);
    expect(isCapabilityGranted(['ai.text.generate@1'], 'ai.text.generate', '1.0')).toBe(true);
  });

  it('cannot smuggle a credential through the closed provider projection', () => {
    for (const key of EXCLUDED_PROVIDER_METADATA_KEYS) {
      expect(unwrapFailure(parseProviderMetadataProjection({ ...projection, [key]: synthetic })).issues.some(
        (issue) => issue.code === 'UNKNOWN_FIELD',
      ), key).toBe(true);
    }
  });

  it('neither a result nor its warnings can carry a configured key', () => {
    const result = makeSuccessResult({
      contractVersion: '1.0',
      requestId: 'req-1',
      capability: 'ai.text.generate',
      capabilityVersion: '1.0',
      output: { text: 'ok' },
      providerMetadata: projection,
      latencyMs: 1,
      warnings: [makeWarning('USAGE_ESTIMATED', 'tokens were estimated')],
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(synthetic);
    expect(serialized).not.toContain('apiKeyId');
    expect(serialized).not.toContain('baseUrl');
  });
});

describe('§2.3 — provider raw errors are not a public contract', () => {
  it('allows only the mapped category through, never a vendor message or status', () => {
    expect(allowedDetailKeys('PROVIDER_BAD_RESPONSE')).toEqual(['providerCategory']);
    expect(allowedDetailKeys('PROVIDER_TIMEOUT')).not.toContain('rawMessage');

    const ok = parseAiError({
      code: 'INVALID_RESPONSE',
      message: 'The provider returned an unusable response.',
      retryable: true,
      stage: 'PROVIDER',
      reason: 'PROVIDER_BAD_RESPONSE',
      details: { providerCategory: 'UPSTREAM' },
    });
    expect(ok.ok).toBe(true);

    for (const hostile of [
      { status: 503 },
      { rawMessage: 'vendor exploded: <html>…' },
      { body: '{"error":"…"}' },
      { headers: 'x-request-id: …' },
      { baseUrl: 'https://example.invalid' },
    ]) {
      const failure = unwrapFailure(
        parseAiError({
          code: 'INVALID_RESPONSE',
          message: 'normalized',
          retryable: true,
          stage: 'PROVIDER',
          reason: 'PROVIDER_BAD_RESPONSE',
          details: hostile,
        }),
      );
      expect(failure.issues.some((issue) => issue.code === 'UNKNOWN_FIELD'), JSON.stringify(hostile)).toBe(true);
    }
  });

  it('builds every reason without tripping its own detail allow-list', () => {
    for (const reason of AI_ERROR_REASONS) {
      const error = makeAiError({ reason, message: 'normalized' });
      expect(error.reason, reason).toBe(reason);
      expect(error.details).toBeUndefined();
    }
  });
});

describe('§3.1 — metadata is a closed allow-list', () => {
  it('rejects an unknown key and accepts the four declared ones', () => {
    expect(unwrapFailure(parseRequestMetadata({ locale: 'zh-CN', sneaky: 'x' })).reason).toBe('METADATA_NOT_ALLOWED');
    expect(unwrap(parseRequestMetadata({ locale: 'zh-CN', traceId: 't', surface: 'idea-lab', correlationId: 'c' }))).toEqual({
      locale: 'zh-CN',
      traceId: 't',
      surface: 'idea-lab',
      correlationId: 'c',
    });
  });
});
