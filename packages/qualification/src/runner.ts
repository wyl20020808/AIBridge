/**
 * Unified provider qualification runner (Stage 8, Phase 27).
 *
 * One runner orchestrates every provider. It does **not** know provider wire formats: the caller
 * supplies a per-feature probe that dispatches through the adapter/runtime. The runner is
 * responsible only for:
 *
 *  - validating the qualification request before running (Phase 34 → CONFIG_INVALID);
 *  - deciding, per feature, that a credential is required and turning its absence into LIVE_NOT_RUN
 *    rather than LIVE_FAILED (Phases 9, 43, 51);
 *  - timing the probe, normalizing the outcome to a safe record, and saving it (Phases 4, 5);
 *  - never letting a probe failure become a thrown error that aborts other features (Phase 43).
 */

import type { ProviderQualificationRecord, QualificationRecordInput } from './record.js';
import { buildQualificationRecord } from './record.js';
import type {
  EvidenceClass,
  QualificationFailureClass,
  QualificationFeature,
  QualificationStatus,
} from './status.js';
import type { QualificationIdentity } from './identity.js';
import type { QualificationStorePort } from './store.js';
import { InMemoryQualificationStore } from './store.js';

/** Result a probe returns on success. All fields are safe primitives. */
export type ProbeSuccess = {
  readonly ok: true;
  readonly latencyMs: number;
  readonly usageProjection?: ProviderQualificationRecord['usageProjection'];
  readonly finishReason?: ProviderQualificationRecord['finishReason'];
  readonly notes?: readonly string[];
};

/** Result a probe returns on a *live* failure. Raw provider text is never included. */
export type ProbeFailure = {
  readonly ok: false;
  /** Normalized, coarse failure classification. */
  readonly reason: QualificationFailureClass;
  readonly latencyMs?: number;
  /** Optionally, a structural assertion failed but the provider responded (e.g. stream contract). */
  readonly status?: Extract<QualificationStatus, 'LIVE_FAILED' | 'UNSUPPORTED'>;
  readonly notes?: readonly string[];
};

export type ProbeResult = ProbeSuccess | ProbeFailure;

/**
 * A probe runs one feature against a real (or deterministic) provider through the runtime. The
 * implementation stays in the provider/host layer; the runner only consumes the normalized result.
 */
export type FeatureProbe = (feature: QualificationFeature) => Promise<ProbeResult>;

export type QualificationRequest = {
  readonly identity: QualificationIdentity;
  /** Adapter version of the provider implementation under test. */
  readonly adapterVersion: string;
  /** Contract version under test. */
  readonly contractVersion: string;
  /** The features the operator asked to qualify. */
  readonly features: readonly QualificationFeature[];
  /** Evidence strength of this probe run. */
  readonly evidenceClass: EvidenceClass;
  /**
   * Whether a credential is available for this provider. When false, live probes are skipped and
   * every feature is recorded LIVE_NOT_RUN (or DECLARED for deterministic runs).
   */
  readonly credentialAvailable: boolean;
  readonly probe: FeatureProbe;
  readonly nowMs?: number;
};

/** Validation issue surfaced before a run starts (Phase 34). */
export type ConfigValidationIssue = {
  readonly reason: 'CONFIG_INVALID';
  readonly detail: string;
};

export type QualificationRunnerOptions = {
  readonly store?: QualificationStorePort;
  /** Default identity fields applied to each feature unless the request overrides `feature`. */
  readonly clock?: { nowMs(): number };
};

/**
 * Validate a qualification request before running. A failed validation is a CONFIG_INVALID outcome,
 * not a failed dispatch (Phase 34).
 */
export function validateQualificationRequest(
  request: QualificationRequest,
): readonly ConfigValidationIssue[] {
  const issues: ConfigValidationIssue[] = [];
  if (!request.identity.providerId) {
    issues.push({ reason: 'CONFIG_INVALID', detail: 'providerId is required' });
  }
  if (!request.identity.modelAlias) {
    issues.push({ reason: 'CONFIG_INVALID', detail: 'modelAlias is required' });
  }
  if (!request.identity.endpoint.host || request.identity.endpoint.host === 'unknown') {
    issues.push({ reason: 'CONFIG_INVALID', detail: 'endpoint host is not resolvable' });
  }
  if (request.features.length === 0) {
    issues.push({ reason: 'CONFIG_INVALID', detail: 'at least one feature must be requested' });
  }
  return issues;
}

