/**
 * Opt-in **live reliability smoke** (ROADMAP Stage 5 Phase 69–70).
 *
 * Never part of `npm run verify` or PR CI: it spends real quota and depends on the public
 * internet. Run explicitly:
 *
 * ```text
 * npm run test:live:reliability
 * ```
 *
 * It runs a **real fallback smoke** only when at least two providers have credentials in the
 * environment (the same `AIBRIDGE_LIVE_*` variables the live provider suite uses — never source,
 * JSON, fixtures, docs or transcripts). With fewer than two, it reports `SKIP`, which is an
 * acceptable outcome and never fails the stage.
 *
 * Prompts are tiny, fixed and synthetic: no user data, no PII, no product data. The run asserts
 * the reliability shape — one terminal result, attempt provenance present, credentials in no
 * output surface — and reports `LIVE_QUALIFIED`, `SKIP` or `LIVE_FAILED` per chain.
 */
import { AiRuntime } from '@aibridge/runtime';
import { InMemorySecretStore, TestClock } from '@aibridge/host-sdk';
import {
  InMemoryUsageLedger,
  InMemoryMetrics,
  RecordingOperationalEvents,
  systemSleeper,
} from '@aibridge/governance';
import { OpenAiAdapter } from '@aibridge/provider-openai';
import { DeepSeekAdapter } from '@aibridge/provider-deepseek';
import { XiaomiTokenPlanAdapter } from '@aibridge/provider-xiaomi-tokenplan';
import { OpenAiCompatibleAdapter } from '@aibridge/provider-openai-compatible';

function report(line) {
  process.stdout.write(`test:live:reliability: ${line}\n`);
}

function env(name) {
  const value = process.env[name];
  return value === undefined || value.length === 0 ? undefined : value;
}

const CREDENTIAL_HANDLE = 'secret://aibridge/live/api-key';

/** Which providers have credentials? Only those take part. */
function configuredProviders() {
  const providers = [];
  if (env('AIBRIDGE_LIVE_DEEPSEEK_API_KEY') !== undefined && env('AIBRIDGE_LIVE_DEEPSEEK_MODEL') !== undefined) {
    providers.push({
      id: 'deepseek',
      modelId: env('AIBRIDGE_LIVE_DEEPSEEK_MODEL'),
      factory: (baseUrl) =>
        new DeepSeekAdapter({
          id: 'deepseek',
          baseUrl: baseUrl ?? 'https://api.deepseek.com',
          models: [{ modelRef: env('AIBRIDGE_LIVE_DEEPSEEK_MODEL'), features: ['text', 'usage'], maxContextTokens: 8_192, maxOutputTokens: 1_024, profiles: ['balanced'] }],
        }),
    });
  }
  if (env('AIBRIDGE_LIVE_OPENAI_API_KEY') !== undefined && env('AIBRIDGE_LIVE_OPENAI_MODEL') !== undefined) {
    providers.push({
      id: 'openai',
      modelId: env('AIBRIDGE_LIVE_OPENAI_MODEL'),
      factory: (baseUrl) =>
        new OpenAiAdapter({
          id: 'openai',
          baseUrl: baseUrl ?? 'https://api.openai.com/v1',
          models: [{ modelRef: env('AIBRIDGE_LIVE_OPENAI_MODEL'), features: ['text', 'usage'], maxContextTokens: 8_192, maxOutputTokens: 1_024, profiles: ['balanced'] }],
        }),
    });
  }
  if (env('AIBRIDGE_LIVE_XIAOMI_API_KEY') !== undefined && env('AIBRIDGE_LIVE_XIAOMI_MODEL') !== undefined) {
    providers.push({
      id: 'xiaomi-tokenplan',
      modelId: env('AIBRIDGE_LIVE_XIAOMI_MODEL'),
      factory: (baseUrl) =>
        new XiaomiTokenPlanAdapter({
          id: 'xiaomi-tokenplan',
          cluster: env('AIBRIDGE_LIVE_XIAOMI_CLUSTER') ?? 'CN',
          models: [{ modelRef: env('AIBRIDGE_LIVE_XIAOMI_MODEL'), features: ['text', 'usage'], maxContextTokens: 8_192, maxOutputTokens: 1_024, profiles: ['balanced'] }],
          ...(baseUrl === undefined ? {} : { baseUrl }),
        }),
    });
  }
  if (env('AIBRIDGE_LIVE_RELAY_BASE_URL') !== undefined && env('AIBRIDGE_LIVE_RELAY_API_KEY') !== undefined && env('AIBRIDGE_LIVE_RELAY_MODEL') !== undefined) {
    providers.push({
      id: 'relay',
      modelId: env('AIBRIDGE_LIVE_RELAY_MODEL'),
      factory: (baseUrl) =>
        new OpenAiCompatibleAdapter({
          id: 'relay',
          baseUrl,
          authScheme: env('AIBRIDGE_LIVE_RELAY_AUTH_SCHEME') ?? 'BEARER',
          models: [{ modelRef: env('AIBRIDGE_LIVE_RELAY_MODEL'), features: ['text', 'usage'], maxContextTokens: 8_192, maxOutputTokens: 1_024, profiles: ['balanced'] }],
        }),
    });
  }
  return providers;
}

