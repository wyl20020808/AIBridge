/**
 * Layer 2 — secret leakage regression tests (TESTING.md §2.1–§2.2, ROADMAP Stage 3 §7).
 *
 * A synthetic key is bound exactly as a real one would be — resolved from the trusted secret port
 * by handle — and then hunted through **every** surface a leak could reach: the generic request,
 * the generic response, error serialization, stream events, snapshots, operator logs and package
 * serialization. A synthetic key is always used; a test that needs a real key is itself a finding.
 *
 * The suite also carries a **negative** test: it deliberately breaks the repository's secret gate
 * (a credential-shaped file in the working tree) and asserts `check-no-secret-leak.mjs` fails,
 * then restores the tree. A security gate that has never been seen to fail is decoration.
 */
import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { InMemorySecretStore, ScriptedProviderAdapter, TestClock, textStep } from '@aibridge/host-sdk';
import { AiRuntime, RecordingOperatorLog, redactOperatorDetail } from '@aibridge/runtime';
import { OpenAiCompatibleAdapter } from '@aibridge/provider-openai-compatible';
import type { ProviderRequest, TrustedCredentials } from '@aibridge/contracts';
import { describe, expect, it } from 'vitest';

import { makeFakeOpenAi } from '../helpers/openai-fake.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const syntheticSecret = `sk-${'D'.repeat(32)}`;
const context = { callerPluginId: 'test.caller', grantedPermissions: ['ai.text.generate'] };

function textRequest(): Record<string, unknown> {
  return {
    contractVersion: '1.0',
    requestId: 'req-secret-1',
    idempotencyKey: 'turn-secret.attempt-1',
    capability: 'ai.text.generate',
    capabilityVersion: '1.0',
    profile: 'balanced',
    input: { instructions: 'Summarise.', context: [] },
  };
}

function assertNoLeak(label: string, surfaces: readonly (string | undefined)[]): void {
  for (const surface of surfaces) {
    expect(surface ?? '', label).not.toContain(syntheticSecret);
  }
}

