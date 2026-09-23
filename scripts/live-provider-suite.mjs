/**
 * Opt-in **live provider suite** (ROADMAP Stage 4 §33–40).
 *
 * Never part of `npm run verify` or PR CI: live calls need secrets, spend quota and depend on the
 * public internet. Run explicitly:
 *
 * ```text
 * npm run test:live-providers            # every provider that has credentials; others SKIP
 * npm run test:live:openai               # one provider
 * npm run test:live:deepseek
 * npm run test:live:xiaomi-tokenplan
 * npm run test:live:relay
 * ```
 *
 * Credentials and model ids come from the **environment only** (§34–35) — never from source, JSON,
 * fixtures, docs, tracked .env files or command transcripts:
 *
 *   AIBRIDGE_LIVE_OPENAI_API_KEY  AIBRIDGE_LIVE_OPENAI_MODEL   [AIBRIDGE_LIVE_OPENAI_BASE_URL]
 *   AIBRIDGE_LIVE_DEEPSEEK_API_KEY AIBRIDGE_LIVE_DEEPSEEK_MODEL [AIBRIDGE_LIVE_DEEPSEEK_BASE_URL]
 *   AIBRIDGE_LIVE_XIAOMI_API_KEY  AIBRIDGE_LIVE_XIAOMI_MODEL   [AIBRIDGE_LIVE_XIAOMI_CLUSTER=CN|SGP|EU]
 *   AIBRIDGE_LIVE_RELAY_BASE_URL  AIBRIDGE_LIVE_RELAY_API_KEY  AIBRIDGE_LIVE_RELAY_MODEL
 *                                 [AIBRIDGE_LIVE_RELAY_AUTH_SCHEME=BEARER|API_KEY_HEADER]
 *
 * Prompts are tiny, fixed and synthetic (§40): no user data, no PII, no product data. Each run
 * reports `LIVE_QUALIFIED`, `LIVE_NOT_RUN` (no credentials) or `LIVE_FAILED`, and asserts the
 * credential appears in no output surface.
 *
 * OpenAI note: a ChatGPT subscription web login is **not** an API credential. Without
 * `AIBRIDGE_LIVE_OPENAI_API_KEY` the OpenAI row reports `LIVE_NOT_RUN` and that is acceptable.
 */
import {
  AiRuntime,
  defaultCapabilityRegistry,
} from '@aibridge/runtime';
import { InMemorySecretStore } from '@aibridge/host-sdk';
import { OpenAiAdapter } from '@aibridge/provider-openai';
import { DeepSeekAdapter } from '@aibridge/provider-deepseek';
import { XiaomiTokenPlanAdapter, XIAOMI_TOKEN_PLAN_ENDPOINTS } from '@aibridge/provider-xiaomi-tokenplan';
import { OpenAiCompatibleAdapter } from '@aibridge/provider-openai-compatible';

const MODEL_ALIAS = 'live.primary';
const CREDENTIAL_HANDLE = 'secret://aibridge/live/api-key';

const only = process.argv[2] ?? 'all';

function report(line) {
  process.stdout.write(`test:live: ${line}\n`);
}

function env(name) {
  const value = process.env[name];
  return value === undefined || value.length === 0 ? undefined : value;
}

/** The tiniest synthetic prompts (§40): fixed strings, no data. */
const PROMPTS = {
  text: {
    instructions: 'Reply with exactly one word: pong.',
    context: [],
  },
  structured: {
    instructions: 'Return exactly one JSON object with one field "summary" whose value is "pong".',
    context: [],
  },
};

function consumerRequest(capability, input, outputSchema) {
  return {
    contractVersion: '1.0',
    requestId: `req-live-${capability.replace(/\./g, '-')}`,
    idempotencyKey: `live.${capability}.${Date.now()}`,
    capability,
    capabilityVersion: '1.0',
    profile: 'balanced',
    input,
    ...(outputSchema === undefined ? {} : { outputSchema }),
  };
}

const trustedContext = {
  callerPluginId: 'aibridge.live-suite',
  grantedPermissions: ['ai.text.generate', 'ai.structured.generate'],
};

