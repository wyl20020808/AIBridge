/**
 * Runtime portability smoke — the second input to `scripts/check-portability.mjs`.
 *
 * It runs from an isolated project that installed the packed tarballs: no repo source, no path
 * aliases, no workspace, and (because the install was `--offline`) no registry. It asserts the
 * portable surface actually works, not just that it typechecks — including one full Stage 3 round
 * trip: Generic Request → Runtime → Reference Adapter → (fake) HTTP → normalized Generic Result.
 *
 * The synthetic credential below is assembled at runtime so that this committed file never contains
 * a credential-shaped literal for the secret-leak gate to flag.
 */
import assert from 'node:assert/strict';

import { parseAiRequestEnvelope, parseConsumerAiRequest, parseAiResult, validateAiStreamSequence } from '@aibridge/contracts';
import { screenAiInput } from '@aibridge/core';
import {
  InMemorySecretStore,
  ScriptedProviderAdapter,
  makeInMemoryHost,
  mutantHosts,
  runHostConformance,
  runProviderConformance,
} from '@aibridge/host-sdk';
import { AiRuntime, materializeProviderSuite, parseProviderSuiteConfig } from '@aibridge/runtime';
import { OpenAiCompatibleAdapter } from '@aibridge/provider-openai-compatible';
import { DeepSeekAdapter } from '@aibridge/provider-deepseek';

const syntheticSecret = `sk-${'A'.repeat(32)}`;

function consumerRequest() {
  return {
    contractVersion: '1.0',
    requestId: 'req-portability-0001',
    idempotencyKey: 'portability.turn-1.attempt-1',
    capability: 'ai.structured.generate',
    capabilityVersion: '1.0',
    profile: 'balanced',
    input: {
      instructions: 'Summarise the supplied text.',
      context: [
        { name: 'body', label: 'Body', type: 'STRING', untrusted: true, value: 'A learner described a two-pass approach.' },
      ],
    },
  };
}

function trustedContext() {
  return {
    callerPluginId: 'portability.caller',
    grantedPermissions: ['ai.structured.generate', 'ai.text.generate'],
  };
}

function jsonResponse(body, init = {}) {
  return {
    status: init.status ?? 200,
    ok: (init.status ?? 200) < 400,
    headers: { get: (name) => (init.headers ?? {})[name.toLowerCase()] ?? null },
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
    body: null,
  };
}

