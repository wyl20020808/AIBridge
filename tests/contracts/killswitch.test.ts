import {
  emptyKillSwitch,
  isCapabilityKilled,
  isProviderKilled,
  parseKillSwitchState,
  resolveKillSwitch,
} from '@aibridge/contracts';
import { describe, expect, it } from 'vitest';

import { unwrap, unwrapFailure } from '../helpers/assertions.js';

describe('kill-switch contract — governance, resolved global → capability → provider', () => {
  it('parses a state and rejects duplicates and unknown fields', () => {
    const state = unwrap(parseKillSwitchState({ global: false, providers: ['main', 'local'], capabilities: ['ai.text.generate@1'] }));
    expect(state.providers).toEqual(['main', 'local']);
    expect(unwrapFailure(parseKillSwitchState({ global: false, providers: ['main', 'main'], capabilities: [] })).issues.some(
      (issue) => issue.code === 'DUPLICATE_FIELD',
    )).toBe(true);
    expect(unwrapFailure(parseKillSwitchState({ global: false, providers: [], capabilities: [], extra: 1 })).reason).toBe(
      'MALFORMED_ENVELOPE',
    );
    expect(unwrapFailure(parseKillSwitchState({ global: 'no', providers: [], capabilities: [] })).reason).toBe(
      'MALFORMED_ENVELOPE',
    );
  });

  it('matches a capability by bare id or id@major', () => {
    expect(isCapabilityKilled({ global: false, providers: [], capabilities: ['ai.text.generate'] }, 'ai.text.generate', '1.0')).toBe(
      true,
    );
    expect(isCapabilityKilled({ global: false, providers: [], capabilities: ['ai.text.generate@1'] }, 'ai.text.generate', '1.0')).toBe(
      true,
    );
    expect(isCapabilityKilled(emptyKillSwitch(), 'ai.text.generate', '1.0')).toBe(false);
    expect(isProviderKilled({ global: false, providers: ['main'], capabilities: [] }, 'main')).toBe(true);
  });

  it('applies global before capability before provider', () => {
    const global = resolveKillSwitch(
      { global: true, providers: [], capabilities: [] },
      { capability: 'ai.text.generate', capabilityVersion: '1.0', candidateProviders: ['main'] },
    );
    expect(global).toEqual({ allowed: false, reason: 'KILL_SWITCH_GLOBAL' });

    const capability = resolveKillSwitch(
      { global: false, providers: [], capabilities: ['ai.text.generate'] },
      { capability: 'ai.text.generate', capabilityVersion: '1.0', candidateProviders: ['main'] },
    );
    expect(capability).toEqual({ allowed: false, reason: 'KILL_SWITCH_CAPABILITY', capability: 'ai.text.generate' });
  });

  it('reports KILL_SWITCH_PROVIDER only when no candidate survives', () => {
    const allDown = resolveKillSwitch(
      { global: false, providers: ['main', 'local'], capabilities: [] },
      { capability: 'ai.text.generate', capabilityVersion: '1.0', candidateProviders: ['main', 'local'] },
    );
    expect(allDown).toEqual({ allowed: false, reason: 'KILL_SWITCH_PROVIDER', providerId: 'main' });

    const survivor = resolveKillSwitch(
      { global: false, providers: ['main'], capabilities: [] },
      { capability: 'ai.text.generate', capabilityVersion: '1.0', candidateProviders: ['main', 'local'] },
    );
    expect(survivor).toEqual({ allowed: true, availableProviders: ['local'] });
  });

  it('does not treat an empty candidate list as a provider outage', () => {
    const verdict = resolveKillSwitch(
      { global: false, providers: ['everything'], capabilities: [] },
      { capability: 'ai.text.generate', capabilityVersion: '1.0', candidateProviders: [] },
    );
    expect(verdict).toEqual({ allowed: true, availableProviders: [] });
  });
});
