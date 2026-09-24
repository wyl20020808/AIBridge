/**
 * The **consumer** request — the untrusted half of the split.
 *
 * A consumer may state what it wants. It may **not** state who it is, what it is allowed to do,
 * or which subject it acts for. Those fields are trusted-only and are rejected here with
 * `TRUSTED_FIELD_IN_CONSUMER_REQUEST` (or, for other forbidden fields, `MALFORMED_ENVELOPE`).
 *
 * The trusted half lives in `TrustedDispatchContext` and is injected by the host/broker. Composing
 * the two is `composeAiRequest` (see `context.ts`). This is the Stage 2 formalization of
 * AGENTS.md §4: a consumer must not be able to forge identity, permission or subject.
 */
import type { AiErrorReason } from './errors.js';
import { describe, isRecord } from './guards.js';
import type { ValidationIssue, ValidationResult } from './issue.js';
import { at, createIssue, invalid, valid } from './issue.js';
import { parseRequestMetadata, type RequestMetadata } from './metadata.js';
import { parseModelProfile, type ModelProfile } from './profile.js';
import { parseCapabilityRequirements, type CapabilityRequirements } from './requirements.js';
import { parseOutputSchema, type OutputSchema } from './schema.js';
import { parseTimeoutBudget, type TimeoutBudget } from './timeout.js';
import { checkMajorCompatibility, AIBRIDGE_CONTRACT_VERSION } from './versions.js';

/** The frozen consumer-visible field set. */
export const CONSUMER_AI_REQUEST_KEYS = [
  'contractVersion',
  'requestId',
  'idempotencyKey',
  'capability',
  'capabilityVersion',
  'profile',
  'requirements',
  'input',
  'outputSchema',
  'policyId',
  'timeoutBudget',
  'metadata',
  'promptApplied',
  'promptVersion',
] as const;

/** Opaque caller-side prompt provenance version: `^[A-Za-z0-9._-]{1,64}$`. Never prompt content. */
export const PROMPT_VERSION_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Fields a consumer must never be able to set. Their presence is a hard rejection, not a drop:
 * silently ignoring a forged `callerPluginId` would hide an attempted privilege escalation.
 */
export const TRUSTED_ONLY_FIELDS = [
  'callerPluginId',
  'subjectToken',
  'grantedPermissions',
  'permissions',
  'hostRequestId',
  'principal',
  'verifiedCaller',
] as const;

/**
 * Provider-shaped or override-shaped fields that have no business in a consumer request.
 * They are `MALFORMED_ENVELOPE`, because they name something a consumer never owns.
 */
export const FORBIDDEN_CONSUMER_FIELDS = [
  'apiKey',
  'api_key',
  'baseUrl',
  'endpoint',
  'model',
  'modelRef',
  'modelName',
  'providerId',
  'systemPrompt',
  'policy',
  'messages',
  'secret',
  'token',
  'credential',
  'authorization',
] as const;

export const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
/** Bounded opaque printable ASCII; allows delimiters such as AlgoQuest's `task:command` form. */
export const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7E]{1,128}$/;
export const POLICY_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export type ConsumerAiRequest<TInput = unknown> = {
  readonly contractVersion: string;
  /** Unique per attempt. Echoed back verbatim. */
  readonly requestId: string;
  /** One logical turn ⇒ one billable call. Scoped to `(callerPluginId, capability, capabilityVersion)`. */
  readonly idempotencyKey: string;
  readonly capability: string;
  readonly capabilityVersion: string;
  readonly profile: ModelProfile;
  readonly requirements?: CapabilityRequirements;
  readonly input: TInput;
  /**
   * Only a generic structured capability allows a caller-supplied output schema. A specialized
   * capability owns its own schema; supplying one is `OUTPUT_SCHEMA_OVERRIDE_FORBIDDEN`.
   */
  readonly outputSchema?: OutputSchema;
  /** Selects a registered policy. Never supplies policy content. */
  readonly policyId?: string;
  readonly timeoutBudget?: TimeoutBudget;
  readonly metadata?: RequestMetadata;
  /**
   * Prompt provenance (Stage 6, additive): did the caller compose `instructions` with an
   * authored business prompt? Opaque pass-through — the bridge never generates business prompts
   * and never reads prompt content.
   */
  readonly promptApplied?: boolean;
  /** The caller's opaque prompt version identifier. Never prompt content. */
  readonly promptVersion?: string;
};

