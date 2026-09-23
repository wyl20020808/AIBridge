/**
 * The input safety boundary (SECURITY.md §3, ARCHITECTURE.md §1.1 responsibility 17).
 *
 * Two different treatments, for two different reasons:
 *
 *  - **Secret-like material is rejected** (`INPUT_SAFETY / SECRET_LIKE_INPUT`). Forwarding a
 *    credential to a third-party model is an irreversible disclosure; redaction is a heuristic that
 *    will miss variants; and silently scrubbing hides that a caller is mishandling credentials.
 *  - **PII is redacted and the caller is warned** (`warnings: [{ code: 'INPUT_REDACTED' }]`). A
 *    learner pasting a phone number into an idea description is not misusing a credential;
 *    rejecting their turn would punish them for the platform's data policy.
 *
 * Size is checked first: a limit enforced only after the provider has billed for it is not a limit.
 */
import { makeAiError, makeWarning, type AiError, type AiWarning } from '@aibridge/contracts';
import { jsonByteLength, mapStrings, walkStrings } from './util.js';

/** Default input cap (SECURITY.md §3.1). */
export const DEFAULT_MAX_INPUT_BYTES = 32_768;

export type SecretPattern = {
  /** Stable, non-sensitive identifier surfaced in `AiError.details.pattern`. */
  readonly id: string;
  readonly pattern: RegExp;
};

