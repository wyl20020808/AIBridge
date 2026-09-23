/**
 * The response envelope — `AiResult` (ARCHITECTURE.md §5, INTEGRATION_CONTRACT_V1.md §4).
 *
 * `status` is binary on purpose. A "half-success" is `SUCCEEDED` plus `warnings`, so a consumer
 * has exactly one branch to write and never sees a partial object.
 *
 * Invariants, enforced by `parseAiResult`:
 *  - `SUCCEEDED` **must** carry a legal `output` and **must not** carry `error`;
 *  - `FAILED` **must** carry an `error` and **must not** return partial business `output`.
 */
import type { AiError, AiErrorCode, AiErrorReason, AiErrorStage } from './errors.js';
import {
  allowedDetailKeys,
  isAiErrorCode,
  isAiErrorReason,
  isAiErrorStage,
  isProviderCategory,
} from './errors.js';
import { describe, isNonNegativeFiniteNumber, isRecord, unknownKeys } from './guards.js';
import type { ValidationIssue, ValidationResult } from './issue.js';
import { at, createIssue, invalid, valid } from './issue.js';
import { isModelClass, isProviderFamily, type ModelClass, type ProviderFamily } from './provider.js';
import { parseAiUsage, type AiUsage } from './usage.js';
import { parseAiWarnings, type AiWarning } from './warnings.js';

/** Closed finish-reason set (ARCHITECTURE.md §5.3). */
export const AI_FINISH_REASONS = ['STOP', 'LENGTH', 'CONTENT_FILTER', 'UNKNOWN'] as const;

export type AiFinishReason = (typeof AI_FINISH_REASONS)[number];

export function isAiFinishReason(value: unknown): value is AiFinishReason {
  return typeof value === 'string' && (AI_FINISH_REASONS as readonly string[]).includes(value);
}

/** The safe provider projection (ARCHITECTURE.md §5.2). A closed key set. */
export type ProviderMetadataProjection = {
  /** Operator-named instance id: `main`, `local`, `backup`. Never a brand. */
  readonly providerId: string;
  readonly providerFamily: ProviderFamily;
  readonly modelClass: ModelClass;
  /** 0 = first choice; > 0 = a fallback served it. */
  readonly routeDepth: number;
  readonly attemptCount: number;
  readonly repaired: boolean;
};

export const PROVIDER_METADATA_KEYS = [
  'providerId',
  'providerFamily',
  'modelClass',
  'routeDepth',
  'attemptCount',
  'repaired',
] as const;

/**
 * Keys that must never appear in the projection. Their absence is asserted by a test.
 * Documented here so the list has exactly one home.
 */
export const EXCLUDED_PROVIDER_METADATA_KEYS = [
  'modelId',
  'modelRef',
  'endpoint',
  'baseUrl',
  'apiKeyId',
  'organizationId',
  'projectId',
  'region',
  'requestHeaders',
  'responseHeaders',
  'rawRequest',
  'rawResponse',
  'rawError',
  'finishText',
  'sessionId',
  'subjectToken',
] as const;

export type AiResult<TOutput = unknown> = {
  readonly contractVersion: string;
  readonly requestId: string;
  readonly capability: string;
  readonly capabilityVersion: string;
  readonly status: 'SUCCEEDED' | 'FAILED';
  /** Present only when `SUCCEEDED`, and only after runtime validation. */
  readonly output?: TOutput;
  /** Present only when `FAILED`. */
  readonly error?: AiError;
  readonly usage: AiUsage;
  readonly providerMetadata: ProviderMetadataProjection;
  /** End to end, including routing and validation. */
  readonly latencyMs: number;
  readonly finishReason: AiFinishReason;
  readonly warnings: readonly AiWarning[];
};

export const AI_RESULT_KEYS = [
  'contractVersion',
  'requestId',
  'capability',
  'capabilityVersion',
  'status',
  'output',
  'error',
  'usage',
  'providerMetadata',
  'latencyMs',
  'finishReason',
  'warnings',
] as const;

export const AI_ERROR_KEYS = [
  'code',
  'message',
  'retryable',
  'retryAfterMs',
  'stage',
  'reason',
  'details',
] as const;

export const AI_ERROR_MESSAGE_MAX_LENGTH = 1024;

export function parseAiFinishReason(value: unknown, path = '$'): ValidationResult<AiFinishReason> {
  if (!isAiFinishReason(value)) {
    return invalid('MALFORMED_ENVELOPE', [
      createIssue('INVALID_VALUE', path, `must be one of ${AI_FINISH_REASONS.join(', ')}`),
    ]);
  }
  return valid(value);
}

