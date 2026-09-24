/**
 * Opt-in **provider live-qualification runner** (Stage 8, Phases 27–29, 40, 56).
 *
 * This is the Stage 8 replacement for ad-hoc live smokes: it drives the same adapters as
 * `scripts/live-provider-suite.mjs`, but produces durable, safe `ProviderQualificationRecord`s via
 * `@aibridge/qualification` instead of only printing a pass/fail line.
 *
 * It is **never** part of `npm run verify` or PR CI: live calls need secrets, spend quota and depend
 * on the public internet. Run explicitly:
 *
 * ```text
 * npm run qualify:providers           # every provider that has credentials; others LIVE_NOT_RUN
 * npm run qualify:openai
 * npm run qualify:deepseek
 * npm run qualify:xiaomi
 * npm run qualify:relay
 * ```
 *
 * Credentials come from the **environment only** (Phase 9) — never from source, JSON, fixtures, docs,
 * tracked .env files or command transcripts. A missing credential is `LIVE_NOT_RUN`, never a failure
 * (Phases 9, 43). Output is **safe** (Phase 29): provider id, model alias, feature, status, latency,
 * a usage summary and a coarse failure class. Never a credential, Authorization header, prompt text,
 * full response text or reasoning content.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AiRuntime,
  defaultCapabilityRegistry,
} from '@aibridge/runtime';
import { InMemorySecretStore } from '@aibridge/host-sdk';
import {
  ProviderQualificationRunner,
  classifyQualificationFailure,
  configDigest,
  providerModelSafeRef,
  safeEndpointIdentity,
  serializeQualificationDocument,
} from '@aibridge/qualification';
import { AIBRIDGE_CONTRACT_VERSION } from '@aibridge/contracts';
import { OpenAiAdapter } from '@aibridge/provider-openai';
import { DeepSeekAdapter } from '@aibridge/provider-deepseek';
import { XiaomiTokenPlanAdapter } from '@aibridge/provider-xiaomi-tokenplan';
import { OpenAiCompatibleAdapter } from '@aibridge/provider-openai-compatible';

const root = fileURLToPath(new URL('..', import.meta.url));
const MODEL_ALIAS = 'live.primary';
const CREDENTIAL_HANDLE = 'secret://aibridge/live/api-key';
const ADAPTER_VERSION = '1.0.0';
const CONTRACT_VERSION = AIBRIDGE_CONTRACT_VERSION;

const only = process.argv[2] ?? 'all';

function report(line) {
  process.stdout.write(`qualify: ${line}\n`);
}

function env(name) {
  const value = process.env[name];
  return value === undefined || value.length === 0 ? undefined : value;
}

/** The tiniest synthetic prompts (Phase 8): fixed strings, no data, no PII. */
const PROMPTS = {
  text: { instructions: 'Reply with exactly one word: pong.', context: [] },
  structured: {
    instructions: 'Return exactly one JSON object with one field "summary" whose value is "pong".',
    context: [],
  },
  stream: { instructions: 'Reply with the two words: pong pong.', context: [] },
};

function consumerRequest(capability, input, outputSchema) {
  return {
    contractVersion: '1.0',
    requestId: `req-qualify-${capability.replace(/\./g, '-')}`,
    idempotencyKey: `qualify.${capability}.${Date.now()}`,
    capability,
    capabilityVersion: '1.0',
    profile: 'balanced',
    input,
    ...(outputSchema === undefined ? {} : { outputSchema }),
  };
}

const trustedContext = {
  callerPluginId: 'aibridge.qualify',
  grantedPermissions: ['ai.text.generate', 'ai.structured.generate'],
};

function assertNoLeak(label, secret, surfaces) {
  for (const surface of surfaces) {
    if ((surface ?? '').includes(secret)) {
      throw new Error(`LEAK — the credential appeared in ${label}`);
    }
  }
}

/** Map a normalized failure to a coarse, safe classification (Phase 44). */
function classifyError(error) {
  // Auth and balance failures are operator configuration ("replace the credential / top up the
  // account"), never provider instability: route them through the shipped classifier so a live
  // run agrees with `classifyQualificationFailure` instead of reporting PROVIDER_FAILURE.
  const reason = error?.reason ?? '';
  if (reason === 'PROVIDER_AUTH_FAILED') return classifyQualificationFailure({ kind: 'auth' });
  if (reason === 'PROVIDER_BALANCE_EXHAUSTED') return classifyQualificationFailure({ kind: 'balance' });
  const code = error?.code ?? 'PROVIDER_ERROR';
  if (code === 'UNAVAILABLE') return 'NETWORK_ENVIRONMENT';
  if (code === 'RATE_LIMITED' || code === 'QUOTA_EXCEEDED') return 'PROVIDER_FAILURE';
  if (code === 'TIMEOUT') return 'PROVIDER_FAILURE';
  if (code === 'INVALID_RESPONSE' || code === 'SCHEMA_MISMATCH') return 'ADAPTER_BUG';
  if (code === 'INVALID_REQUEST' || code === 'MODEL_UNAVAILABLE') return 'CONFIG_FAILURE';
  return 'PROVIDER_FAILURE';
}

