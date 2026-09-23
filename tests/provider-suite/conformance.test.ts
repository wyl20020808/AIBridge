/**
 * Provider conformance across the whole suite (ROADMAP Stage 4 §28).
 *
 * The Stage 3 kit runs unchanged against every adapter — the scripted reference and the four real
 * providers (OpenAI Official, DeepSeek Official, Xiaomi Token Plan, generic relay) — through
 * their own injection seams. One suite, five adapters, no exemptions.
 */
import { PROVIDER_CONFORMANCE_CASES, ScriptedProviderAdapter, runProviderConformance } from '@aibridge/host-sdk';
import { describe, expect, it } from 'vitest';

import { MATRIX_PROVIDERS, makeMatrixProvider, type MatrixProviderName } from '../helpers/provider-matrix.js';

describe('provider conformance kit', () => {
  it('still passes on the scripted reference adapter', async () => {
    const report = await runProviderConformance(new ScriptedProviderAdapter({ id: 'scripted' }), {
      syntheticSecret: `sk-${'C'.repeat(32)}`,
    });
    expect(report.passed, JSON.stringify(report.findings)).toBe(true);
    expect(report.findings).toHaveLength(PROVIDER_CONFORMANCE_CASES.length);
  });

  it.each(MATRIX_PROVIDERS)('passes unchanged on %s', async (name: MatrixProviderName) => {
    const provider = await makeMatrixProvider(name);
    const report = await runProviderConformance(
      { adapter: provider.adapter, enqueue: (behavior) => provider.push(behavior) },
      { syntheticSecret: provider.syntheticSecret },
    );
    expect(report.passed, `${name}: ${JSON.stringify(report.findings)}`).toBe(true);
    expect(report.findings).toHaveLength(PROVIDER_CONFORMANCE_CASES.length);
    // …and the conformance run itself never leaked the synthetic credential.
    expect(JSON.stringify(report)).not.toContain(provider.syntheticSecret);
  });
});