async function main() {
  // 1. A well-formed consumer request is accepted.
  const accepted = parseConsumerAiRequest(consumerRequest());
  assert.equal(accepted.ok, true, 'a well-formed consumer request should be accepted');

  // 2. A consumer may not claim a host-bound identity.
  const forged = { ...consumerRequest(), callerPluginId: 'algoquest.learning-quests' };
  const forgedResult = parseConsumerAiRequest(forged);
  assert.equal(forgedResult.ok, false, 'a consumer request carrying callerPluginId must be rejected');
  assert.equal(forgedResult.failure.reason, 'TRUSTED_FIELD_IN_CONSUMER_REQUEST');

  // 3. The trusted combined envelope accepts the host-bound fields.
  const envelope = parseAiRequestEnvelope({
    ...consumerRequest(),
    callerPluginId: 'algoquest.learning-quests',
    subjectToken: 'subtok_portability_host_minted_0001',
  });
  assert.equal(envelope.ok, true, 'the combined envelope should accept host-bound fields');

  // 4. Unknown metadata is denied by default, not silently dropped.
  const badMetadata = parseConsumerAiRequest({
    ...consumerRequest(),
    metadata: { locale: 'zh-CN', userEmail: 'learner@example.invalid' },
  });
  assert.equal(badMetadata.ok, false, 'unknown metadata must be rejected');
  assert.equal(badMetadata.failure.reason, 'METADATA_NOT_ALLOWED');

  // 5. Credential-shaped input is rejected, never redacted and forwarded.
  const secretScreen = screenAiInput({ text: syntheticSecret });
  assert.equal(secretScreen.ok, false, 'credential-shaped input must be rejected');
  assert.equal(secretScreen.error.reason, 'SECRET_LIKE_INPUT');

  // 6. PII is redacted and warned about, because rejecting a learner's turn would be wrong.
  const piiScreen = screenAiInput({ text: 'contact me at learner@example.invalid' });
  assert.equal(piiScreen.ok, true, 'PII-only input should be accepted after redaction');
  assert.ok(
    piiScreen.warnings.some((warning) => warning.code === 'INPUT_REDACTED'),
    'PII redaction must emit INPUT_REDACTED',
  );
  assert.match(JSON.stringify(piiScreen.value), /\[REDACTED:EMAIL\]/);

  // 7. The in-memory host passes the host conformance kit, including the secret-redaction probe.
  const host = makeInMemoryHost();
  host.secrets.put('secret://portability/synthetic', syntheticSecret);
  const hostReport = await runHostConformance(host, {
    syntheticSecret: { handle: 'secret://portability/synthetic', value: syntheticSecret },
  });
  assert.equal(hostReport.passed, true, `in-memory host should conform: ${JSON.stringify(hostReport.findings)}`);

  // 8. Every mutant host is caught. A conformance kit that never fails is decoration.
  for (const mutant of mutantHosts()) {
    if (mutant.name === 'leaky-secret-store') {
      mutant.host.secrets.leaked['secret://portability/synthetic'] = syntheticSecret;
    }
    const report = await runHostConformance(mutant.host, {
      syntheticSecret: { handle: 'secret://portability/synthetic', value: syntheticSecret },
    });
    assert.equal(report.passed, false, `mutant host "${mutant.name}" must fail conformance`);
  }

  // 9. The scripted provider conforms at the adapter boundary.
  const adapter = new ScriptedProviderAdapter({ id: 'portability-scripted' });
  const providerReport = await runProviderConformance(adapter);
  assert.equal(providerReport.passed, true, `provider conformance should pass: ${JSON.stringify(providerReport.findings)}`);

  // 10. One full Stage 3 round trip through the packed runtime + reference adapter:
  //     Generic Request → Runtime → Adapter → HTTP → normalized Generic Result.
  const captured = [];
  const fakeFetch = async (url, init) => {
    captured.push({ url, init });
    return jsonResponse({
      choices: [{ message: { content: '{"summary":"two-pass approach"}' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
    });
  };
  const openAiAdapter = new OpenAiCompatibleAdapter({
    id: 'main',
    baseUrl: 'https://api.example.invalid/v1',
    fetch: fakeFetch,
    models: [
      {
        modelRef: 'portability-model',
        features: ['text', 'structuredJson', 'streaming', 'usage'],
        maxContextTokens: 8_192,
        maxOutputTokens: 4_096,
        profiles: ['balanced'],
      },
    ],
  });
  const secrets = new InMemorySecretStore();
  secrets.put('secret://portability/main', syntheticSecret);
  const runtime = new AiRuntime({
    routes: { balanced: [{ providerId: 'main', modelRef: 'portability-model' }] },
    secrets,
  });
  const registration = await runtime.registerProvider({
    adapter: openAiAdapter,
    credentialRef: 'secret://portability/main',
  });
  assert.equal(registration.ok, true, 'the reference adapter should register');

  const result = await runtime.execute(
    {
      ...consumerRequest(),
      outputSchema: {
        kind: 'INLINE',
        schemaId: 'portability.summary',
        version: '1.0',
        dialect: 'aibridge.fields/v1',
        fields: [{ name: 'summary', type: 'STRING', required: true, description: 'One-line summary.' }],
      },
    },
    trustedContext(),
  );
  assert.equal(result.status, 'SUCCEEDED', `the round trip should succeed: ${JSON.stringify(result.error)}`);
  assert.deepEqual(result.output, { summary: 'two-pass approach' });
  assert.equal(result.usage.totalTokens, 17);
  assert.equal(result.providerMetadata.providerFamily, 'openai-compatible');

  // The credential rode the Authorization header and appeared nowhere else.
  assert.equal(captured.length, 1, 'exactly one provider call');
  assert.equal(captured[0].init.headers.authorization, `Bearer ${syntheticSecret}`);
  const serializedResult = JSON.stringify(result);
  assert.ok(!serializedResult.includes(syntheticSecret), 'the credential must not appear in the result');
  assert.ok(!captured[0].init.body.includes(syntheticSecret), 'the credential must not appear in the payload');

  // 11. Streaming through the packed surface terminates deterministically.
  const events = [];
  for await (const event of runtime.stream(
    { ...consumerRequest(), capability: 'ai.text.generate', capabilityVersion: '1.0' },
    trustedContext(),
  )) {
    events.push(event);
  }
  assert.equal(events[0].kind, 'STARTED', 'a stream starts with STARTED');
  assert.equal(events[events.length - 1].kind, 'FAILED', 'a scripted-less adapter stream fails deterministically');
  assert.ok(validateAiStreamSequence(events).ok, 'the stream sequence must be contract-valid');

  // 12. One full multi-provider round trip through the Stage 4 suite surface: config -> suite ->
  //     runtime -> one of the four adapter families -> normalized generic result.
  const suite = parseProviderSuiteConfig({
    providers: [
      {
        providerId: 'deepseek',
        preset: 'DEEPSEEK_OFFICIAL',
        enabled: true,
        credentialRef: 'secret://portability/deepseek',
        endpoint: { kind: 'PRESET' },
        models: [
          {
            alias: 'deepseek.text.primary',
            providerId: 'deepseek',
            providerModelId: 'portability-deepseek-model',
            profiles: ['balanced'],
            features: ['text', 'structuredJson', 'usage'],
            verifiedFeatures: ['text'],
          },
        ],
      },
    ],
    routes: [{ profile: 'balanced', chain: ['deepseek.text.primary'] }],
  });
  assert.equal(suite.ok, true, `the provider suite config parses: ${JSON.stringify(suite.ok ? '' : suite.failure.issues)}`);

  const suiteFetch = async (url, init) => {
    captured.push({ url, init });
    return jsonResponse({
      choices: [{ message: { content: '{"summary":"two-pass approach"}' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
    });
  };
  secrets.put('secret://portability/deepseek', syntheticSecret);
  const materialized = await materializeProviderSuite(suite.value, {
    factories: {
      DEEPSEEK_OFFICIAL: (spec) =>
        new DeepSeekAdapter({
          id: spec.providerId,
          baseUrl: spec.baseUrl,
          fetch: suiteFetch,
          models: spec.models.map((model) => ({
            modelRef: model.providerModelId,
            features: model.features,
            maxContextTokens: 8_192,
            maxOutputTokens: 4_096,
            profiles: model.profiles,
          })),
        }),
    },
    secrets,
    resolveEndpoint: (provider) => (provider.preset === 'DEEPSEEK_OFFICIAL' ? 'https://api.deepseek.com' : ''),
  });
  assert.equal(materialized.ok, true, 'the suite materializes');
  const suiteResult = await materialized.value.runtime.execute(
    {
      ...consumerRequest(),
      outputSchema: {
        kind: 'INLINE',
        schemaId: 'portability.summary',
        version: '1.0',
        dialect: 'aibridge.fields/v1',
        fields: [{ name: 'summary', type: 'STRING', required: true, description: 'One-line summary.' }],
      },
    },
    trustedContext(),
  );
  assert.equal(suiteResult.status, 'SUCCEEDED', `suite round trip: ${JSON.stringify(suiteResult.error)}`);
  assert.deepEqual(suiteResult.output, { summary: 'two-pass approach' });
  assert.equal(materialized.value.diagnostics()[0]?.models[0]?.featureStatus.text, 'VERIFIED');
  assert.ok(!JSON.stringify(materialized.value.diagnostics()).includes(syntheticSecret), 'diagnostics never carry credentials');

  // And the result envelope itself parses.
  assert.equal(parseAiResult(result).ok, true, 'the normalized result parses against the contract');

  process.stdout.write('check-portability: smoke OK (12 assertions over the packed runtime surface)\n');
}

await main();