/** The minimum secret shapes SECURITY.md §3.2 requires. Order is deliberate: most specific first. */
export const SECRET_PATTERNS: readonly SecretPattern[] = [
  { id: 'PEM_PRIVATE_KEY', pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/ },
  { id: 'OPENAI_STYLE_KEY', pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/ },
  { id: 'GITHUB_TOKEN', pattern: /\bghp_[A-Za-z0-9]{20,}\b/ },
  { id: 'AWS_ACCESS_KEY_ID', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'SLACK_TOKEN', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { id: 'JWT', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/ },
  { id: 'BEARER_HEADER', pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i },
  { id: 'API_KEY_ASSIGNMENT', pattern: /\bapi[_-]?key\s*[:=]\s*["']?[A-Za-z0-9._-]{12,}/i },
  { id: 'SECRET_ASSIGNMENT', pattern: /\b(?:secret|password|credential|access[_-]?token)\s*[:=]\s*["']?[A-Za-z0-9._-]{8,}/i },
];

export type PiiCategory = 'EMAIL' | 'PHONE' | 'NATIONAL_ID';

export type PiiPattern = {
  readonly category: PiiCategory;
  readonly pattern: RegExp;
};

/** PII categories SECURITY.md §3.3 requires. Replacement markers are `[REDACTED:<category>]`. */
export const PII_PATTERNS: readonly PiiPattern[] = [
  { category: 'EMAIL', pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  { category: 'PHONE', pattern: /(?:\+\d{1,3}[ .-]?)?(?:\(\d{2,4}\)|\d{2,4})[ .-]\d{3,4}[ .-]\d{3,4}/ },
  { category: 'NATIONAL_ID', pattern: /\b\d{15,18}\b/ },
];

export type InputFinding = {
  readonly kind: 'SECRET' | 'PII';
  /** A `SecretPattern.id` for a secret, a `PiiCategory` for PII. */
  readonly id: string;
  /** Rooted path of the offending value, e.g. `$.context[0].value`. */
  readonly path: string;
};

export type InputScreenOptions = {
  readonly maxInputBytes?: number;
  /** Default true. `false` detects PII but does not rewrite it. */
  readonly redactPii?: boolean;
  readonly path?: string;
};

export type InputScreenSuccess = {
  readonly ok: true;
  /** The (possibly redacted) input, safe to dispatch. */
  readonly value: unknown;
  readonly warnings: readonly AiWarning[];
  readonly bytes: number;
  readonly findings: readonly InputFinding[];
};

export type InputScreenFailure = {
  readonly ok: false;
  readonly error: AiError;
  readonly bytes: number;
  readonly findings: readonly InputFinding[];
};

export type InputScreenResult = InputScreenSuccess | InputScreenFailure;

/** Fresh (state-free) test of a pattern. */
function patternMatches(pattern: RegExp, text: string): boolean {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  return new RegExp(pattern.source, flags).test(text);
}

/** Fresh (state-free) global application of a pattern. */
function patternReplace(pattern: RegExp, text: string, replacement: string): string {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  return text.replace(new RegExp(pattern.source, flags), replacement);
}

function pushFindings(findings: InputFinding[], kind: InputFinding['kind'], id: string, path: string): void {
  if (findings.some((finding) => finding.kind === kind && finding.id === id && finding.path === path)) {
    return;
  }
  findings.push({ kind, id, path });
}

/** Detect secret-shaped material anywhere in a value. */
export function findSecrets(value: unknown, path = '$'): readonly InputFinding[] {
  const findings: InputFinding[] = [];
  walkStrings(value, path, (text, textPath) => {
    for (const secret of SECRET_PATTERNS) {
      if (patternMatches(secret.pattern, text)) {
        pushFindings(findings, 'SECRET', secret.id, textPath);
      }
    }
  });
  return findings;
}

/** Detect PII anywhere in a value. */
export function findPii(value: unknown, path = '$'): readonly InputFinding[] {
  const findings: InputFinding[] = [];
  walkStrings(value, path, (text, textPath) => {
    for (const pii of PII_PATTERNS) {
      if (patternMatches(pii.pattern, text)) {
        pushFindings(findings, 'PII', pii.category, textPath);
      }
    }
  });
  return findings;
}

function redactText(text: string): string {
  let result = text;
  for (const pii of PII_PATTERNS) {
    result = patternReplace(pii.pattern, result, `[REDACTED:${pii.category}]`);
  }
  return result;
}

/**
 * Screen a capability input.
 *
 * Order: size → secrets (reject) → PII (redact). A single secret finding fails the whole input; the
 * first finding is reported, because a caller only needs to know a credential was there and where.
 */
export function screenAiInput(value: unknown, options: InputScreenOptions = {}): InputScreenResult {
  const maxInputBytes = options.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES;
  const path = options.path ?? '$';
  const bytes = jsonByteLength(value);
  if (bytes === null) {
    return {
      ok: false,
      bytes: 0,
      findings: [],
      error: makeAiError({
        reason: 'MALFORMED_ENVELOPE',
        message: 'The input could not be serialized for size screening.',
        details: { field: path },
      }),
    };
  }
  if (bytes > maxInputBytes) {
    return {
      ok: false,
      bytes,
      findings: [],
      error: makeAiError({
        reason: 'INPUT_TOO_LARGE',
        message: 'The input exceeds the capability input size cap.',
        details: { maxInputBytes, actualBytes: bytes },
      }),
    };
  }

  const secrets = findSecrets(value, path);
  if (secrets.length > 0) {
    const first = secrets[0];
    return {
      ok: false,
      bytes,
      findings: secrets,
      error: makeAiError({
        reason: 'SECRET_LIKE_INPUT',
        message: 'The input contains credential-shaped material and was rejected rather than forwarded.',
        details: {
          pattern: first === undefined ? 'UNKNOWN' : first.id,
          field: first === undefined ? path : first.path,
        },
      }),
    };
  }

  const pii = findPii(value, path);
  const warnings: AiWarning[] = [];
  let screened: unknown = value;
  if (pii.length > 0) {
    if (options.redactPii !== false) {
      screened = mapStrings(value, path, (text) => redactText(text));
    }
    warnings.push(makeWarning('INPUT_REDACTED', `${pii.length} PII value(s) were redacted before dispatch`));
  }

  return { ok: true, value: screened, warnings, bytes, findings: pii };
}

/** Convenience: the first secret finding's path, for tests that assert where a rejection pointed. */
export function firstSecretPath(value: unknown, path = '$'): string | null {
  const findings = findSecrets(value, path);
  const first = findings[0];
  return first === undefined ? null : first.path;
}
