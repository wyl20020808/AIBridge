/**
 * The idempotency registry (ROADMAP Stage 5 Phase 17–20, ARCHITECTURE.md §14).
 *
 * The frozen semantics, unchanged:
 *
 *  - scoped to `(callerPluginId, capability, capabilityVersion, idempotencyKey)` — one logical
 *    learning turn is one billable call;
 *  - a replay returns the terminal result with `IDEMPOTENT_REPLAY`, never a second dispatch;
 *  - concurrent duplicates **join** the in-flight call rather than starting a second one;
 *  - the same key with a different request fingerprint is `IDEMPOTENCY_CONFLICT`, never a stale
 *    answer (Phase 20).
 *
 * What is stored is the request **fingerprint**, the consumer-visible terminal **result**, and the
 * caller's opaque prompt-provenance labels. Never prompt content, raw provider data or credentials
 * (Phase 19). Retention is 15 minutes with an LRU ceiling of 10 000 entries (ARCHITECTURE.md §14.3);
 * a durable, encrypted store is a later host option, not V1.
 */
import type { AiResult } from '@aibridge/contracts';
import type { Clock } from '@aibridge/host-sdk';

export const IDEMPOTENCY_STATUSES = ['IN_FLIGHT', 'SUCCEEDED', 'FAILED_FINAL'] as const;

export type IdempotencyStatus = (typeof IDEMPOTENCY_STATUSES)[number];

export const IDEMPOTENCY_RETENTION_MS = 15 * 60_000;
export const IDEMPOTENCY_CAPACITY = 10_000;

/** The identity scope. The consumer's `idempotencyKey` is only unique inside it. */
export type IdempotencyIdentity = {
  readonly callerPluginId: string;
  readonly capability: string;
  readonly capabilityVersion: string;
  readonly idempotencyKey: string;
};

export type PromptProvenance = {
  readonly promptApplied?: boolean;
  readonly promptVersion?: string;
};

/** An injective tuple encoding; components remain exact and are never sanitized or hashed. */
export function idempotencyIdentityKey(identity: IdempotencyIdentity): string {
  return [identity.callerPluginId, identity.capability, identity.capabilityVersion, identity.idempotencyKey]
    .map((part) => `${part.length}:${part}`)
    .join('');
}

/**
 * The stored fingerprint: a stable hash of the request digest, **never** the digest itself.
 *
 * A digest is derived from the request body — it embeds the prompt and learner text (Phase 19).
 * The registry therefore hashes whatever it is given before storing, so no caller can accidentally
 * turn the replay cache into a prompt archive.
 */
export function hashRequestFingerprint(digest: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let index = 0; index < digest.length; index += 1) {
    a ^= digest.charCodeAt(index) & 0xff;
    a = Math.imul(a, 0x01000193) >>> 0;
    b ^= digest.charCodeAt(index) >>> 8;
    b = Math.imul(b, 0x01000193) >>> 0;
  }
  return `fp-${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}`;
}

export type IdempotencyRecord = {
  readonly identity: string;
  /** The request fingerprint (`consumerRequestDigest`). Mismatch ⇒ `IDEMPOTENCY_CONFLICT`. */
  readonly fingerprint: string;
  readonly status: IdempotencyStatus;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  readonly logicalRequestId: string;
  /** Only bounded opaque labels needed to attribute a faithful replay; never prompt text. */
  readonly promptProvenance?: PromptProvenance;
  /** The consumer-visible terminal result. Present only in `SUCCEEDED` / `FAILED_FINAL`. */
  readonly result?: AiResult<unknown>;
};

export type IdempotencyClaim =
  | { readonly kind: 'PROCEED'; readonly record: IdempotencyRecord }
  | { readonly kind: 'JOIN'; readonly record: IdempotencyRecord }
  | { readonly kind: 'REPLAY'; readonly record: IdempotencyRecord }
  | { readonly kind: 'CONFLICT'; readonly record: IdempotencyRecord };

/**
 * Durable-enough idempotency storage. Implementations must make `claim` **atomic**: two callers
 * with one identity get exactly one `PROCEED`.
 */
export interface IdempotencyStorePort {
  claim(record: IdempotencyRecord): Promise<IdempotencyClaim>;
  complete(identity: string, status: 'SUCCEEDED' | 'FAILED_FINAL', result: AiResult<unknown>, nowMs: number): Promise<void>;
  get(identity: string): Promise<IdempotencyRecord | null>;
}

