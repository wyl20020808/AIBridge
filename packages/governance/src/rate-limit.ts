/**
 * Rate limiting — *how fast* (ROADMAP Stage 5 Phase 21–22, ARCHITECTURE.md §15.1).
 *
 * Rate limit is not quota: this answers "how many calls per window", not "how much per month".
 * The two are checked at different points and fail with different errors, because a consumer must
 * be able to tell "slow down" (`RATE_LIMITED` + `retryAfterMs`) apart from an exhausted budget
 * (`QUOTA_EXCEEDED`).
 *
 * Algorithm: a **sliding window** over event timestamps. It is exact, deterministic under a fake
 * clock, and needs no distributed state — a Redis-backed limiter is deliberately not V1 (Phase 21).
 *
 * Check order (Phase 22): the limiter runs **before** any provider dispatch. A rejected call makes
 * **zero** provider calls and returns `RATE_LIMITED` with a safe `retryAfterMs`.
 */
import { makeAiError, type AiError } from '@aibridge/contracts';
import type { Clock } from '@aibridge/host-sdk';

export const RATE_LIMIT_DIMENSIONS = ['subject', 'callerPlugin', 'capability', 'provider', 'global'] as const;

export type RateLimitDimension = (typeof RATE_LIMIT_DIMENSIONS)[number];

export type RateLimitPolicy = {
  readonly dimension: RateLimitDimension;
  /** Calls allowed inside the window. */
  readonly limit: number;
  readonly windowMs: number;
  /**
   * Extra scope key: the provider id for `provider`, the capability id for `capability`. Subject,
   * caller and global scopes derive their key from the request.
   */
  readonly scopeKey?: string;
};

export type RateLimitRequest = {
  readonly callerPluginId: string;
  readonly capability: string;
  /** The opaque subject reference (`hashSubjectToken` output). Never the token itself. */
  readonly subjectRef?: string;
  readonly providerId?: string;
};

export type RateLimitDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly error: AiError;
      readonly retryAfterMs: number;
      readonly dimension: RateLimitDimension;
    };

/** The bucket key one policy and one request produce. Stable and low-cardinality. */
export function rateBucketKey(policy: RateLimitPolicy, request: RateLimitRequest): string {
  switch (policy.dimension) {
    case 'subject':
      return `rl|subject|${request.subjectRef ?? 'none'}`;
    case 'callerPlugin':
      return `rl|caller|${request.callerPluginId}`;
    case 'capability':
      return `rl|capability|${policy.scopeKey ?? request.capability}`;
    case 'provider':
      return `rl|provider|${policy.scopeKey ?? request.providerId ?? 'none'}`;
    case 'global':
      return 'rl|global';
    default: {
      const exhaustive: never = policy.dimension;
      void exhaustive;
      return 'rl|global';
    }
  }
}

/**
 * The limiter's state seam. `tryConsume` must be **atomic**: a window that lets `limit + 1` calls
 * through under concurrency is a bug the property tests catch (Phase 61).
 */
export interface RateLimitStorePort {
  tryConsume(
    bucket: string,
    atMs: number,
    limit: number,
    windowMs: number,
  ): Promise<{ readonly allowed: boolean; readonly retryAfterMs: number }>;
  /**
   * Dry-run a consumption without recording it. Optional: stores that implement it let
   * `RateLimiter.consume` check every policy **before** consuming any, so a refused call
   * consumes nothing. Stores without it keep the legacy order (policies before the refusal
   * keep their hit). Per-bucket atomicity still comes from `tryConsume` in both paths.
   */
  check?(
    bucket: string,
    atMs: number,
    limit: number,
    windowMs: number,
  ): Promise<{ readonly allowed: boolean; readonly retryAfterMs: number }>;
}

/** The in-memory sliding-window reference implementation. */
export class InMemoryRateLimitStore implements RateLimitStorePort {
  readonly #hits = new Map<string, number[]>();

