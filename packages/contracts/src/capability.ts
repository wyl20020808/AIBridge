/**
 * Capability identity, descriptors and discovery types (CAPABILITIES.md, INTEGRATION_CONTRACT_V1.md §6).
 *
 * Naming rules (frozen): `<domain>.<subject>.<verb>`, lower dot-case. A **product name must never
 * appear** as a capability id — a product's voice lives in `policyId`.
 *
 * Schema ownership (Stage 2 formalization, Phase 10):
 *  - a **generic structured** capability lets the caller supply `outputSchema`;
 *  - every other capability's input and output schema is owned by the **capability registry**.
 */
import { describe, isPositiveInteger, isRecord, unknownKeys } from './guards.js';
import type { ValidationIssue, ValidationResult } from './issue.js';
import { at, createIssue, invalid, valid } from './issue.js';
import { parseModelProfileList, type ModelProfile } from './profile.js';
import { parseCapabilityRequirements, type CapabilityRequirements } from './requirements.js';
import { parseOutputSchema, type OutputSchema } from './schema.js';
import { CAPABILITY_DESCRIPTOR_VERSION } from './versions.js';

/** The two-layer capability model. */
export const CAPABILITY_KINDS = ['GENERIC', 'SPECIALIZED'] as const;

export type CapabilityKind = (typeof CAPABILITY_KINDS)[number];

/** Availability states. `DISABLED` is deliberately not `UNAVAILABLE`. */
export const CAPABILITY_AVAILABILITIES = ['AVAILABLE', 'DEGRADED', 'UNAVAILABLE', 'DISABLED'] as const;

export type CapabilityAvailability = (typeof CAPABILITY_AVAILABILITIES)[number];

/** Readiness is a contract maturity label, separate from runtime availability. */
export const CAPABILITY_READINESS_VALUES = ['STABLE', 'EXPERIMENTAL', 'RESERVED'] as const;

export type CapabilityReadiness = (typeof CAPABILITY_READINESS_VALUES)[number];

/** This contract version only permits consumer-composed instructions. */
export const CAPABILITY_INSTRUCTION_MODES = ['CONSUMER_COMPOSED'] as const;

export type CapabilityInstructionMode = (typeof CAPABILITY_INSTRUCTION_MODES)[number];

export function isCapabilityKind(value: unknown): value is CapabilityKind {
  return typeof value === 'string' && (CAPABILITY_KINDS as readonly string[]).includes(value);
}

export function isCapabilityAvailability(value: unknown): value is CapabilityAvailability {
  return typeof value === 'string' && (CAPABILITY_AVAILABILITIES as readonly string[]).includes(value);
}

export function isCapabilityReadiness(value: unknown): value is CapabilityReadiness {
  return typeof value === 'string' && (CAPABILITY_READINESS_VALUES as readonly string[]).includes(value);
}

export function isCapabilityInstructionMode(value: unknown): value is CapabilityInstructionMode {
  return typeof value === 'string' && (CAPABILITY_INSTRUCTION_MODES as readonly string[]).includes(value);
}

/** The two generic primitives that ship in V1. */
export const GENERIC_CAPABILITY_IDS = ['ai.text.generate', 'ai.structured.generate'] as const;

export type GenericCapabilityId = (typeof GENERIC_CAPABILITY_IDS)[number];

/** The generic namespace root. */
export const GENERIC_CAPABILITY_NAMESPACE = 'ai.' as const;

/** Product names are forbidden as capability ids, in either direction. */
export const FORBIDDEN_CAPABILITY_PREFIXES = ['algoquest.', 'ojplatform.', 'aibridge.'] as const;

/** 2–4 lower dot-case segments. */
export const CAPABILITY_ID_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*){1,3}$/;

export function isGenericCapabilityId(value: unknown): value is GenericCapabilityId {
  return typeof value === 'string' && (GENERIC_CAPABILITY_IDS as readonly string[]).includes(value);
}

/** True when the id is syntactically valid, never product-prefixed and not `ai.*`. */
export function isSpecializedCapabilityId(value: unknown): boolean {
  if (typeof value !== 'string' || !CAPABILITY_ID_PATTERN.test(value)) {
    return false;
  }
  if (value.startsWith(GENERIC_CAPABILITY_NAMESPACE)) {
    return false;
  }
  return !FORBIDDEN_CAPABILITY_PREFIXES.some((prefix) => value.startsWith(prefix));
}

