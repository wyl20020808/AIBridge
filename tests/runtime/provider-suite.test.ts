/**
 * Multi-provider configuration (ROADMAP Stage 4 §21–25, §27, §41–44).
 *
 * Model aliases in routes, strict config validation, deterministic profile routing, the
 * no-silent-degrade rule, the deterministic fallback-chain contract, declared-vs-verified
 * qualification and the credential-free diagnostics projection.
 */
import { ScriptedProviderAdapter, TestClock, InMemorySecretStore, textStep } from '@aibridge/host-sdk';
import {
  buildRuntimeRoutes,
  featureStatus,
  materializeProviderSuite,
  nextFallback,
  parseProviderSuiteConfig,
  resolveModelAlias,
  type AdapterFactorySpec,
} from '@aibridge/runtime';
import { makeAiError, parseConsumerAiRequest, type AiProviderAdapter } from '@aibridge/contracts';
import type { ProviderSuiteConfig } from '@aibridge/runtime';
import { describe, expect, it } from 'vitest';

import { unwrap, unwrapFailure } from '../helpers/assertions.js';

const syntheticSecret = `sk-${'S'.repeat(32)}`;

function suiteConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    providers: [
      {
        providerId: 'p1',
        preset: 'OPENAI_COMPATIBLE_CUSTOM',
        enabled: true,
        credentialRef: 'secret://suite/p1',
        endpoint: { kind: 'CUSTOM', baseUrl: 'https://one.example.invalid/v1' },
        models: [
          {
            alias: 'relay.reasoning.primary',
            providerId: 'p1',
            providerModelId: 'VENDOR_MODEL_ONE',
            profiles: ['reasoning', 'balanced', 'high-context'],
            features: ['text', 'structuredJson', 'streaming', 'usage'],
          },
          {
            alias: 'relay.fast.primary',
            providerId: 'p1',
            providerModelId: 'VENDOR_MODEL_TWO',
            profiles: ['fast', 'balanced', 'cheap'],
            features: ['text', 'usage'],
          },
        ],
      },
      {
        providerId: 'p2',
        preset: 'DEEPSEEK_OFFICIAL',
        enabled: true,
        credentialRef: 'secret://suite/p2',
        endpoint: { kind: 'PRESET' },
        models: [
          {
            alias: 'deepseek.reasoning.primary',
            providerId: 'p2',
            providerModelId: 'VENDOR_MODEL_THREE',
            profiles: ['reasoning', 'balanced'],
            features: ['text', 'structuredJson', 'reasoning', 'usage'],
            verifiedFeatures: ['text'],
            contextLimit: 65_536,
            outputLimit: 8_192,
          },
        ],
      },
    ],
    routes: [
      { profile: 'reasoning', chain: ['relay.reasoning.primary', 'deepseek.reasoning.primary'] },
      { profile: 'fast', chain: ['relay.fast.primary'] },
    ],
    ...overrides,
  };
}

