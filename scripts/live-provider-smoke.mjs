/**
 * Opt-in **live** provider smoke (ROADMAP Stage 3 §9).
 *
 * Not part of `npm run verify` and not part of any PR CI gate: ordinary CI must never depend on a
 * real provider. Run it explicitly:
 *
 * ```text
 * npm run test:live-provider
 * ```
 *
 * Without credentials it reports `SKIP` and exits 0. With credentials it performs exactly one real
 * round trip — Generic Request → Runtime → Reference Adapter → real provider → Generic Response —
 * and then asserts the credential appears in **no** output surface.
 *
 * Credentials come from the environment only. No key, no base URL with a key in it, and no real
 * model deployment name is committed to this repository (AGENTS.md §3):
 *
 *   AIBRIDGE_LIVE_BASE_URL  e.g. https://api.example.invalid/v1   (an OpenAI-compatible base)
 *   AIBRIDGE_LIVE_API_KEY   the credential (never committed, never logged)
 *   AIBRIDGE_LIVE_MODEL     the operator-side model ref to call
 */
import assert from 'node:assert/strict';

import { AiRuntime } from '@aibridge/runtime';
import { InMemorySecretStore } from '@aibridge/host-sdk';
import { OpenAiCompatibleAdapter } from '@aibridge/provider-openai-compatible';

const baseUrl = process.env['AIBRIDGE_LIVE_BASE_URL'];
const apiKey = process.env['AIBRIDGE_LIVE_API_KEY'];
const model = process.env['AIBRIDGE_LIVE_MODEL'];

function report(line) {
  process.stdout.write(`test:live-provider: ${line}\n`);
}

if (baseUrl === undefined || apiKey === undefined || model === undefined) {
  report('SKIP — set AIBRIDGE_LIVE_BASE_URL, AIBRIDGE_LIVE_API_KEY and AIBRIDGE_LIVE_MODEL to run against a real provider');
  process.exit(0);
}

const credentialHandle = 'secret://aibridge/live/api-key';

function consumerRequest() {
  return {
    contractVersion: '1.0',
    requestId: 'req-live-0001',
    idempotencyKey: 'live.turn-1.attempt-1',
    capability: 'ai.text.generate',
    capabilityVersion: '1.0',
    profile: 'balanced',
    input: {
      instructions: 'Reply with exactly one word: pong.',
      context: [{ name: 'probe', label: 'Probe', type: 'STRING', untrusted: true, value: 'live smoke' }],
    },
  };
}

const trustedContext = {
  callerPluginId: 'aibridge.live-smoke',
  grantedPermissions: ['ai.text.generate'],
};

async function main() {
  const adapter = new OpenAiCompatibleAdapter({
    id: 'live',
    baseUrl,
    models: [
      {
        modelRef: model,
        features: ['text', 'usage'],
        maxContextTokens: 8_192,
        maxOutputTokens: 256,
        profiles: ['balanced'],
      },
    ],
    features: ['text', 'usage'],
  });

  const secrets = new InMemorySecretStore();
  secrets.put(credentialHandle, apiKey);

  const runtime = new AiRuntime({
    providers: [{ adapter, credentialRef: credentialHandle }],
    routes: { balanced: [{ providerId: 'live', modelRef: model }] },
    secrets,
    limits: { serverTimeoutMs: 30_000 },
  });

  report('dispatching one real Generic Request…');
  const result = await runtime.execute(consumerRequest(), {
    ...trustedContext,
    grantedPermissions: ['ai.text.generate'],
  });

  // The whole result is printed; the assertion below is what keeps the key out of it.
  const serialized = JSON.stringify(result, null, 2);
  assert.ok(!serialized.includes(apiKey), 'the credential must not appear in the result');
  assert.ok(!JSON.stringify(runtime).includes(apiKey), 'the credential must not appear in the runtime');
  assert.ok(!JSON.stringify(adapter).includes(apiKey), 'the credential must not appear in the adapter');
  assert.ok(!String(adapter).includes(apiKey), 'the credential must not appear in the adapter string form');

  if (result.status !== 'SUCCEEDED') {
    process.stdout.write(`${serialized}\n`);
    throw new Error(`live smoke failed with ${result.error?.code}/${result.error?.reason}`);
  }

  assert.equal(typeof result.output?.text, 'string');
  assert.ok((result.output?.text ?? '').length > 0, 'the provider answered with text');
  assert.ok(result.usage.totalTokens === undefined || result.usage.totalTokens > 0);
  assert.equal(result.providerMetadata.providerFamily, 'openai-compatible');

  process.stdout.write(`${serialized}\n`);
  report('PASS — one real round trip completed and the credential appeared in no output surface');
}

await main();
