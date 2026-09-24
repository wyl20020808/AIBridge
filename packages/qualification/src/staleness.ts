/**
 * Qualification staleness (Stage 8, Phases 6, 31, 36).
 *
 * A qualification is a historical fact, not a live promise. It describes what was true for a
 * specific (provider, model, endpoint, adapter, contract, config) tuple at a moment in time. When
 * any part of that tuple moves, the old record must not keep advertising LIVE_QUALIFIED.
 *
 * This module is deliberately pure: it compares a stored record against the *current* identity and
 * evidence inputs and reports whether the record is stale, and why. It never mutates storage.
 *
 * Phase 31 separation: staleness is a qualification concern. It must never be conflated with runtime
 * health (a healthy provider with a stale qual is still healthy; an unhealthy provider with a fresh
 * qual still has that historical qual).
 */

import type { ProviderQualificationRecord } from './record.js';
import type { QualificationIdentity } from './identity.js';
import { sameIdentity } from './identity.js';

export const STALENESS_REASONS = [
  'ADAPTER_VERSION_CHANGED',
  'CONTRACT_VERSION_CHANGED',
  'PROVIDER_MODEL_CHANGED',
  'ENDPOINT_CHANGED',
  'CLUSTER_CHANGED',
  'CONFIG_DIGEST_CHANGED',
  'MODEL_FEATURE_DECLARATION_CHANGED',
  'AGE_EXCEEDED',
] as const;

export type StalenessReason = (typeof STALENESS_REASONS)[number];

export type StalenessVerdict = {
  readonly stale: boolean;
  readonly reasons: readonly StalenessReason[];
};

/**
 * Inputs describing "now" for the identity a stored record claims to describe. Any field left
 * undefined is simply not compared (used by tests to isolate one drift axis at a time).
 */
export type CurrentQualificationContext = {
  readonly identity: QualificationIdentity;
  readonly adapterVersion: string;
  readonly contractVersion: string;
  /** Declared features for this model right now; a removed/changed declaration invalidates. */
  readonly declaredFeatures: readonly string[];
  /** Optional age bound in ms (STALE_BY_AGE). V1 ships no automatic age expiry by default. */
  readonly maxAgeMs?: number;
  readonly nowMs?: number;
};

/**
 * Evaluate whether `record` still describes the current context. Reasons accumulate so an operator
 * sees every drift axis at once.
 */
export function evaluateStaleness(
  record: ProviderQualificationRecord,
  current: CurrentQualificationContext,
): StalenessVerdict {
  const reasons: StalenessReason[] = [];
  const stored = record.identity;
  const now = current.identity;

  if (stored.providerId !== now.providerId || stored.modelAlias !== now.modelAlias) {
    // A record for a different provider/model is entirely unrelated; treat as stale.
    reasons.push('PROVIDER_MODEL_CHANGED');
  }

  if (stored.providerModelSafeRef !== now.providerModelSafeRef) {
    // Phase 36: same alias, changed provider model id ⇒ old qualification is stale.
    reasons.push('PROVIDER_MODEL_CHANGED');
  }

  if (!sameEndpoint(stored, now)) {
    reasons.push('ENDPOINT_CHANGED');
  }

  if ((stored.cluster ?? '') !== (now.cluster ?? '')) {
    reasons.push('CLUSTER_CHANGED');
  }

  if (stored.adapterVersion !== current.adapterVersion) {
    reasons.push('ADAPTER_VERSION_CHANGED');
  }

  if (stored.contractVersion !== current.contractVersion) {
    reasons.push('CONTRACT_VERSION_CHANGED');
  }

  if (stored.configDigest !== now.configDigest) {
    reasons.push('CONFIG_DIGEST_CHANGED');
  }

  if (!sameIdentity(stored, now)) {
    // Any residual identity difference is a config-level change.
    if (!reasons.includes('CONFIG_DIGEST_CHANGED')) {
      reasons.push('CONFIG_DIGEST_CHANGED');
    }
  }

  if (!declarationMatches(record, current)) {
    reasons.push('MODEL_FEATURE_DECLARATION_CHANGED');
  }

  if (current.maxAgeMs !== undefined && record.qualifiedAt !== undefined && current.nowMs !== undefined) {
    if (current.nowMs - record.qualifiedAt > current.maxAgeMs) {
      reasons.push('AGE_EXCEEDED');
    }
  }

  const unique = [...new Set(reasons)];
  return { stale: unique.length > 0, reasons: unique };
}

function sameEndpoint(a: QualificationIdentity, b: QualificationIdentity): boolean {
  return (
    a.endpoint.scheme === b.endpoint.scheme &&
    a.endpoint.host === b.endpoint.host &&
    (a.endpoint.port ?? null) === (b.endpoint.port ?? null) &&
    a.endpointKind === b.endpointKind
  );
}

/**
 * A feature-declaration change invalidates the record: a record that was never about a feature, or a
 * feature the model no longer declares, cannot stand. This uses the record's own feature plus the
 * current declared set.
 */
function declarationMatches(
  record: ProviderQualificationRecord,
  current: CurrentQualificationContext,
): boolean {
  // A declaration change is only observable if we know what was declared then. We approximate with
  // the current declared list plus the record's feature: if the record's feature is no longer
  // declared at all, the declaration changed. Requiring the exact historical list would need a
  // second digest, which the config digest already covers via declaredFeatures.
  const declared = new Set<string>(current.declaredFeatures);
  if (record.status === 'DECLARED' || record.status === 'DETERMINISTIC_TESTED' || record.status === 'LIVE_QUALIFIED' || record.status === 'LIVE_FAILED') {
    return declared.has(record.identity.feature);
  }
  // UNSUPPORTED / LIVE_NOT_RUN / STALE carry no positive claim; declaration drift via digest.
  return true;
}

/** Convenience: apply staleness to a status, demoting a positive claim to STALE (Phase 6). */
export function applyStaleness(
  record: ProviderQualificationRecord,
  current: CurrentQualificationContext,
): ProviderQualificationRecord & { readonly staleness: StalenessVerdict } {
  const staleness = evaluateStaleness(record, current);
  if (!staleness.stale) {
    return { ...record, staleness };
  }
  return { ...record, status: 'STALE', staleness };
}
