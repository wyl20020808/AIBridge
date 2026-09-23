/**
 * The AI Bridge error vocabulary (ARCHITECTURE.md §6, INTEGRATION_CONTRACT_V1.md §7).
 *
 * One stable, closed vocabulary. Provider prose, status codes, response bodies and headers are
 * **never** part of it (the non-penetration rule, ARCHITECTURE.md §6.4).
 *
 * This module owns the closed sets and their default classifications. It has no runtime
 * dependencies beyond itself, so it stays portable.
 */

/** The twelve codes. Adding a code is a **major** contract change. */
export const AI_ERROR_CODES = [
  'UNAVAILABLE',
  'TIMEOUT',
  'RATE_LIMITED',
  'QUOTA_EXCEEDED',
  'INVALID_REQUEST',
  'INVALID_RESPONSE',
  'SCHEMA_MISMATCH',
  'PROVIDER_ERROR',
  'MODEL_UNAVAILABLE',
  'CONTENT_BLOCKED',
  'CANCELLED',
  'INTERNAL',
] as const;

export type AiErrorCode = (typeof AI_ERROR_CODES)[number];

/**
 * The eleven pipeline stages from ARCHITECTURE.md §6.1, plus `INTERNAL`.
 *
 * `INTERNAL` is included because §6.2 already groups reasons under an `INTERNAL` label while §6.1
 * omits it — a documentation gap reconciled here. `INTERNAL` is not a pipeline position; it marks
 * an error the bridge could not attribute to a stage. Recorded as a minor contract change.
 */
export const AI_ERROR_STAGES = [
  'ENVELOPE',
  'PERMISSION',
  'INPUT_SAFETY',
  'ROUTING',
  'PROVIDER',
  'EXTRACTION',
  'VALIDATION',
  'POLICY',
  'DEADLINE',
  'GOVERNANCE',
  'CANCELLATION',
  'INTERNAL',
] as const;

export type AiErrorStage = (typeof AI_ERROR_STAGES)[number];

/**
 * The closed reason set (ARCHITECTURE.md §6.2), plus three Stage 2 additions:
 *
 *  - `TRUSTED_FIELD_IN_CONSUMER_REQUEST` — the consumer/trusted-context split (Stage 2, §3).
 *  - `OUTPUT_SCHEMA_OVERRIDE_FORBIDDEN` — a caller may not replace a specialized capability's
 *    output schema (Stage 2, §10).
 *  - `JSON_PARSE_FAILED` — a distinct, stable reason for extraction's parse step (Stage 2, §19).
 *  - `PROVIDER_AUTH_FAILED`, `PROVIDER_REQUEST_REJECTED`, `PROVIDER_UNAVAILABLE` — Stage 3, so that
 *    every closed `ProviderCategory` maps to exactly one reason and a provider-side failure is
 *    never misreported as a consumer bug or as upstream garbage.
 *
 * Adding a reason or a detail key is a **minor** change.
 */
