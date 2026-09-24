/**
 * Bounded retry and output repair in execution (ROADMAP Stage 5 Phase 8–10, 36–38).
 *
 * Backoff runs through the fake clock (`slept` records every delay) — no test here sleeps. The
 * repair contract is the frozen one (§5.3): one bounded repair, same provider and model, a child
 * attempt in the ledger, and never for content, permission, config or cancellation failures.
 */
import { describe, expect, it } from 'vitest';

import {
  callerContext,
  codeDebugCallerContext,
  codeDebugTurn,
  makeHarness,
  script,
  structuredTurn,
  textTurn,
  type FakeStep,
} from '../helpers/reliability.js';

const overloaded: FakeStep = {
  kind: 'rawError',
  rawError: { category: 'OVERLOADED', reason: 'PROVIDER_OVERLOADED', dispatched: true },
};
const throttledWithHint: FakeStep = {
  kind: 'rawError',
  rawError: { category: 'RATE_LIMIT', reason: 'PROVIDER_THROTTLED', dispatched: true, retryAfterMs: 700 },
};
const contentBlocked: FakeStep = {
  kind: 'rawError',
  rawError: { category: 'CONTENT_FILTER', reason: 'PROVIDER_CONTENT_FILTER', dispatched: true },
};

describe('bounded retry in execution (Phase 8–10)', () => {
  it('retries a known transient refusal once, with deterministic backoff on the fake clock', async () => {
    const harness = makeHarness({
      providers: [{ id: 'relay', behavior: script(overloaded, { kind: 'text', text: 'second try works' }) }],
      governance: { retry: { retryKnownNotAccepted: true } },
    });
    const outcome = await harness.runtime.executeObserved(textTurn(1), callerContext);
    expect(outcome.result.status).toBe('SUCCEEDED');
    expect(harness.providers['relay']?.callCount).toBe(2);
    expect(outcome.provenance.retryCount).toBe(1);
    expect(harness.slept).toEqual([250]);
    expect(outcome.result.warnings.map((warning) => warning.code)).toContain('RETRY_USED');
    expect(outcome.result.providerMetadata).toMatchObject({ attemptCount: 2, routeDepth: 0 });
  });

  it('honours a provider-projected Retry-After over the exponential backoff (Phase 10)', async () => {
    const harness = makeHarness({
      providers: [
        {
          id: 'relay',
          behavior: script(
            { kind: 'rawError', rawError: { category: 'OVERLOADED', reason: 'PROVIDER_OVERLOADED', dispatched: true, retryAfterMs: 700 } },
            { kind: 'text', text: 'ok' },
          ),
        },
      ],
      governance: { retry: { retryKnownNotAccepted: true } },
    });
    const outcome = await harness.runtime.executeObserved(textTurn(1), callerContext);
    expect(outcome.result.status).toBe('SUCCEEDED');
    // The provider said "not before 700 ms" and the backoff obeyed it instead of 250 ms.
    expect(harness.slept).toEqual([700]);

    // RATE_LIMITED is never retried in process at all — `retryAfterMs` is the honest answer.
    const limited = makeHarness({
      providers: [{ id: 'relay', behavior: script(throttledWithHint, { kind: 'text', text: 'never' }) }],
      governance: { retry: { retryKnownNotAccepted: true } },
    });
    const refused = await limited.runtime.executeObserved(textTurn(1), callerContext);
    expect(refused.result.error?.reason).toBe('PROVIDER_THROTTLED');
    expect(limited.slept).toEqual([]);
    expect(limited.providers['relay']?.callCount).toBe(1);
  });

  it('gives up after one same-provider retry and then falls back (Phase 9)', async () => {
    const harness = makeHarness({
      providers: [
        { id: 'relay', behavior: script(overloaded, overloaded, { kind: 'text', text: 'never' }) },
        { id: 'openai', behavior: script({ kind: 'text', text: 'fallback serves' }) },
      ],
      governance: { retry: { retryKnownNotAccepted: true } },
    });
    const outcome = await harness.runtime.executeObserved(textTurn(1), callerContext);
    expect(outcome.result.status).toBe('SUCCEEDED');
    expect(outcome.result.output).toEqual({ text: 'fallback serves', finishReason: 'STOP' });
    expect(outcome.provenance.retryCount).toBe(1);
    expect(outcome.provenance.fallbackCount).toBe(1);
    expect(outcome.result.warnings.map((warning) => warning.code)).toEqual(expect.arrayContaining(['RETRY_USED', 'FALLBACK_USED']));
  });

  it('does not repeat an unknown outcome unless the provider really deduplicates (Phase 8)', async () => {
    const unknownOutcome: FakeStep = { kind: 'rawError', rawError: { category: 'UPSTREAM', reason: 'PROVIDER_TIMEOUT' } };
    const unsafe = makeHarness({
      providers: [{ id: 'relay', behavior: script(unknownOutcome, { kind: 'text', text: 'duplicate charge' }) }],
      governance: { retry: { retryUnknownOutcome: true }, fallback: { crossProviderFallbackOnUnknownOutcome: false } },
    });
    const refused = await unsafe.runtime.executeObserved(textTurn(1), callerContext);
    expect(refused.result.status).toBe('FAILED');
    expect(unsafe.providers['relay']?.callCount).toBe(1);

    const safe = makeHarness({
      providers: [{ id: 'relay', behavior: script(unknownOutcome, { kind: 'text', text: 'deduplicated retry' }), supportsReliableIdempotency: true }],
      governance: { retry: { retryUnknownOutcome: true }, fallback: { crossProviderFallbackOnUnknownOutcome: false } },
    });
    const served = await safe.runtime.executeObserved(textTurn(1), callerContext);
    expect(served.result.status).toBe('SUCCEEDED');
    expect(safe.providers['relay']?.callCount).toBe(2);
  });
});

