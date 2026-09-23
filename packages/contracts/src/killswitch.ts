/**
 * Governance kill switches (ARCHITECTURE.md §20, CAPABILITIES.md §6.3).
 *
 * Three switches, all required:
 *  - `global` — every capability is `DISABLED`;
 *  - `providers.<id>` — that provider is not routable; other providers keep serving;
 *  - `capabilities.<id>@<major>` — that capability is `DISABLED`.
 *
 * A kill switch is **governance, never failure**: it must be visible through `discoverCapabilities`
 * *before* a call is made, so a school that forbids AI produces a degraded learning turn rather
 * than an error page (ARCHITECTURE.md §20).
 *
 * Resolution precedence is `global → capability → provider`: the broadest operator intent names
 * the error, so a global switch does not surface as a provider-specific one.
 */
import { capabilityKey } from './capability.js';
import { describe, isRecord, unknownKeys } from './guards.js';
import type { ValidationIssue, ValidationResult } from './issue.js';
import { at, createIssue, invalid, valid } from './issue.js';

/** The three reason codes a kill switch maps to. They are governance, not provider failures. */
export const KILL_SWITCH_REASONS = ['KILL_SWITCH_GLOBAL', 'KILL_SWITCH_PROVIDER', 'KILL_SWITCH_CAPABILITY'] as const;

export type KillSwitchReason = (typeof KILL_SWITCH_REASONS)[number];

export function isKillSwitchReason(value: unknown): value is KillSwitchReason {
  return typeof value === 'string' && (KILL_SWITCH_REASONS as readonly string[]).includes(value);
}

export const KILL_SWITCH_STATE_KEYS = ['global', 'providers', 'capabilities'] as const;

/**
 * The operator-facing switch state.
 *
 * `providers` and `capabilities` are plain string lists so a state is trivially serializable and
 * comparable. A capability entry is either `id` or `id@major`; both mean the same capability is
 * off (the major-scoped form is the exact form the config uses).
 */
export type KillSwitchState = {
  readonly global: boolean;
  readonly providers: readonly string[];
  readonly capabilities: readonly string[];
};

/** Every switch off. The honest default when no operator config exists. */
export function emptyKillSwitch(): KillSwitchState {
  return { global: false, providers: [], capabilities: [] };
}

function parseStringList(
  value: unknown,
  path: string,
  label: string,
  issues: ValidationIssue[],
): readonly string[] {
  if (!Array.isArray(value)) {
    issues.push(createIssue('INVALID_TYPE', path, `must be an array of ${label}`));
    return [];
  }
  const seen = new Set<string>();
  const entries: string[] = [];
  value.forEach((entry, index) => {
    const entryPath = at(path, index);
    if (typeof entry !== 'string' || entry.length === 0) {
      issues.push(createIssue('INVALID_TYPE', entryPath, `must be a non-empty ${label} string`));
      return;
    }
    if (seen.has(entry)) {
      issues.push(createIssue('DUPLICATE_FIELD', entryPath, `duplicate ${label} "${entry}"`));
      return;
    }
    seen.add(entry);
    entries.push(entry);
  });
  return entries;
}

/**
 * Parse a kill-switch state. Unknown fields are rejected; a list entry must be a non-empty string
 * with no duplicates. Sorted issue paths keep a failure reproducible.
 */
export function parseKillSwitchState(value: unknown, path = '$'): ValidationResult<KillSwitchState> {
  if (!isRecord(value)) {
    return invalid('MALFORMED_ENVELOPE', [createIssue('INVALID_TYPE', path, `must be an object, got ${describe(value)}`)]);
  }
  const issues: ValidationIssue[] = [];
  for (const key of unknownKeys(value, KILL_SWITCH_STATE_KEYS)) {
    issues.push(createIssue('UNKNOWN_FIELD', at(path, key), 'unknown kill-switch field'));
  }
  if (typeof value['global'] !== 'boolean') {
    issues.push(createIssue('INVALID_TYPE', at(path, 'global'), 'must be a boolean'));
  }
  const providers = parseStringList(value['providers'], at(path, 'providers'), 'provider id', issues);
  const capabilities = parseStringList(value['capabilities'], at(path, 'capabilities'), 'capability id', issues);
  if (issues.length > 0) {
    return invalid('MALFORMED_ENVELOPE', issues);
  }
  return valid({
    global: value['global'] as boolean,
    providers,
    capabilities,
  });
}

/** True when the capability is off, by either the bare id or its `id@major` form. */
export function isCapabilityKilled(
  state: KillSwitchState,
  capability: string,
  capabilityVersion: string,
): boolean {
  if (state.global) {
    return true;
  }
  const key = capabilityKey(capability, capabilityVersion);
  return state.capabilities.includes(key) || state.capabilities.includes(capability);
}

/** True when the provider is off. A provider switch narrows routing; it does not silence a capability. */
export function isProviderKilled(state: KillSwitchState, providerId: string): boolean {
  return state.providers.includes(providerId);
}

export type KillSwitchQuery = {
  readonly capability: string;
  readonly capabilityVersion: string;
  /** The providers the capability's route chain could use, in route order. */
  readonly candidateProviders: readonly string[];
};

/** The request may proceed, possibly on a narrower set of providers. */
export type KillSwitchAllowed = {
  readonly allowed: true;
  /** The candidates minus any killed provider, preserving route order. */
  readonly availableProviders: readonly string[];
};

/** The request must be refused before routing. */
export type KillSwitchBlocked = {
  readonly allowed: false;
  readonly reason: KillSwitchReason;
  /** Present for `KILL_SWITCH_PROVIDER`: the first candidate provider the switch turned off. */
  readonly providerId?: string;
  /** Present for `KILL_SWITCH_CAPABILITY`. */
  readonly capability?: string;
};

export type KillSwitchVerdict = KillSwitchAllowed | KillSwitchBlocked;

/**
 * Apply the switches to one prospective call.
 *
 * `KILL_SWITCH_PROVIDER` is only reported when *no* candidate provider survives: if one candidate
 * is off but another can serve, the call proceeds on the survivor. A provider switch is a routing
 * restriction, not a capability outage.
 */
export function resolveKillSwitch(state: KillSwitchState, query: KillSwitchQuery): KillSwitchVerdict {
  if (state.global) {
    return { allowed: false, reason: 'KILL_SWITCH_GLOBAL' };
  }
  const key = capabilityKey(query.capability, query.capabilityVersion);
  if (state.capabilities.includes(key) || state.capabilities.includes(query.capability)) {
    return { allowed: false, reason: 'KILL_SWITCH_CAPABILITY', capability: query.capability };
  }
  const availableProviders = query.candidateProviders.filter((providerId) => !isProviderKilled(state, providerId));
  if (query.candidateProviders.length > 0 && availableProviders.length === 0) {
    const first = query.candidateProviders[0];
    return {
      allowed: false,
      reason: 'KILL_SWITCH_PROVIDER',
      ...(first === undefined ? {} : { providerId: first }),
    };
  }
  return { allowed: true, availableProviders };
}
