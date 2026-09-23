/**
 * Portability consumer — the input to `scripts/check-portability.mjs`.
 *
 * It is **not** part of the repo tsconfig: it is copied into an isolated project that installed the
 * packed tarballs, and typechecked there with no workspace, no `paths` aliases, no `src/` and
 * deliberately no `node` types. It only needs to compile. If it does, the published
 * contract/runtime surface is consumable — including the Stage 3 runtime and reference adapter,
 * whose exported signatures are self-declared precisely so this holds.
 */
import {
  parseAiRequestEnvelope,
  parseConsumerAiRequest,
  type ConsumerAiRequest,
  type ValidationResult,
} from '@aibridge/contracts';
import { authorizeCapabilityCall, screenAiInput } from '@aibridge/core';
import {
  ScriptedProviderAdapter,
  makeInMemoryHost,
  runHostConformance,
  runProviderConformance,
} from '@aibridge/host-sdk';
import {
  AiRuntime,
  ConfigManager,
  normalizeProviderError,
  parseProviderSuiteConfig,
  materializeProviderSuite,
  type RuntimeRoutes,
} from '@aibridge/runtime';
import {
  CircuitBreakerRegistry,
  IdempotencyRegistry,
  InMemoryIdempotencyStore,
  InMemoryMetrics,
  InMemoryQuotaStore,
  InMemoryRateLimitStore,
  InMemoryUsageLedger,
  PricingTable,
  QuotaManager,
  RateLimiter,
  RuntimeHealthRegistry,
  estimateCost,
  type PricingRecord,
  type QuotaPolicy,
  type RateLimitPolicy,
  type ReliabilityProvenance,
} from '@aibridge/governance';
import {
  OpenAiCompatibleAdapter,
  type FetchLike,
  type FetchRequestInitLike,
  type FetchResponseLike,
} from '@aibridge/provider-openai-compatible';
import { OpenAiAdapter } from '@aibridge/provider-openai';
import { DeepSeekAdapter, DEEPSEEK_PRESET } from '@aibridge/provider-deepseek';
import { XiaomiTokenPlanAdapter, XIAOMI_TOKEN_PLAN_CLUSTERS } from '@aibridge/provider-xiaomi-tokenplan';

