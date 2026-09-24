/**
 * File-backed dev qualification store (Stage 8, Phases 5, 53).
 *
 * An explicitly **non-secret, versioned, portable** reference store for local/operator use. The file
 * contains only the safe record shape (see {@link ProviderQualificationRecord}), so it is safe to
 * keep on disk, diff, and copy between checkouts. It is never a production dependency: the port is
 * what production uses, and this class is offered for developer convenience only.
 *
 * The serializer is intentionally tiny and dependency-free so it stays inside the declaration-hygiene
 * and portability rules (no `node:` imports in exported signatures). The host supplies the read/write
 * functions, so this class does not itself bind to a filesystem API.
 */

import type { ProviderQualificationRecord } from './record.js';
import { validateQualificationRecord } from './record.js';
import { identityKey } from './identity.js';
import {
  DEFAULT_QUALIFICATION_RETENTION,
  QUALIFICATION_STORE_FORMAT_VERSION,
  type QualificationStorePort,
} from './store.js';

/** Minimal I/O seam so this store adds no platform dependency to the public surface. */
export type QualificationFileIo = {
  read(): Promise<string | null>;
  write(contents: string): Promise<void>;
};

export type QualificationFileStoreOptions = {
  readonly io: QualificationFileIo;
  readonly retention?: number;
};

export type QualificationFileDocument = {
  readonly formatVersion: number;
  readonly records: readonly ProviderQualificationRecord[];
};

export function serializeQualificationDocument(
  records: readonly ProviderQualificationRecord[],
): string {
  const doc: QualificationFileDocument = {
    formatVersion: QUALIFICATION_STORE_FORMAT_VERSION,
    records,
  };
  return JSON.stringify(doc, null, 2);
}

/**
 * Parse a stored document. Unknown format versions are rejected (never best-effort parsed), matching
 * the project's contract discipline (AGENTS.md §5). Records that fail the safe-shape validator are
 * dropped rather than trusted.
 */
export function parseQualificationDocument(text: string): readonly ProviderQualificationRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (parsed === null || typeof parsed !== 'object') {
    return [];
  }
  const doc = parsed as { formatVersion?: unknown; records?: unknown };
  if (doc.formatVersion !== QUALIFICATION_STORE_FORMAT_VERSION) {
    return [];
  }
  if (!Array.isArray(doc.records)) {
    return [];
  }
  const out: ProviderQualificationRecord[] = [];
  for (const candidate of doc.records) {
    if (candidate === null || typeof candidate !== 'object') {
      continue;
    }
    const record = candidate as ProviderQualificationRecord;
    if (validateQualificationRecord(record).length === 0) {
      out.push(record);
    }
  }
  return out;
}

export class FileQualificationStore implements QualificationStorePort {
  readonly #io: QualificationFileIo;
  readonly #retention: number;

  constructor(options: QualificationFileStoreOptions) {
    this.#io = options.io;
    this.#retention = options.retention ?? DEFAULT_QUALIFICATION_RETENTION;
  }

  async #load(): Promise<readonly ProviderQualificationRecord[]> {
    const text = await this.#io.read();
    return text === null ? [] : parseQualificationDocument(text);
  }

  async #persist(records: readonly ProviderQualificationRecord[]): Promise<void> {
    await this.#io.write(serializeQualificationDocument(records));
  }

  async save(record: ProviderQualificationRecord): Promise<readonly ProviderQualificationRecord[]> {
    const records = await this.#load();
    const key = identityKey(record.identity);
    const others = records.filter((candidate) => identityKey(candidate.identity) !== key);
    const sameKey = [record, ...records.filter((candidate) => identityKey(candidate.identity) === key)].sort(
      (a, b) => (b.qualifiedAt ?? 0) - (a.qualifiedAt ?? 0),
    );
    const trimmed = sameKey.slice(0, this.#retention);
    await this.#persist([...others, ...trimmed]);
    return trimmed;
  }

  async list(): Promise<readonly ProviderQualificationRecord[]> {
    const records = await this.#load();
    return [...records].sort((a, b) => (b.qualifiedAt ?? 0) - (a.qualifiedAt ?? 0));
  }

  async latest(key: string): Promise<ProviderQualificationRecord | null> {
    const history = await this.history(key);
    return history[0] ?? null;
  }

  async history(key: string): Promise<readonly ProviderQualificationRecord[]> {
    const records = await this.#load();
    return records
      .filter((candidate) => identityKey(candidate.identity) === key)
      .sort((a, b) => (b.qualifiedAt ?? 0) - (a.qualifiedAt ?? 0));
  }

  async clear(): Promise<void> {
    await this.#persist([]);
  }
}
