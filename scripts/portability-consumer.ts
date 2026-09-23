/**
 * Portability consumer — the input to `scripts/check-portability.mjs`.
 *
 * It is **not** part of the repo tsconfig: it is copied into an isolated project that installed the
 * packed tarballs, and typechecked there with no workspace, no `paths` aliases and no `src/`. It
 * only needs to compile. If it does, the published contract/runtime surface is consumable.
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

  return parsed.ok && envelope.ok && screened.ok && authorization.authorized && hostReport.passed && providerReport.passed;
}