describe('config contract — strict validation (Phase 42)', () => {
  function aliasOf(config: ProviderSuiteConfig, alias: string) {
    const resolved = resolveModelAlias(config, alias);
    if (resolved === null) {
      throw new Error(`alias ${alias} did not resolve`);
    }
    return resolved.model;
  }

  it('accepts a well-formed suite and resolves aliases', () => {
    const config = unwrap(parseProviderSuiteConfig(suiteConfig()));
    expect(config.providers).toHaveLength(2);
    expect(resolveModelAlias(config, 'relay.reasoning.primary')?.model.providerModelId).toBe('VENDOR_MODEL_ONE');
    expect(featureStatus(aliasOf(config, 'relay.reasoning.primary'))).toEqual({
      text: 'DECLARED',
      structuredJson: 'DECLARED',
      streaming: 'DECLARED',
      usage: 'DECLARED',
    });
    // verifiedFeatures narrow only what they name; nothing else is ever assumed verified.
    expect(featureStatus(aliasOf(config, 'deepseek.reasoning.primary'))).toEqual({
      text: 'VERIFIED',
      structuredJson: 'DECLARED',
      reasoning: 'DECLARED',
      usage: 'DECLARED',
    });
  });

  it('rejects duplicate providerId and duplicate model alias', () => {
    const dupProvider = suiteConfig();
    (dupProvider['providers'] as Record<string, unknown>[]).push({
      providerId: 'p1',
      preset: 'DEEPSEEK_OFFICIAL',
      enabled: true,
      credentialRef: 'secret://suite/p3',
      endpoint: { kind: 'PRESET' },
      models: [
        {
          alias: 'third.model.primary',
          providerId: 'p1',
          providerModelId: 'VENDOR_MODEL_X',
          profiles: ['balanced'],
          features: ['text'],
        },
      ],
    });
    expect(
      unwrapFailure(parseProviderSuiteConfig(dupProvider)).issues.some((issue) => issue.message.includes('duplicate providerId')),
    ).toBe(true);

    const dupAlias = suiteConfig();
    ((dupAlias['providers'] as Record<string, unknown>[])[1] as { models: Record<string, unknown>[] }).models[0] = {
      alias: 'relay.fast.primary',
      providerId: 'p2',
      providerModelId: 'X',
      profiles: ['fast'],
      features: ['text'],
    };
    expect(
      unwrapFailure(parseProviderSuiteConfig(dupAlias)).issues.some((issue) => issue.message.includes('duplicate model alias')),
    ).toBe(true);
  });

  it('rejects unknown presets, profiles and feature combinations', () => {
    const unknownPreset = suiteConfig();
    ((unknownPreset['providers'] as Record<string, unknown>[])[0] as Record<string, unknown>)['preset'] = 'MYSTERY_VENDOR';
    expect(unwrapFailure(parseProviderSuiteConfig(unknownPreset)).issues.some((i) => i.path.includes('preset'))).toBe(true);

    const unknownProfile = suiteConfig();
    (((unknownProfile['providers'] as Record<string, unknown>[])[0] as { models: Record<string, unknown>[] })
      .models[0] as Record<string, unknown>)['profiles'] = ['telepathic'];
    expect(unwrapFailure(parseProviderSuiteConfig(unknownProfile)).issues.some((i) => i.message.includes('unknown profile'))).toBe(true);

    // Responses protocol on a chat preset is a config error, not a call-time surprise.
    const badProtocol = suiteConfig();
    ((badProtocol['providers'] as Record<string, unknown>[])[0] as Record<string, unknown>)['wireProtocol'] = 'OPENAI_RESPONSES';
    expect(unwrapFailure(parseProviderSuiteConfig(badProtocol)).issues.some((i) => i.message.includes('requires'))).toBe(true);

    // Clusters belong to the Xiaomi preset only.
    const badCluster = suiteConfig();
    ((badCluster['providers'] as Record<string, unknown>[])[0] as Record<string, unknown>)['endpoint'] = {
      kind: 'PRESET',
      cluster: 'CN',
    };
    expect(unwrapFailure(parseProviderSuiteConfig(badCluster)).issues.some((i) => i.message.includes('clusters'))).toBe(true);

    // Verified-but-never-declared is a config error, not a promotion.
    const badVerify = suiteConfig();
    (((badVerify['providers'] as Record<string, unknown>[])[0] as { models: Record<string, unknown>[] })
      .models[0] as Record<string, unknown>)['verifiedFeatures'] = ['vision'];
    expect(unwrapFailure(parseProviderSuiteConfig(badVerify)).issues.some((i) => i.message.includes('never declared'))).toBe(true);
  });

  it('rejects unsafe endpoints and missing or raw credentials', () => {
    const unsafe = suiteConfig();
    ((unsafe['providers'] as Record<string, unknown>[])[0] as Record<string, unknown>)['endpoint'] = {
      kind: 'CUSTOM',
      baseUrl: 'https://169.254.169.254/',
    };
    expect(unwrapFailure(parseProviderSuiteConfig(unsafe)).issues.some((i) => i.message.includes('unsafe endpoint'))).toBe(true);

    const missingRef = suiteConfig();
    delete (missingRef['providers'] as Record<string, unknown>[])[0]?.['credentialRef'];
    expect(unwrapFailure(parseProviderSuiteConfig(missingRef)).issues.some((i) => i.path.includes('credentialRef'))).toBe(true);

    // A raw credential instead of a handle is rejected outright.
    const rawSecret = suiteConfig();
    ((rawSecret['providers'] as Record<string, unknown>[])[0] as Record<string, unknown>)['credentialRef'] = syntheticSecret;
    expect(unwrapFailure(parseProviderSuiteConfig(rawSecret)).issues.some((i) => i.path.includes('credentialRef'))).toBe(true);
  });

  it('rejects negative limits and unknown route aliases', () => {
    const negative = suiteConfig();
    (((negative['providers'] as Record<string, unknown>[])[0] as { models: Record<string, unknown>[] })
      .models[0] as Record<string, unknown>)['contextLimit'] = -5;
    expect(unwrapFailure(parseProviderSuiteConfig(negative)).issues.some((i) => i.message.includes('positive integer'))).toBe(true);

    const unknownAlias = suiteConfig();
    (unknownAlias['routes'] as Record<string, unknown>[])[1] = { profile: 'fast', chain: ['ghost.model.primary'] };
    expect(unwrapFailure(parseProviderSuiteConfig(unknownAlias)).issues.some((i) => i.message.includes('unknown model alias'))).toBe(true);
  });
});

