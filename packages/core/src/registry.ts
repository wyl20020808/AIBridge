/**
 * `CapabilityRegistry` (CAPABILITIES.md §5, ROADMAP Stage 2).
 *
 * A **metadata** registry: it owns the contract of a capability (schemas, policy, limits), not its
 * execution. Handlers arrive with the capability packs in Stage 8; registering one here would mean
 * shipping a runtime-registration surface before there is a plugin authority behind it
 * (CAPABILITIES.md §9). Keeping that boundary now is what stops Stage 2 becoming Stage 8.
 *
 * Two registrations of the same `id@major` are idempotent when byte-identical and a
 * `CONFLICTING_REGISTRATION` otherwise: a silent overwrite is how two capability packs disagree
 * about a schema forever.
 */
import {
  CAPABILITY_DESCRIPTOR_VERSION,
  capabilityKey,
  createIssue,
  invalid,
  isGenericCapabilityId,
  isSpecializedCapabilityId,
  makeAiError,
  parseCapabilityId,
  parseMajor,
  valid,
  type AiError,
  type CapabilityAvailability,
  type CapabilityDescriptor,
  type CapabilityKind,
  type CapabilityInstructionMode,
  type CapabilityLimits,
  type CapabilityPolicy,
  type CapabilityReadiness,
  type CapabilityRequirements,
  type ModelProfile,
  type OutputSchema,
  type SchemaOwnership,
  type ValidationIssue,
  type ValidationResult,
} from '@aibridge/contracts';
import { canonicalize, isPositiveInteger } from './util.js';

/** Retention classes (CAPABILITIES.md §5.1, ARCHITECTURE.md §16.3). Default is the middle one. */export const RETENTION_LEVELS = ['NONE', 'METADATA_ONLY', 'CONTENT'] as const;

export type Retention = (typeof RETENTION_LEVELS)[number];

/**
 * The registration record. Deliberately has no `handler`: Stage 2 registers capabilities, it does
 * not run them.
 */
export type CapabilityRegistration = {
  readonly id: string;
  /** `MAJOR.MINOR`, major-compatible. */
  readonly version: string;
  readonly kind: CapabilityKind;
  readonly inputSchema: OutputSchema;
  readonly outputSchema: OutputSchema;
  /**
   * For a `SPECIALIZED` capability, the one generic primitive it is layered over (V1: exactly one).
   * For a `GENERIC` primitive, its own id.
   */
  readonly requiredPrimitive: string;
  readonly policy: CapabilityPolicy;
  readonly profiles: readonly ModelProfile[];
  readonly requirements?: CapabilityRequirements;
  readonly limits: CapabilityLimits;
  readonly allowGenericFallback: boolean;
  readonly retention: Retention;
  readonly schemaOwnership: SchemaOwnership;
  /** Base availability before governance is applied. Defaults to `AVAILABLE`. */
  readonly status?: CapabilityAvailability;
  /** Contract maturity; generic defaults to STABLE and specialized defaults to RESERVED. */
  readonly readiness?: CapabilityReadiness;
  /** Instructions remain consumer-authored; defaults to CONSUMER_COMPOSED. */
  readonly instructionMode?: CapabilityInstructionMode;
};

/** Build the consumer-visible descriptor from a registration and a resolved status. */
export function toCapabilityDescriptor(
  registration: CapabilityRegistration,
  status: CapabilityAvailability,
): CapabilityDescriptor {
  return {
    id: registration.id,
    version: registration.version,
    kind: registration.kind,
    status,
    readiness: registration.readiness ?? (registration.kind === 'GENERIC' ? 'STABLE' : 'RESERVED'),
    instructionMode: registration.instructionMode ?? 'CONSUMER_COMPOSED',
    requiredPrimitive: registration.requiredPrimitive,
    profiles: [...registration.profiles],
    requirements: registration.requirements ?? {},
    inputSchema: registration.inputSchema,
    outputSchema: registration.outputSchema,
    policyId: registration.policy.id,
    policyVersion: registration.policy.version,
    allowGenericFallback: registration.allowGenericFallback,
    limits: registration.limits,
    schemaOwnership: registration.schemaOwnership,
  };
}