describe('bounded output repair (Phase 36–38)', () => {
  it('repairs a non-conforming payload exactly once, as a child attempt in the ledger', async () => {
    const harness = makeHarness({
      providers: [
        {
          id: 'relay',
          behavior: script(
            { kind: 'structured', text: 'here you go but not json', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
            { kind: 'structured', text: '{"summary":"repaired"}', usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 } },
          ),
        },
      ],
      governance: { outputRepair: 'ONCE' },
    });
    const outcome = await harness.runtime.executeObserved(structuredTurn(1), callerContext);
    expect(outcome.result.status).toBe('SUCCEEDED');
    expect(outcome.result.output).toEqual({ summary: 'repaired' });
    expect(outcome.result.warnings.map((warning) => warning.code)).toContain('OUTPUT_REPAIRED');
    expect(outcome.result.providerMetadata).toMatchObject({ attemptCount: 2, repaired: true });
    expect(outcome.provenance.repairCount).toBe(1);

    // The repair is a child of the attempt it repairs and it is fully charged (Phase 36).
    const attempts = await harness.ledger.attempts(outcome.provenance.logicalRequestId);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toMatchObject({ attemptKind: 'REPAIR', parentAttemptId: attempts[0]?.attemptId });
    expect(outcome.governance.totalUsage.totalTokens).toBe(21);
  });

  it('never hides the extra call: the final result usage is the last attempt, the total is both', async () => {
    const harness = makeHarness({
      providers: [
        {
          id: 'relay',
          behavior: script(
            { kind: 'structured', text: 'garbage', usage: { totalTokens: 15 } },
            { kind: 'structured', text: '{"summary":"ok"}', usage: { totalTokens: 6 } },
          ),
        },
      ],
      governance: { outputRepair: 'ONCE' },
    });
    const outcome = await harness.runtime.executeObserved(structuredTurn(1), callerContext);
    expect(outcome.result.usage.totalTokens).toBe(6);
    expect(outcome.governance.totalUsage.totalTokens).toBe(21);
  });

  it('reports OUTPUT_REPAIR_EXHAUSTED when the repair also fails (frozen §5.3)', async () => {
    const harness = makeHarness({
      providers: [{ id: 'relay', behavior: script({ kind: 'structured', text: 'garbage' }, { kind: 'structured', text: 'still garbage' }) }],
      governance: { outputRepair: 'ONCE' },
    });
    const outcome = await harness.runtime.executeObserved(structuredTurn(1), callerContext);
    expect(outcome.result.status).toBe('FAILED');
    expect(outcome.result.error?.reason).toBe('OUTPUT_REPAIR_EXHAUSTED');
    expect(harness.providers['relay']?.callCount).toBe(2);
  });

  it('does not repair when policy says NONE, and never for content or permission failures', async () => {
    const off = makeHarness({
      providers: [{ id: 'relay', behavior: script({ kind: 'structured', text: 'garbage' }, { kind: 'structured', text: '{"summary":"never"}' }) }],
      governance: { outputRepair: 'NONE' },
    });
    const refused = await off.runtime.executeObserved(structuredTurn(1), callerContext);
    expect(refused.result.error?.reason).toBe('EXTRACTION_FAILED');
    expect(off.providers['relay']?.callCount).toBe(1);

    const blocked = makeHarness({
      providers: [{ id: 'relay', behavior: script(contentBlocked, { kind: 'structured', text: '{"summary":"never"}' }) }],
      governance: { outputRepair: 'ONCE' },
    });
    const content = await blocked.runtime.executeObserved(structuredTurn(2), callerContext);
    expect(content.result.error?.reason).toBe('PROVIDER_CONTENT_FILTER');
    expect(blocked.providers['relay']?.callCount).toBe(1);
  });

  it('reports the original failure when the shared budget is gone before repair (Phase 38)', async () => {
    const harness = makeHarness({
      providers: [
        {
          id: 'relay',
          behavior: (_call, request) => {
            // Burn the whole budget on the first attempt's own deadline clock.
            harness.clock.advance(request.deadlineAtMs);
            return { kind: 'structured', text: 'garbage' };
          },
        },
      ],
      governance: { outputRepair: 'ONCE' },
    });
    const outcome = await harness.runtime.executeObserved(structuredTurn(1, { timeoutBudget: { totalMs: 2_500, providerMs: 1_500 } }), callerContext);
    expect(outcome.result.status).toBe('FAILED');
    // No repair ran, so this is not repair exhaustion — it is the payload failure itself.
    expect(outcome.result.error?.reason).toBe('EXTRACTION_FAILED');
    expect(harness.providers['relay']?.callCount).toBe(1);
    expect(outcome.provenance.repairCount).toBe(0);
  });
});

