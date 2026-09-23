/**
 * Quota — *how much* (ROADMAP Stage 5 Phase 23–26, ARCHITECTURE.md §15.2).
 *
 * Quota is not rate limit: it answers "how much per day/month", across five scopes
 * (subject, caller plugin, capability, provider, global) and three meters (requests, tokens,
 * estimated cost). Every scope has its own stable reason (`QUOTA_SUBJECT`, `QUOTA_CALLER`,
 * `QUOTA_CAPABILITY`, `QUOTA_PROVIDER`, `QUOTA_GLOBAL`) so a consumer can tell which limit ran out.
 *
 * **Reservation** (Phase 25): before dispatch the manager reserves the estimated maximum against
 * every matching policy, so two concurrent requests can never both believe "1000 tokens are
 * left". After the call the reservation is **settled** at the actual figure — for **every**
 * provider attempt, not just the one that finally succeeded (Phase 26).
 *
 * **Unknown usage** (Phase 24): `unknown = 0` is a lie that breaks budgets. When an attempt's
 * usage is unknown, the reservation settles at its conservative (reserved) amount and the ledger
 * records `usageKnown: false`. Never under-counts; never fabricates a token count.
 */
import { makeAiError, type AiError, type AiErrorReason } from '@aibridge/contracts';
import type { Clock } from '@aibridge/host-sdk';

export const QUOTA_SCOPES = ['subject', 'callerPlugin', 'capability', 'provider', 'global'] as const;

export type QuotaScope = (typeof QUOTA_SCOPES)[number];

export const QUOTA_METERS = ['REQUESTS', 'TOKENS', 'ESTIMATED_COST'] as const;

export type QuotaMeter = (typeof QUOTA_METERS)[number];

export const QUOTA_PERIODS = ['DAY', 'MONTH'] as const;

export type QuotaPeriod = (typeof QUOTA_PERIODS)[number];

export const DEFAULT_TOKEN_RESERVATION = 4_096;

export type QuotaPolicy = {
  readonly scope: QuotaScope;
  readonly meter: QuotaMeter;
  readonly period: QuotaPeriod;
  readonly limit: number;
  /** Provider id / capability id for the scoped meters; derived from the request otherwise. */
  readonly scopeKey?: string;
  /** What a call reserves up front on the `TOKENS` meter. Default 4 096 (Phase 25). */
  readonly reservationTokens?: number;
  /** What a call reserves up front on the `ESTIMATED_COST` meter. Default 0. */
  readonly reservationCost?: number;
};

export type QuotaRequest = {
  readonly callerPluginId: string;
  readonly capability: string;
  /** Opaque subject reference (a hash). Never the token itself (SECURITY.md §16.1). */
  readonly subjectRef?: string;
  readonly providerId?: string;
};

export type QuotaReservationEntry = {
  readonly policy: QuotaPolicy;
  readonly bucket: string;
  readonly amount: number;
  /** The store's reservation id — settlement must hit the same line the reservation opened. */
  readonly storeId: string;
};

export type QuotaReservation = {
  readonly id: string;
  readonly entries: readonly QuotaReservationEntry[];
};

export type QuotaDecision =
  | { readonly ok: true; readonly reservation: QuotaReservation }
  | { readonly ok: false; readonly error: AiError; readonly policy: QuotaPolicy };

/** The stable reason per scope. The scope **is** the reason — never collapse them. */
export function quotaReason(scope: QuotaScope): AiErrorReason {
  switch (scope) {
    case 'subject':
      return 'QUOTA_SUBJECT';
    case 'callerPlugin':
      return 'QUOTA_CALLER';
    case 'capability':
      return 'QUOTA_CAPABILITY';
    case 'provider':
      return 'QUOTA_PROVIDER';
    default:
      return 'QUOTA_GLOBAL';
  }
}

