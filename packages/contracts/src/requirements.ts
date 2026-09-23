/**
 * Capability requirements (ARCHITECTURE.md §4.4, §8.2).
 *
 * Requirements **narrow a route**; they never name a model or a provider. A route is acceptable
 * only if it satisfies both the requested profile and the requirement set.
 *
 * V1 semantics: `streaming` and `vision` are never satisfiable (`OUT_OF_SCOPE_V1`), so a caller
 * that sets them true gets `NO_ROUTE` rather than a quiet downgrade.
 */
import { isRecord, unknownKeys, isPositiveInteger, describe } from './guards.js';
import type { ValidationIssue, ValidationResult } from './issue.js';
import { at, createIssue, invalid, valid } from './issue.js';

export const CAPABILITY_REQUIREMENT_KEYS = [
  'structuredOutput',
  'reasoning',
  'streaming',
  'vision',
  'minContextTokens',
  'maxOutputTokens',
  'maxLatencyMs',
] as const;

const BOOLEAN_REQUIREMENT_KEYS = ['structuredOutput', 'reasoning', 'streaming', 'vision'] as const;
const INTEGER_REQUIREMENT_KEYS = ['minContextTokens', 'maxOutputTokens', 'maxLatencyMs'] as const;

export type CapabilityRequirements = {
  readonly structuredOutput?: boolean;
  readonly reasoning?: boolean;
  /** V1: always false. */
  readonly streaming?: boolean;
  /** V1: always false. */
  readonly vision?: boolean;
  readonly minContextTokens?: number;
  readonly maxOutputTokens?: number;
  readonly maxLatencyMs?: number;
};

/** Requirements that no V1 route can satisfy. Empty for a V1-satisfiable request. */
export function v1UnsupportedRequirements(requirements: CapabilityRequirements): readonly string[] {
  const unsupported: string[] = [];
  if (requirements.streaming === true) unsupported.push('streaming');
  if (requirements.vision === true) unsupported.push('vision');
  return unsupported;
}

/** Parse the requirement set. Unknown keys are rejected, numbers must be positive integers. */
export function parseCapabilityRequirements(
  value: unknown,
  path = '$',
): ValidationResult<CapabilityRequirements> {
  if (!isRecord(value)) {
    return invalid('MALFORMED_ENVELOPE', [createIssue('INVALID_TYPE', path, `must be an object, got ${describe(value)}`)]);
  }
  const issues: ValidationIssue[] = [];
  for (const key of unknownKeys(value, CAPABILITY_REQUIREMENT_KEYS)) {
    issues.push(createIssue('UNKNOWN_FIELD', at(path, key), 'unknown requirement field'));
  }
  for (const key of BOOLEAN_REQUIREMENT_KEYS) {
    const entry = value[key];
    if (entry !== undefined && typeof entry !== 'boolean') {
      issues.push(createIssue('INVALID_TYPE', at(path, key), `must be a boolean, got ${describe(entry)}`));
    }
  }
  for (const key of INTEGER_REQUIREMENT_KEYS) {
    const entry = value[key];
    if (entry !== undefined && !isPositiveInteger(entry)) {
      issues.push(createIssue('INVALID_TYPE', at(path, key), 'must be a positive integer'));
    }
  }
  if (issues.length > 0) {
    return invalid('MALFORMED_ENVELOPE', issues);
  }
  return valid({
    ...(typeof value['structuredOutput'] === 'boolean' ? { structuredOutput: value['structuredOutput'] } : {}),
    ...(typeof value['reasoning'] === 'boolean' ? { reasoning: value['reasoning'] } : {}),
    ...(typeof value['streaming'] === 'boolean' ? { streaming: value['streaming'] } : {}),
    ...(typeof value['vision'] === 'boolean' ? { vision: value['vision'] } : {}),
    ...(typeof value['minContextTokens'] === 'number' ? { minContextTokens: value['minContextTokens'] } : {}),
    ...(typeof value['maxOutputTokens'] === 'number' ? { maxOutputTokens: value['maxOutputTokens'] } : {}),
    ...(typeof value['maxLatencyMs'] === 'number' ? { maxLatencyMs: value['maxLatencyMs'] } : {}),
  });
}

/** The requirement set a generic structured capability can meet. */
export function structuredGenerationRequirements(): CapabilityRequirements {
  return { structuredOutput: true, streaming: false, vision: false };
}

/** The requirement set a generic text capability can meet. */
export function textGenerationRequirements(): CapabilityRequirements {
  return { structuredOutput: false, streaming: false, vision: false };
}