function assertNoLeak(label, secret, surfaces) {
  for (const surface of surfaces) {
    if ((surface ?? '').includes(secret)) {
      throw new Error(`test:live: LEAK — the credential appeared in ${label}`);
    }
  }
}

async function qualify(name, adapter, secret) {
  const secrets = new InMemorySecretStore();
  secrets.put(CREDENTIAL_HANDLE, secret);
  const model = adapter.descriptor.models[0];
  const features = model?.features ?? [];
  const profiles = model?.profiles ?? [];
  const runtime = new AiRuntime({
    capabilities: defaultCapabilityRegistry(),
    providers: [{ adapter, credentialRef: CREDENTIAL_HANDLE }],
    secrets,
    routes: {
      balanced: [{ providerId: adapter.id, modelRef: model?.modelRef ?? MODEL_ALIAS }],
      reasoning: [{ providerId: adapter.id, modelRef: model?.modelRef ?? MODEL_ALIAS }],
    },
    limits: { serverTimeoutMs: 60_000 },
  });

  const ran = ['text'];
  // 1. text smoke (always)
  const started = Date.now();
  const textResult = await runtime.execute(consumerRequest('ai.text.generate', PROMPTS.text), trustedContext);
  assertNoLeak('the text result', secret, [JSON.stringify(textResult), JSON.stringify(adapter), String(adapter)]);
  if (textResult.status !== 'SUCCEEDED') {
    throw new Error(`text smoke failed: ${textResult.error?.code}/${textResult.error?.reason}`);
  }

  // 2. structured smoke — only when the capability is declared (§39: what a relay supports is
  //    declared/probed, never assumed from "OpenAI-compatible").
  if (features.includes('structuredJson') || features.includes('jsonSchema')) {
    const structuredResult = await runtime.execute(
      consumerRequest('ai.structured.generate', PROMPTS.structured, {
        kind: 'INLINE',
        schemaId: 'live.summary',
        version: '1.0',
        dialect: 'aibridge.fields/v1',
        fields: [{ name: 'summary', type: 'STRING', required: true, description: 'One word.' }],
      }),
      trustedContext,
    );
    assertNoLeak('the structured result', secret, [JSON.stringify(structuredResult)]);
    if (structuredResult.status !== 'SUCCEEDED') {
      throw new Error(`structured smoke failed: ${structuredResult.error?.code}/${structuredResult.error?.reason}`);
    }
    ran.push('structured');
  }

  // 3. reasoning-profile smoke — only where reasoning is declared and routed.
  if (features.includes('reasoning') && profiles.includes('reasoning')) {
    const reasoningResult = await runtime.execute(
      consumerRequest('ai.text.generate', PROMPTS.text),
      { ...trustedContext },
    );
    void reasoningResult;
    const routed = await runtime.execute(
      { ...consumerRequest('ai.text.generate', PROMPTS.text), profile: 'reasoning' },
      trustedContext,
    );
    assertNoLeak('the reasoning result', secret, [JSON.stringify(routed)]);
    if (routed.status !== 'SUCCEEDED') {
      throw new Error(`reasoning smoke failed: ${routed.error?.code}/${routed.error?.reason}`);
    }
    // Reasoning content must never surface — the generic output is the final answer only.
    if (JSON.stringify(routed.output).toLowerCase().includes('reasoning_content')) {
      throw new Error('reasoning smoke leaked reasoning content');
    }
    ran.push('reasoning');
  }

  // 4. stream smoke — only where streaming is declared.
  if (features.includes('streaming')) {
    const streamEvents = [];
    for await (const event of runtime.stream(consumerRequest('ai.text.generate', PROMPTS.text), trustedContext)) {
      streamEvents.push(event);
    }
    assertNoLeak('the stream events', secret, [JSON.stringify(streamEvents)]);
    const terminal = streamEvents[streamEvents.length - 1];
    if (terminal?.kind !== 'COMPLETED') {
      throw new Error(
        `stream smoke failed: ${terminal?.kind === 'FAILED' ? `${terminal.error.code}/${terminal.error.reason}` : terminal?.kind}`,
      );
    }
    ran.push('stream');
  }

  const latency = Date.now() - started;
  report(`${name}: LIVE_QUALIFIED — ${ran.join(' + ')} in ${latency}ms`);
  report(`${name}: usage ${JSON.stringify(textResult.usage)}; finish ${textResult.finishReason}; no secret leak`);
  return 'LIVE_QUALIFIED';
}