export const AI_ERROR_REASONS = [
  // ENVELOPE
  'CONTRACT_VERSION_UNSUPPORTED',
  'MALFORMED_ENVELOPE',
  'CAPABILITY_UNKNOWN',
  'CAPABILITY_VERSION_UNSUPPORTED',
  'OUTPUT_SCHEMA_UNSUPPORTED',
  'OUTPUT_SCHEMA_OVERRIDE_FORBIDDEN',
  'METADATA_NOT_ALLOWED',
  'IDEMPOTENCY_CONFLICT',
  'TRUSTED_FIELD_IN_CONSUMER_REQUEST',
  // PERMISSION
  'CALLER_NOT_PERMITTED',
  'SUBJECT_MISSING',
  // INPUT_SAFETY
  'INPUT_TOO_LARGE',
  'SECRET_LIKE_INPUT',
  // GOVERNANCE
  'KILL_SWITCH_GLOBAL',
  'KILL_SWITCH_PROVIDER',
  'KILL_SWITCH_CAPABILITY',
  'RATE_LIMIT_SUBJECT',
  'RATE_LIMIT_CALLER',
  'RATE_LIMIT_CAPABILITY',
  'RATE_LIMIT_PROVIDER',
  'QUOTA_SUBJECT',
  'QUOTA_CALLER',
  'QUOTA_GLOBAL',
  // ROUTING
  'NO_ROUTE',
  'MODEL_UNAVAILABLE',
  'ROUTE_EXHAUSTED',
  // DEADLINE
  'BUDGET_EXHAUSTED',
  // PROVIDER
  'PROVIDER_OVERLOADED',
  'PROVIDER_THROTTLED',
  'PROVIDER_TIMEOUT',
  'PROVIDER_BAD_RESPONSE',
  'PROVIDER_CONTENT_FILTER',
  'PROVIDER_AUTH_FAILED',
  'PROVIDER_REQUEST_REJECTED',
  'PROVIDER_UNAVAILABLE',
  // EXTRACTION
  'EXTRACTION_FAILED',
  'JSON_PARSE_FAILED',
  'OUTPUT_TOO_LARGE',
  // VALIDATION
  'SCHEMA_VALIDATION_FAILED',
  'OUTPUT_REPAIR_EXHAUSTED',
  // POLICY
  'POLICY_VIOLATION',
  // CANCELLATION
  'CANCELLED_BY_CALLER',
  'CANCELLED_BY_HOST',
  // INTERNAL
  'INTERNAL_ERROR',
] as const;

export type AiErrorReason = (typeof AI_ERROR_REASONS)[number];

/** The canonical code, stage and retryability for a reason. */
export type ReasonMeta = {
  readonly code: AiErrorCode;
  readonly stage: AiErrorStage;
  readonly retryable: boolean;
};

/**
 * The authoritative reason → (code, stage, retryable) table.
 *
 * `KILL_SWITCH_*` maps to `MODEL_UNAVAILABLE` / `GOVERNANCE`, matching the frozen
 * `education.idea.evaluate.response.unavailable.json` fixture.
 */
