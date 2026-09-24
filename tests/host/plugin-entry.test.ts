/**
 * Host plugin entry tests (ROADMAP Stage 6).
 *
 * These prove the binding contract a host relies on: construction from a configuration document
 * plus host ports, identity and permission enforcement at the entry, discovery, atomic reload,
 * host-store wiring, safe diagnostics, and disposal. The provider is the scripted adapter, so the
 * suite is fully deterministic and network-free.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  InMemorySecretStore,
  ScriptedProviderAdapter,
  structuredStep,
  textStep,
} from '@aibridge/host-sdk';
import { InMemoryUsageLedger } from '@aibridge/governance';
import {
  aibridgePluginManifest,
  createAiBridgeServerPlugin,
  type AiBridgeServerPlugin,
} from '@aibridge/host';
import { unwrap } from '../helpers/assertions.js';

const root = fileURLToPath(new URL('../..', import.meta.url));

/** Deterministic scripted adapters, one per provider id, through the factory table. */
function makeFactory() {
  const adapters = new Map<string, ScriptedProviderAdapter>();
  const factories = {
    OPENAI_COMPATIBLE_CUSTOM: (spec: { providerId: string }) => {
      let adapter = adapters.get(spec.providerId);
      if (adapter === undefined) {
        adapter = new ScriptedProviderAdapter({ id: spec.providerId });
        adapters.set(spec.providerId, adapter);
      }
      return adapter;
    },
  };
  return {
    factories,
    adapter: () => adapters.get('scripted') as ScriptedProviderAdapter,
    adapterFor: (id: string) => adapters.get(id) as ScriptedProviderAdapter,
    adapterCount: () => adapters.size,
  };
}

/**
 * The whole runtime configuration document, flat: `providers`, `routes`, `governance`
 * (`parseRuntimeConfig` shape).
 */
function configDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    providers: [
      {
        providerId: 'scripted',
        preset: 'OPENAI_COMPATIBLE_CUSTOM',
        enabled: true,
        credentialRef: 'secret://test/scripted',
        endpoint: { kind: 'CUSTOM', baseUrl: 'https://scripted.invalid/v1' },
        models: [
          {
            alias: 'scripted.text.primary',
            providerId: 'scripted',
            providerModelId: 'scripted-model',
            profiles: ['balanced'],
            features: ['text', 'structuredJson', 'usage'],
          },
        ],
      },
    ],
    routes: [{ profile: 'balanced', chain: ['scripted.text.primary'] }],
    governance: {},
    ...overrides,
  };
}

const SECRETS = new InMemorySecretStore();
SECRETS.put('secret://test/scripted', 'synthetic-credential-value');

const trustedContext = {
  callerPluginId: 'site.problem',
  grantedPermissions: ['ai.text.generate', 'ai.structured.generate'],
};

async function makePlugin(overrides: Record<string, unknown> = {}): Promise<{ plugin: AiBridgeServerPlugin; adapter: ScriptedProviderAdapter; adapterFor: (id: string) => ScriptedProviderAdapter }> {
  const factory = makeFactory();
  const plugin = unwrap(
    await createAiBridgeServerPlugin({
      config: configDoc(overrides),
      adapterFactories: factory.factories,
      resolveEndpoint: () => 'https://scripted.invalid/v1',
      secrets: SECRETS,
      stores: {},
    }),
  );
  return { plugin, adapter: factory.adapter(), adapterFor: factory.adapterFor };
}

function textTurn(turn: number): Record<string, unknown> {
  return {
    contractVersion: '1.0',
    requestId: `req-${turn}`,
    idempotencyKey: `turn-${turn}`,
    capability: 'ai.text.generate',
    capabilityVersion: '1.0',
    profile: 'balanced',
    input: { instructions: 'Summarise.', context: [] },
  };
}

function structuredTurn(turn: number): Record<string, unknown> {
  return {
    contractVersion: '1.0',
    requestId: `req-${turn}`,
    idempotencyKey: `turn-${turn}`,
    capability: 'ai.structured.generate',
    capabilityVersion: '1.0',
    profile: 'balanced',
    input: { instructions: 'Summarise.', context: [] },
    outputSchema: {
      kind: 'INLINE',
      schemaId: 'test.summary',
      version: '1.0',
      dialect: 'aibridge.fields/v1',
      fields: [{ name: 'summary', type: 'STRING', required: true, description: 'One line.' }],
    },
  };
}

