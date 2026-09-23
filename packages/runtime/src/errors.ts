/**
 * Generic error propagation (ARCHITECTURE.md §6, AGENTS.md §4).
 *
 * Everything that can go wrong below the runtime — a provider status, a provider error body, a
 * transport exception, a malformed response — is normalized **here** into the closed `AiError`
 * vocabulary and nowhere else. Provider prose never crosses this boundary: an adapter's
 * `rawMessage` goes to the operator log at most, and a thrown exception's `.message` is discarded
 * outright (it may be vendor prose, a stack frame or a URL).
 *
 * `REASON_META` stays the single source of code / stage / retryability: this module names a
 * **reason**, and the classification follows. `details.providerCategory` carries the closed
 * mapped category when the reason allows it — a category, never a message.
 */
import {
  makeAiError,
  reasonForProviderCategory,
  allowedDetailKeys,
  isProviderCallError,
  type AiError,
  type AiErrorReason,
  type ProviderRawError,
  type SafeDetails,
  type ValidationFailure,
} from '@aibridge/contracts';

/** Sanitized bridge wording per provider-side reason. Never vendor prose. */
const PROVIDER_REASON_MESSAGES: Readonly<Partial<Record<AiErrorReason, string>>> = {
  PROVIDER_AUTH_FAILED: 'The provider rejected its configured credential. An operator must repair the deployment.',
  PROVIDER_REQUEST_REJECTED: 'The provider rejected the composed request.',
  PROVIDER_THROTTLED: 'The provider throttled the request.',
  PROVIDER_OVERLOADED: 'The provider is temporarily overloaded.',
  PROVIDER_TIMEOUT: 'The provider did not answer within its deadline.',
  PROVIDER_BAD_RESPONSE: 'The provider returned an unusable response.',
  PROVIDER_CONTENT_FILTER: 'The provider filtered the content.',
  PROVIDER_UNAVAILABLE: 'The provider is currently unavailable.',
  MODEL_UNAVAILABLE: 'The routed model is not available from the provider.',
};

function providerMessage(reason: AiErrorReason): string {
  return PROVIDER_REASON_MESSAGES[reason] ?? 'The provider call failed.';
}

/**
 * Normalize a **mapped** provider failure (`ProviderRawError`) into an `AiError`.
 *
 * The adapter's explicit `reason` wins when present — the adapter is the one component allowed to
 * read a provider error body, so its classification is authoritative. Otherwise the closed
 * `category → reason` table decides.
 */
export function normalizeProviderError(rawError: ProviderRawError): AiError {
  const reason = rawError.reason ?? reasonForProviderCategory(rawError.category);
  const allowed = allowedDetailKeys(reason);
  const details: Record<string, string | number | boolean> = {};
  if (allowed.includes('providerCategory')) {
    details['providerCategory'] = rawError.category;
  }
  return makeAiError({
    reason,
    message: providerMessage(reason),
    ...(rawError.retryAfterMs === undefined ? {} : { retryAfterMs: rawError.retryAfterMs }),
    ...(Object.keys(details).length === 0 ? {} : { details: details as SafeDetails }),
  });
}

/**
 * Normalize anything an adapter threw.
 *
 * A `ProviderCallError` carries mapped facts and is normalized as such. **Anything else** becomes
 * `INTERNAL / INTERNAL_ERROR` with fixed wording: a thrown `.message` never reaches a consumer.
 */
export function normalizeThrown(error: unknown): AiError {
  if (isProviderCallError(error)) {
    return normalizeProviderError(error.rawError);
  }
  return makeAiError({
    reason: 'INTERNAL_ERROR',
    message: 'The provider call failed unexpectedly.',
  });
}

/** The per-attempt deadline elapsed while the overall budget still allows a later attempt. */
export function providerTimeoutError(): AiError {
  return normalizeProviderError({ category: 'UPSTREAM', reason: 'PROVIDER_TIMEOUT' });
}

/** The overall request deadline elapsed. */
export function budgetExhaustedError(remainingMs: number): AiError {
  return makeAiError({
    reason: 'BUDGET_EXHAUSTED',
    message: 'The overall request budget elapsed before the call could complete.',
    details: { remainingMs },
  });
}

/** The caller cancelled. Terminal and idempotent (ARCHITECTURE.md §13.2). */
export function cancelledByCallerError(): AiError {
  return makeAiError({ reason: 'CANCELLED_BY_CALLER', message: 'The caller cancelled the request.' });
}

/** The host cancelled. Terminal and idempotent. */
export function cancelledByHostError(): AiError {
  return makeAiError({ reason: 'CANCELLED_BY_HOST', message: 'The host cancelled the request.' });
}

/**
 * Turn a parser/validator failure into an `AiError`.
 *
 * The issue list is reduced to the closed per-reason detail keys; the offending **values** never
 * travel, only rooted paths and issue codes.
 */
export function validationFailureToAiError(failure: ValidationFailure, message: string): AiError {
  const allowed = allowedDetailKeys(failure.reason);
  const details: Record<string, string | number | boolean> = {};
  const first = failure.issues[0];
  if (allowed.includes('issueCount')) {
    details['issueCount'] = failure.issues.length;
  }
  if (first !== undefined) {
    if (allowed.includes('firstPath')) {
      details['firstPath'] = first.path;
    }
    if (allowed.includes('firstIssueCode')) {
      details['firstIssueCode'] = first.code;
    }
    if (allowed.includes('field') && typeof details['field'] === 'undefined') {
      details['field'] = first.path;
    }
    if (allowed.includes('strategy')) {
      details['strategy'] = first.code;
    }
    if (allowed.includes('position')) {
      details['position'] = first.path;
    }
  }
  return makeAiError({
    reason: failure.reason,
    message,
    ...(Object.keys(details).length === 0 ? {} : { details: details as SafeDetails }),
  });
}
