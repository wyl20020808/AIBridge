/**
 * Deriving qualification contexts from a provider config (Stage 8, Phases 2, 30, 34).
 *
 * The runner and diagnostics need a {@link CurrentQualificationContext} per (model alias, feature)
 * in order to compare a stored record against "now". This module builds those contexts from a
 * minimal, structurally-typed view of the provider configuration, so `@aibridge/qualification` never
 * has to depend on the runtime package (which would invert the dependency arrow, AGENTS.md §1).
 *
 * The caller maps its own config shape onto {@link QualificationConfigProvider}.
 */

import { configDigest, providerModelSafeRef, safeEndpointIdentity, type QualificationIdentity } from './identity.js';
import type { CurrentQualificationContext } from './staleness.js';
import type { QualificationFeature } from './status.js';
import { QUALIFICATION_FEATURES } from './status.js';

/** A structural view of one provider's endpoint config. */
export type QualificationConfigEndpoint =
  | { readonly kind: 'PRESET'; readonly cluster?: string }
  | { readonly kind: 'CUSTOM'; readonly baseUrl: string };

/** A structural view of one model alias config. */
export type QualificationConfigModel = {
  readonly alias: string;
  readonly providerModelId: string;
  readonly features: readonly string[];
};

/** A structural view of one provider config. */
export type QualificationConfigProvider = {
  readonly providerId: string;
  readonly preset: string;
  readonly enabled: boolean;
  readonly family: string;
  readonly endpoint: QualificationConfigEndpoint;
  readonly resolvedBaseUrl: string;
  readonly models: readonly QualificationConfigModel[];
  readonly adapterVersion: string;
  readonly contractVersion: string;
};

/** The qualification features the config declares, intersected with the closed feature set. */
export function declaredQualificationFeatures(features: readonly string[]): readonly QualificationFeature[] {
  const closed = new Set<string>(QUALIFICATION_FEATURES);
  return features.filter((feature): feature is QualificationFeature => closed.has(feature));
}

/**
 * Build contexts for every (model alias, declared qualification feature) in a provider config. Only
 * enabled providers and only features in the closed qualification set are produced.
 */
export function deriveQualificationContexts(
  provider: QualificationConfigProvider,
): readonly CurrentQualificationContext[] {
  if (!provider.enabled) {
    return [];
  }
  const endpoint = safeEndpointIdentity(provider.resolvedBaseUrl);
  const contexts: CurrentQualificationContext[] = [];
  for (const model of provider.models) {
    const modelRef = providerModelSafeRef(model.providerModelId);
    const declared = declaredQualificationFeatures(model.features);
    const digest = configDigest({
      preset: provider.preset,
      endpointKind: provider.endpoint.kind,
      ...(provider.endpoint.kind === 'PRESET' && provider.endpoint.cluster !== undefined
        ? { cluster: provider.endpoint.cluster }
        : {}),
      endpoint,
      providerModelSafeRef: modelRef,
      declaredFeatures: model.features,
    });
    for (const feature of declared) {
      const identity: QualificationIdentity = {
        providerId: provider.providerId,
        providerFamily: provider.family,
        endpointKind: provider.endpoint.kind,
        ...(provider.endpoint.kind === 'PRESET' && provider.endpoint.cluster !== undefined
          ? { cluster: provider.endpoint.cluster }
          : {}),
        endpoint,
        modelAlias: model.alias,
        providerModelSafeRef: modelRef,
        feature,
        adapterVersion: provider.adapterVersion,
        contractVersion: provider.contractVersion,
        configDigest: digest,
      };
      contexts.push({
        identity,
        adapterVersion: provider.adapterVersion,
        contractVersion: provider.contractVersion,
        declaredFeatures: model.features,
      });
    }
  }
  return contexts;
}