describe('the AI Bridge server plugin entry', () => {
  it('constructs from a valid configuration document and host ports', async () => {
    const { plugin } = await makePlugin();
    expect(plugin.id).toBe('ai.bridge');
    expect(plugin.providesCapabilities).toEqual(['ai.text.generate@1.x', 'ai.structured.generate@1.x']);
    expect(plugin.runtime.providerIds).toEqual(['scripted']);
  });

  it('rejects an invalid configuration document without producing a plugin', async () => {
    const factory = makeFactory();
    const result = await createAiBridgeServerPlugin({
      config: { providers: 'not-a-list', routes: [], governance: {} },
      adapterFactories: factory.factories,
      resolveEndpoint: () => 'https://scripted.invalid/v1',
    });
    expect(result.ok).toBe(false);
  });

  it('rejects a configuration whose provider has no adapter factory', async () => {
    const result = await createAiBridgeServerPlugin({
      config: configDoc(),
      adapterFactories: {},
      resolveEndpoint: () => 'https://scripted.invalid/v1',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.issues[0]?.message).toContain('no adapter factory');
    }
  });

  it('executes a text turn through a host-bound trusted context', async () => {
    const { plugin, adapter } = await makePlugin();
    adapter.pushText(textStep('a calm answer'));
    const result = await plugin.execute(textTurn(1), trustedContext);
    expect(result.status).toBe('SUCCEEDED');
    expect(result.output).toEqual({ text: 'a calm answer', finishReason: 'STOP' });
  });

  it('executes a structured turn and validates the output', async () => {
    const { plugin, adapter } = await makePlugin();
    adapter.pushStructured(structuredStep('{"summary":"two words"}'));
    const result = await plugin.execute(structuredTurn(2), trustedContext);
    expect(result.status).toBe('SUCCEEDED');
    expect(result.output).toEqual({ summary: 'two words' });
  });

  it('refuses an unbound caller identity', async () => {
    const { plugin } = await makePlugin();
    const result = await plugin.execute(textTurn(3), { grantedPermissions: ['ai.text.generate'] });
    expect(result.status).toBe('FAILED');
    expect(result.error?.stage).toBe('PERMISSION');
    expect(result.error?.reason).toBe('CALLER_NOT_PERMITTED');
  });

  it('refuses a caller that has not been granted the capability', async () => {
    const { plugin } = await makePlugin();
    const result = await plugin.execute(textTurn(4), {
      callerPluginId: 'plugin.undeclared.consumer',
      grantedPermissions: ['some.other.capability'],
    });
    expect(result.status).toBe('FAILED');
    expect(result.error?.reason).toBe('CALLER_NOT_PERMITTED');
  });

  it('rejects a consumer request that tries to carry the trusted identity', async () => {
    const { plugin } = await makePlugin();
    const result = await plugin.execute({ ...textTurn(5), callerPluginId: 'plugin.forged' }, trustedContext);
    expect(result.status).toBe('FAILED');
    expect(result.error?.reason).toBe('TRUSTED_FIELD_IN_CONSUMER_REQUEST');
  });

  it('lists the generic capabilities with governance applied', async () => {
    const { plugin } = await makePlugin();
    const capabilities = plugin.listCapabilities().map((entry) => `${entry.id}@${entry.version} ${entry.status}`).sort();
    expect(capabilities).toEqual(['ai.structured.generate@1.0 AVAILABLE', 'ai.text.generate@1.0 AVAILABLE']);
    expect(plugin.getCapability('ai.structured.generate', '1')?.kind).toBe('GENERIC');
    expect(plugin.getCapability('nope.nope.nope')).toBeNull();
  });

  it('reports DISABLED when the configuration throws the global kill switch', async () => {
    const { plugin } = await makePlugin({ governance: { killSwitch: { global: true, providers: [], capabilities: [] } } });
    expect(plugin.status().global).toBe('DISABLED');
    expect(plugin.listCapabilities().every((entry) => entry.status === 'DISABLED')).toBe(true);
    const adapterless = await plugin.execute(textTurn(6), trustedContext);
    expect(adapterless.error?.reason).toBe('KILL_SWITCH_GLOBAL');
  });

  it('keeps the previous snapshot when a reload candidate is invalid', async () => {
    const { plugin, adapter } = await makePlugin();
    const before = plugin.configSnapshot().configVersion;
    const bad = await plugin.reload({ providers: [], routes: [], governance: { rateLimits: 'nope' } });
    expect(bad.ok).toBe(false);
    expect(plugin.configSnapshot().configVersion).toBe(before);
    adapter.pushText(textStep('still serving'));
    const result = await plugin.execute(textTurn(7), trustedContext);
    expect(result.status).toBe('SUCCEEDED');
  });

  it('applies a valid reload atomically', async () => {
    const { plugin } = await makePlugin();
    const before = plugin.configSnapshot().configVersion;
    const reloaded = await plugin.reload(configDoc());
    expect(reloaded.ok).toBe(true);
    expect(plugin.configSnapshot().configVersion).not.toBe(before);
  });

  it('rebuilds the runtime when a reload changes the provider shape', async () => {
    const { plugin } = await makePlugin();
    const firstRuntime = plugin.runtime;
    const base = configDoc() as { providers: Record<string, unknown>[] };
    const changed = configDoc();
    (changed as { providers: Record<string, unknown>[] }).providers = [
      ...base.providers,
      {
        providerId: 'scripted-two',
        preset: 'OPENAI_COMPATIBLE_CUSTOM',
        enabled: true,
        credentialRef: 'secret://test/scripted',
        endpoint: { kind: 'CUSTOM', baseUrl: 'https://scripted-two.invalid/v1' },
        models: [
          {
            alias: 'scripted.two.primary',
            providerId: 'scripted-two',
            providerModelId: 'scripted-two-model',
            profiles: ['reasoning'],
            features: ['text', 'structuredJson', 'usage'],
          },
        ],
      },
    ];
    (changed as { routes: Record<string, unknown>[] }).routes = [
      { profile: 'balanced', chain: ['scripted.text.primary'] },
      { profile: 'reasoning', chain: ['scripted.two.primary'] },
    ];
    const reloaded = await plugin.reload(changed);
    expect(reloaded.ok).toBe(true);
    expect(plugin.runtime).not.toBe(firstRuntime);
    expect(plugin.runtime.providerIds).toEqual(['scripted', 'scripted-two']);
  });

  it('routes host stores: the usage ledger receives logical requests and attempts', async () => {
    const factory = makeFactory();
    const ledger = new InMemoryUsageLedger();
    const plugin = unwrap(
      await createAiBridgeServerPlugin({
        config: configDoc(),
        adapterFactories: factory.factories,
        resolveEndpoint: () => 'https://scripted.invalid/v1',
        secrets: SECRETS,
        stores: { usageLedger: ledger },
      }),
    );
    factory.adapter().pushText(textStep('metered'));
    const result = await plugin.execute(textTurn(8), { ...trustedContext, subjectToken: 'sub-opaque-token-1' });
    expect(result.status).toBe('SUCCEEDED');
    const requests = await ledger.requests();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.callerPluginId).toBe('site.problem');
    expect(requests[0]?.subjectHash).toMatch(/^subj-[0-9a-f]{16}$/);
    const attempts = await ledger.attempts();
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.providerId).toBe('scripted');
  });

  it('never exposes the credential value through diagnostics or status', async () => {
    const { plugin } = await makePlugin();
    const serialized = JSON.stringify({ diagnostics: plugin.diagnostics(), status: plugin.status() });
    expect(serialized.includes('synthetic-credential-value')).toBe(false);
    expect(plugin.diagnostics()[0]?.credential).toEqual({ handle: 'secret://test/scripted', bound: true });
  });

  it('refuses to execute after disposal', async () => {
    const { plugin } = await makePlugin();
    plugin.dispose();
    const result = await plugin.execute(textTurn(9), trustedContext);
    expect(result.status).toBe('FAILED');
    expect(result.error?.code).toBe('UNAVAILABLE');
    plugin.dispose();
  });

  it('rejects reload attempts after disposal', async () => {
    const { plugin } = await makePlugin();
    plugin.dispose();
    const result = await plugin.reload(configDoc());
    expect(result.ok).toBe(false);
  });
});

describe('the manifest projection', () => {
  it('matches the repository-root plugin.manifest.json', () => {
    const document = JSON.parse(readFileSync(`${root}/plugin.manifest.json`, 'utf8')) as Record<string, unknown>;
    const manifest = aibridgePluginManifest('0.2.0');
    expect(manifest.id).toBe(document['id']);
    expect(manifest.name).toBe(document['name']);
    expect(manifest.version).toBe(document['version']);
    expect(manifest.apiVersion).toBe(document['apiVersion']);
    expect(manifest.entry).toBe(document['entry']);
    expect(manifest.providesCapabilities).toEqual(document['providesCapabilities']);
    expect(manifest.consumesCapabilities).toEqual(document['consumesCapabilities']);
    expect(manifest.contractVersions).toEqual(document['contractVersions']);
  });

  it('declares the two generic primitives with pinned majors', () => {
    const manifest = aibridgePluginManifest();
    expect(manifest.providesCapabilities).toContain('ai.text.generate@1.x');
    expect(manifest.providesCapabilities).toContain('ai.structured.generate@1.x');
    expect(manifest.consumesCapabilities).toEqual([]);
    expect(manifest.contributes.slots).toEqual([]);
  });
});