describe('no silent degrade (Phase 24)', () => {
  it('rejects a profile chain containing a model not declared for that profile', () => {
    const degrade = suiteConfig();
    (degrade['routes'] as Record<string, unknown>[])[0] = {
      profile: 'reasoning',
      // relay.fast.primary is a fast model — it must never silently stand in for reasoning.
      chain: ['relay.reasoning.primary', 'relay.fast.primary'],
    };
    const failure = unwrapFailure(parseProviderSuiteConfig(degrade));
    expect(failure.issues.some((issue) => issue.message.includes('no silent degrade'))).toBe(true);
  });
});

describe('model aliases and deterministic profile routing (Phase 22–23)', () => {
  function scriptedFactory(spec: AdapterFactorySpec): AiProviderAdapter {
    const adapter = new ScriptedProviderAdapter({ id: spec.providerId });
    // Test wiring: widen the scripted model table to the configured operator-side model ids so
    // alias resolution and route resolution agree (real factories build this from the spec).
    (adapter.descriptor as { models: unknown }).models = spec.models.map((model) => ({
      providerId: spec.providerId,
      modelRef: model.providerModelId,
      displayName: model.alias,
      features: [...model.features],
      maxContextTokens: model.contextLimit ?? 8_192,
      maxOutputTokens: model.outputLimit ?? 4_096,
      profiles: [...model.profiles],
    }));
    return adapter;
  }

  it('resolves aliases to real model ids only inside the materialized route table', async () => {
    const config = unwrap(parseProviderSuiteConfig(suiteConfig()));
    const routes = buildRuntimeRoutes(config);
    // The route table carries operator-side model ids; the *config* routes carry aliases only.
    expect(routes['reasoning']).toEqual([
      { providerId: 'p1', modelRef: 'VENDOR_MODEL_ONE' },
      { providerId: 'p2', modelRef: 'VENDOR_MODEL_THREE' },
    ]);
    expect(JSON.stringify(config.routes)).not.toContain('VENDOR_MODEL');
  });

  it('routes deterministically to the first hop and never wanders', async () => {
    const config = unwrap(parseProviderSuiteConfig(suiteConfig()));
    const secrets = new InMemorySecretStore();
    secrets.put('secret://suite/p1', syntheticSecret);
    secrets.put('secret://suite/p2', syntheticSecret);
    const suite = unwrap(
      await materializeProviderSuite(config, {
        factories: { OPENAI_COMPATIBLE_CUSTOM: scriptedFactory, DEEPSEEK_OFFICIAL: scriptedFactory },
        secrets,
        clock: new TestClock(0),
        resolveEndpoint: (provider) =>
          provider.endpoint.kind === 'CUSTOM' ? provider.endpoint.baseUrl : 'https://preset.example.invalid/v1',
      }),
    );

    const first = suite.providers[0]?.adapter as ScriptedProviderAdapter;
    const second = suite.providers[1]?.adapter as ScriptedProviderAdapter;
    first.pushText(textStep('from hop one'));
    const result = await suite.runtime.execute(
      {
        contractVersion: '1.0',
        requestId: 'req-suite-1',
        idempotencyKey: 'suite.turn-1',
        capability: 'ai.text.generate',
        capabilityVersion: '1.0',
        profile: 'reasoning',
        input: { instructions: 'Answer.', context: [] },
      },
      { callerPluginId: 'suite.caller', grantedPermissions: ['ai.text.generate'] },
    );
    expect(result.status).toBe('SUCCEEDED');
    expect(first.callCount).toBe(1);
    expect(second.callCount).toBe(0);
  });

  it('lets the consumer choose neither endpoint nor model — only aliases exist, and requests may carry no URL', () => {    // A consumer request carrying a base URL / model id is rejected at the contract boundary.
    const rejected = parseConsumerAiRequest({
      contractVersion: '1.0',
      requestId: 'req-suite-2',
      idempotencyKey: 'suite.turn-2',
      capability: 'ai.text.generate',
      capabilityVersion: '1.0',
      profile: 'fast',
      input: { instructions: 'x', context: [] },
      baseUrl: 'https://attacker.invalid',
    });
    expect(rejected.ok).toBe(false);
  });
});

