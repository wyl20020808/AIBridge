/**
 * The **trusted** dispatch context, and the composition that joins it to a consumer request.
 *
 * Injected by the host/broker in a channel the caller cannot write (AGENTS.md §4,
 * SECURITY.md §4). The consumer request never carries these fields; `parseConsumerAiRequest`
 * rejects them.
 */
import { describe, isRecord, unknownKeys } from './guards.js';
import type { ValidationIssue, ValidationResult } from './issue.js';
import { at, createIssue, invalid, valid } from './issue.js';
import type { ConsumerAiRequest } from './request.js';

export const TRUSTED_DISPATCH_CONTEXT_KEYS = [
  'callerPluginId',
  'subjectToken',
  'grantedPermissions',
  'hostRequestId',
  'traceId',
] as const;

export type TrustedDispatchContext = {
  /** Bound by the host plugin runtime. Non-forgeable. */
  readonly callerPluginId: string;
  /** Opaque, host-minted, AI-Bridge-scoped. Never an email, a user id or a raw session token. */
  readonly subjectToken?: string;
  /** Capability ids this caller has declared and been granted. Deny-by-default. */
  readonly grantedPermissions: readonly string[];
  /** The host's own request id, for correlation. */
  readonly hostRequestId?: string;
  /** Opaque trace id, for the operator channel. */
  readonly traceId?: string;
};

export const CALLER_PLUGIN_ID_PATTERN = /^[a-z][a-z0-9._-]{1,127}$/;
const OPAQUE_TOKEN_PATTERN = /^[A-Za-z0-9._~+/=-]{8,256}$/;
const JWT_LIKE_PATTERN = /^eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/**
 * True when a token is plausibly an opaque subject handle: long enough, no `@`, and not a
 * JWT-shaped credential. A host that cannot mint such a token must say so rather than pass an
 * email or a session token.
 */
export function isOpaqueSubjectToken(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    OPAQUE_TOKEN_PATTERN.test(value) &&
    !value.includes('@') &&
    !JWT_LIKE_PATTERN.test(value)
  );
}

export function parseTrustedDispatchContext(
  value: unknown,
  path = '$',
): ValidationResult<TrustedDispatchContext> {
  if (!isRecord(value)) {
    return invalid('MALFORMED_ENVELOPE', [createIssue('INVALID_TYPE', path, `must be an object, got ${describe(value)}`)]);
  }
  const issues: ValidationIssue[] = [];
  for (const key of unknownKeys(value, TRUSTED_DISPATCH_CONTEXT_KEYS)) {
    issues.push(createIssue('UNKNOWN_FIELD', at(path, key), 'unknown trusted-context field'));
  }
  if (typeof value['callerPluginId'] !== 'string' || !CALLER_PLUGIN_ID_PATTERN.test(value['callerPluginId'])) {
    issues.push(createIssue('PATTERN_MISMATCH', at(path, 'callerPluginId'), 'must be a host-bound plugin id'));
  }
  const subjectToken = value['subjectToken'];
  if (subjectToken !== undefined && !isOpaqueSubjectToken(subjectToken)) {
    issues.push(createIssue('INVALID_VALUE', at(path, 'subjectToken'), 'must be an opaque, non-identity token'));
  }
  const grantedPermissions = value['grantedPermissions'];
  if (!Array.isArray(grantedPermissions) || !grantedPermissions.every((entry) => typeof entry === 'string')) {
    issues.push(createIssue('INVALID_TYPE', at(path, 'grantedPermissions'), 'must be an array of capability ids'));
  }
  for (const key of ['hostRequestId', 'traceId'] as const) {
    const entry = value[key];
    if (entry !== undefined && (typeof entry !== 'string' || entry.length === 0)) {
      issues.push(createIssue('INVALID_TYPE', at(path, key), 'must be a non-empty string'));
    }
  }
  if (issues.length > 0) {
    return invalid('MALFORMED_ENVELOPE', issues);
  }
  return valid({
    callerPluginId: value['callerPluginId'] as string,
    grantedPermissions: [...(grantedPermissions as readonly string[])],
    ...(typeof subjectToken === 'string' ? { subjectToken } : {}),
    ...(typeof value['hostRequestId'] === 'string' ? { hostRequestId: value['hostRequestId'] } : {}),
    ...(typeof value['traceId'] === 'string' ? { traceId: value['traceId'] } : {}),
  });
}

/** A consumer request joined to its trusted context. This is what the pipeline actually runs. */
export type ComposedAiRequest<TInput = unknown> = ConsumerAiRequest<TInput> & {
  readonly callerPluginId: string;
  readonly subjectToken?: string;
};

export type ComposeOptions = {
  /** When set, a missing `subjectToken` is `PERMISSION / SUBJECT_MISSING`. */
  readonly subjectRequired?: boolean;
};

/**
 * Join a parsed consumer request to a validated trusted context.
 *
 * This is the only place `callerPluginId` and `subjectToken` enter the pipeline. A caller cannot
 * reach here without the host having supplied the context.
 */
export function composeAiRequest<TInput = unknown>(
  request: ConsumerAiRequest<TInput>,
  context: TrustedDispatchContext,
  options: ComposeOptions = {},
): ValidationResult<ComposedAiRequest<TInput>> {
  if (context.callerPluginId.length === 0) {
    return invalid('CALLER_NOT_PERMITTED', [
      createIssue('PERMISSION_DENIED', '$callerPluginId', 'caller identity was not bound by the host'),
    ]);
  }
  if (options.subjectRequired === true && context.subjectToken === undefined) {
    return invalid('SUBJECT_MISSING', [
      createIssue('MISSING_SUBJECT', '$subjectToken', 'a subject dimension is configured and no subject token was minted'),
    ]);
  }
  return valid({
    ...request,
    callerPluginId: context.callerPluginId,
    ...(context.subjectToken === undefined ? {} : { subjectToken: context.subjectToken }),
  });
}

/** A granted permission matches `capability` or `capability@major`. Deny by default. */
export function isCapabilityGranted(
  grantedPermissions: readonly string[],
  capability: string,
  capabilityVersion?: string,
): boolean {
  if (grantedPermissions.includes(capability)) {
    return true;
  }
  if (capabilityVersion !== undefined) {
    const major = capabilityVersion.split('.')[0];
    if (major !== undefined && grantedPermissions.includes(`${capability}@${major}`)) {
      return true;
    }
  }
  return grantedPermissions.some((granted) => {
    const separator = granted.indexOf('@');
    return separator > 0 && granted.slice(0, separator) === capability;
  });
}

/** The subject token, hashed for the usage ledger. Never the token itself. */
export function subjectTokenHash(subjectToken: string): string {
  // A small, dependency-free digest. Not cryptographic; the subject token is opaque already, and
  // this only needs to be stable and non-reversible in the ledger. A host adapter may replace it.
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < subjectToken.length; i += 1) {
    const code = subjectToken.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + code, 0x85ebca6b) >>> 0;
  }
  return `sub_${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}
