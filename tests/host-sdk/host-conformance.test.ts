import {
  InMemorySecretStore,
  InMemoryUsageStore,
  makeInMemoryHost,
  mutantHosts,
  runHostConformance,
  type HostServices,
} from '@aibridge/host-sdk';
import { describe, expect, it } from 'vitest';

import { syntheticKey } from '../helpers/synthetic.js';

const synthetic = syntheticKey();
const syntheticSecret = { handle: 'secret://test/synthetic', value: synthetic };

/** Reach into the mutant's deliberately-public leak field without widening the port type. */
function leakedMap(host: HostServices): Record<string, string> {
  return (host.secrets as unknown as { leaked: Record<string, string> }).leaked;
}

describe('host conformance kit', () => {
  it('passes on the in-memory host, including the secret-redaction probe', async () => {
    const host = makeInMemoryHost();
    host.secrets.put(syntheticSecret.handle, syntheticSecret.value);
    const report = await runHostConformance(host, { syntheticSecret });
    expect(report.passed, JSON.stringify(report.findings)).toBe(true);
    expect(report.findings.map((finding) => finding.case)).toEqual([
      'identity.null-or-host-bound',
      'permissions.deny-by-default',
      'subject-token.opaque-or-null',
      'secrets.redacted',
      'usage.round-trip',
      'usage.no-content',
      'kill-switch.valid-state',
      'clock.finite',
      'config.loadable',
    ]);
  });

  it('passes without a synthetic secret (serialization probe skipped)', async () => {
    const report = await runHostConformance(makeInMemoryHost());
    expect(report.passed).toBe(true);
  });

  it('fails on every mutant host — a kit that never fails is decoration', async () => {
    for (const mutant of mutantHosts()) {
      if (mutant.name === 'leaky-secret-store') {
        leakedMap(mutant.host)[syntheticSecret.handle] = syntheticSecret.value;
      }
      const report = await runHostConformance(mutant.host, { syntheticSecret });
      expect(report.passed, `mutant "${mutant.name}" must fail`).toBe(false);
      expect(report.findings.some((finding) => !finding.ok), mutant.name).toBe(true);
    }
  });

  it('catches a leaking secret store specifically', async () => {
    const leaky = mutantHosts().find((entry) => entry.name === 'leaky-secret-store');
    expect(leaky).toBeDefined();
    if (leaky === undefined) {
      return;
    }
    leakedMap(leaky.host)[syntheticSecret.handle] = syntheticSecret.value;
    const report = await runHostConformance(leaky.host, { syntheticSecret });
    expect(report.findings.find((finding) => finding.case === 'secrets.redacted')?.ok).toBe(false);
  });
});

describe('in-memory fakes never serialize a secret', () => {
  it('excludes the value from JSON.stringify and String()', () => {
    const store = new InMemorySecretStore();
    store.put('secret://x', synthetic);
    expect(JSON.stringify(store)).not.toContain(synthetic);
    expect(String(store)).not.toContain(synthetic);
    expect(String(store)).toContain('REDACTED');
  });

  it('round-trips a usage record', async () => {
    const store = new InMemoryUsageStore();
    await store.append({
      capability: 'ai.text.generate',
      capabilityVersion: '1.0',
      callerPluginId: 'caller.plugin',
      providerId: 'main',
      modelClass: 'UNKNOWN',
      status: 'SUCCEEDED',
      latencyMs: 1,
      usage: {},
      atMs: 1,
    });
    expect(store.size).toBe(1);
    expect(await store.list()).toHaveLength(1);
  });
});