export const REASON_META: Readonly<Record<AiErrorReason, ReasonMeta>> = {
  CONTRACT_VERSION_UNSUPPORTED: { code: 'INVALID_REQUEST', stage: 'ENVELOPE', retryable: false },
  MALFORMED_ENVELOPE: { code: 'INVALID_REQUEST', stage: 'ENVELOPE', retryable: false },
  CAPABILITY_UNKNOWN: { code: 'INVALID_REQUEST', stage: 'ENVELOPE', retryable: false },
  CAPABILITY_VERSION_UNSUPPORTED: { code: 'INVALID_REQUEST', stage: 'ENVELOPE', retryable: false },
  OUTPUT_SCHEMA_UNSUPPORTED: { code: 'INVALID_REQUEST', stage: 'ENVELOPE', retryable: false },
  OUTPUT_SCHEMA_OVERRIDE_FORBIDDEN: { code: 'INVALID_REQUEST', stage: 'ENVELOPE', retryable: false },
  METADATA_NOT_ALLOWED: { code: 'INVALID_REQUEST', stage: 'ENVELOPE', retryable: false },
  IDEMPOTENCY_CONFLICT: { code: 'INVALID_REQUEST', stage: 'ENVELOPE', retryable: false },
  TRUSTED_FIELD_IN_CONSUMER_REQUEST: { code: 'INVALID_REQUEST', stage: 'ENVELOPE', retryable: false },

  CALLER_NOT_PERMITTED: { code: 'INVALID_REQUEST', stage: 'PERMISSION', retryable: false },
  SUBJECT_MISSING: { code: 'INVALID_REQUEST', stage: 'PERMISSION', retryable: false },

  INPUT_TOO_LARGE: { code: 'INVALID_REQUEST', stage: 'INPUT_SAFETY', retryable: false },
  SECRET_LIKE_INPUT: { code: 'INVALID_REQUEST', stage: 'INPUT_SAFETY', retryable: false },

  KILL_SWITCH_GLOBAL: { code: 'MODEL_UNAVAILABLE', stage: 'GOVERNANCE', retryable: false },
  KILL_SWITCH_PROVIDER: { code: 'MODEL_UNAVAILABLE', stage: 'GOVERNANCE', retryable: false },
  KILL_SWITCH_CAPABILITY: { code: 'MODEL_UNAVAILABLE', stage: 'GOVERNANCE', retryable: false },
  RATE_LIMIT_SUBJECT: { code: 'RATE_LIMITED', stage: 'GOVERNANCE', retryable: true },
  RATE_LIMIT_CALLER: { code: 'RATE_LIMITED', stage: 'GOVERNANCE', retryable: true },
  RATE_LIMIT_CAPABILITY: { code: 'RATE_LIMITED', stage: 'GOVERNANCE', retryable: true },
  RATE_LIMIT_PROVIDER: { code: 'RATE_LIMITED', stage: 'GOVERNANCE', retryable: true },
  QUOTA_SUBJECT: { code: 'QUOTA_EXCEEDED', stage: 'GOVERNANCE', retryable: false },
  QUOTA_CALLER: { code: 'QUOTA_EXCEEDED', stage: 'GOVERNANCE', retryable: false },
  QUOTA_GLOBAL: { code: 'QUOTA_EXCEEDED', stage: 'GOVERNANCE', retryable: false },

  NO_ROUTE: { code: 'UNAVAILABLE', stage: 'ROUTING', retryable: true },
  MODEL_UNAVAILABLE: { code: 'MODEL_UNAVAILABLE', stage: 'ROUTING', retryable: false },
  ROUTE_EXHAUSTED: { code: 'UNAVAILABLE', stage: 'ROUTING', retryable: true },

  BUDGET_EXHAUSTED: { code: 'TIMEOUT', stage: 'DEADLINE', retryable: true },

  PROVIDER_OVERLOADED: { code: 'PROVIDER_ERROR', stage: 'PROVIDER', retryable: true },
  PROVIDER_THROTTLED: { code: 'RATE_LIMITED', stage: 'PROVIDER', retryable: true },
  PROVIDER_TIMEOUT: { code: 'TIMEOUT', stage: 'PROVIDER', retryable: true },
  PROVIDER_BAD_RESPONSE: { code: 'INVALID_RESPONSE', stage: 'PROVIDER', retryable: true },
  PROVIDER_CONTENT_FILTER: { code: 'CONTENT_BLOCKED', stage: 'PROVIDER', retryable: false },
  PROVIDER_AUTH_FAILED: { code: 'PROVIDER_ERROR', stage: 'PROVIDER', retryable: false },
  PROVIDER_REQUEST_REJECTED: { code: 'INVALID_REQUEST', stage: 'PROVIDER', retryable: false },
  PROVIDER_UNAVAILABLE: { code: 'PROVIDER_ERROR', stage: 'PROVIDER', retryable: true },

  EXTRACTION_FAILED: { code: 'INVALID_RESPONSE', stage: 'EXTRACTION', retryable: true },
  JSON_PARSE_FAILED: { code: 'INVALID_RESPONSE', stage: 'EXTRACTION', retryable: true },
  OUTPUT_TOO_LARGE: { code: 'SCHEMA_MISMATCH', stage: 'EXTRACTION', retryable: false },

  SCHEMA_VALIDATION_FAILED: { code: 'SCHEMA_MISMATCH', stage: 'VALIDATION', retryable: false },
  OUTPUT_REPAIR_EXHAUSTED: { code: 'SCHEMA_MISMATCH', stage: 'VALIDATION', retryable: false },

  POLICY_VIOLATION: { code: 'CONTENT_BLOCKED', stage: 'POLICY', retryable: false },

  CANCELLED_BY_CALLER: { code: 'CANCELLED', stage: 'CANCELLATION', retryable: false },
  CANCELLED_BY_HOST: { code: 'CANCELLED', stage: 'CANCELLATION', retryable: false },

  INTERNAL_ERROR: { code: 'INTERNAL', stage: 'INTERNAL', retryable: false },
};