export function parseProviderMetadataProjection(
  value: unknown,
  path = '$',
): ValidationResult<ProviderMetadataProjection> {
  if (!isRecord(value)) {
    return invalid('MALFORMED_ENVELOPE', [createIssue('INVALID_TYPE', path, `must be an object, got ${describe(value)}`)]);
  }
  const issues: ValidationIssue[] = [];
  for (const key of unknownKeys(value, PROVIDER_METADATA_KEYS)) {
    issues.push(createIssue('UNKNOWN_FIELD', at(path, key), 'is not part of the safe projection'));
  }
  if (typeof value['providerId'] !== 'string' || value['providerId'].length === 0) {
    issues.push(createIssue('INVALID_TYPE', at(path, 'providerId'), 'must be a non-empty string'));
  }
  if (!isProviderFamily(value['providerFamily'])) {
    issues.push(createIssue('INVALID_VALUE', at(path, 'providerFamily'), 'must be a known provider family'));
  }
  if (!isModelClass(value['modelClass'])) {
    issues.push(createIssue('INVALID_VALUE', at(path, 'modelClass'), 'must be a known model class'));
  }
  for (const key of ['routeDepth', 'attemptCount'] as const) {
    const entry = value[key];
    if (typeof entry !== 'number' || !Number.isInteger(entry) || entry < 0) {
      issues.push(createIssue('INVALID_TYPE', at(path, key), 'must be a non-negative integer'));
    }
  }
  if (typeof value['repaired'] !== 'boolean') {
    issues.push(createIssue('INVALID_TYPE', at(path, 'repaired'), 'must be a boolean'));
  }
  if (issues.length > 0) {
    return invalid('MALFORMED_ENVELOPE', issues);
  }
  return valid({
    providerId: value['providerId'] as string,
    providerFamily: value['providerFamily'] as ProviderFamily,
    modelClass: value['modelClass'] as ModelClass,
    routeDepth: value['routeDepth'] as number,
    attemptCount: value['attemptCount'] as number,
    repaired: value['repaired'] as boolean,
  });
}

/** Parse a normalized error. Provider prose must never be present. */
export function parseAiError(value: unknown, path = '$'): ValidationResult<AiError> {
  if (!isRecord(value)) {
    return invalid('MALFORMED_ENVELOPE', [createIssue('INVALID_TYPE', path, `must be an object, got ${describe(value)}`)]);
  }
  const issues: ValidationIssue[] = [];
  for (const key of unknownKeys(value, AI_ERROR_KEYS)) {
    issues.push(createIssue('UNKNOWN_FIELD', at(path, key), 'unknown error field'));
  }
  if (!isAiErrorCode(value['code'])) {
    issues.push(createIssue('INVALID_VALUE', at(path, 'code'), 'must be one of the twelve AI error codes'));
  }
  const message = value['message'];
  if (typeof message !== 'string' || message.length === 0) {
    issues.push(createIssue('INVALID_TYPE', at(path, 'message'), 'must be a non-empty, sanitized string'));
  } else if (message.length > AI_ERROR_MESSAGE_MAX_LENGTH) {
    issues.push(createIssue('OUT_OF_RANGE', at(path, 'message'), `must be at most ${AI_ERROR_MESSAGE_MAX_LENGTH} characters`));
  }
  if (typeof value['retryable'] !== 'boolean') {
    issues.push(createIssue('INVALID_TYPE', at(path, 'retryable'), 'must be a boolean'));
  }
  const retryAfterMs = value['retryAfterMs'];
  if (retryAfterMs !== undefined && (!Number.isInteger(retryAfterMs) || (retryAfterMs as number) < 0)) {
    issues.push(createIssue('INVALID_TYPE', at(path, 'retryAfterMs'), 'must be a non-negative integer'));
  }
  if (!isAiErrorStage(value['stage'])) {
    issues.push(createIssue('INVALID_VALUE', at(path, 'stage'), 'must be a known error stage'));
  }
  const reason = value['reason'];
  let reasonValue: AiErrorReason | undefined;
  if (reason !== undefined) {
    if (!isAiErrorReason(reason)) {
      issues.push(createIssue('INVALID_VALUE', at(path, 'reason'), 'must be a known error reason'));
    } else {
      reasonValue = reason;
    }
  }
  const details = value['details'];
  let detailsValue: Readonly<Record<string, string | number | boolean>> | undefined;
  if (details !== undefined) {
    if (reasonValue === undefined) {
      issues.push(createIssue('MISSING_FIELD', at(path, 'reason'), 'is required whenever details are present'));
    } else if (!isRecord(details)) {
      issues.push(createIssue('INVALID_TYPE', at(path, 'details'), 'must be an object'));
    } else {
      const allowed = allowedDetailKeys(reasonValue);
      const collected: Record<string, string | number | boolean> = {};
      for (const key of Object.keys(details).sort()) {
        if (!allowed.includes(key)) {
          issues.push(createIssue('UNKNOWN_FIELD', at(at(path, 'details'), key), 'is not allowed for this reason'));
          continue;
        }
        const entry = details[key];
        if (typeof entry === 'string' || typeof entry === 'boolean') {
          collected[key] = entry;
        } else if (typeof entry === 'number' && Number.isFinite(entry)) {
          collected[key] = entry;
        } else {
          issues.push(createIssue('INVALID_TYPE', at(at(path, 'details'), key), 'must be a string, finite number or boolean'));
        }
      }
      if (reasonValue === 'SCHEMA_VALIDATION_FAILED' || reasonValue === 'OUTPUT_REPAIR_EXHAUSTED') {
        const category = collected['providerCategory'];
        if (category !== undefined && !isProviderCategory(category)) {
          issues.push(createIssue('INVALID_VALUE', at(at(path, 'details'), 'providerCategory'), 'must be a mapped provider category'));
        }
      }
      detailsValue = collected;
    }
  }
  if (issues.length > 0) {
    return invalid('MALFORMED_ENVELOPE', issues);
  }
  return valid({
    code: value['code'] as AiErrorCode,
    message: value['message'] as string,
    retryable: value['retryable'] as boolean,
    stage: value['stage'] as AiErrorStage,
    ...(reasonValue === undefined ? {} : { reason: reasonValue }),
    ...(typeof retryAfterMs === 'number' ? { retryAfterMs } : {}),
    ...(detailsValue === undefined ? {} : { details: detailsValue }),
  });
}

