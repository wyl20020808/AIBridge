/**
 * Endpoint safety — the SSRF boundary for provider base URLs (ROADMAP Stage 4 §19–20).
 *
 * A provider base URL comes **only** from trusted operator configuration. A consumer request can
 * never carry a URL, host or endpoint (`FORBIDDEN_CONSUMER_FIELDS` rejects them at the contract
 * boundary); this module is what makes an *operator's* endpoint choice safe by construction:
 *
 *  - production requires `https:`;
 *  - embedded credentials in the URL are rejected (`https://user:pass@host`);
 *  - loopback, private, link-local and cloud-metadata addresses are rejected — including the
 *    integer/hex/octal IPv4 encodings a naive string check would miss, because the hostname is
 *    normalized by the **WHATWG URL parser**, the same one `fetch` resolves with;
 *  - `localhost` variants and metadata hostnames are rejected by name;
 *  - anything unparseable fails **closed**.
 *
 * `allowPrivateNetworkForDevelopment` (default `false`) relaxes scheme and private-network rules
 * for local development. It is never a production setting and is surfaced in diagnostics.
 *
 * Deliberately not an enterprise SSRF firewall (DNS rebinding, egress allow-lists and TLS pinning
 * are out of Stage 4): the goal is "fail closed on an obviously unsafe endpoint".
 *
 * The URL type is declared locally so the published `.d.ts` stays platform-free while the
 * implementation uses the runtime's WHATWG parser.
 */
import type { ValidationIssue, ValidationResult } from '@aibridge/contracts';
import { createIssue, invalid, valid } from '@aibridge/contracts';

/** The minimal WHATWG URL surface this module needs. Type-only; erased at emit. */
type UrlLike = {
  readonly protocol: string;
  readonly hostname: string;
  readonly username: string;
  readonly password: string;
  readonly href: string;
};
type UrlConstructorLike = new (input: string, base?: string) => UrlLike;
declare const URL: UrlConstructorLike;

/** Closed set of endpoint rejections. A config error names one; nothing else is guessable. */
export const ENDPOINT_REJECTIONS = [
  'INVALID_URL',
  'EMBEDDED_CREDENTIALS',
  'HTTPS_REQUIRED',
  'BLOCKED_HOST',
  'PRIVATE_ADDRESS',
  'METADATA_ADDRESS',
] as const;

export type EndpointRejection = (typeof ENDPOINT_REJECTIONS)[number];

export type EndpointSafetyOptions = {
  /** Development only. Default `false`: production requires HTTPS and public hosts. */
  readonly allowPrivateNetworkForDevelopment?: boolean;
};

export type EndpointCheck =
  | { readonly safe: true; readonly href: string; readonly hostname: string }
  | { readonly safe: false; readonly rejection: EndpointRejection; readonly detail: string };

/** Hostnames rejected by name: loopback aliases and cloud metadata services. */
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'ip6-localhost',
  'ip6-loopback',
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
  '0.0.0.0',
]);

function isIpv4(hostname: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname);
}

function ipv4Parts(hostname: string): readonly number[] | null {
  if (!isIpv4(hostname)) {
    return null;
  }
  const parts = hostname.split('.').map((part) => Number(part));
  return parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) ? parts : null;
}

