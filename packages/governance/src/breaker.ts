/**
 * The circuit breaker (ROADMAP Stage 5 Phase 11–14, ARCHITECTURE.md §10.5).
 *
 * Keyed by **provider + model alias**, not by provider: one model's outage must not disable a
 * provider's other models (Phase 11). V1 is deliberately simple — a counter in a window, a
 * cooldown and a bounded half-open probe. No adaptive statistics.
 *
 * Only provider/system transient failure counts against a breaker (`breakerImpact` in
 * `failure-class.ts`): an invalid request or a blocked piece of content says nothing about
 * provider health and must never open a circuit (Phase 12).
 */
import type { AiError } from '@aibridge/contracts';
import type { Clock } from '@aibridge/host-sdk';
import { breakerImpact } from './failure-class.js';

export const BREAKER_STATES = ['CLOSED', 'OPEN', 'HALF_OPEN'] as const;

export type BreakerState = (typeof BREAKER_STATES)[number];

export type BreakerConfig = {
  /** Transient failures within the window that open the circuit. Default 5. */
  readonly failureThreshold?: number;
  /** The rolling failure window. Default 60 000 ms. */
  readonly windowMs?: number;
  /** How long an open circuit stays open before probing. Default 30 000 ms. */
  readonly cooldownMs?: number;
  /** Concurrent probes allowed in `HALF_OPEN`. Default 1 (Phase 14). */
  readonly halfOpenProbeLimit?: number;
};

export const DEFAULT_BREAKER_CONFIG: Required<BreakerConfig> = {
  failureThreshold: 5,
  windowMs: 60_000,
  cooldownMs: 30_000,
  halfOpenProbeLimit: 1,
};

export function resolveBreakerConfig(config: BreakerConfig = {}): Required<BreakerConfig> {
  return {
    failureThreshold: Math.max(1, config.failureThreshold ?? DEFAULT_BREAKER_CONFIG.failureThreshold),
    windowMs: Math.max(1, config.windowMs ?? DEFAULT_BREAKER_CONFIG.windowMs),
    cooldownMs: Math.max(0, config.cooldownMs ?? DEFAULT_BREAKER_CONFIG.cooldownMs),
    halfOpenProbeLimit: Math.max(1, config.halfOpenProbeLimit ?? DEFAULT_BREAKER_CONFIG.halfOpenProbeLimit),
  };
}

export type BreakerSnapshot = {
  readonly key: string;
  readonly state: BreakerState;
  readonly failureCount: number;
  readonly openedAtMs?: number;
  readonly retryAfterMs?: number;
};

export type DispatchVerdict =
  | { readonly allowed: true; readonly state: BreakerState; readonly probe: boolean }
  | { readonly allowed: false; readonly state: BreakerState; readonly retryAfterMs: number };

/** One breaker: `providerId + modelAlias`. */
export class CircuitBreaker {
  readonly key: string;
  readonly #config: Required<BreakerConfig>;
  readonly #clock: Clock;
  #state: BreakerState = 'CLOSED';
  #failures: number[] = [];
  #openedAtMs: number | null = null;
  #probesInFlight = 0;
  #openedCount = 0;

  constructor(key: string, config: BreakerConfig = {}, clock: Clock) {
    this.key = key;
    this.#config = resolveBreakerConfig(config);
    this.#clock = clock;
  }

  get state(): BreakerState {
    this.#refresh();
    return this.#state;
  }

  /** How many times this breaker has opened. A metric, never a label (Phase 44). */
  get openedCount(): number {
    return this.#openedCount;
  }