/** Parse a capability id: grammar and product-name rejection, namespace-agnostic. */
export function parseCapabilityId(value: unknown, path = '$'): ValidationResult<string> {
  if (typeof value !== 'string') {
    return invalid('MALFORMED_ENVELOPE', [createIssue('INVALID_TYPE', path, `must be a string, got ${describe(value)}`)]);
  }
  if (!CAPABILITY_ID_PATTERN.test(value)) {
    return invalid('MALFORMED_ENVELOPE', [
      createIssue('PATTERN_MISMATCH', path, 'must be a lower dot-case id with two to four segments'),
    ]);
  }
  const forbidden = FORBIDDEN_CAPABILITY_PREFIXES.find((prefix) => value.startsWith(prefix));
  if (forbidden !== undefined) {
    return invalid('MALFORMED_ENVELOPE', [
      createIssue('FORBIDDEN_FIELD', path, `a capability id must not be product-namespaced ("${forbidden}")`),
    ]);
  }
  return valid(value);
}

/** Parse a generic capability id. Anything outside the V1 generic set is `CAPABILITY_UNKNOWN`. */
export function parseGenericCapabilityId(value: unknown, path = '$'): ValidationResult<GenericCapabilityId> {
  if (!isGenericCapabilityId(value)) {
    return invalid('CAPABILITY_UNKNOWN', [
      createIssue('UNKNOWN_CAPABILITY', path, `must be one of ${GENERIC_CAPABILITY_IDS.join(', ')}`),
    ]);
  }
  return valid(value);
}

/** Parse a specialized capability id. `ai.*` belongs to the generic namespace, not here. */
export function parseSpecializedCapabilityId(value: unknown, path = '$'): ValidationResult<string> {
  if (typeof value !== 'string' || !isSpecializedCapabilityId(value)) {
    return invalid('MALFORMED_ENVELOPE', [
      createIssue('INVALID_VALUE', path, 'must be a domain-namespaced specialized capability id, never ai.* or a product name'),
    ]);
  }
  return valid(value);
}

/** The scoped key for `id@major`. */
export function capabilityKey(id: string, version: string): string {
  const major = version.split('.')[0] ?? version;
  return `${id}@${major}`;
}

/** Compare two capability references by id and major. */
export function sameCapability(idA: string, versionA: string, idB: string, versionB: string): boolean {
  return idA === idB && capabilityKey(idA, versionA) === capabilityKey(idB, versionB);
}

/** Who owns a schema's content. */
export const SCHEMA_OWNERS = ['REGISTRY', 'CALLER'] as const;

export type SchemaOwner = (typeof SCHEMA_OWNERS)[number];

export type SchemaOwnership = {
  readonly input: SchemaOwner;
  readonly output: SchemaOwner;
  readonly policy: 'REGISTRY';
};

export type CapabilityLimits = {
  readonly maxInputBytes: number;
  readonly maxOutputBytes: number;
  readonly totalTimeoutMs: number;
  /** 1 for every V1 capability: a capability that quietly makes four model calls is un-auditable. */
  readonly maxCallsPerTurn: number;
};

export type CapabilityPolicy = {
  readonly id: string;
  readonly version: string;
  /** Deny-by-default input keys. A key outside it is rejected. */
  readonly inputAllowList: readonly string[];
  /** Named, machine-checkable rules. */
  readonly outputRules: readonly string[];
  readonly forbiddenOutput: readonly string[];
  readonly maxOutputBytes: number;
};

export type CapabilityDescriptor = {
  readonly id: string;
  readonly version: string;
  readonly kind: CapabilityKind;
  readonly status: CapabilityAvailability;
  readonly readiness?: CapabilityReadiness;
  readonly instructionMode?: CapabilityInstructionMode;
  readonly requiredPrimitive: string;
  readonly profiles: readonly ModelProfile[];
  readonly requirements: CapabilityRequirements;
  readonly inputSchema: OutputSchema;
  readonly outputSchema: OutputSchema;
  readonly policyId: string;
  readonly policyVersion: string;
  readonly allowGenericFallback: boolean;
  readonly limits: CapabilityLimits;
  readonly schemaOwnership: SchemaOwnership;
};

/** The task-facing name for the descriptor type. */
export type AiCapabilityDescriptor = CapabilityDescriptor;

export const CAPABILITY_DESCRIPTOR_KEYS = [
  'id',
  'version',
  'kind',
  'status',
  'readiness',
  'instructionMode',
  'requiredPrimitive',
  'profiles',
  'requirements',
  'inputSchema',
  'outputSchema',
  'policyId',
  'policyVersion',
  'allowGenericFallback',
  'limits',
  'schemaOwnership',
] as const;

