/**
 * Generic stream events — the **minimal additive** streaming contract (Stage 3).
 *
 * Streaming is a delivery concern, not a capability (CAPABILITIES.md §4). A stream is therefore
 * not a second architecture: it reuses the request envelope, the error model (`AiError`), the
 * usage projection (`AiUsage`), the safe provider projection and the warning vocabulary unchanged.
 * The only thing added is *how the answer arrives* — incrementally, with one terminal event that
 * carries exactly the closing facts a non-streaming `AiResult` carries.
 *
 * Frozen sequence (validated by `validateAiStreamSequence`, tested):
 *
 * ```text
 * STARTED  →  TEXT_DELTA*  →  (COMPLETED | FAILED)
 * ```
 *
 *  - exactly one `STARTED`, always first;
 *  - zero or more `TEXT_DELTA`, each a non-empty text increment, only before the terminal event;
 *  - exactly one terminal event (`COMPLETED` xor `FAILED`), always last;
 *  - `COMPLETED.text` is the complete accumulated answer and is identical to the concatenation of
 *    every `TEXT_DELTA.text`;
 *  - a stream that ends without a terminal event is invalid — the producer always terminates it,
 *    including on error, timeout and cancellation.
 *
 * `FAILED` may follow deltas: partial text plus a failure is honest, and the consumer rule stays
 * "one branch to write" — a stream either completes or fails, never both.
 */
import { describe, isNonNegativeFiniteNumber, isRecord, unknownKeys } from './guards.js';
import type { ValidationIssue, ValidationResult } from './issue.js';
import { at, createIssue, invalid, valid } from './issue.js';
import type { AiError } from './errors.js';
import {
  parseAiError,
  parseAiFinishReason,
  parseProviderMetadataProjection,
  type AiFinishReason,
  type ProviderMetadataProjection,
} from './response.js';
import { parseAiUsage, type AiUsage } from './usage.js';
import { parseAiWarnings, type AiWarning } from './warnings.js';

/** The four closed stream event kinds. */
export const AI_STREAM_EVENT_KINDS = ['STARTED', 'TEXT_DELTA', 'COMPLETED', 'FAILED'] as const;

export type AiStreamEventKind = (typeof AI_STREAM_EVENT_KINDS)[number];

export function isAiStreamEventKind(value: unknown): value is AiStreamEventKind {
  return typeof value === 'string' && (AI_STREAM_EVENT_KINDS as readonly string[]).includes(value);
}

/** Identity echo — always the first event. */
export type AiStreamStarted = {
  readonly kind: 'STARTED';
  readonly contractVersion: string;
  readonly requestId: string;
  readonly capability: string;
  readonly capabilityVersion: string;
};

/** One text increment. Never empty: an empty delta carries no information and is a producer bug. */
export type AiStreamTextDelta = {
  readonly kind: 'TEXT_DELTA';
  readonly text: string;
};

/** The closing facts every terminal event carries — the same facts `AiResult` closes with. */
export type AiStreamTerminal = {
  readonly usage: AiUsage;
  readonly finishReason: AiFinishReason;
  readonly providerMetadata: ProviderMetadataProjection;
  /** End to end, including routing and validation. */
  readonly latencyMs: number;
  readonly warnings: readonly AiWarning[];
};

/** Terminal success. `text` is the complete answer: the concatenation of every delta. */
export type AiStreamCompleted = AiStreamTerminal & {
  readonly kind: 'COMPLETED';
  readonly text: string;
};

/** Terminal failure. Normalized `AiError` only — provider prose never appears here. */
export type AiStreamFailed = AiStreamTerminal & {
  readonly kind: 'FAILED';
  readonly error: AiError;
};

export type AiStreamEvent = AiStreamStarted | AiStreamTextDelta | AiStreamCompleted | AiStreamFailed;

const AI_STREAM_STARTED_KEYS = ['kind', 'contractVersion', 'requestId', 'capability', 'capabilityVersion'] as const;
const AI_STREAM_TEXT_DELTA_KEYS = ['kind', 'text'] as const;
const AI_STREAM_COMPLETED_KEYS = ['kind', 'text', 'usage', 'finishReason', 'providerMetadata', 'latencyMs', 'warnings'] as const;
const AI_STREAM_FAILED_KEYS = ['kind', 'error', 'usage', 'finishReason', 'providerMetadata', 'latencyMs', 'warnings'] as const;