/** The calendar bucket one policy is accounted against. Deterministic from the clock. */
export function quotaBucket(policy: QuotaPolicy, request: QuotaRequest, nowMs: number): string {
  const iso = new Date(nowMs).toISOString();
  const periodStart = policy.period === 'DAY' ? iso.slice(0, 10) : iso.slice(0, 7);
  let key: string;
  switch (policy.scope) {
    case 'subject':
      key = request.subjectRef ?? 'none';
      break;
    case 'callerPlugin':
      key = request.callerPluginId;
      break;
    case 'capability':
      key = policy.scopeKey ?? request.capability;
      break;
    case 'provider':
      key = policy.scopeKey ?? request.providerId ?? 'none';
      break;
    default:
      key = 'global';
      break;
  }
  return `qt|${policy.scope}|${key}|${policy.meter}|${policy.period}|${periodStart}`;
}

/** What one call wants to reserve against one policy. */
export function reservationAmount(policy: QuotaPolicy, estimate: { readonly tokens?: number; readonly cost?: number }): number {
  switch (policy.meter) {
    case 'REQUESTS':
      return 1;
    case 'TOKENS':
      return Math.max(1, Math.round(estimate.tokens ?? policy.reservationTokens ?? DEFAULT_TOKEN_RESERVATION));
    default:
      return Math.max(0, estimate.cost ?? policy.reservationCost ?? 0);
  }
}

/**
 * The quota state seam. `reserve` must be **atomic**: the whole point of a reservation is that two
 * concurrent calls cannot both fit through the same remaining limit (Phase 25, Phase 61).
 */
export interface QuotaStorePort {
  /** Reserve `amount` against `bucket`'s `limit`, or `null` when it would overflow. */
  reserve(bucket: string, amount: number, limit: number): Promise<string | null>;
  /** Settle a reservation at `actual` (may exceed the reservation — overspend is recorded, not hidden). */
  settle(bucket: string, reservationId: string, actual: number): Promise<void>;
  /** Release a reservation without consuming anything. */
  release(bucket: string, reservationId: string): Promise<void>;
  /** Settled plus outstanding, for diagnostics. */
  consumed(bucket: string): Promise<number>;
}

type BucketState = { settled: number; outstanding: Map<string, number> };

/** The in-memory reference implementation with real reservation bookkeeping. */
export class InMemoryQuotaStore implements QuotaStorePort {
  readonly #buckets = new Map<string, BucketState>();
  #nextId = 0;

  reserve(bucket: string, amount: number, limit: number): Promise<string | null> {
    const state = this.#state(bucket);
    const outstanding = [...state.outstanding.values()].reduce((sum, value) => sum + value, 0);
    if (state.settled + outstanding + amount > limit) {
      return Promise.resolve(null);
    }
    this.#nextId += 1;
    const id = `qr-${this.#nextId}`;
    state.outstanding.set(id, amount);
    return Promise.resolve(id);
  }

  settle(bucket: string, reservationId: string, actual: number): Promise<void> {
    const state = this.#state(bucket);
    state.outstanding.delete(reservationId);
    state.settled += Math.max(0, actual);
    return Promise.resolve();
  }

  release(bucket: string, reservationId: string): Promise<void> {
    this.#state(bucket).outstanding.delete(reservationId);
    return Promise.resolve();
  }

  consumed(bucket: string): Promise<number> {
    const state = this.#state(bucket);
    const outstanding = [...state.outstanding.values()].reduce((sum, value) => sum + value, 0);
    return Promise.resolve(state.settled + outstanding);
  }

  #state(bucket: string): BucketState {
    let state = this.#buckets.get(bucket);
    if (state === undefined) {
      state = { settled: 0, outstanding: new Map() };
      this.#buckets.set(bucket, state);
    }
    return state;
  }
}

/** How an attempt's settlement behaves when its usage never arrived (Phase 24). */
export const UNKNOWN_USAGE_POLICIES = ['CONSERVATIVE', 'RELEASE'] as const;

export type UnknownUsagePolicy = (typeof UNKNOWN_USAGE_POLICIES)[number];

export type QuotaManagerOptions = {
  readonly store: QuotaStorePort;
  readonly clock: Clock;
  readonly policies?: readonly QuotaPolicy[];
  /** Default `CONSERVATIVE`: unknown usage settles at the reservation, never at zero. */
  readonly unknownUsage?: UnknownUsagePolicy;
};

