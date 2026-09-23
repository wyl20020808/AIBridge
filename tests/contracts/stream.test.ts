/**
 * Layer 1 — the additive stream contract (ROADMAP Stage 3 §6).
 *
 * Streaming is a delivery concern, not a capability. What is frozen here is the **sequence**:
 * `STARTED → TEXT_DELTA* → (COMPLETED | FAILED)`, exactly one terminal, `COMPLETED.text` equal to
 * the concatenated deltas. Order, finish, usage and error behaviour are deterministic because this
 * validator makes them checkable.
 */
import {
  makeStreamCompleted,
  makeStreamFailed,
  makeStreamStarted,
  makeStreamTextDelta,
  parseAiStreamEvent,
  parseAiStreamEvents,
  validateAiStreamSequence,
  type AiStreamEvent,
} from '@aibridge/contracts';
import { describe, expect, it } from 'vitest';

import { unwrap, unwrapFailure } from '../helpers/assertions.js';

const projection = {
  providerId: 'main',
  providerFamily: 'mock',
  modelClass: 'FAST',
  routeDepth: 0,
  attemptCount: 1,
  repaired: false,
} as const;

const started = makeStreamStarted({
  contractVersion: '1.0',
  requestId: 'req-1',
  capability: 'ai.text.generate',
  capabilityVersion: '1.0',
});

function completed(text: string): AiStreamEvent {
  return makeStreamCompleted({ text, usage: { totalTokens: 3 }, finishReason: 'STOP', providerMetadata: projection, latencyMs: 5 });
}

describe('stream events — shape', () => {
  it('parses each event kind with a closed key set', () => {
    expect(unwrap(parseAiStreamEvent(started)).kind).toBe('STARTED');
    expect(unwrap(parseAiStreamEvent(makeStreamTextDelta('hi')))).toEqual({ kind: 'TEXT_DELTA', text: 'hi' });
    expect(unwrap(parseAiStreamEvent(completed('hi'))).kind).toBe('COMPLETED');

    const failure = unwrapFailure(
      parseAiStreamEvent({ kind: 'TEXT_DELTA', text: 'hi', extra: true }),
    );
    expect(failure.issues.some((issue) => issue.code === 'UNKNOWN_FIELD')).toBe(true);
  });

  it('rejects an empty delta and an unknown kind', () => {
    expect(unwrapFailure(parseAiStreamEvent({ kind: 'TEXT_DELTA', text: '' })).issues[0]?.code).toBe('INVALID_TYPE');
    expect(unwrapFailure(parseAiStreamEvent({ kind: 'TELEMETRY' })).issues[0]?.path).toBe('$.kind');
  });

  it('carries the same closing facts as AiResult on the terminal events', () => {
    const terminal = unwrap(parseAiStreamEvent(completed('answer')));
    if (terminal.kind !== 'COMPLETED') {
      throw new Error('expected COMPLETED');
    }
    expect(terminal.usage).toEqual({ totalTokens: 3 });
    expect(terminal.finishReason).toBe('STOP');
    expect(terminal.providerMetadata).toEqual(projection);
    expect(terminal.latencyMs).toBe(5);
  });
});

describe('stream sequences — deterministic order, finish, usage and error behaviour', () => {
  it('accepts STARTED → deltas → COMPLETED when the text is the concatenation of the deltas', () => {
    const events = [started, makeStreamTextDelta('a'), makeStreamTextDelta('b'), completed('ab')];
    expect(validateAiStreamSequence(events).ok).toBe(true);
  });

  it('accepts a failure terminal after deltas', () => {
    const events: AiStreamEvent[] = [
      started,
      makeStreamTextDelta('partial'),
      makeStreamFailed({
        error: { code: 'CANCELLED', message: 'cancelled', retryable: false, stage: 'CANCELLATION', reason: 'CANCELLED_BY_CALLER' },
        usage: {},
        finishReason: 'UNKNOWN',
        providerMetadata: projection,
        latencyMs: 1,
      }),
    ];
    expect(validateAiStreamSequence(events).ok).toBe(true);
  });

  it('rejects a sequence with no terminal event', () => {
    const failure = unwrapFailure(validateAiStreamSequence([started, makeStreamTextDelta('a')]));
    expect(failure.reason).toBe('MALFORMED_ENVELOPE');
    expect(failure.issues.some((issue) => issue.message.includes('terminal'))).toBe(true);
  });

  it('rejects two terminal events, a late delta and a late STARTED', () => {
    const twoTerminals = unwrapFailure(validateAiStreamSequence([started, completed('a'), completed('a')]));
    expect(twoTerminals.issues.some((issue) => issue.message.includes('exactly one terminal'))).toBe(true);

    const lateDelta = unwrapFailure(validateAiStreamSequence([started, completed(''), makeStreamTextDelta('x')]));
    expect(lateDelta.issues.some((issue) => issue.message.includes('must not follow'))).toBe(true);

    const lateStart = unwrapFailure(validateAiStreamSequence([started, completed('a'), started]));
    expect(lateStart.issues.some((issue) => issue.path === '$[2]')).toBe(true);
  });

  it('rejects a COMPLETED whose text contradicts its own deltas', () => {
    const failure = unwrapFailure(validateAiStreamSequence([started, makeStreamTextDelta('a'), completed('ab')]));
    expect(failure.issues.some((issue) => issue.path.endsWith('.text'))).toBe(true);
  });

  it('round-trips a complete stream document through the parser', () => {
    const events = [started, makeStreamTextDelta('a'), completed('a')];
    const parsed = parseAiStreamEvents(JSON.parse(JSON.stringify(events)));
    expect(unwrap(parsed)).toEqual(events);
  });
});
