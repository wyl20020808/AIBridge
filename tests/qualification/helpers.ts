/**
 * Shared test fixtures for the qualification package. Keeps the deterministic, property and fuzz
 * suites building records from one place so the safe-shape invariants are exercised consistently.
 */
import {
  buildQualificationRecord,
  configDigest,
  providerModelSafeRef,
  safeEndpointIdentity,
  type ProviderQualificationRecord,
  type QualificationFeature,
  type QualificationIdentity,
} from '@aibridge/qualification';

export function testIdentity(
  overrides: Partial<QualificationIdentity> & { readonly feature?: QualificationFeature } = {},
): QualificationIdentity {
  const endpoint = overrides.endpoint ?? safeEndpointIdentity('https://api.example.invalid/v1');
  const modelRef = overrides.providerModelSafeRef ?? providerModelSafeRef('vendor-model-one');
  const base: QualificationIdentity = {
    providerId: overrides.providerId ?? 'p1',
    providerFamily: overrides.providerFamily ?? 'openai-compatible',
    endpointKind: overrides.endpointKind ?? 'CUSTOM',
    ...(overrides.cluster === undefined ? {} : { cluster: overrides.cluster }),
    endpoint,
    modelAlias: overrides.modelAlias ?? 'relay.text.primary',
    providerModelSafeRef: modelRef,
    feature: overrides.feature ?? 'text',
    adapterVersion: overrides.adapterVersion ?? '1.0.0',
    contractVersion: overrides.contractVersion ?? '1.1',
    configDigest:
      overrides.configDigest ??
      configDigest({
        preset: 'OPENAI_COMPATIBLE_CUSTOM',
        endpointKind: overrides.endpointKind ?? 'CUSTOM',
        ...(overrides.cluster === undefined ? {} : { cluster: overrides.cluster }),
        endpoint,
        providerModelSafeRef: modelRef,
        declaredFeatures: ['text', 'streaming', 'usage'],
      }),
  };
  return base;
}

export function testRecord(
  overrides: Partial<ProviderQualificationRecord> & { readonly feature?: QualificationFeature } = {},
): ProviderQualificationRecord {
  const identity = overrides.identity ?? testIdentity({ ...(overrides.feature === undefined ? {} : { feature: overrides.feature }) });
  return buildQualificationRecord({
    identity,
    status: overrides.status ?? 'LIVE_QUALIFIED',
    ...(overrides.qualifiedAt === undefined ? { qualifiedAt: 1_000 } : { qualifiedAt: overrides.qualifiedAt }),
    adapterVersion: overrides.adapterVersion ?? '1.0.0',
    contractVersion: overrides.contractVersion ?? '1.1',
    configDigest: overrides.configDigest ?? identity.configDigest,
    evidenceClass: overrides.evidenceClass ?? 'LIVE',
    ...(overrides.latencyMs === undefined ? {} : { latencyMs: overrides.latencyMs }),
    ...(overrides.usageProjection === undefined ? {} : { usageProjection: overrides.usageProjection }),
    ...(overrides.finishReason === undefined ? {} : { finishReason: overrides.finishReason }),
    ...(overrides.safeFailureReason === undefined ? {} : { safeFailureReason: overrides.safeFailureReason }),
    ...(overrides.notes === undefined ? {} : { notes: overrides.notes }),
  });
}