  /** Observed hits in a bucket. Tests read this; production never does. */
  hits(bucket: string): readonly number[] {
    return [...(this.#hits.get(bucket) ?? [])];
  }

  tryConsume(
    bucket: string,
    atMs: number,
    limit: number,
    windowMs: number,
  ): Promise<{ readonly allowed: boolean; readonly retryAfterMs: number }> {
    return Promise.resolve(this.#probe(bucket, atMs, limit, windowMs, true));
  }

  check(
    bucket: string,
    atMs: number,
    limit: number,
    windowMs: number,
  ): Promise<{ readonly allowed: boolean; readonly retryAfterMs: number }> {
    return Promise.resolve(this.#probe(bucket, atMs, limit, windowMs, false));
  }

  #probe(
    bucket: string,
    atMs: number,
    limit: number,
    windowMs: number,
    record: boolean,
  ): { readonly allowed: boolean; readonly retryAfterMs: number } {
    const cutoff = atMs - windowMs;
    const hits = (this.#hits.get(bucket) ?? []).filter((hit) => hit > cutoff);
    if (hits.length >= limit) {
      this.#hits.set(bucket, hits);
      const oldest = hits[0] ?? atMs;
      return { allowed: false, retryAfterMs: Math.max(0, oldest + windowMs - atMs) };
    }
    if (record) {
      hits.push(atMs);
      this.#hits.set(bucket, hits);
    }
    return { allowed: true, retryAfterMs: 0 };
  }
}

/** The reason a dimension maps to. Every one of them is `GOVERNANCE` stage: never fall back on it. */
export function rateLimitReason(dimension: RateLimitDimension): 'RATE_LIMIT_SUBJECT' | 'RATE_LIMIT_CALLER' | 'RATE_LIMIT_CAPABILITY' | 'RATE_LIMIT_PROVIDER' {
  switch (dimension) {
    case 'subject':
      return 'RATE_LIMIT_SUBJECT';
    case 'callerPlugin':
      return 'RATE_LIMIT_CALLER';
    case 'capability':
      return 'RATE_LIMIT_CAPABILITY';
    default:
      return 'RATE_LIMIT_PROVIDER';
  }
}

export type RateLimiterOptions = {
  readonly store: RateLimitStorePort;
  readonly clock: Clock;
  readonly policies?: readonly RateLimitPolicy[];
};

/**
 * The rate limiter. Policies are checked in configuration order and the **first** refusal wins,
 * so the strictest limit is always visible to the caller.
 */
export class RateLimiter {
  readonly #store: RateLimitStorePort;
  readonly #clock: Clock;
  readonly #policies: readonly RateLimitPolicy[];

  constructor(options: RateLimiterOptions) {
    this.#store = options.store;
    this.#clock = options.clock;
    this.#policies = [...(options.policies ?? [])];
  }

  get policies(): readonly RateLimitPolicy[] {
    return this.#policies;
  }

  /**
   * Consume one call against every policy. When the store supports `check`, every policy is
   * probed **before** any is consumed, so a refused call consumes nothing anywhere; otherwise
   * (legacy stores) policies checked before the refusal keep their hit and only the refusal
   * itself consumes nothing further. Either way the window is never extended by a call that
   * was refused by the policy owning that window (Phase 22).
   *
   * `policies` overrides the construction-time set — a request always checks the policies of **its
   * own config snapshot** (Phase 42), never a mixture of two.
   */
  async consume(request: RateLimitRequest, policies: readonly RateLimitPolicy[] = this.#policies): Promise<RateLimitDecision> {
    const atMs = this.#clock.nowMs();
    const check = this.#store.check;
    if (check !== undefined) {
      for (const policy of policies) {
        const probe = await check.call(this.#store, rateBucketKey(policy, request), atMs, policy.limit, policy.windowMs);
        if (!probe.allowed) {
          return this.#refusal(policy, probe.retryAfterMs);
        }
      }
    }
    for (const policy of policies) {
      const bucket = rateBucketKey(policy, request);
      const outcome =
        check !== undefined
          ? await this.#store.tryConsume(bucket, atMs, policy.limit, policy.windowMs)
          : await this.#store.tryConsume(bucket, this.#clock.nowMs(), policy.limit, policy.windowMs);
      if (!outcome.allowed) {
        return this.#refusal(policy, outcome.retryAfterMs);
      }
    }
    return { allowed: true };
  }

  #refusal(policy: RateLimitPolicy, retryAfterMs: number): RateLimitDecision {
    return {
      allowed: false,
      dimension: policy.dimension,
      retryAfterMs,
      error: makeAiError({
        reason: rateLimitReason(policy.dimension),
        message: 'The caller is sending requests too quickly. Retry after the reported delay.',
        retryAfterMs,
        // `dimension` is the metering unit (rate limiting meters calls); the **scope** is the
        // reason (`RATE_LIMIT_SUBJECT`, …). Same convention as the quota errors.
        details: { dimension: 'REQUESTS', limit: policy.limit, windowMs: policy.windowMs },
      }),
    };
  }
}