/** Per-code default retryability (ARCHITECTURE.md §6.3). Reason-level default overrides it. */
export const RETRYABLE_BY_CODE: Readonly<Record<AiErrorCode, boolean>> = {
  UNAVAILABLE: true,
  TIMEOUT: true,
  RATE_LIMITED: true,
  QUOTA_EXCEEDED: false,
  INVALID_REQUEST: false,
  INVALID_RESPONSE: true,
  SCHEMA_MISMATCH: false,
  // `PROVIDER_ERROR` is retryable only when the mapped category is OVERLOADED; the reason-level
  // default (`PROVIDER_OVERLOADED`) carries that, so the bare code default is `false`.
  PROVIDER_ERROR: false,
  MODEL_UNAVAILABLE: false,
  CONTENT_BLOCKED: false,
  CANCELLED: false,
  INTERNAL: false,
};

/**
 * The reason-level retryability, falling back to the code default.
 * `retryable` is authoritative for the caller and may be set explicitly on an `AiError`.
 */
export function defaultRetryable(code: AiErrorCode, reason?: AiErrorReason): boolean {
  if (reason !== undefined) {
    return REASON_META[reason].retryable;
  }
  return RETRYABLE_BY_CODE[code];
}

/**
 * Fallback eligibility per code (ARCHITECTURE.md §10.1, INTEGRATION_CONTRACT_V1.md §7.2).
 *
 * `'CONFIGURED'` means "only when the capability route opts in". `PROVIDER_ERROR` is listed as
 * eligible, but the caller must also check `error.retryable` — a non-OVERLOADED provider error
 * must not be quietly retried elsewhere.
 */
export const FALLBACK_BY_CODE: Readonly<Record<AiErrorCode, 'YES' | 'NO' | 'CONFIGURED'>> = {
  UNAVAILABLE: 'YES',
  TIMEOUT: 'YES',
  RATE_LIMITED: 'CONFIGURED',
  QUOTA_EXCEEDED: 'CONFIGURED',
  INVALID_REQUEST: 'NO',
  INVALID_RESPONSE: 'NO',
  SCHEMA_MISMATCH: 'NO',
  PROVIDER_ERROR: 'YES',
  MODEL_UNAVAILABLE: 'YES',
  CONTENT_BLOCKED: 'NO',
  CANCELLED: 'NO',
  INTERNAL: 'NO',
};

export type FallbackOptions = {
  readonly fallbackOnRateLimit?: boolean;
  readonly fallbackOnQuotaExceeded?: boolean;
};

/**
 * Whether another provider may serve this request.
 *
 * Rule: *if the failure is a property of the request or the content, do not spend another
 * provider's money on it* (ARCHITECTURE.md §10.2).
 */
export function fallbackEligibility(code: AiErrorCode, options: FallbackOptions = {}): boolean {
  switch (code) {
    case 'UNAVAILABLE':
    case 'TIMEOUT':
    case 'MODEL_UNAVAILABLE':
      return true;
    case 'PROVIDER_ERROR':
      // Eligible only when `retryable` is true; the caller checks `error.retryable`.
      return true;
    case 'RATE_LIMITED':
      return options.fallbackOnRateLimit === true;
    case 'QUOTA_EXCEEDED':
      return options.fallbackOnQuotaExceeded === true;
    default:
      return false;
  }
}

/** Mapped upstream categories. A category may cross the boundary; a message never does. */
export const PROVIDER_CATEGORIES = [
  'RATE_LIMIT',
  'AUTH',
  'OVERLOADED',
  'BAD_REQUEST',
  'CONTENT_FILTER',
  'UPSTREAM',
  'UNKNOWN',
] as const;

