/**
 * Model profiles (ARCHITECTURE.md §8, INTEGRATION_CONTRACT_V1.md §3).
 *
 * A profile is a **semantic class**, never a vendor model. A consumer requests a profile, or a
 * requirement set; AI Bridge configuration decides which real provider and model satisfy it.
 *
 * `vision` is deliberately **not** a V1 profile. It is recorded as reserved and `OUT_OF_SCOPE_V1`
 * — not permanently rejected. Nothing in V1 may imply vision support.
 */
import type { ValidationIssue, ValidationResult } from './issue.js';
import { at, createIssue, invalid, valid } from './issue.js';

/** The five V1 profiles. */
export const MODEL_PROFILES = ['fast', 'balanced', 'reasoning', 'cheap', 'high-context'] as const;

export type ModelProfile = (typeof MODEL_PROFILES)[number];

/**
 * Reserved profile names outside V1. `vision` is the only one, and the reason it is here rather
 * than in `MODEL_PROFILES` is that adding a profile that no route can satisfy would be a silent
 * downgrade waiting to happen.
 */
export const RESERVED_MODEL_PROFILES = ['vision'] as const;

export type ReservedModelProfile = (typeof RESERVED_MODEL_PROFILES)[number];

export function isModelProfile(value: unknown): value is ModelProfile {
  return typeof value === 'string' && (MODEL_PROFILES as readonly string[]).includes(value);
}

export function isReservedModelProfile(value: unknown): value is ReservedModelProfile {
  return typeof value === 'string' && (RESERVED_MODEL_PROFILES as readonly string[]).includes(value);
}

/**
 * Parse a profile.
 *
 * A reserved profile is rejected with a message that says so, so an integrator is not left
 * guessing whether `vision` was a typo.
 */
export function parseModelProfile(value: unknown, path = '$'): ValidationResult<ModelProfile> {
  if (isModelProfile(value)) {
    return valid(value);
  }
  if (isReservedModelProfile(value)) {
    return invalid('MALFORMED_ENVELOPE', [
      createIssue('INVALID_VALUE', path, `profile "${value}" is reserved and OUT_OF_SCOPE_V1`),
    ]);
  }
  return invalid('MALFORMED_ENVELOPE', [
    createIssue('INVALID_VALUE', path, `profile must be one of ${MODEL_PROFILES.join(', ')}`),
  ]);
}

/** A read-only copy of the profile list, for descriptor construction. */
export function modelProfiles(): readonly ModelProfile[] {
  return [...MODEL_PROFILES];
}

/** True when `value` is a profile array with no duplicates and only known profiles. */
export function isModelProfileList(value: unknown): value is readonly ModelProfile[] {
  if (!Array.isArray(value)) {
    return false;
  }
  const seen = new Set<string>();
  for (const entry of value) {
    if (!isModelProfile(entry) || seen.has(entry)) {
      return false;
    }
    seen.add(entry);
  }
  return true;
}

/** Parse a profile list (descriptor fields). */
export function parseModelProfileList(value: unknown, path = '$'): ValidationResult<readonly ModelProfile[]> {
  if (!Array.isArray(value)) {
    return invalid('MALFORMED_ENVELOPE', [createIssue('INVALID_TYPE', path, 'must be an array of profiles')]);
  }
  const issues: ValidationIssue[] = [];
  const seen = new Set<string>();
  const profiles: ModelProfile[] = [];
  value.forEach((entry, index) => {
    const entryPath = at(path, index);
    if (!isModelProfile(entry)) {
      issues.push(createIssue('INVALID_VALUE', entryPath, `profile must be one of ${MODEL_PROFILES.join(', ')}`));
      return;
    }
    if (seen.has(entry)) {
      issues.push(createIssue('DUPLICATE_FIELD', entryPath, `duplicate profile "${entry}"`));
      return;
    }
    seen.add(entry);
    profiles.push(entry);
  });
  return issues.length > 0 ? invalid('MALFORMED_ENVELOPE', issues) : valid(profiles);
}