  /** Ask permission to dispatch. A denied dispatch never reaches a provider (Phase 52). */
  dispatchVerdict(): DispatchVerdict {
    this.#refresh();
    const nowMs = this.#clock.nowMs();
    if (this.#state === 'OPEN') {
      const openedAtMs = this.#openedAtMs ?? nowMs;
      return {
        allowed: false,
        state: 'OPEN',
        retryAfterMs: Math.max(0, openedAtMs + this.#config.cooldownMs - nowMs),
      };
    }
    if (this.#state === 'HALF_OPEN' && this.#probesInFlight >= this.#config.halfOpenProbeLimit) {
      return { allowed: false, state: 'HALF_OPEN', retryAfterMs: this.#config.cooldownMs };
    }
    if (this.#state === 'HALF_OPEN') {
      this.#probesInFlight += 1;
      return { allowed: true, state: 'HALF_OPEN', probe: true };
    }
    return { allowed: true, state: 'CLOSED', probe: false };
  }

  /** Record a successful call. Closes a half-open circuit and clears the window. */
  recordSuccess(): void {
    if (this.#state === 'HALF_OPEN') {
      this.#probesInFlight = Math.max(0, this.#probesInFlight - 1);
    }
    this.#failures = [];
    this.#state = 'CLOSED';
    this.#openedAtMs = null;
  }

  /** Record a failure. Only transient provider failure moves the breaker (Phase 12). */
  recordFailure(error: AiError): void {
    if (this.#state === 'HALF_OPEN') {
      this.#probesInFlight = Math.max(0, this.#probesInFlight - 1);
    }
    if (!breakerImpact(error)) {
      return;
    }
    const nowMs = this.#clock.nowMs();
    if (this.#state === 'HALF_OPEN') {
      this.#open(nowMs);
      return;
    }
    this.#failures.push(nowMs);
    this.#prune(nowMs);
    if (this.#failures.length >= this.#config.failureThreshold) {
      this.#open(nowMs);
    }
  }

  snapshot(): BreakerSnapshot {
    this.#refresh();
    const nowMs = this.#clock.nowMs();
    const openedAtMs = this.#openedAtMs;
    return {
      key: this.key,
      state: this.#state,
      failureCount: this.#failures.length,
      ...(openedAtMs === null ? {} : { openedAtMs }),
      ...(this.#state === 'OPEN'
        ? { retryAfterMs: Math.max(0, (openedAtMs ?? nowMs) + this.#config.cooldownMs - nowMs) }
        : {}),
    };
  }

  #open(nowMs: number): void {
    this.#state = 'OPEN';
    this.#openedAtMs = nowMs;
    this.#openedCount += 1;
  }

  #prune(nowMs: number): void {
    const cutoff = nowMs - this.#config.windowMs;
    this.#failures = this.#failures.filter((atMs) => atMs > cutoff);
  }

  /** Time moves the state machine, not calls (Phase 14): cooldown over ⇒ half-open probing. */
  #refresh(): void {
    const nowMs = this.#clock.nowMs();
    this.#prune(nowMs);
    if (this.#state === 'OPEN' && this.#openedAtMs !== null && nowMs - this.#openedAtMs >= this.#config.cooldownMs) {
      this.#state = 'HALF_OPEN';
      this.#probesInFlight = 0;
    }
  }
}

export type BreakerRegistryOptions = {
  readonly config?: BreakerConfig;
  readonly clock: Clock;
};

/** The per-(provider, model alias) breaker table. */
export class CircuitBreakerRegistry {
  readonly #config: BreakerConfig;
  readonly #clock: Clock;
  readonly #breakers = new Map<string, CircuitBreaker>();

  constructor(options: BreakerRegistryOptions) {
    this.#config = options.config ?? {};
    this.#clock = options.clock;
  }

  /** The stable key: one model's failure never disables a provider's other models (Phase 11). */
  static key(providerId: string, modelAlias: string): string {
    return `${providerId}::${modelAlias}`;
  }

  for(providerId: string, modelAlias: string): CircuitBreaker {
    const key = CircuitBreakerRegistry.key(providerId, modelAlias);
    let breaker = this.#breakers.get(key);
    if (breaker === undefined) {
      breaker = new CircuitBreaker(key, this.#config, this.#clock);
      this.#breakers.set(key, breaker);
    }
    return breaker;
  }

  snapshots(): readonly BreakerSnapshot[] {
    return [...this.#breakers.values()].map((breaker) => breaker.snapshot()).sort((a, b) => a.key.localeCompare(b.key));
  }
}