/**
 * Run qualification for every requested feature and return the safe records in request order. The
 * store is written as a side effect unless one is not supplied (then an internal in-memory store is
 * used and records are only returned).
 */
export class ProviderQualificationRunner {
  readonly #store: QualificationStorePort;
  readonly #clock: { nowMs(): number };

  constructor(options: QualificationRunnerOptions = {}) {
    this.#store = options.store ?? new InMemoryQualificationStore();
    this.#clock = options.clock ?? { nowMs: () => Date.now() };
  }

  get store(): QualificationStorePort {
    return this.#store;
  }

  /** Run the request; returns records for every requested feature (never throws on probe failure). */
  async run(request: QualificationRequest): Promise<readonly ProviderQualificationRecord[]> {
    const issues = validateQualificationRequest(request);
    if (issues.length > 0) {
      // Phase 34: an invalid request is a CONFIG_INVALID outcome, not a failed dispatch.
      const record = buildQualificationRecord({
        identity: { ...request.identity, feature: request.features[0] ?? 'text' },
        status: 'LIVE_NOT_RUN',
        adapterVersion: request.adapterVersion,
        contractVersion: request.contractVersion,
        configDigest: request.identity.configDigest,
        evidenceClass: 'DECLARED',
        safeFailureReason: 'CONFIG_FAILURE',
      });
      await this.#store.save(record);
      return [record];
    }

    const records: ProviderQualificationRecord[] = [];
    for (const feature of request.features) {
      const record = await this.#runFeature(request, feature);
      await this.#store.save(record);
      records.push(record);
    }
    return records;
  }

  async #runFeature(
    request: QualificationRequest,
    feature: QualificationFeature,
  ): Promise<ProviderQualificationRecord> {
    const identity: QualificationIdentity = { ...request.identity, feature };
    const base: Omit<QualificationRecordInput, 'status'> & { status: QualificationStatus } = {
      identity,
      status: 'LIVE_NOT_RUN',
      adapterVersion: request.adapterVersion,
      contractVersion: request.contractVersion,
      configDigest: identity.configDigest,
      evidenceClass: request.evidenceClass,
    };

    if (!request.credentialAvailable && request.evidenceClass === 'LIVE') {
      // Phases 9/43/51: no credential ⇒ LIVE_NOT_RUN, never FAILED, never UNSUPPORTED.
      return buildQualificationRecord({ ...base, status: 'LIVE_NOT_RUN' });
    }

    const startedAt = this.#clock.nowMs();
    let result: ProbeResult;
    try {
      result = await request.probe(feature);
    } catch {
      // A probe that throws is a structural failure, not a crash: record it safely (Phase 43).
      return buildQualificationRecord({
        ...base,
        status: 'LIVE_FAILED',
        qualifiedAt: startedAt,
        safeFailureReason: 'ADAPTER_BUG',
      });
    }
    const finishedAt = this.#clock.nowMs();

    if (result.ok) {
      const evidence: EvidenceClass = request.evidenceClass;
      const status: QualificationStatus =
        evidence === 'LIVE' ? 'LIVE_QUALIFIED' : evidence === 'DETERMINISTIC' ? 'DETERMINISTIC_TESTED' : 'DECLARED';
      return buildQualificationRecord({
        ...base,
        status,
        qualifiedAt: finishedAt,
        evidenceClass: evidence,
        latencyMs: result.latencyMs,
        ...(result.usageProjection === undefined ? {} : { usageProjection: result.usageProjection }),
        ...(result.finishReason === undefined ? {} : { finishReason: result.finishReason }),
        ...(result.notes === undefined ? {} : { notes: result.notes }),
      });
    }

    const failureClass = result.reason;
    const status: QualificationStatus = result.status ?? 'LIVE_FAILED';
    return buildQualificationRecord({
      ...base,
      status,
      qualifiedAt: finishedAt,
      ...(result.latencyMs === undefined ? {} : { latencyMs: result.latencyMs }),
      safeFailureReason: failureClass,
      ...(result.notes === undefined ? {} : { notes: result.notes }),
    });
  }
}
