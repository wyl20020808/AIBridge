/**
 * The usage ledger (ROADMAP Stage 5 Phase 27–29, ARCHITECTURE.md §16.1).
 *
 * Append-only. One **logical request** record and one **provider attempt** record per dispatch,
 * so a fallback chain is fully accounted: every provider that was paid is visible (Phase 26).
 *
 * What is recorded is counts, ids, timing and safe provenance. What is **never** recorded is
 * content: no prompt, no learner text, no AI output, no reasoning content, no credential, no
 * provider raw error (Phase 29). The record shape makes the first half convenient and the second
 * half impossible — there is no content field to fill in.
 */
import type { AiErrorCode, AiErrorReason, AiUsage, ModelProfile } from '@aibridge/contracts';
import type { CostEstimate } from './cost.js';

export const ATTEMPT_KINDS = ['PRIMARY', 'RETRY', 'FALLBACK', 'REPAIR'] as const;

export type AttemptKind = (typeof ATTEMPT_KINDS)[number];

export const ATTEMPT_STATUSES = ['SUCCEEDED', 'FAILED', 'CANCELLED', 'SKIPPED'] as const;

export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];

/** Why an attempt was made (or skipped). Stable closed values, never prose. */
export const ATTEMPT_SKIP_REASONS = [
  'KILL_SWITCH',
  'BREAKER_OPEN',
  'CAPABILITY_UNMET',
  'NOT_REGISTERED',
  'DEADLINE_EXHAUSTED',
  'QUOTA_INELIGIBLE',
  'CHAIN_EXHAUSTED',
] as const;

export type AttemptSkipReason = (typeof ATTEMPT_SKIP_REASONS)[number];

export type ProviderAttemptUsageRecord = {
  readonly usageRecordId: string;
  readonly logicalRequestId: string;
  readonly attemptId: string;
  /** The attempt that spawned this one — a repair is a child of the attempt it repairs. */
  readonly parentAttemptId?: string;
  readonly sequence: number;
  readonly attemptKind: AttemptKind;
  readonly callerPluginId: string;
  /** Opaque, hashed subject reference. Never the token (SECURITY.md §16.1). */
  readonly subjectHash?: string;
  readonly capability: string;
  readonly capabilityVersion: string;
  readonly profile: ModelProfile;
  readonly providerId: string;
  readonly modelAlias: string;
  /** Operator-side real model id. Never consumer-visible. */
  readonly providerModelId: string;
  /** The config snapshot version the attempt ran against. */
  readonly routeConfigVersion: string;
  readonly startedAtMs: number;
  readonly finishedAtMs: number;
  readonly latencyMs: number;
  readonly status: AttemptStatus;
  readonly errorCode?: AiErrorCode;
  readonly errorReason?: AiErrorReason;
  /** Why a retry/fallback/repair happened — the closed decision rule, never prose. */
  readonly retryRule?: string;
  readonly fallbackRule?: string;
  readonly skipReason?: AttemptSkipReason;
  readonly usage: AiUsage;
  /** False when the provider reported no usage. Never silently zero (Phase 24). */
  readonly usageKnown: boolean;
  readonly cost?: CostEstimate;
  readonly pricingId?: string;
  readonly pricingVersion?: string;
};

export type LogicalRequestUsageRecord = {
  readonly usageRecordId: string;
  readonly logicalRequestId: string;
  readonly requestId: string;
  readonly callerPluginId: string;
  readonly subjectHash?: string;
  readonly capability: string;
  readonly capabilityVersion: string;
  readonly profile: ModelProfile;
  readonly configVersion: string;
  readonly configDigest: string;
  readonly startedAtMs: number;
  readonly finishedAtMs: number;
  readonly latencyMs: number;
  readonly status: 'SUCCEEDED' | 'FAILED';
  readonly errorCode?: AiErrorCode;
  readonly errorReason?: AiErrorReason;
  readonly attemptCount: number;
  readonly fallbackCount: number;
  readonly retryCount: number;
  readonly repairCount: number;
  /** The **final** attempt's usage — the frozen `AiResult.usage` semantics (Phase 58). */
  readonly finalUsage: AiUsage;
  /** Every attempt, including the ones that failed (Phase 26). */
  readonly totalUsage: AiUsage;
  readonly totalUsageComplete: boolean;
  readonly totalCost: CostEstimate;
  readonly idempotencyOutcome: 'EXECUTED' | 'REPLAYED' | 'JOINED';
  /** Prompt provenance (Stage 6, additive): opaque caller-side labels. Never prompt content. */
  readonly promptApplied?: boolean;
  readonly promptVersion?: string;
};

/** Durable-enough, append-only usage storage. The host owns persistence; AI Bridge owns the shape. */
export interface UsageLedgerPort {
  appendAttempt(record: ProviderAttemptUsageRecord): Promise<void>;
  appendRequest(record: LogicalRequestUsageRecord): Promise<void>;
  attempts(logicalRequestId?: string): Promise<readonly ProviderAttemptUsageRecord[]>;
  requests(logicalRequestId?: string): Promise<readonly LogicalRequestUsageRecord[]>;
}

/** The in-memory reference ledger. Append-only: records are never rewritten. */
export class InMemoryUsageLedger implements UsageLedgerPort {
  readonly #attempts: ProviderAttemptUsageRecord[] = [];
  readonly #requests: LogicalRequestUsageRecord[] = [];
  /** Per-list capacity. Oldest records are evicted first — the store is bounded by design. */
  readonly #capacity: number;

  constructor(options: { readonly capacity?: number } = {}) {
    const capacity = options.capacity ?? 10_000;
    this.#capacity = Number.isInteger(capacity) && capacity > 0 ? capacity : 10_000;
  }

  get size(): number {
    return this.#attempts.length + this.#requests.length;
  }

  /** Current per-list capacity bound. */
  get capacity(): number {
    return this.#capacity;
  }

  appendAttempt(record: ProviderAttemptUsageRecord): Promise<void> {
    this.#attempts.push(record);
    while (this.#attempts.length > this.#capacity) {
      this.#attempts.shift();
    }
    return Promise.resolve();
  }

  appendRequest(record: LogicalRequestUsageRecord): Promise<void> {
    this.#requests.push(record);
    while (this.#requests.length > this.#capacity) {
      this.#requests.shift();
    }
    return Promise.resolve();
  }

  attempts(logicalRequestId?: string): Promise<readonly ProviderAttemptUsageRecord[]> {
    return Promise.resolve(
      logicalRequestId === undefined ? [...this.#attempts] : this.#attempts.filter((r) => r.logicalRequestId === logicalRequestId),
    );
  }

  requests(logicalRequestId?: string): Promise<readonly LogicalRequestUsageRecord[]> {
    return Promise.resolve(
      logicalRequestId === undefined ? [...this.#requests] : this.#requests.filter((r) => r.logicalRequestId === logicalRequestId),
    );
  }
}