function validateRegistration(registration: CapabilityRegistration): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const id = parseCapabilityId(registration.id, '$.id');
  if (!id.ok) {
    issues.push(...id.failure.issues);
  } else if (registration.kind === 'GENERIC' && !isGenericCapabilityId(registration.id)) {
    issues.push(createIssue('INVALID_VALUE', '$.id', 'a GENERIC capability must be a V1 generic primitive'));
  } else if (registration.kind === 'SPECIALIZED' && !isSpecializedCapabilityId(registration.id)) {
    issues.push(
      createIssue('INVALID_VALUE', '$.id', 'a SPECIALIZED capability must be domain-namespaced, never ai.* or a product name'),
    );
  }
  if (typeof registration.version !== 'string' || registration.version.length === 0) {
    issues.push(createIssue('INVALID_TYPE', '$.version', 'must be a non-empty version string'));
  }
  if (typeof registration.requiredPrimitive !== 'string' || registration.requiredPrimitive.length === 0) {
    issues.push(createIssue('INVALID_TYPE', '$.requiredPrimitive', 'must be a non-empty capability id'));
  }
  if (
    registration.readiness !== undefined &&
    !['STABLE', 'EXPERIMENTAL', 'RESERVED'].includes(registration.readiness)
  ) {
    issues.push(createIssue('INVALID_VALUE', '$.readiness', 'must be STABLE, EXPERIMENTAL or RESERVED'));
  }
  if (registration.instructionMode !== undefined && registration.instructionMode !== 'CONSUMER_COMPOSED') {
    issues.push(createIssue('INVALID_VALUE', '$.instructionMode', 'must be CONSUMER_COMPOSED'));
  }
  for (const key of ['maxInputBytes', 'maxOutputBytes', 'totalTimeoutMs', 'maxCallsPerTurn'] as const) {
    if (!isPositiveInteger(registration.limits[key])) {
      issues.push(createIssue('INVALID_TYPE', `$.limits.${key}`, 'must be a positive integer'));
    }
  }
  if (typeof registration.policy.id !== 'string' || registration.policy.id.length === 0) {
    issues.push(createIssue('INVALID_TYPE', '$.policy.id', 'must be a non-empty policy id'));
  }
  if (!(RETENTION_LEVELS as readonly string[]).includes(registration.retention)) {
    issues.push(createIssue('INVALID_VALUE', '$.retention', `must be one of ${RETENTION_LEVELS.join(', ')}`));
  }
  if (registration.allowGenericFallback && registration.kind === 'SPECIALIZED' && registration.schemaOwnership.output === 'CALLER') {
    issues.push(
      createIssue('INVALID_VALUE', '$.schemaOwnership.output', 'a specialized capability owns its output schema'),
    );
  }
  return issues;
}

function majorOf(version: string): number {
  return parseMajor(version) ?? 0;
}

/** One resolved registration for an id, at the highest registered major unless pinned. */
function latestFor(
  registrations: ReadonlyMap<string, CapabilityRegistration>,
  id: string,
): CapabilityRegistration | null {
  let best: CapabilityRegistration | null = null;
  for (const registration of registrations.values()) {
    if (registration.id !== id) {
      continue;
    }
    if (best === null || majorOf(registration.version) > majorOf(best.version)) {
      best = registration;
    }
  }
  return best;
}

export class CapabilityRegistry {
  readonly #registrations = new Map<string, CapabilityRegistration>();