export const CAPABILITY_LIMITS_KEYS = ['maxInputBytes', 'maxOutputBytes', 'totalTimeoutMs', 'maxCallsPerTurn'] as const;
export const CAPABILITY_POLICY_KEYS = ['id', 'version', 'inputAllowList', 'outputRules', 'forbiddenOutput', 'maxOutputBytes'] as const;
export const SCHEMA_OWNERSHIP_KEYS = ['input', 'output', 'policy'] as const;

export const DEFAULT_CAPABILITY_LIMITS: CapabilityLimits = {
  maxInputBytes: 32_768,
  maxOutputBytes: 65_536,
  totalTimeoutMs: 20_000,
  maxCallsPerTurn: 1,
};

function parseLimits(value: unknown, path: string, issues: ValidationIssue[]): CapabilityLimits | undefined {
  if (!isRecord(value)) {
    issues.push(createIssue('INVALID_TYPE', path, 'must be an object'));
    return undefined;
  }
  for (const key of unknownKeys(value, CAPABILITY_LIMITS_KEYS)) {
    issues.push(createIssue('UNKNOWN_FIELD', at(path, key), 'unknown capability limit'));
  }
  for (const key of CAPABILITY_LIMITS_KEYS) {
    if (!isPositiveInteger(value[key])) {
      issues.push(createIssue('INVALID_TYPE', at(path, key), 'must be a positive integer'));
    }
  }
  if (issues.length > 0) {
    return undefined;
  }
  return {
    maxInputBytes: value['maxInputBytes'] as number,
    maxOutputBytes: value['maxOutputBytes'] as number,
    totalTimeoutMs: value['totalTimeoutMs'] as number,
    maxCallsPerTurn: value['maxCallsPerTurn'] as number,
  };
}

function parseOwnership(value: unknown, path: string, issues: ValidationIssue[]): SchemaOwnership | undefined {
  if (!isRecord(value)) {
    issues.push(createIssue('INVALID_TYPE', path, 'must be an object'));
    return undefined;
  }
  for (const key of unknownKeys(value, SCHEMA_OWNERSHIP_KEYS)) {
    issues.push(createIssue('UNKNOWN_FIELD', at(path, key), 'unknown schema-ownership field'));
  }
  for (const key of ['input', 'output'] as const) {
    if (value[key] !== 'REGISTRY' && value[key] !== 'CALLER') {
      issues.push(createIssue('INVALID_VALUE', at(path, key), 'must be REGISTRY or CALLER'));
    }
  }
  if (value['policy'] !== 'REGISTRY') {
    issues.push(createIssue('INVALID_VALUE', at(path, 'policy'), 'must be REGISTRY'));
  }
  if (issues.length > 0) {
    return undefined;
  }
  return {
    input: value['input'] as SchemaOwner,
    output: value['output'] as SchemaOwner,
    policy: 'REGISTRY',
  };
}

export function parseCapabilityPolicy(value: unknown, path = '$'): ValidationResult<CapabilityPolicy> {
  if (!isRecord(value)) {
    return invalid('MALFORMED_ENVELOPE', [createIssue('INVALID_TYPE', path, `must be an object, got ${describe(value)}`)]);
  }
  const issues: ValidationIssue[] = [];
  for (const key of unknownKeys(value, CAPABILITY_POLICY_KEYS)) {
    issues.push(createIssue('UNKNOWN_FIELD', at(path, key), 'unknown policy field'));
  }
  for (const key of ['id', 'version'] as const) {
    if (typeof value[key] !== 'string' || (value[key] as string).length === 0) {
      issues.push(createIssue('INVALID_TYPE', at(path, key), 'must be a non-empty string'));
    }
  }
  for (const key of ['inputAllowList', 'outputRules', 'forbiddenOutput'] as const) {
    const list = value[key];
    if (!Array.isArray(list) || !list.every((entry) => typeof entry === 'string' && entry.length > 0)) {
      issues.push(createIssue('INVALID_TYPE', at(path, key), 'must be an array of non-empty strings'));
    }
  }
  if (!isPositiveInteger(value['maxOutputBytes'])) {
    issues.push(createIssue('INVALID_TYPE', at(path, 'maxOutputBytes'), 'must be a positive integer'));
  }
  if (issues.length > 0) {
    return invalid('MALFORMED_ENVELOPE', issues);
  }
  return valid({
    id: value['id'] as string,
    version: value['version'] as string,
    inputAllowList: [...(value['inputAllowList'] as readonly string[])],
    outputRules: [...(value['outputRules'] as readonly string[])],
    forbiddenOutput: [...(value['forbiddenOutput'] as readonly string[])],
    maxOutputBytes: value['maxOutputBytes'] as number,
  });
}