describe('code.debug.analyze@1.0 output repair', () => {
  it.each([
    ['an unknown issue category', { issueCategories: ['FULL_SOLUTION'], diagnosticContextRefs: ['sourceCode:1'], limitations: [] }],
    ['a reference outside supplied source', { issueCategories: ['SYNTAX'], diagnosticContextRefs: ['sourceCode:2'], limitations: [] }],
  ])('repairs %s through the registered structured primitive', async (_caseName, invalidOutput) => {
    const validOutput = {
      issueCategories: ['SYNTAX'],
      diagnosticContextRefs: ['sourceCode:1'],
      limitations: [],
    };
    const harness = makeHarness({
      providers: [{
        id: 'relay',
        behavior: script(
          { kind: 'structured', text: JSON.stringify(invalidOutput) },
          { kind: 'structured', text: JSON.stringify(validOutput) },
        ),
      }],
      governance: { outputRepair: 'ONCE' },
    });

    const outcome = await harness.runtime.executeObserved(codeDebugTurn(40), codeDebugCallerContext);

    expect(outcome.result.status).toBe('SUCCEEDED');
    expect(outcome.result.output).toEqual(validOutput);
    expect(outcome.provenance.repairCount).toBe(1);
    expect(harness.providers['relay']?.requests.map((request) => request.capability)).toEqual([
      'ai.structured.generate',
      'ai.structured.generate',
    ]);
  });

  it('fails safely when a repaired diagnostic reference is still invalid', async () => {
    const harness = makeHarness({
      providers: [{
        id: 'relay',
        behavior: script(
          { kind: 'structured', text: '{"issueCategories":["FULL_SOLUTION"],"diagnosticContextRefs":["sourceCode:1"],"limitations":[]}' },
          { kind: 'structured', text: '{"issueCategories":["SYNTAX"],"diagnosticContextRefs":["sourceCode:2"],"limitations":[]}' },
        ),
      }],
      governance: { outputRepair: 'ONCE' },
    });

    const outcome = await harness.runtime.executeObserved(codeDebugTurn(41), codeDebugCallerContext);

    expect(outcome.result.status).toBe('FAILED');
    expect(outcome.result.error?.reason).toBe('OUTPUT_REPAIR_EXHAUSTED');
    expect(JSON.stringify(outcome.result)).not.toContain('FULL_SOLUTION');
    expect(harness.providers['relay']?.callCount).toBe(2);
  });
});