export type InMemoryIdempotencyStoreOptions = {
  readonly clock: Clock;
  readonly retentionMs?: number;
  readonly capacity?: number;
};

/**
 * The in-memory reference store: TTL 15 minutes, LRU ceiling 10 000 (ARCHITECTURE.md §14.3).
 *
 * `claim` runs without awaiting anything, so it is atomic on a single event loop — the property
 * concurrent-duplicate tests lean on (Phase 61).
 */
export class InMemoryIdempotencyStore implements IdempotencyStorePort {
  readonly #clock: Clock;
  readonly #retentionMs: number;
  readonly #capacity: number;
  /** Insertion-ordered; the tail is the least recently used entry. */
  readonly #records = new Map<string, IdempotencyRecord>();

  constructor(options: InMemoryIdempotencyStoreOptions) {
    this.#clock = options.clock;
    this.#retentionMs = Math.max(1, options.retentionMs ?? IDEMPOTENCY_RETENTION_MS);
    this.#capacity = Math.max(1, options.capacity ?? IDEMPOTENCY_CAPACITY);
  }

  get size(): number {
    return this.#records.size;
  }

  claim(record: IdempotencyRecord): Promise<IdempotencyClaim> {
    const nowMs = this.#clock.nowMs();
    this.#purge(nowMs);
    const existing = this.#records.get(record.identity);
    if (existing !== undefined) {
      if (existing.expiresAtMs <= nowMs) {
        this.#records.delete(record.identity);
      } else if (existing.fingerprint !== record.fingerprint) {
        // Same key, different request: never return the old answer (Phase 20).
        return Promise.resolve({ kind: 'CONFLICT', record: existing });
      } else {
        this.#touch(record.identity, existing);
        return Promise.resolve(
          existing.status === 'IN_FLIGHT' ? { kind: 'JOIN', record: existing } : { kind: 'REPLAY', record: existing },
        );
      }
    }
    // The store enforces its own retention ceiling at the boundary: a host store needs a retention
    // policy of its own, and "forever" is never the default (Phase 19).
    this.#records.set(record.identity, {
      ...record,
      expiresAtMs: Math.min(record.expiresAtMs, nowMs + this.#retentionMs),
    });
    this.#evict();
    return Promise.resolve({ kind: 'PROCEED', record: this.#records.get(record.identity) ?? record });
  }

  complete(identity: string, status: 'SUCCEEDED' | 'FAILED_FINAL', result: AiResult<unknown>, nowMs: number): Promise<void> {
    const existing = this.#records.get(identity);
    if (existing === undefined) {
      return Promise.resolve();
    }
    this.#touch(identity, {
      ...existing,
      status,
      result,
      // A completed entry keeps its original expiry — the retention window is measured from the
      // turn, not from whichever call happened to finish it.
      expiresAtMs: Math.max(existing.expiresAtMs, nowMs),
    });
    return Promise.resolve();
  }

  get(identity: string): Promise<IdempotencyRecord | null> {
    const nowMs = this.#clock.nowMs();
    this.#purge(nowMs);
    const record = this.#records.get(identity) ?? null;
    return Promise.resolve(record === null || record.expiresAtMs <= nowMs ? null : record);
  }

  #touch(identity: string, record: IdempotencyRecord): void {
    this.#records.delete(identity);
    this.#records.set(identity, record);
  }

  #purge(nowMs: number): void {
    for (const [identity, record] of this.#records) {
      if (record.expiresAtMs <= nowMs) {
        this.#records.delete(identity);
      }
    }
  }

  #evict(): void {
    while (this.#records.size > this.#capacity) {
      const oldest = this.#records.keys().next();
      if (oldest.done === true || oldest.value === undefined) {
        return;
      }
      this.#records.delete(oldest.value);
    }
  }
}

export type IdempotencyGate =
  | { readonly kind: 'PROCEED'; readonly settle: (result: AiResult<unknown>) => Promise<void> }
  | { readonly kind: 'REPLAY'; readonly result: AiResult<unknown>; readonly promptProvenance?: PromptProvenance }
  | { readonly kind: 'JOIN'; readonly result: Promise<AiResult<unknown>>; readonly promptProvenance?: PromptProvenance }
  | { readonly kind: 'CONFLICT' };