export type ProviderCategory = (typeof PROVIDER_CATEGORIES)[number];

/**
 * A value type safe to expose in `AiError.details`.
 * Strings, finite numbers and booleans only — never an object, never an array.
 */
export type SafeDetailValue = string | number | boolean;

/** The closed inner record carried by `AiError.details`. */
export type SafeDetails = Readonly<Record<string, SafeDetailValue>>;

/**
 * The closed per-reason detail-key allow-list. A reason absent here allows **no** detail keys.
 * Deny-by-default: an unlisted key is a `MALFORMED_ENVELOPE` rejection, not a silent drop.
 */
export const DETAIL_KEYS_BY_REASON: Readonly<Partial<Record<AiErrorReason, readonly string[]>>> = {
  CONTRACT_VERSION_UNSUPPORTED: ['expectedMajor', 'actualVersion'],
  MALFORMED_ENVELOPE: ['field'],
  CAPABILITY_UNKNOWN: ['capability'],
  CAPABILITY_VERSION_UNSUPPORTED: ['capability', 'expectedMajor', 'actualVersion'],
  OUTPUT_SCHEMA_UNSUPPORTED: ['schemaId', 'version', 'dialect'],
  OUTPUT_SCHEMA_OVERRIDE_FORBIDDEN: ['capability'],
  METADATA_NOT_ALLOWED: ['key'],
  IDEMPOTENCY_CONFLICT: ['idempotencyKey'],
  TRUSTED_FIELD_IN_CONSUMER_REQUEST: ['field'],

  CALLER_NOT_PERMITTED: ['capability'],
  SUBJECT_MISSING: [],

  INPUT_TOO_LARGE: ['maxInputBytes', 'actualBytes'],
  SECRET_LIKE_INPUT: ['pattern', 'field'],

  KILL_SWITCH_GLOBAL: [],
  KILL_SWITCH_PROVIDER: ['providerId'],
  KILL_SWITCH_CAPABILITY: ['capability'],

  RATE_LIMIT_SUBJECT: ['dimension', 'limit', 'windowMs'],
  RATE_LIMIT_CALLER: ['dimension', 'limit', 'windowMs'],
  RATE_LIMIT_CAPABILITY: ['dimension', 'limit', 'windowMs'],
  RATE_LIMIT_PROVIDER: ['dimension', 'limit', 'windowMs'],
  QUOTA_SUBJECT: ['dimension', 'period', 'limit'],
  QUOTA_CALLER: ['dimension', 'period', 'limit'],
  QUOTA_GLOBAL: ['dimension', 'period', 'limit'],

  NO_ROUTE: ['profile'],
  MODEL_UNAVAILABLE: ['profile'],
  ROUTE_EXHAUSTED: ['profile'],

  BUDGET_EXHAUSTED: ['remainingMs'],

  PROVIDER_OVERLOADED: ['providerCategory'],
  PROVIDER_THROTTLED: ['providerCategory'],
  PROVIDER_TIMEOUT: ['providerCategory'],
  PROVIDER_BAD_RESPONSE: ['providerCategory'],
  PROVIDER_CONTENT_FILTER: ['providerCategory'],
  PROVIDER_AUTH_FAILED: ['providerCategory'],
  PROVIDER_REQUEST_REJECTED: ['providerCategory'],
  PROVIDER_UNAVAILABLE: ['providerCategory'],

  EXTRACTION_FAILED: ['strategy'],
  JSON_PARSE_FAILED: ['position'],
  OUTPUT_TOO_LARGE: ['maxOutputBytes', 'actualBytes'],

  SCHEMA_VALIDATION_FAILED: ['issueCount', 'firstPath', 'firstIssueCode'],
  OUTPUT_REPAIR_EXHAUSTED: ['issueCount', 'firstPath', 'firstIssueCode', 'providerCategory'],

  POLICY_VIOLATION: ['rule'],

  CANCELLED_BY_CALLER: [],
  CANCELLED_BY_HOST: [],

  INTERNAL_ERROR: [],
};

