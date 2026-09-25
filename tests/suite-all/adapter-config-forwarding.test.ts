/**
 * `@aibridge/suite-all` config-forwarding pin test (V1 stabilization audit, S-2).
 *
 * Every `AdapterFactorySpec` field must land on the built adapter: a new `ProviderConfig`
 * field that the factory table forgets to forward must fail this test, not silently drop an
 * operator override (the S-1 class of bug: `authScheme` parsed, shaped, but never delivered).
 *
 * No network is touched: `globalThis.fetch` is stubbed per test.
 */
import { describe, expect, it, afterEach, vi } from 'vitest';
import { SUITE_ADAPTER_FACTORIES } from '@aibridge/suite-all';
import { semanticIssues } from '@aibridge/runtime';
import type { AdapterFactorySpec } from '@aibridge/runtime';
import type { ProviderRequest } from '@aibridge/contracts';

const SECRET = 'pin-test-secret-value';

function spec(
  preset: AdapterFactorySpec['preset'],
  providerId: string,
  overrides: Partial<AdapterFactorySpec> = {},
): AdapterFactorySpec {
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
    ...overrides,
  };
}

function stubFetch() {
  const calls: Array<{ url: string; init: { headers?: Record<string, string>; body?: string } }> = [];
  const stub = (url: string, init: { headers?: Record<string, string>; body?: string } = {}): Promise<unknown> => {
    calls.push({ url, init });
    return Promise.resolve({
      status: 200,
      ok: true,
      headers: { get: () => 'application/json' },
      text: () =>
        Promise.resolve(
          JSON.stringify({
            choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        ),
      body: null,
    });
  };
  vi.stubGlobal('fetch', stub);
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function build(preset: AdapterFactorySpec['preset'], s: AdapterFactorySpec) {
  const factory = SUITE_ADAPTER_FACTORIES[preset];
  if (factory === undefined) {
    throw new Error(`missing suite factory for ${preset}`);
  }
  return factory(s);
}

function providerRequest(modelRef: string): ProviderRequest {
  return {
    capability: 'ai.text.generate',
    profile: 'balanced',
    instructions: 'Answer with one word.',
    context: [{ name: 'probe', label: 'Probe', untrusted: true, value: 'ping' }],
    modelRef,
    deadlineAtMs: 1_000_000,
  };
}

describe('suite-all forwards every AdapterFactorySpec field', () => {
  it('forwards model limits, profiles and features for every preset', () => {
    const cases = [
      ['OPENAI_OFFICIAL', 'openai'],
      ['DEEPSEEK_OFFICIAL', 'deepseek'],
      ['XIAOMI_TOKENPLAN', 'xiaomi'],
      ['OPENAI_COMPATIBLE_CUSTOM', 'relay'],
    ] as const;
    for (const [preset, providerId] of cases) {
      const adapter = build(
        preset,
        spec(preset, providerId, {
          models: [
            {
              alias: `${providerId}.text.primary`,
              providerId,
              providerModelId: `${providerId}-model`,
              profiles: ['balanced', 'fast'],
              features: ['text', 'usage'],
              contextLimit: 16_384,
              outputLimit: 1_024,
            },
          ],
        }),
      );
      const model = adapter.descriptor.models[0];
      expect(model?.modelRef, `${preset} modelRef`).toBe(`${providerId}-model`);
      expect(model?.maxContextTokens, `${preset} contextLimit`).toBe(16_384);
      expect(model?.maxOutputTokens, `${preset} outputLimit`).toBe(1_024);
      expect(model?.profiles, `${preset} profiles`).toEqual(['balanced', 'fast']);
      expect(model?.features, `${preset} features`).toEqual(['text', 'usage']);
    }
  });

  it('applies default model capacity bounds when configuration declares none', () => {
    const adapter = build('OPENAI_COMPATIBLE_CUSTOM', spec('OPENAI_COMPATIBLE_CUSTOM', 'relay'));
    expect(adapter.descriptor.models[0]?.maxContextTokens).toBe(128_000);
    expect(adapter.descriptor.models[0]?.maxOutputTokens).toBe(8_192);
  });

  it('forwards allowPrivateNetworkForDevelopment for every preset', () => {
    const cases = [
      ['OPENAI_OFFICIAL', 'openai'],
      ['DEEPSEEK_OFFICIAL', 'deepseek'],
      ['XIAOMI_TOKENPLAN', 'xiaomi'],
      ['OPENAI_COMPATIBLE_CUSTOM', 'relay'],
    ] as const;
    for (const [preset, providerId] of cases) {
      // A loopback URL only constructs when the relaxation reaches the adapter.
      const relaxed = build(
        preset,
        spec(preset, providerId, {
          baseUrl: 'https://127.0.0.1/v1',
          allowPrivateNetworkForDevelopment: true,
        }),
      );
      expect(relaxed.id, `${preset} relaxed`).toBe(providerId);
      expect(() =>
        build(
          preset,
          spec(preset, providerId, {
            baseUrl: 'https://127.0.0.1/v1',
            allowPrivateNetworkForDevelopment: false,
          }),
        ),
      ).toThrow();
    }
  });

  it('forwards authScheme to the DeepSeek, Xiaomi and relay adapters', async () => {
    const cases = [
      ['DEEPSEEK_OFFICIAL', 'deepseek'],
      ['XIAOMI_TOKENPLAN', 'xiaomi'],
      ['OPENAI_COMPATIBLE_CUSTOM', 'relay'],
    ] as const;
    for (const [preset, providerId] of cases) {
      for (const authScheme of ['BEARER', 'API_KEY_HEADER'] as const) {
        const calls = stubFetch();
        const adapter = build(preset, spec(preset, providerId, { authScheme }));
        if (typeof adapter.bindCredentials !== 'function') {
          throw new Error(`${preset} adapter cannot bind credentials`);
        }
        adapter.bindCredentials({ handle: `secret://test/${providerId}`, secret: SECRET });
        await adapter.generateText(providerRequest(`${providerId}-model`));
        const headers = calls[0]?.init.headers ?? {};
        if (authScheme === 'BEARER') {
          expect(headers['authorization'], `${preset} bearer`).toBe(`Bearer ${SECRET}`);
          expect(headers['api-key'], `${preset} no api-key`).toBeUndefined();
        } else {
          expect(headers['api-key'], `${preset} api-key`).toBe(SECRET);
          expect(headers['authorization'], `${preset} no bearer`).toBeUndefined();
        }
        vi.unstubAllGlobals();
      }
    }
  });

  it('rejects a non-BEARER authScheme on OPENAI_OFFICIAL instead of dropping it', () => {
    const issues = semanticIssues(
      [
        {
          providerId: 'openai',
          preset: 'OPENAI_OFFICIAL',
          enabled: true,
          credentialRef: 'secret://test/openai',
          authScheme: 'API_KEY_HEADER',
          endpoint: { kind: 'PRESET' },
          models: [],
        },
      ],
      [],
    );
    expect(issues.some((issue) => issue.path.endsWith('.authScheme'))).toBe(true);
  });
});