/**
 * Build a per-feature probe bound to one adapter. The runner orchestrates; this closure owns the
 * provider-specific dispatch through `AiRuntime`.
 */
function makeProbe(runtime, adapter, secret) {
  return async (feature) => {
    const started = Date.now();
    try {
      if (feature === 'streaming') {
        const events = [];
        for await (const event of runtime.stream(consumerRequest('ai.text.generate', PROMPTS.stream), trustedContext)) {
          events.push(event);
        }
        assertNoLeak('the stream events', secret, [JSON.stringify(events)]);
        const terminal = events[events.length - 1];
        if (terminal?.kind !== 'COMPLETED') {
          return {
            ok: false,
            reason: 'ADAPTER_BUG',
            latencyMs: Date.now() - started,
            status: 'LIVE_FAILED',
          };
        }
        return { ok: true, latencyMs: Date.now() - started, finishReason: 'STOP' };
      }

      const capability = feature === 'structuredJson' || feature === 'jsonSchema'
        ? 'ai.structured.generate'
        : 'ai.text.generate';
      const input = feature === 'structuredJson' || feature === 'jsonSchema' ? PROMPTS.structured : PROMPTS.text;
      const schema = capability === 'ai.structured.generate'
        ? {
            kind: 'INLINE',
            schemaId: 'live.summary',
            version: '1.0',
            dialect: 'aibridge.fields/v1',
            fields: [{ name: 'summary', type: 'STRING', required: true, description: 'One word.' }],
          }
        : undefined;
      const request = { ...consumerRequest(capability, input, schema), profile: feature === 'reasoning' ? 'reasoning' : 'balanced' };
      const result = await runtime.execute(request, trustedContext);
      assertNoLeak('the result', secret, [JSON.stringify(result), JSON.stringify(adapter), String(adapter)]);
      if (result.status !== 'SUCCEEDED') {
        return {
          ok: false,
          reason: classifyError(result.error),
          latencyMs: Date.now() - started,
          status: 'LIVE_FAILED',
        };
      }
      if (feature === 'reasoning' && JSON.stringify(result.output).toLowerCase().includes('reasoning_content')) {
        return { ok: false, reason: 'ADAPTER_BUG', latencyMs: Date.now() - started, status: 'LIVE_FAILED' };
      }
      const usage = result.usage ?? {};
      const projection = {
        ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
        ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
        ...(usage.totalTokens === undefined ? {} : { totalTokens: usage.totalTokens }),
        ...(usage.cachedTokens === undefined ? {} : { cachedTokens: usage.cachedTokens }),
        ...(usage.reasoningTokens === undefined ? {} : { reasoningTokens: usage.reasoningTokens }),
      };
      return {
        ok: true,
        latencyMs: Date.now() - started,
        ...(Object.keys(projection).length === 0 ? {} : { usageProjection: projection }),
        ...(result.finishReason === undefined ? {} : { finishReason: result.finishReason }),
        ...(result.attemptCount > 1 ? { notes: ['REPAIR_USED'] } : {}),
      };
    } catch (error) {
      return {
        ok: false,
        reason: error?.rawError === undefined ? 'ADAPTER_BUG' : classifyError(error.rawError),
        latencyMs: Date.now() - started,
        status: 'LIVE_FAILED',
      };
    }
  };
}

/**
 * Qualify one provider: build the runtime, derive the identity from the real adapter surface, and
 * run every declared-and-implemented feature through the unified runner.
 */