function parseTerminalFields(
  value: Record<string, unknown>,
  path: string,
  issues: ValidationIssue[],
): {
  readonly usage: AiUsage;
  readonly finishReason: AiFinishReason;
  readonly providerMetadata: ProviderMetadataProjection;
  readonly latencyMs: number;
  readonly warnings: readonly AiWarning[];
} | null {
  const usage = parseAiUsage(value['usage'], at(path, 'usage'));
  if (!usage.ok) {
    issues.push(...usage.failure.issues);
  }
  const finishReason = parseAiFinishReason(value['finishReason'], at(path, 'finishReason'));
  if (!finishReason.ok) {
    issues.push(...finishReason.failure.issues);
  }
  const providerMetadata = parseProviderMetadataProjection(value['providerMetadata'], at(path, 'providerMetadata'));
  if (!providerMetadata.ok) {
    issues.push(...providerMetadata.failure.issues);
  }
  if (!isNonNegativeFiniteNumber(value['latencyMs'])) {
    issues.push(createIssue('INVALID_TYPE', at(path, 'latencyMs'), 'must be a finite, non-negative number'));
  }
  const warnings = parseAiWarnings(value['warnings'], at(path, 'warnings'));
  if (!warnings.ok) {
    issues.push(...warnings.failure.issues);
  }
  if (issues.length > 0) {
    return null;
  }
  return {
    usage: usage.ok ? usage.value : {},
    finishReason: finishReason.ok ? finishReason.value : 'UNKNOWN',
    providerMetadata: providerMetadata.ok ? providerMetadata.value : {
      providerId: '',
      providerFamily: 'mock',
      modelClass: 'UNKNOWN',
      routeDepth: 0,
      attemptCount: 0,
      repaired: false,
    },
    latencyMs: typeof value['latencyMs'] === 'number' ? value['latencyMs'] : 0,
    warnings: warnings.ok ? warnings.value : [],
  };
}

/** Parse one stream event. Closed key set per kind; unknown fields are rejected. */
export function parseAiStreamEvent(value: unknown, path = '$'): ValidationResult<AiStreamEvent> {
  if (!isRecord(value)) {
    return invalid('MALFORMED_ENVELOPE', [createIssue('INVALID_TYPE', path, `must be an object, got ${describe(value)}`)]);
  }
  const kind = value['kind'];
  if (!isAiStreamEventKind(kind)) {
    return invalid('MALFORMED_ENVELOPE', [
      createIssue('INVALID_VALUE', at(path, 'kind'), `must be one of ${AI_STREAM_EVENT_KINDS.join(', ')}`),
    ]);
  }
  const issues: ValidationIssue[] = [];

  if (kind === 'STARTED') {
    for (const key of unknownKeys(value, AI_STREAM_STARTED_KEYS)) {
      issues.push(createIssue('UNKNOWN_FIELD', at(path, key), 'unknown stream event field'));
    }
    for (const key of ['contractVersion', 'requestId', 'capability', 'capabilityVersion'] as const) {
      if (typeof value[key] !== 'string' || (value[key] as string).length === 0) {
        issues.push(createIssue('INVALID_TYPE', at(path, key), 'must be a non-empty string'));
      }
    }
    return issues.length > 0
      ? invalid('MALFORMED_ENVELOPE', issues)
      : valid({
          kind: 'STARTED',
          contractVersion: value['contractVersion'] as string,
          requestId: value['requestId'] as string,
          capability: value['capability'] as string,
          capabilityVersion: value['capabilityVersion'] as string,
        });
  }

  if (kind === 'TEXT_DELTA') {
    for (const key of unknownKeys(value, AI_STREAM_TEXT_DELTA_KEYS)) {
      issues.push(createIssue('UNKNOWN_FIELD', at(path, key), 'unknown stream event field'));
    }
    const text = value['text'];
    if (typeof text !== 'string' || text.length === 0) {
      issues.push(createIssue('INVALID_TYPE', at(path, 'text'), 'must be a non-empty string'));
    }
    return issues.length > 0
      ? invalid('MALFORMED_ENVELOPE', issues)
      : valid({ kind: 'TEXT_DELTA', text: text as string });
  }

  const allowed = kind === 'COMPLETED' ? AI_STREAM_COMPLETED_KEYS : AI_STREAM_FAILED_KEYS;
  for (const key of unknownKeys(value, allowed)) {
    issues.push(createIssue('UNKNOWN_FIELD', at(path, key), 'unknown stream event field'));
  }
  const terminal = parseTerminalFields(value, path, issues);
  if (terminal === null) {
    return invalid('MALFORMED_ENVELOPE', issues);
  }

  if (kind === 'COMPLETED') {
    const text = value['text'];
    if (typeof text !== 'string') {
      issues.push(createIssue('INVALID_TYPE', at(path, 'text'), 'must be a string'));
    }
    return issues.length > 0
      ? invalid('MALFORMED_ENVELOPE', issues)
      : valid({ kind: 'COMPLETED', text: text as string, ...terminal });
  }

  const error = parseAiError(value['error'], at(path, 'error'));
  if (!error.ok) {
    return invalid('MALFORMED_ENVELOPE', [...issues, ...error.failure.issues]);
  }
  return valid({ kind: 'FAILED', error: error.value, ...terminal });
}

/**
 * Validate a complete stream sequence against the frozen ordering rules.
 *
 * This is what makes "order, finish, usage and error behaviour are deterministic" a checked
 * property rather than a claim: a producer cannot emit two terminals, forget the terminal, or
 * contradict its own deltas without this returning a rooted, reproducible issue list.
 */