async function runProvider(name, build) {
  const setup = build();
  if (setup === null) {
    report(`${name}: LIVE_NOT_RUN — no credentials in the environment (not a Stage 4 failure)`);
    return 'LIVE_NOT_RUN';
  }
  try {
    return await qualify(name, setup.adapter, setup.secret);
  } catch (error) {
    report(`${name}: LIVE_FAILED — ${error instanceof Error ? error.message : String(error)}`);
    return 'LIVE_FAILED';
  }
}

const builders = {
  openai: () => {
    const key = env('AIBRIDGE_LIVE_OPENAI_API_KEY');
    const model = env('AIBRIDGE_LIVE_OPENAI_MODEL');
    if (key === undefined || model === undefined) return null;
    return {
      secret: key,
      adapter: new OpenAiAdapter({
        id: 'live-openai',
        baseUrl: env('AIBRIDGE_LIVE_OPENAI_BASE_URL') ?? 'https://api.openai.com/v1',
        reasoningEffortByProfile: {},
        models: [{ modelRef: model, features: ['text', 'structuredJson', 'jsonSchema', 'streaming', 'usage'], maxContextTokens: 8_192, maxOutputTokens: 4_096, profiles: ['balanced'] }],
      }),
    };
  },
  deepseek: () => {
    const key = env('AIBRIDGE_LIVE_DEEPSEEK_API_KEY');
    const model = env('AIBRIDGE_LIVE_DEEPSEEK_MODEL');
    if (key === undefined || model === undefined) return null;
    return {
      secret: key,
      adapter: new DeepSeekAdapter({
        id: 'live-deepseek',
        baseUrl: env('AIBRIDGE_LIVE_DEEPSEEK_BASE_URL') ?? 'https://api.deepseek.com',
        models: [{ modelRef: model, features: ['text', 'structuredJson', 'reasoning', 'streaming', 'usage'], maxContextTokens: 65_536, maxOutputTokens: 8_192, profiles: ['balanced', 'reasoning'] }],
      }),
    };
  },
  'xiaomi-tokenplan': () => {
    const key = env('AIBRIDGE_LIVE_XIAOMI_API_KEY');
    const model = env('AIBRIDGE_LIVE_XIAOMI_MODEL');
    if (key === undefined || model === undefined) return null;
    const cluster = env('AIBRIDGE_LIVE_XIAOMI_CLUSTER') ?? 'CN';
    return {
      secret: key,
      adapter: new XiaomiTokenPlanAdapter({
        id: 'live-xiaomi',
        cluster: ['CN', 'SGP', 'EU'].includes(cluster) ? cluster : 'CN',
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
    // What the relay supports is declared here — never assumed from "OpenAI-compatible". The
    // declaration decides which smokes run (structured/stream only when declared).
    const declared = (env('AIBRIDGE_LIVE_RELAY_FEATURES') ?? 'text,streaming,usage')
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    return {
      secret: key,
      adapter: new OpenAiCompatibleAdapter({
        id: 'live-relay',
        baseUrl,
        authScheme,
        models: [{ modelRef: model, features: declared, maxContextTokens: 8_192, maxOutputTokens: 4_096, profiles: ['balanced'] }],
      }),
    };
  },
};

void XIAOMI_TOKEN_PLAN_ENDPOINTS;

async function main() {
  const names = only === 'all' ? Object.keys(builders) : [only];
  const results = {};
  for (const name of names) {
    const build = builders[name];
    if (build === undefined) {
      report(`${name}: unknown provider (known: ${Object.keys(builders).join(', ')})`);
      results[name] = 'LIVE_NOT_RUN';
      continue;
    }
    results[name] = await runProvider(name, build);
  }
  report(`summary: ${JSON.stringify(results)}`);
  // A missing credential is SKIP, never a failure. A real failure is a failure.
  const failed = Object.values(results).filter((value) => value === 'LIVE_FAILED').length > 0;
  process.exit(failed ? 1 : 0);
}

await main();