async function qualifyProvider(entry) {
  const secrets = new InMemorySecretStore();
  secrets.put(CREDENTIAL_HANDLE, entry.secret);
  const model = entry.adapter.descriptor.models[0];
  const features = model?.features ?? [];
  const endpoint = safeEndpointIdentity(entry.baseUrl);
  const modelRef = providerModelSafeRef(model?.modelRef ?? MODEL_ALIAS);

  const runtime = new AiRuntime({
    capabilities: defaultCapabilityRegistry(),
    providers: [{ adapter: entry.adapter, credentialRef: CREDENTIAL_HANDLE }],
    secrets,
    routes: {
      balanced: [{ providerId: entry.adapter.id, modelRef: model?.modelRef ?? MODEL_ALIAS }],
      reasoning: [{ providerId: entry.adapter.id, modelRef: model?.modelRef ?? MODEL_ALIAS }],
    },
    limits: { serverTimeoutMs: 60_000 },
  });

  // Feature-by-feature qualification (§3): text always; structured/streaming/reasoning only when the
  // model declares them; usage rides on the text call (Phase 20).
  const requested = ['text'];
  if (features.includes('structuredJson') || features.includes('jsonSchema')) requested.push('structuredJson');
  if (features.includes('streaming')) requested.push('streaming');
  if (features.includes('reasoning') && (model?.profiles ?? []).includes('reasoning')) requested.push('reasoning');
  requested.push('usage');

  const identity = {
    providerId: entry.adapter.id,
    providerFamily: entry.family,
    endpointKind: entry.endpointKind,
    ...(entry.cluster === undefined ? {} : { cluster: entry.cluster }),
    endpoint,
    modelAlias: MODEL_ALIAS,
    providerModelSafeRef: modelRef,
    feature: 'text',
    adapterVersion: ADAPTER_VERSION,
    contractVersion: CONTRACT_VERSION,
    configDigest: configDigest({
      preset: entry.preset,
      endpointKind: entry.endpointKind,
      ...(entry.cluster === undefined ? {} : { cluster: entry.cluster }),
      endpoint,
      providerModelSafeRef: modelRef,
      declaredFeatures: [...features],
      ...(entry.authScheme === undefined ? {} : { authScheme: entry.authScheme }),
      ...(entry.wireProtocol === undefined ? {} : { wireProtocol: entry.wireProtocol }),
    }),
  };

  const runner = new ProviderQualificationRunner();
  const records = await runner.run({
    identity,
    adapterVersion: ADAPTER_VERSION,
    contractVersion: CONTRACT_VERSION,
    features: requested,
    evidenceClass: 'LIVE',
    credentialAvailable: true,
    probe: makeProbe(runtime, entry.adapter, entry.secret),
  });

  return records;
}

const builders = {
  openai: () => {
    const key = env('AIBRIDGE_LIVE_OPENAI_API_KEY');
    const model = env('AIBRIDGE_LIVE_OPENAI_MODEL');
    if (key === undefined || model === undefined) return null;
    const baseUrl = env('AIBRIDGE_LIVE_OPENAI_BASE_URL') ?? 'https://api.openai.com/v1';
    return {
      secret: key,
      baseUrl,
      preset: 'OPENAI_OFFICIAL',
      family: 'openai',
      endpointKind: 'PRESET',
      authScheme: 'BEARER',
      wireProtocol: 'OPENAI_RESPONSES',
      adapter: new OpenAiAdapter({
        id: 'openai.live',
        baseUrl,
        reasoningEffortByProfile: {},
        models: [{ modelRef: model, features: ['text', 'structuredJson', 'jsonSchema', 'streaming', 'usage'], maxContextTokens: 8_192, maxOutputTokens: 4_096, profiles: ['balanced'] }],
      }),
    };
  },
  deepseek: () => {
    const key = env('AIBRIDGE_LIVE_DEEPSEEK_API_KEY');
    const model = env('AIBRIDGE_LIVE_DEEPSEEK_MODEL');
    if (key === undefined || model === undefined) return null;
    const baseUrl = env('AIBRIDGE_LIVE_DEEPSEEK_BASE_URL') ?? 'https://api.deepseek.com';
    return {
      secret: key,
      baseUrl,
      preset: 'DEEPSEEK_OFFICIAL',
      family: 'deepseek',
      endpointKind: 'PRESET',
      authScheme: 'BEARER',
      wireProtocol: 'OPENAI_CHAT_COMPLETIONS',
      adapter: new DeepSeekAdapter({
        id: 'deepseek.live',
        baseUrl,
        models: [{ modelRef: model, features: ['text', 'structuredJson', 'reasoning', 'streaming', 'usage'], maxContextTokens: 65_536, maxOutputTokens: 8_192, profiles: ['balanced', 'reasoning'] }],
      }),
    };
  },
  xiaomi: () => {
    const key = env('AIBRIDGE_LIVE_XIAOMI_API_KEY');
    const model = env('AIBRIDGE_LIVE_XIAOMI_MODEL');
    if (key === undefined || model === undefined) return null;
    const cluster = env('AIBRIDGE_LIVE_XIAOMI_CLUSTER') ?? 'CN';
    const resolvedCluster = ['CN', 'SGP', 'EU'].includes(cluster) ? cluster : 'CN';
    const baseUrl = env('AIBRIDGE_LIVE_XIAOMI_BASE_URL') ?? `https://token-plan.${resolvedCluster.toLowerCase()}.example.invalid`;
    return {
      secret: key,
      baseUrl,
      preset: 'XIAOMI_TOKENPLAN',
      family: 'xiaomi',
      endpointKind: 'PRESET',
      cluster: resolvedCluster,
      authScheme: 'API_KEY_HEADER',
      wireProtocol: 'OPENAI_CHAT_COMPLETIONS',
      adapter: new XiaomiTokenPlanAdapter({
        id: 'xiaomi.live',
        cluster: resolvedCluster,
        ...(env('AIBRIDGE_LIVE_XIAOMI_BASE_URL') === undefined ? {} : { baseUrl: env('AIBRIDGE_LIVE_XIAOMI_BASE_URL') }),
        models: [{ modelRef: model, features: ['text', 'structuredJson', 'streaming', 'usage'], maxContextTokens: 1_048_576, maxOutputTokens: 131_072, profiles: ['balanced'] }],
      }),
    };
  },
  relay: () => {
    const key = env('AIBRIDGE_LIVE_RELAY_API_KEY');
    const model = env('AIBRIDGE_LIVE_RELAY_MODEL');
    const baseUrl = env('AIBRIDGE_LIVE_RELAY_BASE_URL');
    if (key === undefined || model === undefined || baseUrl === undefined) return null;
    const authScheme = env('AIBRIDGE_LIVE_RELAY_AUTH_SCHEME') === 'API_KEY_HEADER' ? 'API_KEY_HEADER' : 'BEARER';
    const declared = (env('AIBRIDGE_LIVE_RELAY_FEATURES') ?? 'text,streaming,usage')
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    return {
      secret: key,
      baseUrl,
      preset: 'OPENAI_COMPATIBLE_CUSTOM',
      family: 'openai-compatible',
      endpointKind: 'CUSTOM',
      authScheme,
      wireProtocol: 'OPENAI_CHAT_COMPLETIONS',
      adapter: new OpenAiCompatibleAdapter({
        id: 'relay.live',
        baseUrl,
        authScheme,
        models: [{ modelRef: model, features: declared, maxContextTokens: 8_192, maxOutputTokens: 4_096, profiles: ['balanced'] }],
      }),
    };
  },
};

