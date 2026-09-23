/**
 * The provider conformance kit against **both** adapters (TESTING.md §1.1, layer 3).
 *
 * The same neutral behaviours, injected through two different seams — the scripted queue and the
 * fake HTTP transport — must produce identical behaviour at the AI Bridge boundary. That is what
 * makes "every adapter behaves identically" a checked property.
 */
import { PROVIDER_CONFORMANCE_CASES, ScriptedProviderAdapter, makeProviderRequest, runProviderConformance } from '@aibridge/host-sdk';
import { describe, expect, it } from 'vitest';

import { makeFakeOpenAi } from '../helpers/openai-fake.js';

const syntheticSecret = `sk-${'C'.repeat(32)}`;

/** An adapter that swallows transport failures, to prove the kit can fail. */
class SwallowingAdapter extends ScriptedProviderAdapter {
  override async generateText(): Promise<{ text: string; usage: Record<string, never>; finishReason: 'STOP' }> {
    return { text: 'always fine', usage: {}, finishReason: 'STOP' };
  }
}

describe('provider conformance kit', () => {
  it('passes on the scripted adapter and exposes the documented cases', async () => {
    const adapter = new ScriptedProviderAdapter({ id: 'scripted' });
    const report = await runProviderConformance(adapter, { syntheticSecret });
    expect(report.passed, JSON.stringify(report.findings)).toBe(true);
    expect(report.subject).toBe('provider:scripted');
    expect(report.findings).toHaveLength(PROVIDER_CONFORMANCE_CASES.length);
    expect(PROVIDER_CONFORMANCE_CASES.map((entry) => entry.name)).toEqual([
      'text.happy-path',
      'structured.happy-path',
      'error.surfaces-as-failure',
      'error.mapped-category',
      'usage.shape',
      'finish-reason.closed',
      'stream.round-trip',
      'stream.error-terminal',
      'secret.no-escape',
    ]);
  });

  it('passes unchanged on the reference adapter, driven through fake HTTP', async () => {
    const fake = makeFakeOpenAi({ id: 'fake' });
    const report = await runProviderConformance(fake.target(), { syntheticSecret });
    expect(report.passed, JSON.stringify(report.findings)).toBe(true);
    expect(report.subject).toBe('provider:fake');
  });

  it('fails on an adapter that swallows a transport failure', async () => {
    const report = await runProviderConformance(new SwallowingAdapter({ id: 'swallowing' }));
    expect(report.passed).toBe(false);
    expect(report.findings.find((finding) => finding.case === 'error.surfaces-as-failure')?.ok).toBe(false);
  });

  it('hands the adapter a neutral, vendor-free request shape', () => {
    const request = makeProviderRequest();
    expect(request.capability).toBe('ai.text.generate');
    expect(request.profile).toBe('balanced');
    expect(request.deadlineAtMs).toBe(1_000_000);
    // No vendor names, no endpoint, no credential.
    expect(Object.keys(request).sort()).toEqual(
      ['capability', 'context', 'deadlineAtMs', 'instructions', 'modelRef', 'profile'].sort(),
    );
  });
});
