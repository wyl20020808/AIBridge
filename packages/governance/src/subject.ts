/**
 * Safe subject references (SECURITY.md §16.1, ARCHITECTURE.md §15.3).
 *
 * A subject token is an opaque, host-minted handle. It is never logged, never a metric label and
 * never a ledger field: usage and quota carry a **hash** instead. The hash exists for correlation,
 * not for secrecy — the raw token is simply never written down anywhere in this layer.
 */

const FNV_OFFSET_A = 0x811c9dc5;
const FNV_OFFSET_B = 0x01000193;

function fnv1a(text: string, seed: number): string {
  let hash = seed >>> 0;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index) & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
    hash ^= text.charCodeAt(index) >>> 8;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * A stable, opaque reference to a subject token: `subj-<hex>`.
 *
 * Deterministic across processes (correlation needs it) and derived through two FNV-1a passes so a
 * single token cannot be distinguished from a random handle by length or shape.
 */
export function hashSubjectToken(token: string): string {
  return `subj-${fnv1a(token, FNV_OFFSET_A)}${fnv1a(token, FNV_OFFSET_B)}`;
}

/** The safe reference for an optional subject, or `undefined` when there is no subject. */
export function safeSubjectRef(token: string | undefined | null): string | undefined {
  return token === undefined || token === null || token.length === 0 ? undefined : hashSubjectToken(token);
}
