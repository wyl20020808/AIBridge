/**
 * Runtime portability smoke — the second input to `scripts/check-portability.mjs`.
 *
 * It runs from an isolated project that installed the packed tarballs: no repo source, no path
 * aliases, no workspace, and (because the install was `--offline`) no registry. It asserts the
 * portable surface actually works, not just that it typechecks.
 *
 * The synthetic credential below is assembled at runtime so that this committed file never contains
 * a credential-shaped literal for the secret-leak gate to flag.
 */
import assert from 'node:assert/strict';

import { parseAiRequestEnvelope, parseConsumerAiRequest } from '@aibridge/contracts';
import { screenAiInput } from '@aibridge/core';
import {
  ScriptedProviderAdapter,
  makeInMemoryHost,
  mutantHosts,
  runHostConformance,
  runProviderConformance,
} from '@aibridge/host-sdk';

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
      context: [{ name: 'body', type: 'STRING', untrusted: true, value: 'A learner described a two-pass approach.' }],
    },
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

  // 9. The scripted provider (the Stage 2 stand-in for a real adapter) conforms.
  const adapter = new ScriptedProviderAdapter({ id: 'portability-scripted' });
  const providerReport = await runProviderConformance(adapter);
  assert.equal(providerReport.passed, true, `provider conformance should pass: ${JSON.stringify(providerReport.findings)}`);

  process.stdout.write('check-portability: smoke OK (9 assertions over the packed runtime surface)\n');
}

await main();
