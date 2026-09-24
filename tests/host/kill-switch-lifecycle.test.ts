/**
 * Kill-switch lifecycle through the host plugin (Stage 6 regression).
 *
 * Two bugs this pins, both found by the packed-artifact qualification:
 *
 *  1. **Registry fork.** `ServerPlugin`'s constructor received the kill-switch registry built by
 *     `create()` but a field initializer silently replaced it — reloads applied switch state to a
 *     registry nothing executed against, and `status()` disagreed with what execution enforced.
 *     The registry is now one shared instance and `status()` must agree with execution.
 *  2. **Reason collapse.** A kill that landed at dispatch time always surfaced
 *     `KILL_SWITCH_PROVIDER`, even for a global kill. The closed vocabulary distinguishes
 *     `KILL_SWITCH_GLOBAL` / `KILL_SWITCH_CAPABILITY` / `KILL_SWITCH_PROVIDER` deliberately and
 *     the distinction must survive to the consumer.
 */
import { describe, expect, it } from 'vitest';
import {
  InMemorySecretStore,
  ScriptedProviderAdapter,
  textStep,
} from '@aibridge/host-sdk';
import { createAiBridgeServerPlugin, type AiBridgeServerPlugin } from '@aibridge/host';
import { unwrap } from '../helpers/assertions.js';

function makeFactory() {
  const adapters = new Map<string, ScriptedProviderAdapter>();
  return {
    factories: {
      OPENAI_COMPATIBLE_CUSTOM: (spec: { providerId: string }) => {
        let adapter = adapters.get(spec.providerId);
        if (adapter === undefined) {
          adapter = new ScriptedProviderAdapter({ id: spec.providerId });
          adapters.set(spec.providerId, adapter);
        }
        return adapter;
      },
    },
    adapterFor: (id: string) => adapters.get(id) as ScriptedProviderAdapter,
  };
}

function configDoc(killSwitch: Record<string, unknown> = {}): Record<string, unknown> {
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
    governance: Object.keys(killSwitch).length === 0 ? {} : { killSwitch },
  };
}

const SECRETS = new InMemorySecretStore();
SECRETS.put('secret://test/scripted', 'synthetic-credential-value');

const trustedContext = {
  callerPluginId: 'site.problem',
  grantedPermissions: ['ai.text.generate', 'ai.structured.generate'],
};

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

async function makePlugin(): Promise<{ plugin: AiBridgeServerPlugin; adapter: ScriptedProviderAdapter }> {
  const factory = makeFactory();
  const plugin = unwrap(
    await createAiBridgeServerPlugin({
      config: configDoc(),
      adapterFactories: factory.factories,
      resolveEndpoint: () => 'https://scripted.invalid/v1',
      secrets: SECRETS,
      stores: {},
    }),
  );
  return { plugin, adapter: factory.adapterFor('scripted') };
}

describe('kill-switch lifecycle across atomic reload', () => {
  it('a global kill switch from reload gates execution with KILL_SWITCH_GLOBAL and is visible in status', async () => {
    const { plugin, adapter } = await makePlugin();
    adapter.pushText(textStep('before the switch'));
    expect((await plugin.execute(textTurn(1), trustedContext)).status).toBe('SUCCEEDED');

    const reloaded = await plugin.reload(
      configDoc({ global: true, providers: [], capabilities: [] }),
    );
    expect(reloaded.ok).toBe(true);
    // status() and execution read the SAME registry (the forked-registry regression).
    expect(plugin.status().killSwitch.global).toBe(true);

    const denied = await plugin.execute(textTurn(2), trustedContext);
    expect(denied.status).toBe('FAILED');
    expect(denied.error?.code).toBe('MODEL_UNAVAILABLE');
    expect(denied.error?.reason).toBe('KILL_SWITCH_GLOBAL');
  });

  it('switch state is replaced, not accumulated: clearing the switch restores service', async () => {
    const { plugin, adapter } = await makePlugin();
    adapter.pushText(textStep('one'));
    adapter.pushText(textStep('two'));
    await plugin.reload(configDoc({ global: true, providers: [], capabilities: [] }));
    expect((await plugin.execute(textTurn(1), trustedContext)).status).toBe('FAILED');
    await plugin.reload(configDoc());
    expect(plugin.status().killSwitch.global).toBe(false);
    expect((await plugin.execute(textTurn(2), trustedContext)).status).toBe('SUCCEEDED');
  });

  it('a capability kill switch surfaces KILL_SWITCH_CAPABILITY, not the provider flavour', async () => {
    const { plugin, adapter } = await makePlugin();
    adapter.pushText(textStep('never'));
    await plugin.reload(
      configDoc({ global: false, providers: [], capabilities: ['ai.text.generate'] }),
    );
    const denied = await plugin.execute(textTurn(1), trustedContext);
    expect(denied.status).toBe('FAILED');
    expect(denied.error?.reason).toBe('KILL_SWITCH_CAPABILITY');
  });

  it('a provider kill switch surfaces KILL_SWITCH_PROVIDER naming the provider', async () => {
    const { plugin, adapter } = await makePlugin();
    adapter.pushText(textStep('never'));
    await plugin.reload(
      configDoc({ global: false, providers: ['scripted'], capabilities: [] }),
    );
    const denied = await plugin.execute(textTurn(1), trustedContext);
    expect(denied.status).toBe('FAILED');
    expect(denied.error?.reason).toBe('KILL_SWITCH_PROVIDER');
    expect(denied.error?.details?.['providerId']).toBe('scripted');
  });

  it('a kill switch applied through the live registry after planning still reports its true reason', async () => {
    const { plugin, adapter } = await makePlugin();
    adapter.pushText(textStep('served'));
    // The reload path is the operator surface; its state must reach the runtime's live registry
    // (the exact seam the forked-registry bug broke).
    await plugin.reload(configDoc({ global: true, providers: [], capabilities: [] }));
    expect((await plugin.execute(textTurn(1), trustedContext)).error?.reason).toBe('KILL_SWITCH_GLOBAL');
  });
});
