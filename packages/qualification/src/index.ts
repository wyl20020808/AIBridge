/**
 * `@aibridge/qualification` — provider live-qualification model (Stage 8).
 *
 * This package turns "the provider declares it supports a feature" into "a specific provider + model
 * + endpoint has been qualified through a repeatable run", with a strict separation between what is
 * declared, what a deterministic test proved, and what a real live run proved.
 *
 * It is deliberately small and portable: it depends only on `@aibridge/contracts`, holds no host
 * knowledge, opens no sockets and starts no probes. Production startup never calls it (Phase 55).
 */

export {
  QUALIFICATION_STATUSES,
  QUALIFICATION_FEATURES,
  EVIDENCE_CLASSES,
  QUALIFICATION_FAILURE_CLASSES,
  isQualificationStatus,
  isQualificationFeature,
  isEvidenceClass,
  isQualificationFailureClass,
  evidenceRank,
  canReplaceEvidence,
} from './status.js';
export type {
  QualificationStatus,
  QualificationFeature,
  EvidenceClass,
  QualificationFailureClass,
} from './status.js';

export {
  providerModelSafeRef,
  safeEndpointIdentity,
  configDigest,
  fnv1a64,
  sameIdentity,
  identityKey,
} from './identity.js';
export type { SafeEndpointIdentity, QualificationIdentity } from './identity.js';

export {
  buildQualificationRecord,
  validateQualificationRecord,
  safeUsage,
  QUALIFICATION_NOTE_CODES,
  FORBIDDEN_RECORD_KEYS,
} from './record.js';
export type {
  ProviderQualificationRecord,
  QualificationRecordInput,
  QualificationUsageProjection,
  QualificationFinishReason,
  QualificationNoteCode,
  RecordValidationIssue,
} from './record.js';

export {
  STALENESS_REASONS,
  evaluateStaleness,
  applyStaleness,
} from './staleness.js';
export type { StalenessReason, StalenessVerdict, CurrentQualificationContext } from './staleness.js';

export {
  InMemoryQualificationStore,
  DEFAULT_QUALIFICATION_RETENTION,
  QUALIFICATION_STORE_FORMAT_VERSION,
} from './store.js';
export type { QualificationStorePort, QualificationStoreOptions } from './store.js';

export {
  FileQualificationStore,
  serializeQualificationDocument,
  parseQualificationDocument,
} from './file-store.js';
export type {
  QualificationFileIo,
  QualificationFileStoreOptions,
  QualificationFileDocument,
} from './file-store.js';

export {
  ProviderQualificationRunner,
  validateQualificationRequest,
} from './runner.js';
export type {
  QualificationRequest,
  QualificationRunnerOptions,
  FeatureProbe,
  ProbeResult,
  ProbeSuccess,
  ProbeFailure,
  ConfigValidationIssue,
} from './runner.js';

export {
  getQualificationStatus,
  statusSatisfiesPolicy,
  QUALIFICATION_POLICIES,
  DEFAULT_QUALIFICATION_POLICY,
} from './diagnostics.js';
export type {
  FeatureQualificationView,
  ModelQualificationView,
  ProviderQualificationView,
  QualificationStatusInput,
  QualificationPolicy,
} from './diagnostics.js';

export { classifyQualificationFailure, isFixableInAIBridge } from './classify.js';
export type { FailureSignal } from './classify.js';

export {
  deriveQualificationContexts,
  declaredQualificationFeatures,
} from './config-context.js';
export type {
  QualificationConfigProvider,
  QualificationConfigModel,
  QualificationConfigEndpoint,
} from './config-context.js';
