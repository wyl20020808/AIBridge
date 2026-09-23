/**
 * Atomic configuration reload (ROADMAP Stage 5 Phase 39鈥?3).
 *
 * The rules are sharp on purpose: a candidate that fails **any** validation step leaves the active
 * snapshot untouched, an in-flight request finishes against the snapshot it bound at ingress, and
 * rollback is a snapshot swap 鈥?never a re-parse.
 */
import { ConfigManager, canonicalJson, compileFallbackIssues, parseRuntimeConfig } from '@aibridge/runtime';
import { RecordingOperationalEvents, nullOperationalEventSink } from '@aibridge/governance';
import { TestClock } from '@aibridge/host-sdk';
import { describe, expect, it } from 'vitest';

import { callerContext, makeHarness, textTurn, type FakeStep } from '../helpers/reliability.js';

const served: FakeStep = { kind: 'text', text: 'served' };

function configDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    providers: [
      {
        providerId: 'relay',
        preset: 'OPENAI_COMPATIBLE_CUSTOM',
        enabled: true,
        credentialRef: 'secret://test/relay',
        endpoint: { kind: 'CUSTOM', baseUrl: 'https://api.example.invalid/v1' },
        models: [
          {
            alias: 'relay.text.primary',
            providerId: 'relay',
            providerModelId: 'relay-model',
            profiles: ['balanced'],
            features: ['text', 'structuredJson', 'usage'],
          },
        ],
      },
    ],
    routes: [{ profile: 'balanced', chain: ['relay.text.primary'] }],
    governance: {},
    ...overrides,
  };
}

describe('runtime configuration parsing (Phase 39鈥?1)', () => {
  it('parses a full governance document and rejects unknown fields', () => {
    const parsed = parseRuntimeConfig(
      configDoc({
        governance: {
          fallback: { fallbackOnRateLimit: true },
          retry: { maxSameProviderRetries: 1, baseBackoffMs: 100, maxBackoffMs: 400 },
          breaker: { failureThreshold: 3, windowMs: 10_000, cooldownMs: 5_000, halfOpenProbeLimit: 1 },
          rateLimits: [{ dimension: 'callerPlugin', limit: 5, windowMs: 1_000 }],
          quotas: [{ scope: 'subject', meter: 'TOKENS', period: 'DAY', limit: 10_000 }],
          budget: { maxEstimatedCostPerRequest: 1, currency: 'USD' },
          pricing: [
            {
              pricingId: 'price-1',
              version: '1',
              providerId: 'relay',
              modelAlias: 'relay.text.primary',
              currency: 'USD',
              inputTokenPrice: 1,
              outputTokenPrice: 2,
              unit: 'PER_1K_TOKENS',
              validFromMs: 0,
              source: 'rate card',
            },
          ],
          idempotency: { enabled: true, retentionMs: 60_000 },
          outputRepair: 'ONCE',
          unknownUsage: 'CONSERVATIVE',
          killSwitch: { global: false, providers: [], capabilities: [] },
        },
      }),
    );
    expect(parsed.ok).toBe(true);

    const withTypo = parseRuntimeConfig(configDoc({ governance: { fallbackOnRateLimit: true } }));
    expect(withTypo.ok).toBe(false);
  });

  it('refuses capability degrade: Stage 5 implements `false` only (Phase 5)', () => {
    const parsed = parseRuntimeConfig(configDoc({ governance: { fallback: { allowCapabilityDegrade: true } } }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.failure.issues.some((issue) => issue.path.endsWith('allowCapabilityDegrade'))).toBe(true);
    }
  });

  it('rejects a raw credential 鈥?handles only, never values (Phase 72)', () => {
    const parsed = parseRuntimeConfig(
      configDoc({
        providers: [
          {
            providerId: 'relay',
            preset: 'OPENAI_COMPATIBLE_CUSTOM',
            enabled: true,
            credentialRef: `sk-${'A'.repeat(32)}`,
            endpoint: { kind: 'CUSTOM', baseUrl: 'https://api.example.invalid/v1' },
            models: [
              { alias: 'relay.text.primary', providerId: 'relay', providerModelId: 'relay-model', profiles: ['balanced'], features: ['text'] },
            ],
          },
        ],
      }),
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.failure.issues.some((issue) => issue.path.endsWith('credentialRef'))).toBe(true);
    }
  });

  it('rejects an unsafe endpoint at validation time (SSRF)', () => {
    const parsed = parseRuntimeConfig(
      configDoc({
        providers: [
          {
            providerId: 'relay',
            preset: 'OPENAI_COMPATIBLE_CUSTOM',
            enabled: true,
            credentialRef: 'secret://test/relay',
            endpoint: { kind: 'CUSTOM', baseUrl: 'http://127.0.0.1:8080/v1' },
            models: [
              { alias: 'relay.text.primary', providerId: 'relay', providerModelId: 'relay-model', profiles: ['balanced'], features: ['text'] },
            ],
          },
        ],
      }),
    );
    expect(parsed.ok).toBe(false);
  });

  it('rejects duplicate and impossible fallback targets (Phase 6)', () => {
    const duplicateTarget = ConfigManager.bootstrap(
      {
        providers: [
          {
            providerId: 'relay',
            preset: 'OPENAI_COMPATIBLE_CUSTOM',
            enabled: true,
            credentialRef: 'secret://test/relay',
            endpoint: { kind: 'CUSTOM', baseUrl: 'https://api.example.invalid/v1' },
            models: [
              { alias: 'relay.text.primary', providerId: 'relay', providerModelId: 'relay-model', profiles: ['balanced'], features: ['text'] },
              { alias: 'relay.text.backup', providerId: 'relay', providerModelId: 'relay-model', profiles: ['balanced'], features: ['text'] },
            ],
          },
        ],
        routes: [{ profile: 'balanced', chain: ['relay.text.primary', 'relay.text.backup'] }],
      },
      { clock: new TestClock(0) },
    );
    // Two aliases resolving to one target make the chain a loop — rejected at compile time.
    expect(duplicateTarget.ok).toBe(false);
    expect(
      compileFallbackIssues({
        providers: [],
        routes: [{ profile: 'balanced', chain: ['ghost.model.one', 'ghost.model.two'] }],
      }).some((issue) => issue.code === 'UNKNOWN_FIELD'),
    ).toBe(true);
  });
});