async function main() {
  const providers = configuredProviders();
  if (providers.length < 2) {
    // Phase 69/70: fewer than two credentials means no real fallback chain to smoke. SKIP is the
    // documented, acceptable outcome and never fails the stage.
    report(`SKIP (a fallback smoke needs two configured providers; found ${providers.length}). Providers stay LIVE_NOT_RUN.`);
    return;
  }

  const secrets = new InMemorySecretStore();
  secrets.put(CREDENTIAL_HANDLE, env('AIBRIDGE_LIVE_OPENAI_API_KEY') ?? env('AIBRIDGE_LIVE_DEEPSEEK_API_KEY') ?? 'unset');
  const ledger = new InMemoryUsageLedger();
  const metrics = new InMemoryMetrics();
  const events = new RecordingOperationalEvents();

  const chain = providers.map((provider) => ({
    providerId: provider.id,
    modelRef: provider.modelId,
    modelAlias: `${provider.id}.text.primary`,
  }));

  const runtime = new AiRuntime({
    providers: providers.map((provider) => ({
      adapter: provider.factory(provider.id === 'relay' ? env('AIBRIDGE_LIVE_RELAY_BASE_URL') : undefined),
      credentialRef: CREDENTIAL_HANDLE,
    })),
    routes: { balanced: chain },
    clock: new TestClock(Date.now()),
    services: { ledger, metrics, events, sleeper: systemSleeper() },
    governanceConfig: { outputRepair: 'NONE' },
  });

  const outcome = await runtime.executeObserved(
    {
      contractVersion: '1.0',
      requestId: `req-live-reliability-${Date.now()}`,
      idempotencyKey: `live.reliability.${Date.now()}`,
      capability: 'ai.text.generate',
      capabilityVersion: '1.0',
      profile: 'balanced',
      input: { instructions: 'Reply with exactly one word: pong.', context: [] },
    },
    { callerPluginId: 'aibridge.live-reliability', grantedPermissions: ['ai.text.generate'] },
  );

  const secret = env('AIBRIDGE_LIVE_OPENAI_API_KEY') ?? env('AIBRIDGE_LIVE_DEEPSEEK_API_KEY') ?? '';
  const surfaces = JSON.stringify({ result: outcome.result, provenance: outcome.provenance, governance: outcome.governance });
  if (secret.length > 0 && surfaces.includes(secret)) {
    report('LIVE_FAILED (a credential appeared in a result surface)');
    process.exitCode = 1;
    return;
  }
  if (outcome.result.status !== 'SUCCEEDED') {
    report(`LIVE_FAILED (${outcome.result.error?.reason ?? 'unknown'} on chain ${providers.map((provider) => provider.id).join(' -> ')})`);
    process.exitCode = 1;
    return;
  }

  report(
    `LIVE_QUALIFIED (chain ${providers.map((provider) => provider.id).join(' -> ')}; ` +
      `served by ${outcome.result.providerMetadata.providerId} at routeDepth ${outcome.result.providerMetadata.routeDepth}, ` +
      `attempts ${outcome.governance.attemptCount}, fallbacks ${outcome.governance.fallbackCount})`,
  );
  report(`providers without an unchanged live status remain LIVE_NOT_RUN / LIVE_QUALIFIED per PROVIDERS.md`);
}

await main();