export async function portabilityCheck(): Promise<boolean> {
  const request: ConsumerAiRequest = {
    contractVersion: '1.0',
    requestId: 'req-portability-0001',
    idempotencyKey: 'portability.turn-1.attempt-1',
    capability: 'ai.structured.generate',
    capabilityVersion: '1.0',
    profile: 'balanced',
    input: { instructions: 'hello', context: [] },
  };

  const parsed: ValidationResult<ConsumerAiRequest> = parseConsumerAiRequest(request);
  const envelope = parseAiRequestEnvelope(request);
  const screened = screenAiInput(request.input);
  const authorization = authorizeCapabilityCall(1, 0);

  const hostReport = await runHostConformance(makeInMemoryHost());
  const providerReport = await runProviderConformance(new ScriptedProviderAdapter({ id: 'portability' }));

  // The Stage 3 surface: the runtime, the reference adapter and its self-declared transport seam.
  const routes: RuntimeRoutes = { balanced: [{ providerId: 'main', modelRef: 'portability-model' }] };
  const runtime = new AiRuntime({ routes });
  const fetchLike: FetchLike = (_url: string, _init: FetchRequestInitLike): Promise<FetchResponseLike> =>
    Promise.resolve({
      status: 200,
      ok: true,
      headers: { get: () => null },
      text: () => Promise.resolve('{"choices":[]}'),
    });
  const adapter = new OpenAiCompatibleAdapter({
    id: 'main',
    baseUrl: 'https://api.example.invalid/v1',
    fetch: fetchLike,
    models: [
      {
        modelRef: 'portability-model',
        features: ['text', 'structuredJson', 'streaming', 'usage'],
        maxContextTokens: 8_192,
        maxOutputTokens: 4_096,
      },
    ],
  });
  await runtime.registerProvider({ adapter });
  const normalized = normalizeProviderError({ category: 'AUTH' });

  // The Stage 4 surface: four provider families, the preset vocabulary and the config contract.
  const suiteConfig = parseProviderSuiteConfig({
    providers: [
      {
        providerId: 'relay',
        preset: 'OPENAI_COMPATIBLE_CUSTOM',
        enabled: true,
        credentialRef: 'secret://portability/relay',
        endpoint: { kind: 'CUSTOM', baseUrl: 'https://api.example.invalid/v1' },
        models: [
          {
            alias: 'relay.text.primary',
            providerId: 'relay',
            providerModelId: 'portability-model',
            profiles: ['balanced'],
            features: ['text', 'structuredJson', 'streaming', 'usage'],
          },
        ],
      },
    ],
    routes: [{ profile: 'balanced', chain: ['relay.text.primary'] }],
  });
  const openai = new OpenAiAdapter({
    id: 'openai',
    baseUrl: 'https://api.example.invalid/v1',
    fetch: fetchLike,
    models: [{ modelRef: 'portability-model', features: ['text'], maxContextTokens: 8, maxOutputTokens: 8 }],
  });
  const deepseek = new DeepSeekAdapter({
    id: 'deepseek',
    baseUrl: DEEPSEEK_PRESET.defaultBaseUrl,
    fetch: fetchLike,
    models: [{ modelRef: 'portability-model', features: ['text'], maxContextTokens: 8, maxOutputTokens: 8 }],
  });
  const xiaomi = new XiaomiTokenPlanAdapter({
    id: 'xiaomi',
    cluster: XIAOMI_TOKEN_PLAN_CLUSTERS[0],
    fetch: fetchLike,
    models: [{ modelRef: 'portability-model', features: ['text'], maxContextTokens: 8, maxOutputTokens: 8 }],
  });
  void materializeProviderSuite;

  // The Stage 5 surface: reliability and governance primitives, all portable and clock-driven.
  const governanceClock = { nowMs: () => 0 };
  const pricing: PricingRecord = {
    pricingId: 'price-portability-1',
    version: '1',
    providerId: 'relay',
    currency: 'USD',
    inputTokenPrice: 1,
    outputTokenPrice: 2,
    unit: 'PER_1K_TOKENS',
    validFromMs: 0,
    source: 'portability rate card',
  };
  const pricingTable = new PricingTable([pricing]);
  const cost = estimateCost({ inputTokens: 10, outputTokens: 5 }, pricingTable.snapshotFor('relay', {}, 0));
  const quotas = new QuotaManager({
    store: new InMemoryQuotaStore(),
    clock: governanceClock,
    policies: [{ scope: 'global', meter: 'TOKENS', period: 'DAY', limit: 1_000 } satisfies QuotaPolicy],
  });
  const limiter = new RateLimiter({
    store: new InMemoryRateLimitStore(),
    clock: governanceClock,
    policies: [{ dimension: 'global', limit: 5, windowMs: 1_000 } satisfies RateLimitPolicy],
  });
  const idempotency = new IdempotencyRegistry({ store: new InMemoryIdempotencyStore({ clock: governanceClock }), clock: governanceClock });
  const breakers = new CircuitBreakerRegistry({ clock: governanceClock });
  const health = new RuntimeHealthRegistry({ clock: governanceClock, breakers });
  void new InMemoryUsageLedger();
  void new InMemoryMetrics();
  const provenanceShape: ReliabilityProvenance | null = null;
  void provenanceShape;
  const configManager = ConfigManager.bootstrap(
    {
      providers: suiteConfig.ok ? suiteConfig.value.providers : [],
      routes: [{ profile: 'balanced', chain: ['relay.text.primary'] }],
    },
    { clock: governanceClock },
  );
  void idempotency;
  void limiter;
  void quotas;
  void health;

  return (
    parsed.ok &&
    envelope.ok &&
    screened.ok &&
    authorization.authorized &&
    hostReport.passed &&
    providerReport.passed &&
    runtime.providerIds.length === 1 &&
    normalized.code === 'PROVIDER_ERROR' &&
    suiteConfig.ok &&
    openai.adapterApiVersion === 1 &&
    deepseek.family === 'openai-compatible' &&
    xiaomi.credentialShape === null &&
    cost.basis === 'ESTIMATED_FROM_PRICING' &&
    breakers.for('relay', 'relay.text.primary').state === 'CLOSED' &&
    configManager.ok
  );
}