/** Classify an IPv4 address. Rejections: loopback/private/link-local/metadata/unspecified. */
function classifyIpv4(parts: readonly number[]): EndpointRejection | null {
  const [a = 0, b = 0] = parts;
  if (a === 0) {
    return 'PRIVATE_ADDRESS'; // "this network" / unspecified
  }
  if (a === 127) {
    return 'PRIVATE_ADDRESS'; // loopback
  }
  if (a === 10) {
    return 'PRIVATE_ADDRESS';
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return 'PRIVATE_ADDRESS';
  }
  if (a === 192 && b === 168) {
    return 'PRIVATE_ADDRESS';
  }
  if (a === 169 && b === 254) {
    // link-local, and the cloud metadata service that lives there
    return 'METADATA_ADDRESS';
  }
  if (a === 100 && b >= 64 && b <= 127) {
    return 'PRIVATE_ADDRESS'; // CGNAT
  }
  if (a === 192 && b === 0) {
    return 'PRIVATE_ADDRESS'; // IETF protocol assignments / some cloud metadata ranges
  }
  return null;
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

/** Classify an IPv6 address (already unbracketed, lower-cased). */
function classifyIpv6(hostname: string): EndpointRejection | null {
  const address = hostname.toLowerCase();
  if (address === '::' || address === '::1') {
    return 'PRIVATE_ADDRESS';
  }
  if (address.startsWith('fe8') || address.startsWith('fe9') || address.startsWith('fea') || address.startsWith('feb')) {
    return 'PRIVATE_ADDRESS'; // link-local fe80::/10
  }
  if (address.startsWith('fc') || address.startsWith('fd')) {
    return 'PRIVATE_ADDRESS'; // unique-local fc00::/7
  }
  if (address.startsWith('::ffff:')) {
    // IPv4-mapped: classify the embedded IPv4 rather than waving it through.
    const mapped = ipv4Parts(address.slice('::ffff:'.length));
    return mapped === null ? 'PRIVATE_ADDRESS' : classifyIpv4(mapped);
  }
  return null;
}

/**
 * Check one endpoint URL. Failures name a closed `EndpointRejection`; nothing about the caller
 * or the deployment is echoed beyond the rejection itself.
 */
export function checkEndpointSafety(rawUrl: string, options: EndpointSafetyOptions = {}): EndpointCheck {
  const development = options.allowPrivateNetworkForDevelopment === true;
  let parsed: UrlLike;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { safe: false, rejection: 'INVALID_URL', detail: 'not a parseable absolute URL' };
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    return { safe: false, rejection: 'EMBEDDED_CREDENTIALS', detail: 'credentials must never be embedded in a URL' };
  }
  if (parsed.protocol !== 'https:' && !(development && parsed.protocol === 'http:')) {
    return { safe: false, rejection: 'HTTPS_REQUIRED', detail: 'production endpoints must use https' };
  }

  // `URL` normalizes integer/hex/octal IPv4 encodings to dotted-quad, so the checks below see
  // the address the resolver will actually use.
  const hostname = parsed.hostname.toLowerCase();
  const bare = stripIpv6Brackets(hostname);

  if (!development) {
    if (BLOCKED_HOSTNAMES.has(bare) || bare.endsWith('.localhost') || bare.endsWith('.local')) {
      return { safe: false, rejection: 'BLOCKED_HOST', detail: 'localhost and metadata hostnames are not routable endpoints' };
    }
    const v4 = ipv4Parts(bare);
    if (v4 !== null) {
      const rejection = classifyIpv4(v4);
      if (rejection !== null) {
        return { safe: false, rejection, detail: 'private, loopback, link-local and metadata addresses are not routable endpoints' };
      }
    } else if (bare.includes(':')) {
      const rejection = classifyIpv6(bare);
      if (rejection !== null) {
        return { safe: false, rejection, detail: 'private, loopback, link-local and metadata addresses are not routable endpoints' };
      }
    }
    if (bare === 'metadata.google.internal' || bare.endsWith('.metadata.google.internal')) {
      return { safe: false, rejection: 'METADATA_ADDRESS', detail: 'cloud metadata targets are never endpoints' };
    }
  }
  return { safe: true, href: parsed.href, hostname };
}

/** `ValidationResult` wrapper for configuration validation, with rooted issues. */
export function validateEndpointUrl(
  rawUrl: unknown,
  path = '$',
  options: EndpointSafetyOptions = {},
): ValidationResult<string> {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) {
    return invalid('MALFORMED_ENVELOPE', [createIssue('INVALID_TYPE', path, 'must be a non-empty endpoint URL')]);
  }
  const check = checkEndpointSafety(rawUrl, options);
  if (!check.safe) {
    return invalid('MALFORMED_ENVELOPE', [
      createIssue('INVALID_VALUE', path, `unsafe endpoint (${check.rejection}): ${check.detail}`),
    ]);
  }
  // Normalized form (trailing-slash-free base is the caller's convention; href is canonical).
  return valid(rawUrl);
}

/** The issue a rejected endpoint produces, for callers that collect issues themselves. */
export function endpointIssue(rawUrl: string, path: string, options: EndpointSafetyOptions = {}): ValidationIssue | null {
  const check = checkEndpointSafety(rawUrl, options);
  return check.safe ? null : createIssue('INVALID_VALUE', path, `unsafe endpoint (${check.rejection}): ${check.detail}`);
}
