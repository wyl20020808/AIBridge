/**
 * The operator-only diagnostic channel (SECURITY.md §6).
 *
 * A provider's raw error text may appear **only** here, and only credential-stripped, PII-stripped
 * and truncated. Nothing on this channel is ever returned to a consumer, rendered, or written to
 * a consumer-facing log. The secret-leakage regression tests capture every entry this build can
 * write and assert a configured key appears in none of them (TESTING.md §2.1, §2.2).
 */
import { PII_PATTERNS, SECRET_PATTERNS } from '@aibridge/core';

export const OPERATOR_DETAIL_MAX_LENGTH = 512;

export const OPERATOR_LOG_EVENTS = [
  'runtime.rejected',
  'provider.dispatched',
  'provider.raw_error',
  'provider.timeout',
  'provider.cancelled',
  'runtime.succeeded',
] as const;

export type OperatorLogEvent = (typeof OPERATOR_LOG_EVENTS)[number];

export type OperatorLogEntry = {
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly event: OperatorLogEvent;
  readonly atMs: number;
  readonly requestId?: string;
  readonly capability?: string;
  readonly providerId?: string;
  /** Credential-stripped, PII-stripped, truncated detail. Never raw input or output content. */
  readonly detail?: string;
};

/** The sink implementations provide. A sink that stores entries must treat them as operator-only. */
export type OperatorLogSink = {
  write(entry: OperatorLogEntry): void;
};

/** A sink that discards everything. The default: no logging is the safest default. */
export function nullOperatorLog(): OperatorLogSink {
  return { write: () => undefined };
}

/** An in-memory sink for tests. Entries are operator-only by contract. */
export class RecordingOperatorLog implements OperatorLogSink {
  readonly entries: OperatorLogEntry[] = [];

  write(entry: OperatorLogEntry): void {
    this.entries.push(entry);
  }
}

function freshGlobal(pattern: RegExp): RegExp {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  return new RegExp(pattern.source, flags);
}

/**
 * Strip credentials and PII from operator detail and truncate it.
 *
 * `boundSecrets` are the resolved credential values this runtime bound to an adapter; they are
 * removed literally as well as by pattern, because a rotated key may match no pattern at all.
 */
export function redactOperatorDetail(detail: string, boundSecrets: readonly string[] = []): string {
  let redacted = detail;
  for (const secret of boundSecrets) {
    if (secret.length > 0) {
      redacted = redacted.split(secret).join('[REDACTED]');
    }
  }
  for (const secret of SECRET_PATTERNS) {
    redacted = redacted.replace(freshGlobal(secret.pattern), `[REDACTED:${secret.id}]`);
  }
  for (const pii of PII_PATTERNS) {
    redacted = redacted.replace(freshGlobal(pii.pattern), `[REDACTED:${pii.category}]`);
  }
  return redacted.slice(0, OPERATOR_DETAIL_MAX_LENGTH);
}
