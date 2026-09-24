/**
 * The single version source for AI Bridge.
 *
 * Every versioned thing is deliberately separate, so that one moving does not invalidate another
 * (ARCHITECTURE.md §24). These constants are the only place a frozen version value is written in
 * code; the parallel contract records the same values in INTEGRATION_CONTRACT_V1.md §2.
 *
 * Version policy (frozen):
 *  - comparison is **major-compatible**: `1.0` accepts `1`, `1.0`, `1.0.3`;
 *  - an **unknown or higher major is rejected**. Never best-effort parsed
 *    (AGENTS.md §5, ARCHITECTURE.md §24).
 *
 * This module has no imports and no runtime dependencies, so it stays parseable in any host.
 */

/** Plugin ↔ host loading version. Unknown major ⇒ the host rejects registration. */
export const PLUGIN_API_VERSION = 1 as const;

/** Request envelope, response envelope and error vocabulary. */
export const AIBRIDGE_CONTRACT_VERSION = '1.1' as const;

/** The `AiRequestEnvelope` / consumer request field set. `1.1` — additive Stage 6 provenance fields. */
export const GENERIC_REQUEST_SCHEMA_VERSION = '1.1' as const;

/** The `AiResult` response envelope field set. */
export const AIBRIDGE_RESPONSE_SCHEMA_VERSION = '1.1' as const;

/** The `AiErrorCode` / `AiErrorReason` vocabulary. `1.2` — additive Stage 6 reason. */
export const AIBRIDGE_ERROR_VERSION = '1.2' as const;

/** One capability's declared output shape (per `schemaId@version`). */
export const STRUCTURED_OUTPUT_SCHEMA_VERSION = '1.0' as const;

/** AI Bridge ↔ provider adapter. Internal; not a frozen public contract. */
export const PROVIDER_ADAPTER_API_VERSION = 1 as const;

/** The capability descriptor shape. */
export const CAPABILITY_DESCRIPTOR_VERSION = '1.0' as const;

/** The shared JSON fixture set version. */
export const FIXTURE_SET_VERSION = '1.0' as const;

/** The major version the structured output-schema field table supports. */
export const STRUCTURED_OUTPUT_SCHEMA_MAJOR = 1 as const;

/** The one output-schema dialect AI Bridge understands in V1 (ARCHITECTURE.md §4.3). */
export const AIBRIDGE_FIELD_DIALECT = 'aibridge.fields/v1' as const;

/** A supported version reported by `checkMajorCompatibility`. */
export type MajorCompatibility = {
  /** True when both versions parse and their majors match. */
  readonly compatible: boolean;
  /** The major of the version AI Bridge supports. `null` when the expected version is unparseable. */
  readonly expectedMajor: number | null;
  /** The major of the supplied version. `null` when it is unknown or unparseable. */
  readonly actualMajor: number | null;
  /** True when `actualMajor` parses and is *higher* than `expectedMajor`. */
  readonly mustReject: boolean;
};

const SEMVER_MAJOR = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/;
const NUMERIC_MAJOR = /^(\d+)$/;

/**
 * Parse a version string to its major number.
 *
 * Accepts `1`, `1.0`, `1.0.3`, and the number `1`. Rejects anything else, including
 * `01`, `1.x`, `v1`, `''` and `2.0` — a version AI Bridge cannot read is a version it rejects.
 */
export function parseMajor(version: unknown): number | null {
  if (typeof version === 'number') {
    return Number.isInteger(version) && version >= 0 ? version : null;
  }
  if (typeof version !== 'string') {
    return null;
  }
  const trimmed = version.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const match = SEMVER_MAJOR.exec(trimmed) ?? NUMERIC_MAJOR.exec(trimmed);
  if (match === null) {
    return null;
  }
  const majorText = match[1];
  if (majorText === undefined) {
    return null;
  }
  return Number(majorText);
}

/**
 * Compare a supplied version against the version AI Bridge supports.
 *
 * Unknown major ⇒ `mustReject: true`. The caller maps that to
 * `INVALID_REQUEST` / `CONTRACT_VERSION_UNSUPPORTED` (or the capability-specific equivalent).
 */
export function checkMajorCompatibility(actual: unknown, expected: string = AIBRIDGE_CONTRACT_VERSION): MajorCompatibility {
  const expectedMajor = parseMajor(expected);
  const actualMajor = parseMajor(actual);
  if (expectedMajor === null || actualMajor === null || expectedMajor !== actualMajor) {
    return { compatible: false, expectedMajor, actualMajor, mustReject: true };
  }
  return { compatible: true, expectedMajor, actualMajor, mustReject: false };
}

/** Convenience predicate: both versions parse and share a major. */
export function isMajorCompatible(actual: unknown, expected: string = AIBRIDGE_CONTRACT_VERSION): boolean {
  return checkMajorCompatibility(actual, expected).compatible;
}
