/**
 * `@aibridge/suite-all` tests (ROADMAP Stage 6).
 *
 * Proves the complete factory table constructs an adapter for every supported preset from a
 * factory spec, and that endpoint resolution honours both endpoint kinds. Construction only —
 * no adapter method is called, so no network is touched.
 */
import { describe, expect, it } from 'vitest';
import { SUITE_ADAPTER_FACTORIES, OPENAI_OFFICIAL_DEFAULT_ENDPOINT, suiteResolveEndpoint } from '@aibridge/suite-all';
import type { AdapterFactorySpec, ProviderConfig } from '@aibridge/runtime';

function spec(preset: AdapterFactorySpec['preset'], providerId: string): AdapterFactorySpec {
  return {
    providerId,
    preset,
    baseUrl: 'https://suite-all.invalid/v1',
    authScheme: 'BEARER',
    wireProtocol: 'OPENAI_CHAT_COMPLETIONS',
    allowPrivateNetworkForDevelopment: false,
    models: [
      {
        alias: `${providerId}.text.primary`,
        providerId,
        providerModelId: `${providerId}-model`,
        profiles: ['balanced'],
        features: ['text', 'structuredJson', 'usage'],
      },
    ],
  };
}

describe('the complete adapter factory table', () => {
  it('constructs an adapter for every supported preset', () => {
    const cases: readonly [Parameters<typeof spec>[0], string][] = [
      ['OPENAI_OFFICIAL', 'openai'],
      ['DEEPSEEK_OFFICIAL', 'deepseek'],
      ['XIAOMI_TOKENPLAN', 'xiaomi'],
      ['OPENAI_COMPATIBLE_CUSTOM', 'relay'],
    ];
    for (const [preset, providerId] of cases) {
      const factory = SUITE_ADAPTER_FACTORIES[preset];
      expect(factory, `factory for ${preset}`).toBeDefined();
      const adapter = factory?.(spec(preset, providerId));
      expect(adapter?.id).toBe(providerId);
      expect(adapter?.descriptor.id).toBe(providerId);
      expect(adapter?.descriptor.models[0]?.modelRef).toBe(`${providerId}-model`);
    }
  });

  it('resolves CUSTOM endpoints verbatim', () => {
    const provider: ProviderConfig = {
      providerId: 'relay',
      preset: 'OPENAI_COMPATIBLE_CUSTOM',
      enabled: true,
      credentialRef: 'secret://test/relay',
      endpoint: { kind: 'CUSTOM', baseUrl: 'https://relay.example.invalid/v1' },
      models: [],
    };
    expect(suiteResolveEndpoint(provider)).toBe('https://relay.example.invalid/v1');
  });

  it('resolves PRESET endpoints per preset and cluster', () => {
    const openai: ProviderConfig = {
      providerId: 'openai',
      preset: 'OPENAI_OFFICIAL',
      enabled: true,
      credentialRef: 'secret://test/openai',
      endpoint: { kind: 'PRESET' },
      models: [],
    };
    expect(suiteResolveEndpoint(openai)).toBe(OPENAI_OFFICIAL_DEFAULT_ENDPOINT);

    const xiaomiSgp: ProviderConfig = {
      providerId: 'xiaomi',
      preset: 'XIAOMI_TOKENPLAN',
      enabled: true,
      credentialRef: 'secret://test/xiaomi',
      endpoint: { kind: 'PRESET', cluster: 'SGP' },
      models: [],
    };
    expect(suiteResolveEndpoint(xiaomiSgp)).toBe('https://token-plan-sgp.xiaomimimo.com/v1');

    const deepseek: ProviderConfig = {
      providerId: 'deepseek',
      preset: 'DEEPSEEK_OFFICIAL',
      enabled: true,
      credentialRef: 'secret://test/deepseek',
      endpoint: { kind: 'PRESET' },
      models: [],
    };
    expect(suiteResolveEndpoint(deepseek)).toBe('https://api.deepseek.com');
  });
});