export function parseCapabilityDescriptor(value: unknown, path = '$'): ValidationResult<CapabilityDescriptor> {
  if (!isRecord(value)) {
    return invalid('MALFORMED_ENVELOPE', [createIssue('INVALID_TYPE', path, `must be an object, got ${describe(value)}`)]);
  }
  const issues: ValidationIssue[] = [];
  for (const key of unknownKeys(value, CAPABILITY_DESCRIPTOR_KEYS)) {
    issues.push(createIssue('UNKNOWN_FIELD', at(path, key), 'unknown capability descriptor field'));
  }
  const id = parseCapabilityId(value['id'], at(path, 'id'));
  if (!id.ok) {
    issues.push(...id.failure.issues);
  }
  if (typeof value['version'] !== 'string' || value['version'].length === 0) {
    issues.push(createIssue('INVALID_TYPE', at(path, 'version'), 'must be a non-empty string'));
  }
  if (!isCapabilityKind(value['kind'])) {
    issues.push(createIssue('INVALID_VALUE', at(path, 'kind'), 'must be GENERIC or SPECIALIZED'));
  }
  if (!isCapabilityAvailability(value['status'])) {
    issues.push(createIssue('INVALID_VALUE', at(path, 'status'), 'must be a known availability state'));
  }
  const readiness = value['readiness'];
  if (readiness !== undefined && !isCapabilityReadiness(readiness)) {
    issues.push(createIssue('INVALID_VALUE', at(path, 'readiness'), 'must be a known capability readiness state'));
  }
  const instructionMode = value['instructionMode'];
  if (instructionMode !== undefined && !isCapabilityInstructionMode(instructionMode)) {
    issues.push(createIssue('INVALID_VALUE', at(path, 'instructionMode'), 'must be a known capability instruction mode'));
  }
  if (typeof value['requiredPrimitive'] !== 'string' || value['requiredPrimitive'].length === 0) {
    issues.push(createIssue('INVALID_TYPE', at(path, 'requiredPrimitive'), 'must be a non-empty capability id'));
  }
  const profiles = parseModelProfileList(value['profiles'], at(path, 'profiles'));
  if (!profiles.ok) {
    issues.push(...profiles.failure.issues);
  }
  const requirements = parseCapabilityRequirements(value['requirements'], at(path, 'requirements'));
  if (!requirements.ok) {
    issues.push(...requirements.failure.issues);
  }
  const inputSchema = parseOutputSchema(value['inputSchema'], at(path, 'inputSchema'));
  if (!inputSchema.ok) {
    issues.push(...inputSchema.failure.issues);
  }
  const outputSchema = parseOutputSchema(value['outputSchema'], at(path, 'outputSchema'));
  if (!outputSchema.ok) {
    issues.push(...outputSchema.failure.issues);
  }
  for (const key of ['policyId', 'policyVersion'] as const) {
    if (typeof value[key] !== 'string' || (value[key] as string).length === 0) {
      issues.push(createIssue('INVALID_TYPE', at(path, key), 'must be a non-empty string'));
    }
  }
  if (typeof value['allowGenericFallback'] !== 'boolean') {
    issues.push(createIssue('INVALID_TYPE', at(path, 'allowGenericFallback'), 'must be a boolean'));
  }
  const limits = parseLimits(value['limits'], at(path, 'limits'), issues);
  const ownership = parseOwnership(value['schemaOwnership'], at(path, 'schemaOwnership'), issues);

  if (issues.length > 0 || limits === undefined || ownership === undefined) {
    return invalid('MALFORMED_ENVELOPE', issues);
  }
  return valid({
    id: id.ok ? id.value : '',
    version: value['version'] as string,
    kind: value['kind'] as CapabilityKind,
    status: value['status'] as CapabilityAvailability,
    ...(readiness === undefined ? {} : { readiness: readiness as CapabilityReadiness }),
    ...(instructionMode === undefined ? {} : { instructionMode: instructionMode as CapabilityInstructionMode }),
    requiredPrimitive: value['requiredPrimitive'] as string,
    profiles: profiles.ok ? profiles.value : [],
    requirements: requirements.ok ? requirements.value : {},
    inputSchema: inputSchema.ok ? inputSchema.value : { kind: 'REF', ref: { schemaId: '', version: '' } },
    outputSchema: outputSchema.ok ? outputSchema.value : { kind: 'REF', ref: { schemaId: '', version: '' } },
    policyId: value['policyId'] as string,
    policyVersion: value['policyVersion'] as string,
    allowGenericFallback: value['allowGenericFallback'] as boolean,
    limits,
    schemaOwnership: ownership,
  });
}

