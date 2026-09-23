/**
 * Observability (ROADMAP Stage 5 Phase 44–48).
 *
 * Metrics and events must answer operational questions without becoming a data leak: labels are a
 * closed, low-cardinality set, payloads are metadata, and health reports generic failure classes
 * only.
 */
import { describe, expect, it } from 'vitest';

import { callerContext, makeHarness, script, textTurn, type FakeStep } from '../helpers/reliability.js';
import { METRIC_LABEL_KEYS, METRIC_NAMES, OPERATIONAL_EVENT_TYPES } from '@aibridge/governance';

const unavailable: FakeStep = {
  kind: 'rawError',
  rawError: { category: 'UPSTREAM', reason: 'PROVIDER_UNAVAILABLE', dispatched: true, rawMessage: 'upstream said: nope' },
};

describe('metrics and operational events (Phase 44–47)', () => {
  it('records the Phase 44 metric set over the closed label set', async () => {
    const harness = makeHarness({
      providers: [
        { id: 'deepseek', behavior: script(unavailable) },
        { id: 'openai', behavior: script({ kind: 'text', text: 'served', usage: { totalTokens: 5 } }) },
      ],
    });
    await harness.runtime.executeObserved(textTurn(1), callerContext);

    expect(harness.metrics.sum('ai.request.count')).toBe(1);
    expect(harness.metrics.sum('ai.attempt.count')).toBe(2);
    expect(harness.metrics.sum('ai.fallback.count')).toBe(1);
    expect(harness.metrics.sum('ai.request.success.count')).toBe(1);
    expect(harness.metrics.sum('ai.tokens.total')).toBe(5);
    // The label vocabulary is closed and low-cardinality (Phase 45).
    expect([...METRIC_LABEL_KEYS]).not.toContain('requestId');
    expect([...METRIC_LABEL_KEYS]).not.toContain('subjectToken');
    expect([...METRIC_NAMES]).toContain('ai.cost.estimated');
    for (const sample of harness.metrics.totals()) {
      for (const key of Object.keys(sample.labels)) {
        expect(METRIC_LABEL_KEYS as readonly string[]).toContain(key);
      }
    }
  });

  it('emits the operational lifecycle events with metadata-only payloads (Phase 47)', async () => {
    const harness = makeHarness({
      providers: [
        { id: 'deepseek', behavior: script(unavailable) },
        { id: 'openai', behavior: script({ kind: 'text', text: 'served' }) },
      ],
    });
    await harness.runtime.executeObserved(textTurn(1), callerContext);

    for (const type of ['ai.request_started', 'ai.provider_attempt_started', 'ai.provider_attempt_finished', 'ai.fallback_applied', 'ai.request_finished'] as const) {
      expect(harness.events.ofType(type).length, type).toBeGreaterThan(0);
    }
    // Every payload is metadata: strings, finite numbers and booleans — never content.
    for (const event of harness.events.events) {
      for (const value of Object.values(event.payload)) {
        expect(['string', 'number', 'boolean']).toContain(typeof value);
      }
    }
    const serialized = JSON.stringify(harness.events.events);
    expect(serialized).not.toContain('upstream said');
    expect(serialized).not.toContain('Summarise.');
  });

  it('counts rate refusals, quota refusals and breaker openings', async () => {
    const limited = makeHarness({
      providers: [{ id: 'relay', behavior: script({ kind: 'text', text: 'ok' }) }],
      governance: { rateLimits: [{ dimension: 'global', limit: 1, windowMs: 60_000 }] },
    });
    await limited.runtime.executeObserved(textTurn(1), callerContext);
    await limited.runtime.executeObserved(textTurn(2), callerContext);
    expect(limited.metrics.sum('ai.rate_limited.count')).toBe(1);
    expect(limited.events.ofType('ai.rate_limited')).toHaveLength(1);

    const quotaBound = makeHarness({
      providers: [{ id: 'relay', behavior: script({ kind: 'text', text: 'ok' }) }],
      governance: { quotas: [{ scope: 'global', meter: 'REQUESTS', period: 'DAY', limit: 1 }] },
    });
    await quotaBound.runtime.executeObserved(textTurn(1), callerContext);
    await quotaBound.runtime.executeObserved(textTurn(2), callerContext);
    expect(quotaBound.metrics.sum('ai.quota_rejected.count')).toBe(1);
    expect(quotaBound.events.ofType('ai.quota_rejected')).toHaveLength(1);

    const breaking = makeHarness({
      providers: [{ id: 'relay', behavior: script(unavailable, unavailable) }],
      governance: { breaker: { failureThreshold: 1 }, retry: { maxSameProviderRetries: 0 } },
    });
    await breaking.runtime.executeObserved(textTurn(1), callerContext);
    expect(breaking.metrics.sum('ai.breaker_open.count')).toBe(1);
    expect(breaking.events.ofType('ai.breaker_opened')).toHaveLength(1);
  });

  it('emits retry events and counts (Phase 57)', async () => {
    const harness = makeHarness({
      providers: [
        {
          id: 'relay',
          behavior: script(
            { kind: 'rawError', rawError: { category: 'OVERLOADED', reason: 'PROVIDER_OVERLOADED', dispatched: true } },
            { kind: 'text', text: 'ok' },
          ),
        },
      ],
      governance: { retry: { retryKnownNotAccepted: true } },
    });
    const outcome = await harness.runtime.executeObserved(textTurn(1), callerContext);
    expect(outcome.result.status).toBe('SUCCEEDED');
    expect(harness.events.ofType('ai.retry_applied')).toHaveLength(1);
    expect(harness.metrics.sum('ai.retry.count')).toBe(1);
    expect(outcome.result.warnings.map((warning) => warning.code)).toContain('RETRY_USED');
  });

  it('exposes safe per-target health diagnostics (Phase 48)', async () => {
    const harness = makeHarness({
      providers: [
        { id: 'deepseek', behavior: script(unavailable) },
        { id: 'openai', behavior: script({ kind: 'text', text: 'served' }) },
      ],
    });
    await harness.runtime.executeObserved(textTurn(1), callerContext);
    const reports = harness.runtime.getProviderHealth();
    expect(reports.length).toBeGreaterThan(0);
    const report = reports.find((entry) => entry.providerId === 'deepseek');
    expect(report?.recentFailureClasses['PROVIDER_TRANSIENT']).toBe(1);
    expect(report?.lastFailureAtMs).toBeGreaterThanOrEqual(0);
    // Capability and health stay different facts (Phase 16).
    expect(JSON.stringify(reports)).not.toContain('rawMessage');
    expect(JSON.stringify(reports)).not.toContain('message');
  });

  it('keeps the operational event vocabulary closed', () => {
    expect([...OPERATIONAL_EVENT_TYPES]).toContain('ai.config_reloaded');
    expect([...OPERATIONAL_EVENT_TYPES]).toContain('ai.config_reload_failed');
  });
});