export type QuotaSettlement = {
  /** `false` when any settled attempt reported no usage at all. */
  readonly usageKnown: boolean;
  readonly tokens?: number;
  readonly cost?: number;
};

export class QuotaManager {
  readonly #store: QuotaStorePort;
  readonly #clock: Clock;
  readonly #policies: readonly QuotaPolicy[];
  readonly #unknownUsage: UnknownUsagePolicy;

  constructor(options: QuotaManagerOptions) {
    this.#store = options.store;
    this.#clock = options.clock;
    this.#policies = [...(options.policies ?? [])];
    this.#unknownUsage = options.unknownUsage ?? 'CONSERVATIVE';
  }

  get policies(): readonly QuotaPolicy[] {
    return this.#policies;
  }

  /**
   * Reserve against every matching policy. Refusal is `QUOTA_*` with the closed detail keys
   * `dimension/period/limit`, and **zero** provider calls have been made (Phase 51).
   *
   * `policies` overrides the construction-time set: a request reserves against the policies of its
   * own config snapshot (Phase 42).
   */
  async reserve(
    request: QuotaRequest,
    estimate: { readonly tokens?: number; readonly cost?: number } = {},
    policies: readonly QuotaPolicy[] = this.#policies,
  ): Promise<QuotaDecision> {
    const nowMs = this.#clock.nowMs();
    const entries: QuotaReservationEntry[] = [];
    const taken: { bucket: string; id: string }[] = [];
    for (const policy of policies) {
      const bucket = quotaBucket(policy, request, nowMs);
      const amount = reservationAmount(policy, estimate);
      const id = await this.#store.reserve(bucket, amount, policy.limit);
      if (id === null) {
        for (const entry of taken) {
          await this.#store.release(entry.bucket, entry.id);
        }
        return {
          ok: false,
          policy,
          error: makeAiError({
            reason: quotaReason(policy.scope),
            message: 'The quota for this scope is exhausted for the current period.',
            details: { dimension: policy.meter, period: policy.period, limit: policy.limit },
          }),
        };
      }
      taken.push({ bucket, id });
      entries.push({ policy, bucket, amount, storeId: id });
    }
    return { ok: true, reservation: { id: `res-${nowMs}-${taken.length}`, entries } };
  }

  /**
   * Settle a reservation after the call — with the **total** of every attempt that ran (Phase 26).
   *
   * Unknown usage is settled at the conservative reserved amount (`CONSERVATIVE`, the default) or
   * released (`RELEASE`, opt-in). It is never settled at zero.
   */
  async settle(reservation: QuotaReservation, settlement: QuotaSettlement): Promise<void> {
    for (const entry of reservation.entries) {
      const actual = this.#settlementAmount(entry, settlement);
      await this.#store.settle(entry.bucket, entry.storeId, actual);
    }
  }

  /** Release every reservation without consuming anything (cancelled or rejected before dispatch). */
  async release(reservation: QuotaReservation): Promise<void> {
    for (const entry of reservation.entries) {
      await this.#store.release(entry.bucket, entry.storeId);
    }
  }

  /** Current consumption for one policy's bucket (diagnostics, budget pre-checks). */
  async consumed(policy: QuotaPolicy, request: QuotaRequest): Promise<number> {
    return this.#store.consumed(quotaBucket(policy, request, this.#clock.nowMs()));
  }

  #settlementAmount(entry: QuotaReservationEntry, settlement: QuotaSettlement): number {
    const known = entry.policy.meter === 'REQUESTS' ? true : entry.policy.meter === 'TOKENS' ? settlement.tokens !== undefined : settlement.cost !== undefined;
    if (known) {
      switch (entry.policy.meter) {
        case 'REQUESTS':
          return 1;
        case 'TOKENS':
          return Math.max(0, settlement.tokens ?? 0);
        default:
          return Math.max(0, settlement.cost ?? 0);
      }
    }
    // Unknown usage: the conservative reserved amount (default), never zero (Phase 24).
    return this.#unknownUsage === 'CONSERVATIVE' ? entry.amount : 0;
  }
}
