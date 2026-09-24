/**
 * Provider qualification record (Stage 8, Phases 4, 37, 38, 39).
 *
 * The record is the durable artifact of a qualification. It is deliberately a **closed, safe shape**:
 * it has no field that could carry prompt text, a full AI response, an API key, an Authorization
 * header, reasoning content or learner data. The builder accepts only safe primitives and the
 * validator re-asserts the invariant, so a malicious provider error body (Phase 39) cannot leak in.
 */

import type { QualificationFailureClass, QualificationStatus } from './status.js';
import type { QualificationIdentity } from './identity.js';

/** A safe usage projection. Unknown counts are absent, never 0 (Phase 20). */
export type QualificationUsageProjection = {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly cachedTokens?: number;
  readonly reasoningTokens?: number;
};

/** Consumer-visible finish reason, normalized to the closed contract vocabulary. */
export type QualificationFinishReason = 'STOP' | 'LENGTH' | 'CONTENT_FILTER' | 'UNKNOWN';

/** A durable, secret-free qualification record. */
export type ProviderQualificationRecord = {
  readonly qualificationId: string;
  readonly identity: QualificationIdentity;
  readonly status: QualificationStatus;
  /** Epoch ms of the qualifying run; absent for DECLARED-only records. */
  readonly qualifiedAt?: number;
  readonly adapterVersion: string;
  readonly contractVersion: string;
  readonly configDigest: string;
  readonly evidenceClass: 'DECLARED' | 'DETERMINISTIC' | 'LIVE';
  readonly latencyMs?: number;
  readonly usageProjection?: QualificationUsageProjection;
  readonly finishReason?: QualificationFinishReason;
  /** Coarse, safe failure class for a failure. Never a provider's raw message. */
  readonly safeFailureReason?: QualificationFailureClass;
  /**
   * Optional stable, non-secret operator note code (e.g. 'DECLARATION_MISMATCH', 'REPAIR_USED').
   * Never free-form text that could carry provider prose.
   */
  readonly notes?: readonly string[];
};

/** Input to {@link buildQualificationRecord}. Omits only the derived id. */
export type QualificationRecordInput = Omit<ProviderQualificationRecord, 'qualificationId'> & {
  readonly qualificationId?: string;
};

/** Note codes are a closed set so no free-form provider text can be smuggled into a record. */
export const QUALIFICATION_NOTE_CODES = [
  'DECLARATION_MISMATCH',
  'REPAIR_USED',
  'USAGE_INCONSISTENT',
  'TIMEOUT_VIA_DEADLINE',
  'CANCELLATION_VERIFIED',
  'CANCELLATION_NOT_VERIFIED',
  'LAST_KNOWN_LIVE_QUALIFIED',
] as const;

export type QualificationNoteCode = (typeof QUALIFICATION_NOTE_CODES)[number];

/**
 * Build a record. `qualificationId` is derived from the identity plus the run timestamp so the same
 * identity qualified twice yields two history entries (Phase 37) rather than overwriting.
 */
export function buildQualificationRecord(input: QualificationRecordInput): ProviderQualificationRecord {
  const identity = input.identity;
  const at = input.qualifiedAt;
  const id =
    input.qualificationId ??
    `${identity.providerId}:${identity.modelAlias}:${identity.feature}:${at ?? 'declared'}`;
  return {
    qualificationId: id,
    identity,
    status: input.status,
    ...(at === undefined ? {} : { qualifiedAt: at }),
    adapterVersion: input.adapterVersion,
    contractVersion: input.contractVersion,
    configDigest: input.configDigest,
    evidenceClass: input.evidenceClass,
    ...(input.latencyMs === undefined ? {} : { latencyMs: input.latencyMs }),
    ...(input.usageProjection === undefined ? {} : { usageProjection: safeUsage(input.usageProjection) }),
    ...(input.finishReason === undefined ? {} : { finishReason: input.finishReason }),
    ...(input.safeFailureReason === undefined ? {} : { safeFailureReason: input.safeFailureReason }),
    ...(input.notes === undefined ? {} : { notes: safeNotes(input.notes) }),
  };
}

/** Keep only finite, non-negative integer token counts. Unknown stays absent (Phase 20). */
export function safeUsage(usage: QualificationUsageProjection): QualificationUsageProjection {
  const out: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    cachedTokens?: number;
    reasoningTokens?: number;
  } = {};
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'cachedTokens', 'reasoningTokens'] as const) {
    const value = usage[key];
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
      out[key] = value;
    }
  }
  return out;
}

function safeNotes(notes: readonly string[]): readonly string[] {
  const allowed = new Set<string>(QUALIFICATION_NOTE_CODES);
  return notes.filter((note) => allowed.has(note));
}

/**
 * Fields that must never appear on a serialized qualification record. Scanned by the validator so a
 * regression that widens the shape is caught (Phases 38/39).
 */
export const FORBIDDEN_RECORD_KEYS = [
  'prompt',
  'instructions',
  'context',
  'response',
  'text',
  'reasoningContent',
  'reasoning_content',
  'apiKey',
  'authorization',
  'credential',
  'secret',
  'rawMessage',
  'stack',
  'headers',
] as const;

export type RecordValidationIssue = {
  readonly path: string;
  readonly message: string;
};

/**
 * Validate a record's shape invariants: no forbidden secret-bearing key anywhere, only known note
 * codes, non-negative integer usage. Returns issues (empty = valid).
 */
export function validateQualificationRecord(
  record: ProviderQualificationRecord,
): readonly RecordValidationIssue[] {
  const issues: RecordValidationIssue[] = [];
  const forbidden = new Set<string>(FORBIDDEN_RECORD_KEYS.map((key) => key.toLowerCase()));

  const visit = (value: unknown, path: string): void => {
    if (value === null || typeof value !== 'object') {
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (forbidden.has(key.toLowerCase())) {
        issues.push({ path: `${path}.${key}`, message: 'forbidden secret-bearing field' });
      }
      visit(child, `${path}.${key}`);
    }
  };

  visit(record, '$');

  for (const note of record.notes ?? []) {
    if (!(QUALIFICATION_NOTE_CODES as readonly string[]).includes(note)) {
      issues.push({ path: '$.notes', message: `unknown note code "${note}"` });
    }
  }

  for (const [key, value] of Object.entries(record.usageProjection ?? {})) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      issues.push({ path: `$.usageProjection.${key}`, message: 'usage counts must be non-negative integers' });
    }
  }

  return issues;
}
