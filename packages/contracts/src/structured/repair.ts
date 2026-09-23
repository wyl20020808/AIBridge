/**
 * Output repair contract (ARCHITECTURE.md §10.4, INTEGRATION_CONTRACT_V1.md §5.3).
 *
 * Repair is a **third** mechanism, distinct from retry and fallback:
 *  - not a retry — the request changed (validation issues are appended as feedback);
 *  - not a fallback — the same provider and model are re-asked;
 *  - bounded to **one** attempt in V1;
 *  - charged to the same overall budget and the same `idempotencyKey`;
 *  - reported as `warnings: [{ code: 'OUTPUT_REPAIRED' }]`.
 *
 * Stage 2 defines the contract only. It never calls a provider.
 */
import type { AiError } from '../errors.js';
import { makeAiError } from '../errors.js';
import type { ValidationIssue } from '../issue.js';
import type { AiWarning } from '../warnings.js';
import { makeWarning } from '../warnings.js';

export const DEFAULT_MAX_REPAIR_ATTEMPTS = 1;

/** How many repair attempts a policy allows. */
export const OUTPUT_REPAIR_POLICIES = ['NONE', 'ONCE'] as const;

export type OutputRepairPolicy = (typeof OUTPUT_REPAIR_POLICIES)[number];

export function repairAttemptsFor(policy: OutputRepairPolicy): number {
  return policy === 'ONCE' ? 1 : 0;
}

/** What the bridge hands back to the provider on a repair attempt. */
export type RepairRequest = {
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly idempotencyKey: string;
  /** The same provider and model as the original attempt. */
  readonly providerId: string;
  readonly modelRef: string;
  readonly capability: string;
  /** The validation issues, rendered as feedback. */
  readonly issues: readonly ValidationIssue[];
  /** The raw candidate that failed, so the model can see what it produced. */
  readonly rawCandidate: string;
};

export type RepairRequestInput = Omit<RepairRequest, 'attempt' | 'maxAttempts'> & {
  readonly attempt?: number;
  readonly maxAttempts?: number;
};

export function buildRepairRequest(input: RepairRequestInput): RepairRequest {
  return {
    attempt: input.attempt ?? 1,
    maxAttempts: input.maxAttempts ?? DEFAULT_MAX_REPAIR_ATTEMPTS,
    idempotencyKey: input.idempotencyKey,
    providerId: input.providerId,
    modelRef: input.modelRef,
    capability: input.capability,
    issues: input.issues,
    rawCandidate: input.rawCandidate,
  };
}

/** The better candidate a repair produced. */
export type RepairRepaired = {
  readonly outcome: 'REPAIRED';
  readonly candidate: string;
  readonly warnings: readonly AiWarning[];
};

/** Repair gave up. The caller reports `VALIDATION / OUTPUT_REPAIR_EXHAUSTED`. */
export type RepairExhausted = {
  readonly outcome: 'EXHAUSTED';
  readonly error: AiError;
};

export type RepairResult = RepairRepaired | RepairExhausted;

export function makeRepaired(candidate: string): RepairRepaired {
  return {
    outcome: 'REPAIRED',
    candidate,
    warnings: [makeWarning('OUTPUT_REPAIRED', 'one bounded repair attempt changed the payload')],
  };
}

export function makeRepairExhausted(issues: readonly ValidationIssue[]): RepairExhausted {
  const first = issues.length > 0 ? issues[0] : undefined;
  return {
    outcome: 'EXHAUSTED',
    error: makeAiError({
      reason: 'OUTPUT_REPAIR_EXHAUSTED',
      message: 'The generated answer did not conform to the declared output schema.',
      details: {
        issueCount: issues.length,
        ...(first === undefined ? {} : { firstPath: first.path, firstIssueCode: first.code }),
      },
    }),
  };
}
