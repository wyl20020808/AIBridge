/**
 * V1 stabilization audit — targeted mutant-kill tests (Phase 44).
 *
 * Each test names the mutant it kills: a single-guard deletion that must turn the suite red.
 * These are public-surface guard-presence tests, not code-coverage theatre — every one of them
 * fails if the corresponding coordinator/governance guard is removed.
 */
import { KillSwitchRegistry } from '@aibridge/core';
import { evaluateStaleness } from '@aibridge/qualification';
import { describe, expect, it } from 'vitest';

import { callerContext, makeHarness, script, textTurn } from '../helpers/reliability.js';
import { testIdentity, testRecord } from '../qualification/helpers.js';

describe('mutants: a dropped kill switch must fail closed', () => {
  it('a global kill refuses the call before any dispatch', async () => {
    const killSwitches = new KillSwitchRegistry();
    killSwitches.setGlobal(true);
    const harness = makeHarness({
      providers: [{ id: 'relay', behavior: script({ kind: 'text', text: 'must never serve' }) }],
      killSwitches,
    });
    const outcome = await harness.runtime.executeObserved(textTurn(1), callerContext);
    expect(outcome.result.status).toBe('FAILED');
    expect(outcome.result.error?.reason).toBe('KILL_SWITCH_GLOBAL');
    expect(harness.providers['relay']?.callCount).toBe(0);
  });
});

describe('mutants: skipped quota settlement must surface as a refusal', () => {
  it('the second call is refused when the first call settled its reservation', async () => {
    const harness = makeHarness({
      providers: [{ id: 'relay', behavior: script({ kind: 'text', text: 'served' }) }],
      governance: { quotas: [{ scope: 'callerPlugin', meter: 'REQUESTS', period: 'DAY', limit: 1 }] },
    });
    const first = await harness.runtime.executeObserved(textTurn(1), callerContext);
    expect(first.result.status).toBe('SUCCEEDED');
    const second = await harness.runtime.executeObserved(textTurn(2), callerContext);
    expect(second.result.status).toBe('FAILED');
    expect(second.result.error?.reason).toBe('QUOTA_CALLER');
    expect(harness.providers['relay']?.callCount).toBe(1);
  });
});

describe('mutants: dropped provenance enforcement must not admit forged identity', () => {
  it('a consumer request carrying callerPluginId is rejected at ingress', async () => {
    const harness = makeHarness({
      providers: [{ id: 'relay', behavior: script({ kind: 'text', text: 'must never serve' }) }],
    });
    const forged = await harness.runtime.executeObserved(
      textTurn(1, { callerPluginId: 'attacker.forged' }),
      callerContext,
    );
    expect(forged.result.status).toBe('FAILED');
    expect(forged.result.error?.reason).toBe('TRUSTED_FIELD_IN_CONSUMER_REQUEST');
    expect(harness.providers['relay']?.callCount).toBe(0);
  });

  it('a context value claiming trusted status is rejected by closed keys', async () => {
    const harness = makeHarness({
      providers: [{ id: 'relay', behavior: script({ kind: 'text', text: 'must never serve' }) }],
    });
    const sneaky = await harness.runtime.executeObserved(
      textTurn(1, {
        input: {
          instructions: 'Classify only evidence in the supplied source.',
          context: [
            {
              name: 'sourceCode',
              label: 'Source code',
              type: 'STRING',
              untrusted: true,
              value: 'const value = 1;',
              trusted: true,
            },
          ],
        },
      }),
      callerContext,
    );
    expect(sneaky.result.status).toBe('FAILED');
    expect(sneaky.result.error?.code).toBe('INVALID_REQUEST');
    expect(harness.providers['relay']?.callCount).toBe(0);
  });
});

describe('mutants: dropped fallback accounting must break the ledger invariant', () => {
  it('every dispatched attempt lands in the ledger, fallback included', async () => {
    const harness = makeHarness({
      providers: [
        {
          id: 'p1',
          behavior: script({ kind: 'rawError', rawError: { category: 'UPSTREAM', reason: 'PROVIDER_UNAVAILABLE', dispatched: true } }),
        },
        { id: 'p2', behavior: script({ kind: 'text', text: 'served by fallback' }) },
      ],
      chains: { balanced: ['p1', 'p2'] },
    });
    const outcome = await harness.runtime.executeObserved(textTurn(1), callerContext);
    expect(outcome.result.status).toBe('SUCCEEDED');
    const attempts = await harness.ledger.attempts(outcome.provenance.logicalRequestId);
    const recorded = attempts.filter((record) => record.status !== 'SKIPPED');
    expect(outcome.governance.attemptCount).toBeGreaterThanOrEqual(2);
    expect(recorded).toHaveLength(outcome.governance.attemptCount);
  });
});

describe('mutants: a bypassed idempotency gate must not cross caller identities', () => {
  it('the same key under a different caller executes fresh, never replays', async () => {
    const harness = makeHarness({
      providers: [{ id: 'relay', behavior: script({ kind: 'text', text: 'served' }) }],
    });
    const first = await harness.runtime.executeObserved(textTurn(1), callerContext);
    expect(first.result.status).toBe('SUCCEEDED');
    const other = {
      callerPluginId: 'other.caller',
      grantedPermissions: ['ai.text.generate', 'ai.structured.generate'],
    };
    const second = await harness.runtime.executeObserved(textTurn(1), other);
    expect(second.result.status).toBe('SUCCEEDED');
    expect(second.result.error).toBeUndefined();
    expect(harness.providers['relay']?.callCount).toBe(2);
  });
});

describe('mutants: leaked provider prose must never reach the consumer', () => {
  it('a thrown vendor error with secret material normalizes to closed vocabulary', async () => {
    const harness = makeHarness({
      providers: [
        {
          id: 'relay',
          behavior: script({
            kind: 'throw',
            error: new Error('vendor prose: 429 slow down this instant; key=sk-live-SECRET123'),
          }),
        },
      ],
    });
    const outcome = await harness.runtime.executeObserved(textTurn(1), callerContext);
    expect(outcome.result.status).toBe('FAILED');
    expect(outcome.result.error?.code).toBe('INTERNAL');
    expect(outcome.result.error?.reason).toBe('INTERNAL_ERROR');
    const serialized = JSON.stringify(outcome.result);
    expect(serialized).not.toContain('slow down');
    expect(serialized).not.toContain('sk-live-SECRET123');
  });
});

describe('mutants: a stale qualification record must never read green', () => {
  it('a record stamped under an older contract evaluates STALE, never qualified', async () => {
    const record = testRecord();
    const verdict = evaluateStaleness(record, {
      identity: testIdentity(),
      adapterVersion: '1.0.0',
      contractVersion: '1.2',
      declaredFeatures: ['text', 'streaming', 'usage'],
    });
    expect(verdict.stale).toBe(true);
    expect(verdict.reasons).toContain('CONTRACT_VERSION_CHANGED');
  });
});
