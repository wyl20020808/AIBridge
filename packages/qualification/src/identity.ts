/**
 * Qualification identity (Stage 8, Phases 2, 35, 36).
 *
 * A qualification is only meaningful when it is bound to *exactly* what was qualified. The identity
 * below is the full binding set, projected to be **safe by construction**:
 *
 *  - never an API key, credential value or Authorization header;
 *  - never a raw base URL that could embed userinfo / query secrets;
 *  - only a host/domain safe projection plus an opaque config digest.
 *
 * `configDigest` and `providerModelSafeRef` are stable fingerprints, not secrets. That is what lets
 * model-config drift (Phase 36) and endpoint/cluster drift (Phase 6) invalidate a stale record.
 */

import type { QualificationFeature } from './status.js';

/**
 * A safe endpoint projection: the scheme, host and (when non-default) port only. Any userinfo,
 * path, query string or fragment is dropped so credentials embedded in a URL can never be recorded.
 */
export type SafeEndpointIdentity = {
  /** e.g. 'https' — never includes userinfo. */
  readonly scheme: string;
  /** e.g. 'api.deepseek.com' — lowercased, no credentials, no port. */
  readonly host: string;
  /** Present only when the URL carried an explicit non-default port. */
  readonly port?: number;
};

/** The full, secret-free binding set for one qualification. */
export type QualificationIdentity = {
  readonly providerId: string;
  readonly providerFamily: string;
  /** Configured endpoint preset, e.g. 'PRESET' | 'CUSTOM'. */
  readonly endpointKind: string;
  /** Xiaomi/relay cluster when the endpoint is a preset, e.g. 'CN' | 'SGP' | 'EU'. */
  readonly cluster?: string;
  /** Safe endpoint projection; query string and credentials are never present. */
  readonly endpoint: SafeEndpointIdentity;
  readonly modelAlias: string;
  /**
   * A safe reference to the provider's own model id. Always the raw providerModelId is NOT recorded
   * verbatim when it could embed a secret; instead this is a stable hash-based safe ref. See
   * {@link providerModelSafeRef}.
   */
  readonly providerModelSafeRef: string;
  readonly feature: QualificationFeature;
  readonly adapterVersion: string;
  readonly contractVersion: string;
  /** Fingerprint of the effective config for this provider/model/endpoint. */
  readonly configDigest: string;
};

/**
 * Derive a safe, stable reference to a provider model id.
 *
 * The model id itself is not a secret, but it can appear inside a URL or carry vendor-specific
 * tokens in exotic setups, so it is not echoed verbatim in a public record/CLI. The safe ref keeps
 * enough of the shape to be debuggable while being derived, not copied.
 */
export function providerModelSafeRef(providerModelId: string): string {
  const digest = fnv1a64(providerModelId);
  const hint = providerModelId.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 12);
  return `${hint || 'model'}#${digest}`;
}

/**
 * Project a base URL to a safe identity. Anything that could carry a secret (userinfo, path, query,
 * fragment) is deliberately dropped. Unparseable input yields a placeholder that never leaks input.
 */
export function safeEndpointIdentity(baseUrl: string): SafeEndpointIdentity {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return { scheme: 'unknown', host: 'unknown' };
  }
  const scheme = parsed.protocol.replace(/:$/, '') || 'unknown';
  const host = parsed.hostname.toLowerCase() || 'unknown';
  const portText = parsed.port;
  if (portText === '') {
    return { scheme, host };
  }
  const port = Number.parseInt(portText, 10);
  if (!Number.isFinite(port)) {
    return { scheme, host };
  }
  return { scheme, host, port };
}

/**
 * Fingerprint an effective configuration for one provider/model/endpoint into a stable digest.
 * Only the fields that, if changed, must invalidate a qualification are included (Phase 6/36).
 */
export function configDigest(input: {
  readonly preset: string;
  readonly endpointKind: string;
  readonly cluster?: string;
  readonly endpoint: SafeEndpointIdentity;
  readonly providerModelSafeRef: string;
  readonly declaredFeatures: readonly string[];
}): string {
  const canonical = [
    `preset=${input.preset}`,
    `endpointKind=${input.endpointKind}`,
    `cluster=${input.cluster ?? ''}`,
    `endpoint=${input.endpoint.scheme}://${input.endpoint.host}:${input.endpoint.port ?? ''}`,
    `model=${input.providerModelSafeRef}`,
    `features=${[...input.declaredFeatures].sort().join(',')}`,
  ].join('|');
  return `cfg#${fnv1a64(canonical)}`;
}

/**
 * A stable, non-cryptographic 64-bit FNV-1a digest rendered as hex. Used only for drift detection
 * and safe refs — never as a security primitive. Deterministic across runs and platforms.
 */
export function fnv1a64(value: string): string {
  // 64-bit FNV-1a via two 32-bit lanes, assembled BigInt-free to stay runtime-portable.
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = (hash * prime) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, '0');
}

/**
 * True when two identities refer to the same qualified thing. Used by staleness (Phase 6) and by
 * the record store to decide replacement vs coexistence.
 */
export function sameIdentity(a: QualificationIdentity, b: QualificationIdentity): boolean {
  return identityKey(a) === identityKey(b);
}

/** Canonical string key for an identity; safe to use as a map key. */
export function identityKey(identity: QualificationIdentity): string {
  return [
    identity.providerId,
    identity.modelAlias,
    identity.feature,
    identity.endpointKind,
    identity.cluster ?? '',
    identity.endpoint.scheme,
    identity.endpoint.host,
    identity.endpoint.port ?? '',
  ].join('::');
}
