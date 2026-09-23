import { AIBRIDGE_CONTRACT_VERSION } from '@aibridge/contracts';
import { AiCapabilityDirectory, CapabilityRegistry, GENERIC_CAPABILITY_REGISTRATIONS, KillSwitchRegistry } from '@aibridge/core';
import { describe, expect, it } from 'vitest';

import { unwrap } from '../helpers/assertions.js';

function buildDirectory(): { directory: AiCapabilityDirectory; killSwitch: KillSwitchRegistry } {
  const registry = new CapabilityRegistry();
  for (const registration of GENERIC_CAPABILITY_REGISTRATIONS) {
    unwrap(registry.register(registration));
  }
  const killSwitch = new KillSwitchRegistry();
  return { directory: new AiCapabilityDirectory(registry, { killSwitch }), killSwitch };
}

describe('capability directory — "did the school turn AI off, or is AI broken?"', () => {
  it('reports governance-resolved status before any call', () => {
    const { directory, killSwitch } = buildDirectory();
    expect(directory.statusOf('ai.text.generate', '1.0')).toBe('AVAILABLE');
    expect(directory.getCapability('ai.text.generate')?.status).toBe('AVAILABLE');

    killSwitch.setCapability('ai.text.generate', true, '1.0');
    expect(directory.statusOf('ai.text.generate', '1.0')).toBe('DISABLED');
    // A different capability is untouched.
    expect(directory.statusOf('ai.structured.generate', '1.0')).toBe('AVAILABLE');
  });

  it('makes DISABLED win over the registered status, without becoming an error', () => {
    const { directory, killSwitch } = buildDirectory();
    killSwitch.setGlobal(true);
    for (const descriptor of directory.listCapabilities()) {
      expect(descriptor.status).toBe('DISABLED');
    }
    const status = unwrap(directory.getStatus());
    expect(status.global).toBe('DISABLED');
    expect(status.killSwitch.global).toBe(true);
    expect(status.capabilities).toHaveLength(2);
    // The Stage 5 additive compatibility bump (usage `reasoningTokens`, `RETRY_USED`, quota and
    // cost-budget reasons) raised the contract to `1.1`; major-compatible, so a `1.0` consumer is
    // still accepted. See the compatibility note in INTEGRATION_CONTRACT_V1.md.
    expect(status.contractVersion).toBe(AIBRIDGE_CONTRACT_VERSION);
  });

  it('returns null for an unknown capability and keeps the switch state visible', () => {
    const { directory, killSwitch } = buildDirectory();
    expect(directory.statusOf('ai.nope.generate', '1.0')).toBeNull();
    expect(directory.getCapability('ai.nope.generate')).toBeNull();
    killSwitch.setProvider('main', true);
    expect(unwrap(directory.getStatus()).killSwitch.providers).toEqual(['main']);
  });
});
