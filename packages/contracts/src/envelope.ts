/**
 * The combined request envelope — `AiRequestEnvelope` (ARCHITECTURE.md §4).
 *
 * The frozen envelope carries **both halves** in one document: the consumer-authored fields and the
 * two host-bound fields `callerPluginId` and `subjectToken`. That combined shape is what a host
 * adapter transports, and it is the shape the frozen fixtures use.
 *
 * The **security boundary is not here**. This parser validates *shape*. Identity provenance is the
 * host's responsibility (SECURITY.md §4): an in-process host injects `TrustedDispatchContext` and
 * composes it with a request validated by `parseConsumerAiRequest`, which **rejects**
 * `callerPluginId`/`subjectToken` outright. This envelope parser exists for the trusted channel and
 * for fixture conformance; it never grants a consumer the right to author those fields.
 */
import { isOpaqueSubjectToken, CALLER_PLUGIN_ID_PATTERN, type ComposedAiRequest } from './context.js';
import { describe, isRecord } from './guards.js';
import type { ValidationIssue, ValidationResult } from './issue.js';
import { at, createIssue, invalid, valid } from './issue.js';
import {
  CONSUMER_AI_REQUEST_KEYS,
  FORBIDDEN_CONSUMER_FIELDS,
  parseConsumerAiRequest,
  type ParseConsumerAiRequestOptions,
} from './request.js';

/** The consumer keys plus the two host-bound keys. Nothing else may appear. */
export const AI_REQUEST_ENVELOPE_KEYS = [...CONSUMER_AI_REQUEST_KEYS, 'callerPluginId', 'subjectToken'] as const;

/**
 * The combined envelope type. Structurally a `ComposedAiRequest`, named separately because the two
 * describe different moments: composition is the in-process join, the envelope is the wire shape.
 */
export type AiRequestEnvelope<TInput = unknown> = ComposedAiRequest<TInput>;

/**
 * Parse a combined request envelope.
 *
 * Precedence mirrors `parseConsumerAiRequest`: a consumer-half failure (unsupported version,
 * disallowed metadata, unsupported output schema) is returned as-is, because it is the more
 * specific diagnosis; envelope-level problems (unknown/forbidden keys, a malformed
 * `callerPluginId`) are `MALFORMED_ENVELOPE`.
 */
export function parseAiRequestEnvelope<TInput = unknown>(
  value: unknown,
  options: ParseConsumerAiRequestOptions = {},
  path = '$',
): ValidationResult<AiRequestEnvelope<TInput>> {
  if (!isRecord(value)) {
    return invalid('MALFORMED_ENVELOPE', [createIssue('INVALID_TYPE', path, `must be an object, got ${describe(value)}`)]);
  }
  const issues: ValidationIssue[] = [];
  const allowed = AI_REQUEST_ENVELOPE_KEYS as readonly string[];
  for (const key of Object.keys(value).sort()) {
    if (allowed.includes(key)) {
      continue;
    }
    if ((FORBIDDEN_CONSUMER_FIELDS as readonly string[]).includes(key)) {
      issues.push(createIssue('FORBIDDEN_FIELD', at(path, key), 'is never part of a request envelope'));
    } else {
      issues.push(createIssue('UNKNOWN_FIELD', at(path, key), 'unknown request envelope field'));
    }
  }

  const callerPluginId = value['callerPluginId'];
  if (typeof callerPluginId !== 'string' || !CALLER_PLUGIN_ID_PATTERN.test(callerPluginId)) {
    issues.push(createIssue('PATTERN_MISMATCH', at(path, 'callerPluginId'), 'must be a host-bound plugin id'));
  }
  const subjectToken = value['subjectToken'];
  if (subjectToken !== undefined && !isOpaqueSubjectToken(subjectToken)) {
    issues.push(createIssue('INVALID_VALUE', at(path, 'subjectToken'), 'must be an opaque, non-identity token'));
  }

  const consumerDocument: Record<string, unknown> = {};
  for (const key of CONSUMER_AI_REQUEST_KEYS) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      consumerDocument[key] = value[key];
    }
  }
  const consumer = parseConsumerAiRequest<TInput>(consumerDocument, options, path);
  if (!consumer.ok) {
    return consumer;
  }
  if (issues.length > 0) {
    return invalid('MALFORMED_ENVELOPE', issues);
  }
  return valid({
    ...consumer.value,
    callerPluginId: callerPluginId as string,
    ...(typeof subjectToken === 'string' ? { subjectToken } : {}),
  });
}
