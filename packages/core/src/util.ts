/**
 * Small, dependency-free helpers for `@aibridge/core`.
 *
 * Kept local rather than imported from `@aibridge/contracts`' internal guard module, so the public
 * contract surface stays exactly the documented one.
 */

/** True for a plain object (never an array, never null). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A positive finite integer. */
export function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

/**
 * UTF-8 byte length of a string, computed in pure ECMAScript.
 *
 * Not `TextEncoder`, not `Buffer`: core stays parseable in a host that offers neither
 * (ARCHITECTURE.md §21).
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

/** Deterministic stringification for equality checks and digests. Not a canonical-JSON claim. */
export function canonicalize(value: unknown): string {
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

/**
 * The UTF-8 byte length of a value's JSON serialization, or `null` when it does not serialize.
 * `null` is a rejection: a value that cannot be measured cannot be size-bounded.
 */
export function jsonByteLength(value: unknown): number | null {
  try {
    const serialized: unknown = JSON.stringify(value);
    return typeof serialized === 'string' ? utf8ByteLength(serialized) : null;
  } catch {
    return null;
  }
}

/** Walk every string value of a JSON-like structure, depth-agnostic and cycle-unsafe (JSON only). */
export function walkStrings(
  value: unknown,
  path: string,
  visit: (text: string, path: string) => void,
): void {
  if (typeof value === 'string') {
    visit(value, path);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      walkStrings(entry, `${path}[${index}]`, visit);
    });
    return;
  }
  if (isRecord(value)) {
    for (const key of Object.keys(value)) {
      walkStrings(value[key], path === '$' ? `$.${key}` : `${path}.${key}`, visit);
    }
  }
}

/** Rebuild a JSON-like structure with every string value passed through `map`. */
export function mapStrings(value: unknown, path: string, map: (text: string, path: string) => string): unknown {
  if (typeof value === 'string') {
    return map(value, path);
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => mapStrings(entry, `${path}[${index}]`, map));
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      out[key] = mapStrings(value[key], path === '$' ? `$.${key}` : `${path}.${key}`, map);
    }
    return out;
  }
  return value;
}