describe('deterministic fallback boundary (Phase 25)', () => {
  const hopA = { providerId: 'p1', modelRef: 'A' };
  const hopB = { providerId: 'p2', modelRef: 'B' };

  it('falls back only on transient, provider-shaped failures', () => {
    expect(nextFallback([hopA, hopB], makeAiError({ reason: 'PROVIDER_UNAVAILABLE', message: 'x' }))).toEqual({
      kind: 'FALLBACK',
      next: hopB,
      remaining: [],
    });
    expect(nextFallback([hopA, hopB], makeAiError({ reason: 'PROVIDER_TIMEOUT', message: 'x' })).kind).toBe('FALLBACK');
    expect(nextFallback([hopA, hopB], makeAiError({ reason: 'MODEL_UNAVAILABLE', message: 'x' })).kind).toBe('FALLBACK');
    expect(nextFallback([hopA, hopB], makeAiError({ reason: 'PROVIDER_OVERLOADED', message: 'x' })).kind).toBe('FALLBACK');
  });

  it('never falls back on request/content/permission/secret failures', () => {
    for (const reason of [
      'MALFORMED_ENVELOPE',
      'SCHEMA_VALIDATION_FAILED',
      'PROVIDER_CONTENT_FILTER',
      'CALLER_NOT_PERMITTED',
      'INTERNAL_ERROR',
      'CANCELLED_BY_CALLER',
    ] as const) {
      const verdict = nextFallback([hopA, hopB], makeAiError({ reason, message: 'x' }));
      expect(verdict.kind, reason).toBe('STOP');
    }
  });

  it('keeps rate limit and quota opt-in, and reports why the chain stopped', () => {
    const throttled = makeAiError({ reason: 'PROVIDER_THROTTLED', message: 'x' });
    expect(nextFallback([hopA, hopB], throttled)).toEqual({ kind: 'STOP', rule: 'NOT_ELIGIBLE' });
    expect(nextFallback([hopA, hopB], throttled, { fallbackOnRateLimit: true }).kind).toBe('FALLBACK');

    expect(nextFallback([], makeAiError({ reason: 'PROVIDER_UNAVAILABLE', message: 'x' }))).toEqual({
      kind: 'STOP',
      rule: 'CHAIN_EXHAUSTED',
    });
  });
});

describe('safe diagnostics and qualification (Phase 27, §44)', () => {
  it('exposes ids, aliases and assurance — never a credential', async () => {
    const config = unwrap(parseProviderSuiteConfig(suiteConfig()));
    const secrets = new InMemorySecretStore();
    secrets.put('secret://suite/p1', syntheticSecret);
    secrets.put('secret://suite/p2', syntheticSecret);
    const scriptedFactory = (spec: AdapterFactorySpec): AiProviderAdapter =>
      new ScriptedProviderAdapter({ id: spec.providerId });
    const suite = unwrap(
      await materializeProviderSuite(config, {
        factories: { OPENAI_COMPATIBLE_CUSTOM: scriptedFactory, DEEPSEEK_OFFICIAL: scriptedFactory },
        secrets,
        clock: new TestClock(0),
        resolveEndpoint: (provider) =>
          provider.endpoint.kind === 'CUSTOM' ? provider.endpoint.baseUrl : 'https://preset.example.invalid/v1',
      }),
    );

    const diagnostics = suite.diagnostics();
    const serialized = JSON.stringify(diagnostics);
    expect(serialized).not.toContain(syntheticSecret);
    expect(serialized).toContain('secret://suite/p1'); // the handle is fine
    expect(serialized).toContain('relay.reasoning.primary');
    expect(serialized).toContain('DECLARED');
    expect(serialized).toContain('VERIFIED');

    // Qualification evidence is per-feature and additive; nothing is ever auto-verified.
    suite.recordQualification('relay.reasoning.primary', ['text', 'streaming']);
    const after = suite.diagnostics()[0]?.models.find((model) => model.alias === 'relay.reasoning.primary');
    expect(after?.featureStatus['text']).toBe('VERIFIED');
    expect(after?.featureStatus['streaming']).toBe('VERIFIED');
    expect(after?.featureStatus['structuredJson']).toBe('DECLARED');
  });
});