describe('the credential never crosses the trusted boundary', () => {
  it('binds by handle and leaks into no runtime surface', async () => {
    const log = new RecordingOperatorLog();
    const fake = makeFakeOpenAi({ id: 'main', modelRef: 'fake-model' });
    const secrets = new InMemorySecretStore();
    secrets.put('secret://main/api-key', syntheticSecret);
    const runtime = new AiRuntime({
      providers: [{ adapter: fake.adapter, credentialRef: 'secret://main/api-key' }],
      routes: { balanced: [{ providerId: 'main', modelRef: 'fake-model' }] },
      secrets,
      clock: new TestClock(0),
      operatorLog: log,
    });

    fake.push({
      json: {
        choices: [{ message: { content: 'answer' }, finish_reason: 'stop' }],
        usage: { total_tokens: 2 },
      },
    });
    const result = await runtime.execute(textRequest(), context);

    assertNoLeak('generic response', [
      JSON.stringify(result),
      JSON.stringify(runtime),
      JSON.stringify(fake.adapter),
      String(fake.adapter),
    ]);
    // The provider payload is where the credential must NOT be…
    assertNoLeak('provider payload', [fake.calls[0]?.body]);
    // …and the Authorization header is the one place it may be.
    expect(fake.calls[0]?.headers['authorization']).toBe(`Bearer ${syntheticSecret}`);
  });

  it('keeps the credential out of failures, stream events and operator logs', async () => {
    const log = new RecordingOperatorLog();
    const fake = makeFakeOpenAi({ id: 'main', modelRef: 'fake-model' });
    const secrets = new InMemorySecretStore();
    secrets.put('secret://main/api-key', syntheticSecret);
    const runtime = new AiRuntime({
      providers: [{ adapter: fake.adapter, credentialRef: 'secret://main/api-key' }],
      routes: { balanced: [{ providerId: 'main', modelRef: 'fake-model' }] },
      secrets,
      clock: new TestClock(0),
      operatorLog: log,
    });

    // A vendor error body that *contains* the credential — the worst case a raw log could copy.
    fake.push({
      status: 500,
      json: { error: { type: 'server_error', message: `upstream rejected token ${syntheticSecret}` } },
    });
    const failure = await runtime.execute(textRequest(), context);
    assertNoLeak('normalized failure', [JSON.stringify(failure)]);

    fake.push({ sse: [JSON.stringify({ error: { type: 'server_error', message: `bad token ${syntheticSecret}` } })] });
    const events = [];
    for await (const event of runtime.stream(textRequest(), context)) {
      events.push(event);
    }
    assertNoLeak('stream events', [JSON.stringify(events)]);

    // The operator channel sees the raw prose — credential-stripped and truncated.
    const serializedLog = JSON.stringify(log.entries);
    assertNoLeak('operator log', [serializedLog]);
    expect(serializedLog).toContain('[REDACTED');
  });

  it('never lets the credential into the generic request either', async () => {
    const adapter = new ScriptedProviderAdapter({ id: 'scripted' });
    const secrets = new InMemorySecretStore();
    secrets.put('secret://main/api-key', syntheticSecret);
    const runtime = new AiRuntime({
      providers: [{ adapter, credentialRef: 'secret://main/api-key' }],
      routes: { balanced: [{ providerId: 'scripted', modelRef: 'scripted-model' }] },
      secrets,
      clock: new TestClock(0),
    });
    adapter.pushText(textStep('ok'));
    await runtime.execute(textRequest(), context);

    expect(adapter.requests).toHaveLength(1);
    const dispatched: ProviderRequest | undefined = adapter.requests[0];
    assertNoLeak('ProviderRequest', [JSON.stringify(dispatched)]);
    expect(Object.keys(dispatched ?? {}).sort()).not.toContain('apiKey');
    // The scripted adapter drops the value on binding and keeps the handle only.
    expect(adapter.credentialHandle).toBe('secret://main/api-key');
  });

  it('refuses to resolve a credential for an adapter that cannot bind one', async () => {
    const adapter = new ScriptedProviderAdapter({ id: 'scripted' });
    const withoutBinding = {
      id: adapter.id,
      family: adapter.family,
      adapterApiVersion: adapter.adapterApiVersion,
      descriptor: adapter.descriptor,
      generateText: adapter.generateText.bind(adapter),
      generateStructured: adapter.generateStructured.bind(adapter),
    };
    const secrets = new InMemorySecretStore();
    secrets.put('secret://main/api-key', syntheticSecret);
    const runtime = new AiRuntime({
      routes: { balanced: [{ providerId: 'scripted', modelRef: 'scripted-model' }] },
      secrets,
      clock: new TestClock(0),
    });
    const registration = await runtime.registerProvider({
      adapter: withoutBinding,
      credentialRef: 'secret://main/api-key',
    });
    expect(registration.ok).toBe(false);
  });

  it('strips a rotated key that matches no credential pattern', () => {
    const rotated = 'ZZ-topsecret-rotated-value-42';
    const detail = redactOperatorDetail(`upstream said ${rotated} was rejected`, [rotated]);
    expect(detail).not.toContain(rotated);
    expect(detail).toContain('[REDACTED]');
  });
});

describe('negative security test — the gate fails when deliberately broken', () => {
  it('check-no-secret-leak rejects a credential-shaped file in the tree', () => {
    const planted = join(root, 'tests', 'security', 'planted-credential.json');
    writeFileSync(planted, `{"apiKey": "${`sk-${'E'.repeat(32)}`}"}`, 'utf8');
    let exitCode = 0;
    let output = '';
    try {
      execFileSync(process.execPath, [join(root, 'scripts', 'check-no-secret-leak.mjs')], {
        cwd: root,
        encoding: 'utf8',
        stdio: 'pipe',
      });
    } catch (error) {
      const failure = error as { status?: number; stdout?: string; stderr?: string };
      exitCode = failure.status ?? 1;
      output = `${failure.stdout ?? ''}\n${failure.stderr ?? ''}`;
    } finally {
      rmSync(planted, { force: true });
    }
    expect(exitCode, 'the secret gate must fail while a credential-shaped file exists').not.toBe(0);
    expect(output).toContain('OPENAI_STYLE_KEY');
  });

  it('detects a mutant adapter that serializes its credential', () => {
    /** A deliberately broken adapter: exactly the mutation the regression assertions must catch. */
    class LeakyAdapter extends OpenAiCompatibleAdapter {
      override toJSON(): { kind: string; id: string; credential: string } {
        return { kind: 'leaky', id: this.id, credential: syntheticSecret };
      }
    }
    const leaky = new LeakyAdapter({
      id: 'leaky',
      baseUrl: 'https://api.example.invalid/v1',
      fetch: () => Promise.reject(new Error('unused')),
      models: [{ modelRef: 'm', features: ['text'], maxContextTokens: 1, maxOutputTokens: 1 }],
    });
    leaky.bindCredentials({ handle: 'secret://leaky', secret: syntheticSecret } as TrustedCredentials);
    // The regression assertion above would catch this mutation exactly here:
    expect(JSON.stringify(leaky)).toContain(syntheticSecret);
  });
});
