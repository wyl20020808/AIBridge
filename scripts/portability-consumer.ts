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
import { AiRuntime, normalizeProviderError, type RuntimeRoutes } from '@aibridge/runtime';
import {
  OpenAiCompatibleAdapter,
  type FetchLike,
  type FetchRequestInitLike,
  type FetchResponseLike,
} from '@aibridge/provider-openai-compatible';

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

  return (
    parsed.ok &&
    envelope.ok &&
    screened.ok &&
    authorization.authorized &&
    hostReport.passed &&
    providerReport.passed &&
    runtime.providerIds.length === 1 &&
    normalized.code === 'PROVIDER_ERROR'
  );
}
