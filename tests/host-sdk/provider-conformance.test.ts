import { PROVIDER_CONFORMANCE_CASES, ScriptedProviderAdapter, makeProviderRequest, rejectStep, runProviderConformance, textStep } from '@aibridge/host-sdk';
import type { ProviderTextResult } from '@aibridge/contracts';
import { describe, expect, it } from 'vitest';

/** An adapter that swallows transport failures, to prove the kit can fail. */
class SwallowingAdapter extends ScriptedProviderAdapter {
  override async generateText(): Promise<ProviderTextResult> {
    return { text: 'always fine', usage: {}, finishReason: 'STOP' };
  }
}

describe('provider conformance kit', () => {
  it('passes on the scripted adapter — the Stage 2 stand-in for a real adapter', async () => {
    const adapter = new ScriptedProviderAdapter({ id: 'scripted' });
    const report = await runProviderConformance(adapter);
    expect(report.passed, JSON.stringify(report.findings)).toBe(true);
    expect(report.subject).toBe('provider:scripted');
    expect(report.findings).toHaveLength(PROVIDER_CONFORMANCE_CASES.length);
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

  it('exposes the documented case names', () => {
    expect(PROVIDER_CONFORMANCE_CASES.map((entry) => entry.name)).toEqual([
      'text.happy-path',
      'structured.happy-path',
      'error.surfaces-as-failure',
      'usage.shape',
      'finish-reason.closed',
    ]);
    expect(textStep('x').kind).toBe('result');
    expect(rejectStep(new Error('x')).kind).toBe('reject');
  });
});
