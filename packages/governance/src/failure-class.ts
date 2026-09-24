/**
 * Failure classification — the single, stable place every reliability decision reads from
 * (ROADMAP Stage 5, ARCHITECTURE.md §6, §10).
 *
 * Retry, fallback, breaker and terminal-error selection must all agree about *what kind* of thing
 * went wrong, and they must agree **without reading provider prose** (AGENTS.md §4). So the
 * classification is a pure function over the closed `AiError` vocabulary — code, stage and reason —
 * and nothing else. A provider that rewords its 503 page cannot change a routing decision.
 *
 * The classes answer one question each:
 *
 * | Class | Question it answers |
 * | --- | --- |
 * | `REQUEST` | Is the caller's request itself wrong? |
 * | `CONTENT` | Was the content blocked, or did it not conform? |
 * | `PERMISSION` | Was the caller not allowed to do this? |
 * | `GOVERNANCE` | Did **our own** limit say no? |
 * | `ROUTING` | Is nothing available to serve this right now? |
 * | `PROVIDER_TRANSIENT` | Did a provider fail in a way that may pass? |
 * | `PROVIDER_PERMANENT` | Did a provider fail in a way an operator must repair? |
 * | `DEADLINE` | Did the caller's own time budget run out? |
 * | `CANCELLED` | Did somebody stop the call? |
 * | `INTERNAL` | Is this our bug or our configuration? |
 */
import type { AiError, AiErrorReason } from '@aibridge/contracts';

export const FAILURE_CLASSES = [
  'REQUEST',
  'CONTENT',
  'PERMISSION',
  'GOVERNANCE',
  'ROUTING',
  'PROVIDER_TRANSIENT',
  'PROVIDER_PERMANENT',
  'DEADLINE',
  'CANCELLED',
  'INTERNAL',
] as const;

export type FailureClass = (typeof FAILURE_CLASSES)[number];

const CLASS_BY_REASON: Readonly<Partial<Record<AiErrorReason, FailureClass>>> = {
  // The request is wrong — another provider would reject it too.
  CONTRACT_VERSION_UNSUPPORTED: 'REQUEST',
  MALFORMED_ENVELOPE: 'REQUEST',
  CAPABILITY_UNKNOWN: 'REQUEST',
  CAPABILITY_VERSION_UNSUPPORTED: 'REQUEST',
  OUTPUT_SCHEMA_UNSUPPORTED: 'REQUEST',
  OUTPUT_SCHEMA_OVERRIDE_FORBIDDEN: 'REQUEST',
  METADATA_NOT_ALLOWED: 'REQUEST',
  IDEMPOTENCY_CONFLICT: 'REQUEST',
  TRUSTED_FIELD_IN_CONSUMER_REQUEST: 'REQUEST',
  INPUT_TOO_LARGE: 'REQUEST',
  SECRET_LIKE_INPUT: 'REQUEST',
  PROVIDER_REQUEST_REJECTED: 'REQUEST',

  CALLER_NOT_PERMITTED: 'PERMISSION',
  SUBJECT_MISSING: 'PERMISSION',

  // The content was blocked or did not conform — never "shop" for a more permissive answer.
  POLICY_VIOLATION: 'CONTENT',
  PROVIDER_CONTENT_FILTER: 'CONTENT',
  OUTPUT_TOO_LARGE: 'CONTENT',
  SCHEMA_VALIDATION_FAILED: 'CONTENT',
  OUTPUT_REPAIR_EXHAUSTED: 'CONTENT',
  EXTRACTION_FAILED: 'CONTENT',
  JSON_PARSE_FAILED: 'CONTENT',

  // Our own limits and switches. A fallback must never be used to dodge them.
  KILL_SWITCH_GLOBAL: 'GOVERNANCE',
  KILL_SWITCH_PROVIDER: 'GOVERNANCE',
  KILL_SWITCH_CAPABILITY: 'GOVERNANCE',
  RATE_LIMIT_SUBJECT: 'GOVERNANCE',
  RATE_LIMIT_CALLER: 'GOVERNANCE',
  RATE_LIMIT_CAPABILITY: 'GOVERNANCE',
  RATE_LIMIT_PROVIDER: 'GOVERNANCE',
  QUOTA_SUBJECT: 'GOVERNANCE',
  QUOTA_CALLER: 'GOVERNANCE',
  QUOTA_CAPABILITY: 'GOVERNANCE',
  QUOTA_PROVIDER: 'GOVERNANCE',
  QUOTA_GLOBAL: 'GOVERNANCE',
  COST_BUDGET_EXHAUSTED: 'GOVERNANCE',

  NO_ROUTE: 'ROUTING',
  MODEL_UNAVAILABLE: 'ROUTING',
  ROUTE_EXHAUSTED: 'ROUTING',

  BUDGET_EXHAUSTED: 'DEADLINE',

  PROVIDER_OVERLOADED: 'PROVIDER_TRANSIENT',
  PROVIDER_UNAVAILABLE: 'PROVIDER_TRANSIENT',
  PROVIDER_TIMEOUT: 'PROVIDER_TRANSIENT',
  PROVIDER_BAD_RESPONSE: 'PROVIDER_TRANSIENT',

  PROVIDER_AUTH_FAILED: 'PROVIDER_PERMANENT',
  // A depleted balance is one wallet's problem, not the request's or the deployment's — the
  // class is permanent-for-this-provider, and `decideFallback` names the exact chase rule.
  PROVIDER_BALANCE_EXHAUSTED: 'PROVIDER_PERMANENT',

  CANCELLED_BY_CALLER: 'CANCELLED',
  CANCELLED_BY_HOST: 'CANCELLED',

  INTERNAL_ERROR: 'INTERNAL',
};

