/**
 * Small, dependency-free guards shared by the parsers.
 *
 * These are internal helpers; they are not part of the exported contract surface.
 */

/** True for a plain object (never an array, never null). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Keys present on `value` that are not in `allowed`, sorted for stable issue ordering. */
export function unknownKeys(value: Record<string, unknown>, allowed: readonly string[]): readonly string[] {
  return Object.keys(value)
    .filter((key) => !allowed.includes(key))
    .sort();
}

/** A short, human-readable type name for an issue message. Never echoes the value itself. */
export function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  switch (typeof value) {
    case 'string':
      return 'string';
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'undefined':
      return 'undefined';
    case 'object':
      return 'object';
    case 'function':
      return 'function';
    case 'bigint':
      return 'bigint';
    case 'symbol':
      return 'symbol';
    default:
      return 'unknown';
  }
}

/** A finite, non-negative number. */
export function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** A finite number. */
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** A finite integer. */
export function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

/** A positive finite integer. */
export function isPositiveInteger(value: unknown): value is number {
  return isInteger(value) && value >= 1;
}

/** A non-empty string that is exactly itself when trimmed. */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** True when `value` is one of `allowed`. */
export function isOneOf<T extends readonly string[]>(value: unknown, allowed: T): value is T[number] {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}

/**
 * UTF-8 byte length of a string, computed in pure ECMAScript.
 *
 * Deliberately not `TextEncoder`, not `Buffer`: the contracts package must stay parseable in a
 * host that offers neither.
 */
export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < value.length ? value.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/** Deterministic key order for digests. Not a canonical JSON implementation — just stable here. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortValue(entry));
  }
  if (isRecord(value)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortValue(value[key]);
    }
    return sorted;
  }
  return value;
}