export type IdempotencyRegistryOptions = {
  readonly store: IdempotencyStorePort;
  readonly clock: Clock;
  /** Claim expiry window for new turns. Defaults to `IDEMPOTENCY_RETENTION_MS`. */
  readonly retentionMs?: number;
};

/**
 * The registry: store-backed facts plus **in-process coalescing**.
 *
 * Two callers with one identity must produce one provider execution chain (Phase 18/63). The
 * durable store proves it happened; the in-flight promise map lets the second caller actually
 * *join* the first one's result instead of polling.
 */
export class IdempotencyRegistry {
  readonly #store: IdempotencyStorePort;
  readonly #clock: Clock;
  #retentionMs: number;
  readonly #inFlight = new Map<string, { readonly result: Promise<AiResult<unknown>>; resolve(value: AiResult<unknown>): void }>();

  constructor(options: IdempotencyRegistryOptions) {
    this.#store = options.store;
    this.#clock = options.clock;
    this.#retentionMs = Math.max(1, options.retentionMs ?? IDEMPOTENCY_RETENTION_MS);
  }

  get store(): IdempotencyStorePort {
    return this.#store;
  }

  /**
   * Retune the claim expiry window for future turns. Stored records keep their own
   * `expiresAtMs`; the store's capacity is construction-time and never retuned here.
   */
  reconfigure(retentionMs?: number): void {
    this.#retentionMs = Math.max(1, retentionMs ?? IDEMPOTENCY_RETENTION_MS);
  }

  /** The gate every logical call passes, before governance and before any dispatch (Phase 51). */
  async gate(
    identity: IdempotencyIdentity,
    fingerprint: string,
    logicalRequestId: string,
    promptProvenance?: PromptProvenance,
  ): Promise<IdempotencyGate> {
    const key = idempotencyIdentityKey(identity);
    const hashedFingerprint = hashRequestFingerprint(fingerprint);
    const nowMs = this.#clock.nowMs();
    const claim = await this.#store.claim({
      identity: key,
      fingerprint: hashedFingerprint,
      status: 'IN_FLIGHT',
      createdAtMs: nowMs,
      expiresAtMs: nowMs + this.#retentionMs,
      logicalRequestId,
      ...(promptProvenance === undefined ? {} : { promptProvenance }),
    });

    switch (claim.kind) {
      case 'CONFLICT':
        return { kind: 'CONFLICT' };
      case 'REPLAY': {
        const result = claim.record.result;
        return result === undefined
          ? { kind: 'CONFLICT' }
          : {
              kind: 'REPLAY',
              result,
              ...(claim.record.promptProvenance === undefined ? {} : { promptProvenance: claim.record.promptProvenance }),
            };
      }
      case 'JOIN': {
        const inFlight = this.#inFlight.get(key);
        if (inFlight !== undefined) {
          return {
            kind: 'JOIN',
            result: inFlight.result,
            ...(claim.record.promptProvenance === undefined ? {} : { promptProvenance: claim.record.promptProvenance }),
          };
        }
        // The store claims a turn is in flight but this process holds no leader promise
        // (restart with a durable host store, or a leader that died before settling). Parking
        // the caller on `IDEMPOTENCY_CONFLICT` until TTL would be a lie — the fingerprint
        // matches, so this is not a conflict. Fall through and take the turn over as a fresh
        // leader: settle overwrites the stale record via `complete`. Two post-restart racers
        // can both take over; cross-process fencing is out of scope for the reference port.
        break;
      }
      case 'PROCEED': {
        // Fresh turn: this caller is the leader.
        break;
      }
      default: {
        const exhaustive: never = claim;
        void exhaustive;
        return { kind: 'CONFLICT' };
      }
    }
    let resolve!: (value: AiResult<unknown>) => void;
    const result = new Promise<AiResult<unknown>>((r) => {
      resolve = r;
    });
    this.#inFlight.set(key, { result, resolve });
    return {
      kind: 'PROCEED',
      settle: async (final: AiResult<unknown>): Promise<void> => {
        this.#inFlight.delete(key);
        resolve(final);
        await this.#store.complete(key, final.status === 'SUCCEEDED' ? 'SUCCEEDED' : 'FAILED_FINAL', final, this.#clock.nowMs());
      },
    };
  }
}