/** The stable failure class of a normalized error. Pure; reads only code/stage/reason. */
export function classifyFailure(error: AiError): FailureClass {
  if (error.reason !== undefined) {
    const mapped = CLASS_BY_REASON[error.reason];
    if (mapped !== undefined) {
      return mapped;
    }
  }
  // A reason-less error falls back to its code/stage. Order matters: cancellation wins, then the
  // caller's own governance, then the stage's natural home.
  if (error.code === 'CANCELLED' || error.stage === 'CANCELLATION') {
    return 'CANCELLED';
  }
  switch (error.stage) {
    case 'GOVERNANCE':
      return 'GOVERNANCE';
    case 'PERMISSION':
      return 'PERMISSION';
    case 'DEADLINE':
      return 'DEADLINE';
    case 'PROVIDER':
      return error.retryable ? 'PROVIDER_TRANSIENT' : 'PROVIDER_PERMANENT';
    case 'ROUTING':
      return 'ROUTING';
    case 'EXTRACTION':
    case 'VALIDATION':
      return 'CONTENT';
    case 'POLICY':
      return 'CONTENT';
    default:
      return error.code === 'INVALID_REQUEST' ? 'REQUEST' : 'INTERNAL';
  }
}

/** True when the failure is a property of the **request** or the **content** (ARCHITECTURE.md §10.2). */
export function isRequestOrContentFailure(error: AiError): boolean {
  const failureClass = classifyFailure(error);
  return failureClass === 'REQUEST' || failureClass === 'CONTENT' || failureClass === 'PERMISSION';
}

/**
 * True when the failure counts against the **circuit breaker**.
 *
 * Only provider/system transient failure counts (ARCHITECTURE.md §10.5): an invalid request, a
 * blocked piece of content, a permission denial or a cancellation says nothing about whether the
 * provider is healthy, and must never open a circuit.
 */
export function breakerImpact(error: AiError): boolean {
  return (
    error.reason === 'PROVIDER_UNAVAILABLE' ||
    error.reason === 'PROVIDER_OVERLOADED' ||
    error.reason === 'PROVIDER_TIMEOUT'
  );
}