export type ParseConsumerAiRequestOptions = {
  /** Expected contract version. Defaults to `AIBRIDGE_CONTRACT_VERSION`. */
  readonly expectedContractVersion?: string;
};

/** Reason precedence: the most specific reason wins over the generic envelope one. */
const REASON_PRECEDENCE: readonly AiErrorReason[] = [
  'CONTRACT_VERSION_UNSUPPORTED',
  'METADATA_NOT_ALLOWED',
  'OUTPUT_SCHEMA_UNSUPPORTED',
  'IDEMPOTENCY_CONFLICT',
  'MALFORMED_ENVELOPE',
];

/**
 * Parse an untrusted consumer request.
 *
 * Trusted-only and forbidden fields are rejected **before** any field is read, so a caller cannot
 * "pass validation anyway" by also sending good fields.
 */
export function parseConsumerAiRequest<TInput = unknown>(
  value: unknown,
  options: ParseConsumerAiRequestOptions = {},
  path = '$',
): ValidationResult<ConsumerAiRequest<TInput>> {
  if (!isRecord(value)) {
    return invalid('MALFORMED_ENVELOPE', [createIssue('INVALID_TYPE', path, `must be an object, got ${describe(value)}`)]);
  }
  const issues: ValidationIssue[] = [];
  const trustedIssues: ValidationIssue[] = [];
  let reason: AiErrorReason = 'MALFORMED_ENVELOPE';

  const noteReason = (candidate: AiErrorReason): void => {
    const currentIndex = REASON_PRECEDENCE.indexOf(reason);
    const candidateIndex = REASON_PRECEDENCE.indexOf(candidate);
    if (candidateIndex !== -1 && (currentIndex === -1 || candidateIndex < currentIndex)) {
      reason = candidate;
    }
  };

  for (const key of Object.keys(value).sort()) {
    if ((TRUSTED_ONLY_FIELDS as readonly string[]).includes(key)) {
      trustedIssues.push(createIssue('TRUSTED_FIELD', at(path, key), 'is a host-bound field and must not appear in a consumer request'));
    } else if ((FORBIDDEN_CONSUMER_FIELDS as readonly string[]).includes(key)) {
      issues.push(createIssue('FORBIDDEN_FIELD', at(path, key), 'is never part of a consumer request'));
    } else if (!(CONSUMER_AI_REQUEST_KEYS as readonly string[]).includes(key)) {
      issues.push(createIssue('UNKNOWN_FIELD', at(path, key), 'unknown consumer request field'));
    }
  }

  if (trustedIssues.length > 0) {
    // Trusted-field rejection wins over every other problem: it is the security-relevant one.
    return invalid('TRUSTED_FIELD_IN_CONSUMER_REQUEST', [...trustedIssues, ...issues]);
  }

  const expectedContractVersion = options.expectedContractVersion ?? AIBRIDGE_CONTRACT_VERSION;
  const contractVersion = value['contractVersion'];
  if (typeof contractVersion !== 'string') {
    issues.push(createIssue('MISSING_FIELD', at(path, 'contractVersion'), 'must be a version string'));
  } else {
    const compatibility = checkMajorCompatibility(contractVersion, expectedContractVersion);
    if (!compatibility.compatible) {
      issues.push(
        createIssue('UNSUPPORTED_VERSION', at(path, 'contractVersion'), `major ${String(compatibility.actualMajor)} is not supported`),
      );
      noteReason('CONTRACT_VERSION_UNSUPPORTED');
    }
  }

  const requestId = value['requestId'];
  if (typeof requestId !== 'string' || !REQUEST_ID_PATTERN.test(requestId)) {
    issues.push(createIssue('PATTERN_MISMATCH', at(path, 'requestId'), 'must match ^[A-Za-z0-9._-]{1,64}$'));
  }
  const idempotencyKey = value['idempotencyKey'];
  if (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    issues.push(createIssue('PATTERN_MISMATCH', at(path, 'idempotencyKey'), 'must match ^[A-Za-z0-9._-]{1,128}$'));
  }
  for (const key of ['capability', 'capabilityVersion'] as const) {
    if (typeof value[key] !== 'string' || (value[key] as string).length === 0) {
      issues.push(createIssue('MISSING_FIELD', at(path, key), 'must be a non-empty string'));
    }
  }

  const profile = parseModelProfile(value['profile'], at(path, 'profile'));
  if (!profile.ok) {
    issues.push(...profile.failure.issues);
  }

  let requirements: CapabilityRequirements | undefined;
  if (value['requirements'] !== undefined) {
    const parsed = parseCapabilityRequirements(value['requirements'], at(path, 'requirements'));
    if (parsed.ok) {
      requirements = parsed.value;
    } else {
      issues.push(...parsed.failure.issues);
    }
  }

  if (!Object.prototype.hasOwnProperty.call(value, 'input')) {
    issues.push(createIssue('MISSING_FIELD', at(path, 'input'), 'is required'));
  }

  let outputSchema: OutputSchema | undefined;
  if (value['outputSchema'] !== undefined) {
    const parsed = parseOutputSchema(value['outputSchema'], at(path, 'outputSchema'));
    if (parsed.ok) {
      outputSchema = parsed.value;
    } else {
      issues.push(...parsed.failure.issues);
      noteReason('OUTPUT_SCHEMA_UNSUPPORTED');
    }
  }

  let policyId: string | undefined;
  if (value['policyId'] !== undefined) {
    const rawPolicyId = value['policyId'];
    if (typeof rawPolicyId !== 'string' || !POLICY_ID_PATTERN.test(rawPolicyId)) {
      issues.push(createIssue('PATTERN_MISMATCH', at(path, 'policyId'), 'must match ^[a-z0-9][a-z0-9._-]{0,63}$'));
    } else {
      policyId = rawPolicyId;
    }
  }

  let timeoutBudget: TimeoutBudget | undefined;
  if (value['timeoutBudget'] !== undefined) {
    const parsed = parseTimeoutBudget(value['timeoutBudget'], at(path, 'timeoutBudget'));
    if (parsed.ok) {
      timeoutBudget = parsed.value;
    } else {
      issues.push(...parsed.failure.issues);
    }
  }

  let metadata: RequestMetadata | undefined;
  if (value['metadata'] !== undefined) {
    const parsed = parseRequestMetadata(value['metadata'], at(path, 'metadata'));
    if (parsed.ok) {
      metadata = parsed.value;
    } else {
      issues.push(...parsed.failure.issues);
      noteReason('METADATA_NOT_ALLOWED');
    }
  }

  const promptApplied = value['promptApplied'];
  if (promptApplied !== undefined && typeof promptApplied !== 'boolean') {
    issues.push(createIssue('INVALID_TYPE', at(path, 'promptApplied'), 'must be a boolean'));
  }
  const promptVersion = value['promptVersion'];
  if (promptVersion !== undefined && (typeof promptVersion !== 'string' || !PROMPT_VERSION_PATTERN.test(promptVersion))) {
    issues.push(createIssue('PATTERN_MISMATCH', at(path, 'promptVersion'), 'must match ^[A-Za-z0-9._-]{1,64}$'));
  }
  const promptVersionValid = typeof promptVersion === 'string' && PROMPT_VERSION_PATTERN.test(promptVersion);
  if (
    (promptApplied === true && !promptVersionValid) ||
    (promptApplied === false && promptVersion !== undefined) ||
    (promptApplied === undefined && promptVersionValid)
  ) {
    issues.push(
      createIssue('INVALID_VALUE', at(path, 'promptVersion'), 'must be present exactly when promptApplied is true'),
    );
  }

  if (issues.length > 0) {
    return invalid(reason, issues);
  }
  return valid({
    contractVersion: contractVersion as string,
    requestId: requestId as string,
    idempotencyKey: idempotencyKey as string,
    capability: value['capability'] as string,
    capabilityVersion: value['capabilityVersion'] as string,
    profile: profile.ok ? profile.value : 'balanced',
    input: value['input'] as TInput,
    ...(requirements === undefined ? {} : { requirements }),
    ...(outputSchema === undefined ? {} : { outputSchema }),
    ...(policyId === undefined ? {} : { policyId }),
    ...(timeoutBudget === undefined ? {} : { timeoutBudget }),
    ...(metadata === undefined ? {} : { metadata }),
    ...(promptApplied === undefined ? {} : { promptApplied: promptApplied as boolean }),
    ...(promptVersion === undefined ? {} : { promptVersion: promptVersion as string }),
  });
}

/** The consumer-visible body digest used for idempotency-conflict detection. */
export function consumerRequestDigest(request: ConsumerAiRequest<unknown>): string {
  return JSON.stringify({
    capability: request.capability,
    capabilityVersion: request.capabilityVersion,
    profile: request.profile,
    input: request.input,
    outputSchema: request.outputSchema ?? null,
    policyId: request.policyId ?? null,
  });
}
