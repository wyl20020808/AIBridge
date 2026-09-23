import {
  InMemoryConfigPort,
  InMemoryIdentityPort,
  InMemoryKillSwitchAuthority,
  InMemoryPermissionPort,
  InMemorySubjectTokenPort,
  REDACTED,
  TestClock,
} from '@aibridge/host-sdk';
import { emptyKillSwitch } from '@aibridge/contracts';
import { describe, expect, it } from 'vitest';

describe('in-memory host ports', () => {
  it('binds and unbinds identity, returning null when unbound', () => {
    const identity = new InMemoryIdentityPort();
    expect(identity.currentCallerPluginId()).toBeNull();
    identity.bind('algoquest.learning-quests');
    expect(identity.currentCallerPluginId()).toBe('algoquest.learning-quests');
    identity.unbind();
    expect(identity.currentCallerPluginId()).toBeNull();
  });

  it('denies by default and supports capability@major grants', () => {
    const permissions = new InMemoryPermissionPort();
    expect(permissions.isCapabilityGranted('caller.plugin', 'ai.text.generate')).toBe(false);
    permissions.grant('caller.plugin', 'ai.text.generate@1');
    expect(permissions.isCapabilityGranted('caller.plugin', 'ai.text.generate', '1.0')).toBe(true);
    expect(permissions.declaredCapabilities('caller.plugin')).toEqual(['ai.text.generate@1']);
    permissions.revoke('caller.plugin', 'ai.text.generate@1');
    expect(permissions.isCapabilityGranted('caller.plugin', 'ai.text.generate', '1.0')).toBe(false);
  });

  it('mints or withholds an opaque subject token', () => {
    const tokens = new InMemorySubjectTokenPort();
    expect(tokens.mintSubjectToken()).toBeNull();
    tokens.setToken('subtok_opaque_host_minted_0001');
    expect(tokens.mintSubjectToken()).toBe('subtok_opaque_host_minted_0001');
  });

  it('notifies observers of config reload and kill-switch changes', () => {
    const config = new InMemoryConfigPort<{ flag: number }>({ flag: 1 });
    const seen: number[] = [];
    const unsubscribe = config.onReload((next) => seen.push(next.flag));
    config.set({ flag: 2 });
    unsubscribe();
    config.set({ flag: 3 });
    expect(seen).toEqual([2]);

    const killSwitch = new InMemoryKillSwitchAuthority();
    expect(killSwitch.currentState()).toEqual(emptyKillSwitch());
    const states: boolean[] = [];
    const off = killSwitch.onChange((state) => states.push(state.global));
    killSwitch.set({ global: true, providers: [], capabilities: [] });
    off();
    killSwitch.set({ global: false, providers: [], capabilities: [] });
    expect(states).toEqual([true]);
  });

  it('drives a deterministic clock', () => {
    const clock = new TestClock(100);
    expect(clock.nowMs()).toBe(100);
    clock.advance(50);
    expect(clock.nowMs()).toBe(150);
    clock.set(0);
    expect(clock.nowMs()).toBe(0);
  });

  it('exposes a redaction marker that is not the value it stands for', () => {
    expect(REDACTED).toBe('[REDACTED]');
  });
});
