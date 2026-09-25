/**
 * `@aibridge/suite-all` — the complete adapter factory table (ROADMAP Stage 6).
 *
 * `@aibridge/runtime` deliberately owns no provider, and `@aibridge/host` deliberately imports no
 * provider. A host's trusted bootstrap still needs concrete adapters eventually, and this is the
 * one audited place that happens: a factory per preset plus endpoint resolution per preset. A
 * host that wants a subset passes a filtered table; a host that adds a private gateway uses
 * `OPENAI_COMPATIBLE_CUSTOM` from the same table.
 *
 * Nothing here reads a credential, an environment variable or a file: credential handles flow from
 * configuration through the secret port inside the runtime; endpoints come from the trusted
 * configuration document (`PRESET` kind resolves through this table, `CUSTOM` kind carries its own
 * base URL).
 */
import { DeepSeekAdapter, DEEPSEEK_PRESET } from '@aibridge/provider-deepseek';
import { OpenAiAdapter } from '@aibridge/provider-openai';
import { OpenAiCompatibleAdapter } from '@aibridge/provider-openai-compatible';
import { XIAOMI_TOKEN_PLAN_ENDPOINTS, XiaomiTokenPlanAdapter } from '@aibridge/provider-xiaomi-tokenplan';
import type { AdapterFactories, AdapterFactorySpec, ProviderConfig } from '@aibridge/runtime';

/** The official OpenAI API endpoint used when a `PRESET` endpoint names no custom base URL. */
export const OPENAI_OFFICIAL_DEFAULT_ENDPOINT = 'https://api.openai.com/v1';

/** Resolves a provider endpoint from trusted configuration. `CUSTOM` carries its own base URL. */
export function suiteResolveEndpoint(provider: ProviderConfig): string {
  if (provider.endpoint.kind === 'CUSTOM') {
    return provider.endpoint.baseUrl;
  }
  switch (provider.preset) {
    case 'OPENAI_OFFICIAL':
      return OPENAI_OFFICIAL_DEFAULT_ENDPOINT;
    case 'DEEPSEEK_OFFICIAL':
      return DEEPSEEK_PRESET.defaultBaseUrl;
    case 'XIAOMI_TOKENPLAN':
      return XIAOMI_TOKEN_PLAN_ENDPOINTS[provider.endpoint.cluster ?? 'CN'] ?? XIAOMI_TOKEN_PLAN_ENDPOINTS.CN;
    default:
      // An OPENAI_COMPATIBLE_CUSTOM provider must declare a CUSTOM endpoint; config validation
      // rejects the combination before this table is ever asked.
      throw new Error(`preset ${provider.preset} requires a CUSTOM endpoint`);
  }
}

/** Default model capacity bounds when configuration declares none. */
const DEFAULT_MAX_CONTEXT_TOKENS = 128_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 8_192;

function modelConfigs(spec: AdapterFactorySpec) {
  return spec.models.map((model) => ({
    modelRef: model.providerModelId,
    features: model.features,
    maxContextTokens: model.contextLimit ?? DEFAULT_MAX_CONTEXT_TOKENS,
    maxOutputTokens: model.outputLimit ?? DEFAULT_MAX_OUTPUT_TOKENS,
    ...(model.profiles === undefined ? {} : { profiles: model.profiles }),
  }));
}

/** The complete factory table: every supported preset, wired to its adapter. */
export const SUITE_ADAPTER_FACTORIES: AdapterFactories = {
  OPENAI_OFFICIAL: (spec) =>
    new OpenAiAdapter({
      id: spec.providerId,
      baseUrl: spec.baseUrl,
      models: modelConfigs(spec),
      allowPrivateNetworkForDevelopment: spec.allowPrivateNetworkForDevelopment,
    }),
  DEEPSEEK_OFFICIAL: (spec) =>
    new DeepSeekAdapter({
      id: spec.providerId,
      baseUrl: spec.baseUrl,
      models: modelConfigs(spec),
      authScheme: spec.authScheme,
      allowPrivateNetworkForDevelopment: spec.allowPrivateNetworkForDevelopment,
    }),
  XIAOMI_TOKENPLAN: (spec) =>
    new XiaomiTokenPlanAdapter({
      id: spec.providerId,
      baseUrl: spec.baseUrl,
      models: modelConfigs(spec),
      authScheme: spec.authScheme,
      allowPrivateNetworkForDevelopment: spec.allowPrivateNetworkForDevelopment,
    }),
  OPENAI_COMPATIBLE_CUSTOM: (spec) =>
    new OpenAiCompatibleAdapter({
      id: spec.providerId,
      baseUrl: spec.baseUrl,
      models: modelConfigs(spec),
      // The operator's declared wire facts are forwarded verbatim: a custom gateway's auth scheme
      // and the development-only private-network relaxation are configuration, never URL guesses.
      authScheme: spec.authScheme,
      allowPrivateNetworkForDevelopment: spec.allowPrivateNetworkForDevelopment,
    }),
};
