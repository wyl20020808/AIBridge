/**
 * Provider qualification status vocabulary (Stage 8, Phase 3).
 *
 * A model's support is never a single boolean. The assurance ladder is:
 *
 *   DECLARED          the operator/config says the model supports the feature.
 *   DETERMINISTIC_TESTED  a deterministic test (fake transport, no network) proved it.
 *   LIVE_QUALIFIED    a real provider run against a real endpoint proved it.
 *
 * The remaining states are observations, not rungs on the ladder:
 *
 *   LIVE_FAILED       a real run ran and failed (safe, normalized reason recorded).
 *   LIVE_NOT_RUN      no credential / no run happened. **Not** a failure and **not** unsupported.
 *   UNSUPPORTED       the provider/model genuinely does not implement the feature.
 *   STALE             a qualification existed but its identity no longer matches.
 *
 * INVARIANT (Phase 51): a missing credential can only ever produce LIVE_NOT_RUN, never LIVE_FAILED.
 * INVARIANT (Phase 51): LIVE_NOT_RUN never degrades to UNSUPPORTED.
 */

export const QUALIFICATION_STATUSES = [
  'DECLARED',
  'DETERMINISTIC_TESTED',
  'LIVE_QUALIFIED',
  'LIVE_FAILED',
  'LIVE_NOT_RUN',
  'UNSUPPORTED',
  'STALE',
] as const;

export type QualificationStatus = (typeof QUALIFICATION_STATUSES)[number];

/** The provider feature a qualification record is about. Mirrors the closed provider feature set. */
export const QUALIFICATION_FEATURES = [
  'text',
  'structuredJson',
  'jsonSchema',
  'streaming',
  'reasoning',
  'usage',
  'cancellation',
] as const;

export type QualificationFeature = (typeof QUALIFICATION_FEATURES)[number];

/**
 * How the evidence behind a record was produced. Ordered weakest → strongest; a stronger evidence
 * class may overwrite a weaker one for the same identity, never the reverse.
 */
export const EVIDENCE_CLASSES = [
  'DECLARED',
  'DETERMINISTIC',
  'LIVE',
] as const;

export type EvidenceClass = (typeof EVIDENCE_CLASSES)[number];

/** Failure classification for a live run (Phase 44). Never a raw provider string. */
export const QUALIFICATION_FAILURE_CLASSES = [
  'CONFIG_FAILURE',
  'AUTH_FAILURE',
  'PROVIDER_FAILURE',
  'CAPABILITY_MISMATCH',
  'ADAPTER_BUG',
  'NETWORK_ENVIRONMENT',
] as const;

export type QualificationFailureClass = (typeof QUALIFICATION_FAILURE_CLASSES)[number];

export function isQualificationStatus(value: unknown): value is QualificationStatus {
  return typeof value === 'string' && (QUALIFICATION_STATUSES as readonly string[]).includes(value);
}

export function isQualificationFeature(value: unknown): value is QualificationFeature {
  return typeof value === 'string' && (QUALIFICATION_FEATURES as readonly string[]).includes(value);
}

export function isEvidenceClass(value: unknown): value is EvidenceClass {
  return typeof value === 'string' && (EVIDENCE_CLASSES as readonly string[]).includes(value);
}

export function isQualificationFailureClass(value: unknown): value is QualificationFailureClass {
  return (
    typeof value === 'string' && (QUALIFICATION_FAILURE_CLASSES as readonly string[]).includes(value)
  );
}

/** Rank of an evidence class for monotonic overwrite decisions. Higher wins. */
export function evidenceRank(evidence: EvidenceClass): number {
  return EVIDENCE_CLASSES.indexOf(evidence);
}

/**
 * Can a record with `incoming` evidence replace one with `existing` evidence for the same identity?
 * Evidence never weakens: a deterministic result must not erase a live qualification.
 */
export function canReplaceEvidence(existing: EvidenceClass, incoming: EvidenceClass): boolean {
  return evidenceRank(incoming) >= evidenceRank(existing);
}