export type ParseAiResultOptions<TOutput> = {
  /** Optional output validator. When absent, `output` is accepted as-is (envelope-only check). */
  readonly parseOutput?: (output: unknown, path: string) => ValidationResult<TOutput>;
};

export function parseAiResult<TOutput = unknown>(
  value: unknown,
  options: ParseAiResultOptions<TOutput> = {},
  path = '$',
): ValidationResult<AiResult<TOutput>> {
  if (!isRecord(value)) {
    return invalid('MALFORMED_ENVELOPE', [createIssue('INVALID_TYPE', path, `must be an object, got ${describe(value)}`)]);
  }
  const issues: ValidationIssue[] = [];
  for (const key of unknownKeys(value, AI_RESULT_KEYS)) {
    issues.push(createIssue('UNKNOWN_FIELD', at(path, key), 'unknown response field'));
  }
  for (const key of ['contractVersion', 'requestId', 'capability', 'capabilityVersion'] as const) {
    if (typeof value[key] !== 'string' || (value[key] as string).length === 0) {
      issues.push(createIssue('INVALID_TYPE', at(path, key), 'must be a non-empty string'));
    }
  }
  const status = value['status'];
  if (status !== 'SUCCEEDED' && status !== 'FAILED') {
    issues.push(createIssue('INVALID_VALUE', at(path, 'status'), 'must be SUCCEEDED or FAILED'));
  }

  const hasOutput = Object.prototype.hasOwnProperty.call(value, 'output');
  const hasError = Object.prototype.hasOwnProperty.call(value, 'error');

  let output: TOutput | undefined;
  let error: AiError | undefined;

  if (status === 'SUCCEEDED') {
    if (!hasOutput) {
      issues.push(createIssue('MISSING_FIELD', at(path, 'output'), 'is required when status is SUCCEEDED'));
    }
    if (hasError) {
      issues.push(createIssue('INVARIANT_VIOLATION', at(path, 'error'), 'must be absent when status is SUCCEEDED'));
    }
    if (hasOutput) {
      if (options.parseOutput === undefined) {
        output = value['output'] as TOutput;
      } else {
        const parsedOutput = options.parseOutput(value['output'], at(path, 'output'));
        if (parsedOutput.ok) {
          output = parsedOutput.value;
        } else {
          issues.push(...parsedOutput.failure.issues);
        }
      }
    }
  } else if (status === 'FAILED') {
    if (!hasError) {
      issues.push(createIssue('MISSING_FIELD', at(path, 'error'), 'is required when status is FAILED'));
    }
    if (hasOutput) {
      issues.push(createIssue('INVARIANT_VIOLATION', at(path, 'output'), 'must be absent when status is FAILED'));
    }
    if (hasError) {
      const parsedError = parseAiError(value['error'], at(path, 'error'));
      if (parsedError.ok) {
        error = parsedError.value;
      } else {
        issues.push(...parsedError.failure.issues);
      }
    }
  }

  const usage = parseAiUsage(value['usage'], at(path, 'usage'));
  if (!usage.ok) {
    issues.push(...usage.failure.issues);
  }
  const providerMetadata = parseProviderMetadataProjection(value['providerMetadata'], at(path, 'providerMetadata'));
  if (!providerMetadata.ok) {
    issues.push(...providerMetadata.failure.issues);
  }
  if (!isNonNegativeFiniteNumber(value['latencyMs'])) {
    issues.push(createIssue('INVALID_TYPE', at(path, 'latencyMs'), 'must be a finite, non-negative number'));
  }
  const finishReason = parseAiFinishReason(value['finishReason'], at(path, 'finishReason'));
  if (!finishReason.ok) {
    issues.push(...finishReason.failure.issues);
  }
  const warnings = parseAiWarnings(value['warnings'], at(path, 'warnings'));
  if (!warnings.ok) {
    issues.push(...warnings.failure.issues);
  }

  if (issues.length > 0) {
    return invalid('MALFORMED_ENVELOPE', issues);
  }
  return valid({
    contractVersion: value['contractVersion'] as string,
    requestId: value['requestId'] as string,
    capability: value['capability'] as string,
    capabilityVersion: value['capabilityVersion'] as string,
    status: status as 'SUCCEEDED' | 'FAILED',
    ...(output === undefined ? {} : { output }),
    ...(error === undefined ? {} : { error }),
    usage: usage.ok ? usage.value : {},
    providerMetadata: providerMetadata.ok ? providerMetadata.value : neverProjection(),
    latencyMs: value['latencyMs'] as number,
    finishReason: finishReason.ok ? finishReason.value : 'UNKNOWN',
    warnings: warnings.ok ? warnings.value : [],
  });
}