/** The detail keys allowed for a reason. An unknown reason allows nothing. */
export function allowedDetailKeys(reason: AiErrorReason | undefined): readonly string[] {
  if (reason === undefined) {
    return [];
  }
  return DETAIL_KEYS_BY_REASON[reason] ?? [];
}

/** A normalized, consumer-safe error. Provider prose never appears in any field. */
export type AiError = {
  readonly code: AiErrorCode;
  /** Sanitized bridge-authored wording. Never provider prose, never a stack trace, never a URL. */
  readonly message: string;
  /** Authoritative for the caller. Overrides `RETRYABLE_BY_CODE` when the bridge knows better. */
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly stage: AiErrorStage;
  /** The closed sub-reason, when the bridge can be specific. */
  readonly reason?: AiErrorReason;
  /** Closed keys per reason (`SafeDetails`). */
  readonly details?: SafeDetails;
};

/** Input to `makeAiError`. `code`, `stage` and `retryable` default from `REASON_META`. */
export type AiErrorInput = {
  readonly reason: AiErrorReason;
  readonly message: string;
  readonly code?: AiErrorCode;
  readonly stage?: AiErrorStage;
  readonly retryable?: boolean;
  readonly retryAfterMs?: number;
  readonly details?: SafeDetails;
};

/** Build an `AiError`, filling code, stage and retryability from the reason's canonical meta. */
export function makeAiError(input: AiErrorInput): AiError {
  const meta = REASON_META[input.reason];
  return {
    code: input.code ?? meta.code,
    message: input.message,
    retryable: input.retryable ?? meta.retryable,
    stage: input.stage ?? meta.stage,
    reason: input.reason,
    ...(input.retryAfterMs === undefined ? {} : { retryAfterMs: input.retryAfterMs }),
    ...(input.details === undefined ? {} : { details: input.details }),
  };
}

export function isAiErrorCode(value: unknown): value is AiErrorCode {
  return typeof value === 'string' && (AI_ERROR_CODES as readonly string[]).includes(value);
}

export function isAiErrorStage(value: unknown): value is AiErrorStage {
  return typeof value === 'string' && (AI_ERROR_STAGES as readonly string[]).includes(value);
}

export function isAiErrorReason(value: unknown): value is AiErrorReason {
  return typeof value === 'string' && (AI_ERROR_REASONS as readonly string[]).includes(value);
}

export function isProviderCategory(value: unknown): value is ProviderCategory {
  return typeof value === 'string' && (PROVIDER_CATEGORIES as readonly string[]).includes(value);
}

/**
 * The default `category → reason` mapping (Stage 3).
 *
 * An adapter may name a more specific reason on `ProviderRawError.reason`; when it does not, this
 * table gives the closed categories exactly one home each, so two adapters cannot disagree about
 * what "AUTH" means. `REASON_META` remains the single source for code, stage and retryability.
 */
export const REASON_BY_PROVIDER_CATEGORY: Readonly<Record<ProviderCategory, AiErrorReason>> = {
  RATE_LIMIT: 'PROVIDER_THROTTLED',
  AUTH: 'PROVIDER_AUTH_FAILED',
  OVERLOADED: 'PROVIDER_OVERLOADED',
  BAD_REQUEST: 'PROVIDER_REQUEST_REJECTED',
  CONTENT_FILTER: 'PROVIDER_CONTENT_FILTER',
  UPSTREAM: 'PROVIDER_UNAVAILABLE',
  UNKNOWN: 'PROVIDER_UNAVAILABLE',
};

/** The generic reason a mapped provider failure normalizes to. */
export function reasonForProviderCategory(category: ProviderCategory): AiErrorReason {
  return REASON_BY_PROVIDER_CATEGORY[category];
}