/** Safe per-feature summary line (Phase 29). */
function summarize(name, records) {
  for (const record of records) {
    const bits = [`status=${record.status}`];
    if (record.latencyMs !== undefined) bits.push(`latencyMs=${record.latencyMs}`);
    if (record.usageProjection !== undefined) bits.push(`usage=${JSON.stringify(record.usageProjection)}`);
    if (record.safeFailureReason !== undefined) bits.push(`reason=${record.safeFailureReason}`);
    if (record.notes !== undefined && record.notes.length > 0) bits.push(`notes=${record.notes.join('+')}`);
    report(`${name} ${record.identity.modelAlias} ${record.identity.feature}: ${bits.join(' ')}`);
  }
}

async function main() {
  const names = only === 'all' ? Object.keys(builders) : [only];
  const results = {};
  const allRecords = [];

  for (const name of names) {
    const build = builders[name];
    if (build === undefined) {
      report(`${name}: unknown provider (known: ${Object.keys(builders).join(', ')})`);
      results[name] = 'LIVE_NOT_RUN';
      continue;
    }
    const setup = build();
    if (setup === null) {
      report(`${name}: LIVE_NOT_RUN — no credentials in the environment (not a Stage 8 failure)`);
      results[name] = 'LIVE_NOT_RUN';
      continue;
    }
    try {
      const records = await qualifyProvider(setup);
      allRecords.push(...records);
      summarize(name, records);
      const failed = records.some((record) => record.status === 'LIVE_FAILED');
      results[name] = failed ? 'LIVE_FAILED' : 'LIVE_QUALIFIED';
    } catch (error) {
      report(`${name}: LIVE_FAILED — ${error instanceof Error ? error.message : String(error)}`);
      results[name] = 'LIVE_FAILED';
    }
  }

  // Persist a safe, non-secret document for the operator (Phase 5). Records carry no credentials,
  // prompts, raw responses or reasoning content (Phases 4, 38).
  const outPath = join(root, 'tmp', 'qualification', 'live-qualification.json');
  try {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, serializeQualificationDocument(allRecords), 'utf8');
    report(`wrote ${allRecords.length} safe record(s) to tmp/qualification/live-qualification.json`);
  } catch (error) {
    report(`note: could not write qualification document (${error instanceof Error ? error.message : String(error)})`);
  }

  report(`summary: ${JSON.stringify(results)}`);
  const failed = Object.values(results).some((value) => value === 'LIVE_FAILED');
  process.exit(failed ? 1 : 0);
}

await main();
