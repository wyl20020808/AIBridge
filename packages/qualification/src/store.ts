/**
 * Qualification storage (Stage 8, Phases 5, 37).
 *
 * AI Bridge owns no host database (AGENTS.md §9). A qualification store is a **port**: the host may
 * back it with whatever it likes. This package ships an in-memory reference and an optional
 * file-backed dev store, both of which hold only safe, versioned, non-secret metadata.
 *
 * Retention is bounded (Phase 37): history keeps at most `retention` records per
 * (providerId, modelAlias, feature), newest first. There are no unbounded append logs.
 */

import type { ProviderQualificationRecord } from './record.js';
import { identityKey } from './identity.js';

export const QUALIFICATION_STORE_FORMAT_VERSION = 1;

export type QualificationStorePort = {
  /** Append a record, applying retention. Returns the stored (possibly trimmed) history. */
  save(record: ProviderQualificationRecord): Promise<readonly ProviderQualificationRecord[]>;
  /** All records, newest first. */
  list(): Promise<readonly ProviderQualificationRecord[]>;
  /** The newest record for one identity key, or null. */
  latest(identityKey: string): Promise<ProviderQualificationRecord | null>;
  /** History for one identity key, newest first. */
  history(identityKey: string): Promise<readonly ProviderQualificationRecord[]>;
  /** Drop everything (test/ops helper). */
  clear(): Promise<void>;
};

export type QualificationStoreOptions = {
  /** Max records kept per identity key. Default 10. */
  readonly retention?: number;
};

export const DEFAULT_QUALIFICATION_RETENTION = 10;

/**
 * In-memory reference store. Deterministic, dependency-free, and the default for tests and for the
 * runner when no durable store is supplied.
 */
export class InMemoryQualificationStore implements QualificationStorePort {
  readonly #retention: number;
  readonly #byKey = new Map<string, ProviderQualificationRecord[]>();

  constructor(options: QualificationStoreOptions = {}) {
    this.#retention = options.retention ?? DEFAULT_QUALIFICATION_RETENTION;
  }

  async save(record: ProviderQualificationRecord): Promise<readonly ProviderQualificationRecord[]> {
    const key = identityKey(record.identity);
    const current = this.#byKey.get(key) ?? [];
    const next = [record, ...current].sort(
      (a, b) => (b.qualifiedAt ?? 0) - (a.qualifiedAt ?? 0),
    );
    const trimmed = next.slice(0, this.#retention);
    this.#byKey.set(key, trimmed);
    return trimmed;
  }

  async list(): Promise<readonly ProviderQualificationRecord[]> {
    const all: ProviderQualificationRecord[] = [];
    for (const records of this.#byKey.values()) {
      all.push(...records);
    }
    return all.sort((a, b) => (b.qualifiedAt ?? 0) - (a.qualifiedAt ?? 0));
  }

  async latest(key: string): Promise<ProviderQualificationRecord | null> {
    const records = this.#byKey.get(key);
    return records === undefined || records.length === 0 ? null : records[0] ?? null;
  }

  async history(key: string): Promise<readonly ProviderQualificationRecord[]> {
    return this.#byKey.get(key) ?? [];
  }

  async clear(): Promise<void> {
    this.#byKey.clear();
  }
}