function neverProjection(): ProviderMetadataProjection {
  return { providerId: '', providerFamily: 'mock', modelClass: 'UNKNOWN', routeDepth: 0, attemptCount: 0, repaired: false };
}

/** Build a `SUCCEEDED` result. */
export function makeSuccessResult<TOutput>(input: {
  readonly contractVersion: string;
  readonly requestId: string;
  readonly capability: string;
  readonly capabilityVersion: string;
  readonly output: TOutput;
  readonly usage?: AiUsage;
  readonly providerMetadata: ProviderMetadataProjection;
  readonly latencyMs: number;
  readonly finishReason?: AiFinishReason;
  readonly warnings?: readonly AiWarning[];
}): AiResult<TOutput> {
  return {
    contractVersion: input.contractVersion,
    requestId: input.requestId,
    capability: input.capability,
    capabilityVersion: input.capabilityVersion,
    status: 'SUCCEEDED',
    output: input.output,
    usage: input.usage ?? {},
    providerMetadata: input.providerMetadata,
    latencyMs: input.latencyMs,
    finishReason: input.finishReason ?? 'STOP',
    warnings: input.warnings ?? [],
  };
}

/** Build a `FAILED` result with `latencyMs` defaulting to a measured value the caller supplies. */
export function makeFailureResult(input: {
  readonly contractVersion: string;
  readonly requestId: string;
  readonly capability: string;
  readonly capabilityVersion: string;
  readonly error: AiError;
  readonly usage?: AiUsage;
  readonly providerMetadata: ProviderMetadataProjection;
  readonly latencyMs: number;
  readonly finishReason?: AiFinishReason;
  readonly warnings?: readonly AiWarning[];
}): AiResult<never> {
  return {
    contractVersion: input.contractVersion,
    requestId: input.requestId,
    capability: input.capability,
    capabilityVersion: input.capabilityVersion,
    status: 'FAILED',
    error: input.error,
    usage: input.usage ?? {},
    providerMetadata: input.providerMetadata,
    latencyMs: input.latencyMs,
    finishReason: input.finishReason ?? 'UNKNOWN',
    warnings: input.warnings ?? [],
  };
}
