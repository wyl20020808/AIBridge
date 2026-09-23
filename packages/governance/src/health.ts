/**
 * Runtime health (ROADMAP Stage 5 Phase 15–16, §48).
 *
 * **Health is not capability.** A model can support `reasoning` and be `OPEN_CIRCUIT` at the same
 * time, and those are different facts: the descriptor answers "can it?", this registry answers
 * "is it serving right now?". Never conflate them (Phase 16).
 *
 * State is composed from three inputs — observed calls, the breaker, and the operator switch:
 *
 * | State | Meaning |
 * | --- | --- |
 * | `DISABLED` | an operator or kill switch turned it off |
 * | `OPEN_CIRCUIT` | the breaker is open |
 * | `DEGRADED` | repeated transient failures, or a half-open probe |
 * | `HEALTHY` | observed and working |
 * | `UNKNOWN` | never observed |
 *
 * One 429 never becomes a permanent `UNHEALTHY` (Phase 15): a single transient failure leaves the
 * target `HEALTHY`, and every state but `DISABLED` recovers on the next success.
 */
import type { AiError } from '@aibridge/contracts';
import type { Clock } from '@aibridge/host-sdk';
import type { CircuitBreakerRegistry } from './breaker.js';
import { classifyFailure, type FailureClass } from './failure-class.js';

export const HEALTH_STATES = ['HEALTHY', 'DEGRADED', 'OPEN_CIRCUIT', 'DISABLED', 'UNKNOWN'] as const;

export type HealthState = (typeof HEALTH_STATES)[number];

/** Safe diagnostics for one provider/model target (Phase 48). Generic counts only. */
export type ProviderHealthReport = {
  readonly providerId: string;
  readonly modelAlias: string;
  readonly state: HealthState;
  readonly breakerState: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
  /** Generic failure classes seen in the window. Never a raw provider error (Phase 48). */
  readonly recentFailureClasses: Readonly<Partial<Record<FailureClass, number>>>;
  readonly lastSuccessAtMs?: number;
  readonly lastFailureAtMs?: number;
};

type HealthEntry = {
  providerId: string;
  modelAlias: string;
  disabled: boolean;
  failures: { readonly atMs: number; readonly failureClass: FailureClass }[];
  lastSuccessAtMs?: number;
  lastFailureAtMs?: number;
};

export type RuntimeHealthOptions = {
  readonly clock: Clock;
  readonly breakers?: CircuitBreakerRegistry;
  /** How long a failure stays visible to the state rule. Default 60 000 ms. */
  readonly windowMs?: number;
  /** Transient failures in the window that make a target `DEGRADED`. Default 2 (Phase 15). */
  readonly degradedFailureCount?: number;
};

export class RuntimeHealthRegistry {
  readonly #clock: Clock;
  readonly #breakers: CircuitBreakerRegistry | undefined;
  readonly #windowMs: number;
  readonly #degradedFailureCount: number;
  readonly #entries = new Map<string, HealthEntry>();

  constructor(options: RuntimeHealthOptions) {
    this.#clock = options.clock;
    this.#breakers = options.breakers;
    this.#windowMs = Math.max(1, options.windowMs ?? 60_000);
    this.#degradedFailureCount = Math.max(1, options.degradedFailureCount ?? 2);
  }

  static key(providerId: string, modelAlias: string): string {
    return `${providerId}::${modelAlias}`;
  }

  /** Operator/kill-switch override. `DISABLED` outranks every observed state (Phase 49). */
  setDisabled(providerId: string, modelAlias: string, disabled: boolean): void {
    this.#entry(providerId, modelAlias).disabled = disabled;
  }

  recordSuccess(providerId: string, modelAlias: string): void {
    const entry = this.#entry(providerId, modelAlias);
    entry.lastSuccessAtMs = this.#clock.nowMs();
    // A success ends the degraded episode: health must recover (Phase 15), never latch.
    entry.failures = [];
  }

  recordFailure(providerId: string, modelAlias: string, error: AiError): void {
    const entry = this.#entry(providerId, modelAlias);
    const atMs = this.#clock.nowMs();
    entry.lastFailureAtMs = atMs;
    entry.failures.push({ atMs, failureClass: classifyFailure(error) });
    this.#prune(entry, atMs);
  }

  /** The safe health report for one target (Phase 48). */
  health(providerId: string, modelAlias: string): ProviderHealthReport {
    const entry = this.#entry(providerId, modelAlias);
    const nowMs = this.#clock.nowMs();
    this.#prune(entry, nowMs);
    const breaker = this.#breakers?.for(providerId, modelAlias);
    const breakerState = breaker?.state ?? 'CLOSED';

    let state: HealthState;
    if (entry.disabled) {
      state = 'DISABLED';
    } else if (breakerState === 'OPEN') {
      state = 'OPEN_CIRCUIT';
    } else if (breakerState === 'HALF_OPEN') {
      state = 'DEGRADED';
    } else if (entry.failures.length === 0 && entry.lastSuccessAtMs === undefined && entry.lastFailureAtMs === undefined) {
      state = 'UNKNOWN';
    } else if (entry.failures.length >= this.#degradedFailureCount) {
      state = 'DEGRADED';
    } else {
      // One transient failure is not a verdict (Phase 15).
      state = 'HEALTHY';
    }

    const recentFailureClasses: Partial<Record<FailureClass, number>> = {};
    for (const failure of entry.failures) {
      recentFailureClasses[failure.failureClass] = (recentFailureClasses[failure.failureClass] ?? 0) + 1;
    }
    return {
      providerId,
      modelAlias,
      state,
      breakerState,
      recentFailureClasses,
      ...(entry.lastSuccessAtMs === undefined ? {} : { lastSuccessAtMs: entry.lastSuccessAtMs }),
      ...(entry.lastFailureAtMs === undefined ? {} : { lastFailureAtMs: entry.lastFailureAtMs }),
    };
  }

  /** Every observed target, ordered by key. */
  list(): readonly ProviderHealthReport[] {
    return [...this.#entries.keys()]
      .sort()
      .map((key) => {
        const entry = this.#entries.get(key);
        return entry === undefined ? null : this.health(entry.providerId, entry.modelAlias);
      })
      .filter((report): report is ProviderHealthReport => report !== null);
  }

  #entry(providerId: string, modelAlias: string): HealthEntry {
    const key = RuntimeHealthRegistry.key(providerId, modelAlias);
    let entry = this.#entries.get(key);
    if (entry === undefined) {
      entry = { providerId, modelAlias, disabled: false, failures: [] };
      this.#entries.set(key, entry);
    }
    return entry;
  }

  #prune(entry: HealthEntry, nowMs: number): void {
    const cutoff = nowMs - this.#windowMs;
    entry.failures = entry.failures.filter((failure) => failure.atMs > cutoff);
  }
}