describe('atomic reload and rollback (Phase 41鈥?3)', () => {
  it('swaps atomically on success and keeps the old snapshot on any failure', async () => {
    const clock = new TestClock(0);
    const events = new RecordingOperationalEvents();
    const manager = ConfigManager.bootstrap(configDoc(), { clock, events });
    expect(manager.ok).toBe(true);
    if (!manager.ok) {
      return;
    }
    const configManager = manager.value;
    const first = configManager.active();
    expect(first.configVersion).toBe('cfg-1');

    // A candidate with one broken field fails **as a whole** 鈥?nothing is half-applied.
    const failed = await configManager.reload({ ...configDoc(), governance: { quotas: [{ scope: 'subject', meter: 'TOKENS', period: 'DAY', limit: -1 }] } });
    expect(failed.ok).toBe(false);
    expect(configManager.active()).toBe(first);
    expect(events.ofType('ai.config_reload_failed')).toHaveLength(1);

    const reloaded = await configManager.reload({
      ...configDoc(),
      governance: {
        rateLimits: [{ dimension: 'global', limit: 10, windowMs: 1_000 }],
      },
    });
    expect(reloaded.ok).toBe(true);
    expect(configManager.active().configVersion).toBe('cfg-2');
    expect(configManager.active()).not.toBe(first);
    expect(configManager.active().governance.rateLimits).toHaveLength(1);
    expect(events.ofType('ai.config_reloaded')).toHaveLength(1);

    // Rollback is a snapshot swap back to the previous generation (Phase 43).
    const rolled = await configManager.rollback();
    expect(rolled.ok).toBe(true);
    expect(configManager.active()).toBe(first);
  });

  it('digests content stably and never contains a credential (Phase 40/72)', async () => {
    const clock = new TestClock(0);
    const manager = ConfigManager.bootstrap(configDoc(), { clock, events: nullOperationalEventSink() });
    if (!manager.ok) {
      throw new Error('bootstrap failed');
    }
    const snapshot = manager.value.active();
    expect(snapshot.contentDigest).toMatch(/^dgst-[0-9a-f]{16}$/);
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    const serialized = JSON.stringify(snapshot);
    expect(serialized).toContain('secret://test/relay');
    expect(serialized).not.toContain('sk-');
    expect(serialized).not.toMatch(/Bearer\s+[A-Za-z0-9]/);
  });

  it('binds every request to exactly one snapshot 鈥?a reload never mixes versions (Phase 42)', async () => {
    const clock = new TestClock(0);
    const manager = ConfigManager.bootstrap(configDoc(), { clock, events: nullOperationalEventSink() });
    if (!manager.ok) {
      throw new Error('bootstrap failed');
    }
    const configManager = manager.value;

    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const harness = makeHarness({
      providers: [
        {
          id: 'relay',
          behavior: async () => {
            await gate;
            return served;
          },
        },
      ],
      configManager,
    });

    const inFlight = harness.runtime.executeObserved(textTurn(1), callerContext);
    // Reload while the request is in flight.
    await configManager.reload({
      ...configDoc(),
      governance: { rateLimits: [{ dimension: 'global', limit: 1_000, windowMs: 1_000 }] },
    });
    release?.();
    const outcome = await inFlight;
    expect(outcome.result.status).toBe('SUCCEEDED');
    // The in-flight request reports the snapshot it bound at ingress, not the new one.
    expect(outcome.provenance.configVersion).toBe('cfg-1');

    const next = await harness.runtime.executeObserved(textTurn(2), callerContext);
    expect(next.provenance.configVersion).toBe('cfg-2');
  });
});