/** A discovered capability summary. */
export type CapabilityStatusEntry = {
  readonly id: string;
  readonly version: string;
  readonly status: CapabilityAvailability;
};

/** Overall bridge status (CAPABILITIES.md §6.3). */
export type AiBridgeStatus = {
  readonly contractVersion: string;
  readonly global: CapabilityAvailability;
  readonly killSwitch: {
    readonly global: boolean;
    readonly providers: readonly string[];
    readonly capabilities: readonly string[];
  };
  readonly capabilities: readonly CapabilityStatusEntry[];
};

export const AI_BRIDGE_STATUS_KEYS = ['contractVersion', 'global', 'killSwitch', 'capabilities'] as const;

export function parseAiBridgeStatus(value: unknown, path = '$'): ValidationResult<AiBridgeStatus> {
  if (!isRecord(value)) {
    return invalid('MALFORMED_ENVELOPE', [createIssue('INVALID_TYPE', path, `must be an object, got ${describe(value)}`)]);
  }
  const issues: ValidationIssue[] = [];
  for (const key of unknownKeys(value, AI_BRIDGE_STATUS_KEYS)) {
    issues.push(createIssue('UNKNOWN_FIELD', at(path, key), 'unknown status field'));
  }
  if (typeof value['contractVersion'] !== 'string' || value['contractVersion'].length === 0) {
    issues.push(createIssue('INVALID_TYPE', at(path, 'contractVersion'), 'must be a non-empty string'));
  }
  if (!isCapabilityAvailability(value['global'])) {
    issues.push(createIssue('INVALID_VALUE', at(path, 'global'), 'must be a known availability state'));
  }
  const killSwitch = value['killSwitch'];
  if (!isRecord(killSwitch)) {
    issues.push(createIssue('INVALID_TYPE', at(path, 'killSwitch'), 'must be an object'));
  } else {
    if (typeof killSwitch['global'] !== 'boolean') {
      issues.push(createIssue('INVALID_TYPE', at(at(path, 'killSwitch'), 'global'), 'must be a boolean'));
    }
    for (const key of ['providers', 'capabilities'] as const) {
      const list = killSwitch[key];
      if (!Array.isArray(list) || !list.every((entry) => typeof entry === 'string')) {
        issues.push(createIssue('INVALID_TYPE', at(at(path, 'killSwitch'), key), 'must be an array of strings'));
      }
    }
  }
  const capabilities = value['capabilities'];
  if (!Array.isArray(capabilities)) {
    issues.push(createIssue('INVALID_TYPE', at(path, 'capabilities'), 'must be an array'));
  } else {
    capabilities.forEach((entry, index) => {
      const entryPath = at(at(path, 'capabilities'), index);
      if (!isRecord(entry)) {
        issues.push(createIssue('INVALID_TYPE', entryPath, 'must be an object'));
        return;
      }
      for (const key of unknownKeys(entry, ['id', 'version', 'status'])) {
        issues.push(createIssue('UNKNOWN_FIELD', at(entryPath, key), 'unknown capability status field'));
      }
      for (const key of ['id', 'version'] as const) {
        if (typeof entry[key] !== 'string' || (entry[key] as string).length === 0) {
          issues.push(createIssue('INVALID_TYPE', at(entryPath, key), 'must be a non-empty string'));
        }
      }
      if (!isCapabilityAvailability(entry['status'])) {
        issues.push(createIssue('INVALID_VALUE', at(entryPath, 'status'), 'must be a known availability state'));
      }
    });
  }
  if (issues.length > 0) {
    return invalid('MALFORMED_ENVELOPE', issues);
  }
  const killSwitchRecord = killSwitch as Record<string, unknown>;
  return valid({
    contractVersion: value['contractVersion'] as string,
    global: value['global'] as CapabilityAvailability,
    killSwitch: {
      global: killSwitchRecord['global'] as boolean,
      providers: [...(killSwitchRecord['providers'] as readonly string[])],
      capabilities: [...(killSwitchRecord['capabilities'] as readonly string[])],
    },
    capabilities: (capabilities as readonly Record<string, unknown>[]).map((entry) => ({
      id: entry['id'] as string,
      version: entry['version'] as string,
      status: entry['status'] as CapabilityAvailability,
    })),
  });
}

/** The descriptor version this build records. */
export function capabilityDescriptorVersion(): string {
  return CAPABILITY_DESCRIPTOR_VERSION;
}