  /**
   * Register a capability. Idempotent for a byte-identical re-registration; a different record for
   * the same `id@major` is `CONFLICTING_REGISTRATION`.
   */
  register(registration: CapabilityRegistration): ValidationResult<CapabilityDescriptor> {
    const issues = validateRegistration(registration);
    if (issues.length > 0) {
      return invalid('MALFORMED_ENVELOPE', issues);
    }
    const key = capabilityKey(registration.id, registration.version);
    const existing = this.#registrations.get(key);
    if (existing !== undefined) {
      if (canonicalize(existing) === canonicalize(registration)) {
        return valid(toCapabilityDescriptor(existing, existing.status ?? 'AVAILABLE'));
      }
      return invalid('MALFORMED_ENVELOPE', [
        createIssue('CONFLICTING_REGISTRATION', '$', `a different registration already exists for ${key}`),
      ]);
    }
    this.#registrations.set(key, registration);
    return valid(toCapabilityDescriptor(registration, registration.status ?? 'AVAILABLE'));
  }

  /** Resolve a descriptor. A pinned version matches by major; an omitted one picks the highest major. */
  get(id: string, version?: string): CapabilityDescriptor | null {
    const registration = this.getRegistration(id, version);
    return registration === null ? null : toCapabilityDescriptor(registration, registration.status ?? 'AVAILABLE');
  }

  /** Resolve the underlying registration. */
  getRegistration(id: string, version?: string): CapabilityRegistration | null {
    if (version !== undefined) {
      return this.#registrations.get(capabilityKey(id, version)) ?? null;
    }
    return latestFor(this.#registrations, id);
  }

  has(id: string, version?: string): boolean {
    return this.getRegistration(id, version) !== null;
  }

  /** Every registration, ordered by id then descending major. */
  listRegistrations(): readonly CapabilityRegistration[] {
    return [...this.#registrations.values()].sort((a, b) => {
      if (a.id !== b.id) {
        return a.id < b.id ? -1 : 1;
      }
      return majorOf(b.version) - majorOf(a.version);
    });
  }

  /** Every descriptor, ordered by id then descending major. */
  list(): readonly CapabilityDescriptor[] {
    return this.listRegistrations().map((registration) =>
      toCapabilityDescriptor(registration, registration.status ?? 'AVAILABLE'),
    );
  }

  get size(): number {
    return this.#registrations.size;
  }

  clear(): void {
    this.#registrations.clear();
  }
}

/* -------------------------------------------------------------------------------------------------
 * `maxCallsPerTurn` — a capability that quietly makes four model calls is un-auditable.
 * ----------------------------------------------------------------------------------------------- */

export type CallAuthorization =
  | { readonly authorized: true; readonly remaining: number }
  | { readonly authorized: false; readonly error: AiError };

/**
 * Authorize the next model call for one turn.
 *
 * Exceeding the limit is `POLICY / POLICY_VIOLATION` with `details.rule = maxCallsPerTurn`: it is a
 * declared policy rule, not an internal accident.
 */
export function authorizeCapabilityCall(maxCallsPerTurn: number, callsMade: number): CallAuthorization {
  if (callsMade >= maxCallsPerTurn) {
    return {
      authorized: false,
      error: makeAiError({
        reason: 'POLICY_VIOLATION',
        message: `The capability allows at most ${maxCallsPerTurn} model call(s) per turn.`,
        details: { rule: 'maxCallsPerTurn' },
      }),
    };
  }
  return { authorized: true, remaining: maxCallsPerTurn - callsMade };
}

/** A per-turn counter bound to one capability's limit. */
export class TurnCallCounter {
  readonly #limit: number;
  #callsMade = 0;

  constructor(limit: number) {
    this.#limit = limit;
  }

  authorize(): CallAuthorization {
    const authorization = authorizeCapabilityCall(this.#limit, this.#callsMade);
    if (authorization.authorized) {
      this.#callsMade += 1;
    }
    return authorization;
  }

  get callsMade(): number {
    return this.#callsMade;
  }

  get limit(): number {
    return this.#limit;
  }

  reset(): void {
    this.#callsMade = 0;
  }
}

/** The descriptor version every registration in this build is described by. */
export function registrationDescriptorVersion(): string {
  return CAPABILITY_DESCRIPTOR_VERSION;
}