export function validateAiStreamSequence(
  events: readonly AiStreamEvent[],
  path = '$',
): ValidationResult<readonly AiStreamEvent[]> {
  const issues: ValidationIssue[] = [];
  if (events.length === 0) {
    return invalid('MALFORMED_ENVELOPE', [
      createIssue('MISSING_FIELD', path, 'a stream must contain at least a STARTED event and one terminal event'),
    ]);
  }

  const first = events[0];
  if (first === undefined || first.kind !== 'STARTED') {
    issues.push(createIssue('INVARIANT_VIOLATION', at(path, 0), 'the first event must be STARTED'));
  }
  let startedCount = 0;
  let terminalIndex = -1;
  let accumulated = '';
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event === undefined) {
      continue;
    }
    const eventPath = at(path, index);
    if (event.kind === 'STARTED') {
      startedCount += 1;
      if (index !== 0) {
        issues.push(createIssue('INVARIANT_VIOLATION', eventPath, 'STARTED must be the first event and appear exactly once'));
      }
      continue;
    }
    if (event.kind === 'TEXT_DELTA') {
      if (terminalIndex !== -1) {
        issues.push(createIssue('INVARIANT_VIOLATION', eventPath, 'a TEXT_DELTA must not follow a terminal event'));
      }
      if (event.text.length === 0) {
        issues.push(createIssue('INVARIANT_VIOLATION', eventPath, 'a TEXT_DELTA must carry a non-empty increment'));
      }
      accumulated += event.text;
      continue;
    }
    if (terminalIndex !== -1) {
      issues.push(createIssue('INVARIANT_VIOLATION', eventPath, 'a stream carries exactly one terminal event'));
    }
    terminalIndex = index;
    if (index !== events.length - 1) {
      issues.push(createIssue('INVARIANT_VIOLATION', eventPath, 'the terminal event must be the last event'));
    }
    if (event.kind === 'COMPLETED' && event.text !== accumulated) {
      issues.push(
        createIssue('INVARIANT_VIOLATION', at(eventPath, 'text'), 'must be the concatenation of every TEXT_DELTA'),
      );
    }
  }
  if (startedCount !== 1) {
    issues.push(createIssue('INVARIANT_VIOLATION', path, 'a stream carries exactly one STARTED event'));
  }
  if (terminalIndex === -1) {
    issues.push(createIssue('MISSING_FIELD', path, 'a stream must end with exactly one terminal event'));
  }
  return issues.length > 0 ? invalid('MALFORMED_ENVELOPE', issues) : valid(events);
}

/** Parse and sequence-validate a complete stream document (e.g. a fixture or a replayed stream). */
export function parseAiStreamEvents(value: unknown, path = '$'): ValidationResult<readonly AiStreamEvent[]> {
  if (!Array.isArray(value)) {
    return invalid('MALFORMED_ENVELOPE', [createIssue('INVALID_TYPE', path, `must be an array, got ${describe(value)}`)]);
  }
  const issues: ValidationIssue[] = [];
  const events: AiStreamEvent[] = [];
  value.forEach((entry, index) => {
    const parsed = parseAiStreamEvent(entry, at(path, index));
    if (parsed.ok) {
      events.push(parsed.value);
    } else {
      issues.push(...parsed.failure.issues);
    }
  });
  if (issues.length > 0) {
    return invalid('MALFORMED_ENVELOPE', issues);
  }
  return validateAiStreamSequence(events, path);
}

/** Build the identity echo. */
export function makeStreamStarted(input: {
  readonly contractVersion: string;
  readonly requestId: string;
  readonly capability: string;
  readonly capabilityVersion: string;
}): AiStreamStarted {
  return { kind: 'STARTED', ...input };
}

/** Build a text increment. */
export function makeStreamTextDelta(text: string): AiStreamTextDelta {
  return { kind: 'TEXT_DELTA', text };
}

/** Build the terminal success. */
export function makeStreamCompleted(input: {
  readonly text: string;
  readonly usage: AiUsage;
  readonly finishReason: AiFinishReason;
  readonly providerMetadata: ProviderMetadataProjection;
  readonly latencyMs: number;
  readonly warnings?: readonly AiWarning[];
}): AiStreamCompleted {
  return { kind: 'COMPLETED', text: input.text, usage: input.usage, finishReason: input.finishReason, providerMetadata: input.providerMetadata, latencyMs: input.latencyMs, warnings: input.warnings ?? [] };
}

/** Build the terminal failure. */
export function makeStreamFailed(input: {
  readonly error: AiError;
  readonly usage: AiUsage;
  readonly finishReason: AiFinishReason;
  readonly providerMetadata: ProviderMetadataProjection;
  readonly latencyMs: number;
  readonly warnings?: readonly AiWarning[];
}): AiStreamFailed {
  return { kind: 'FAILED', error: input.error, usage: input.usage, finishReason: input.finishReason, providerMetadata: input.providerMetadata, latencyMs: input.latencyMs, warnings: input.warnings ?? [] };
}
