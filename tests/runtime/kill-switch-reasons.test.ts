/**
 * Kill-switch **reason fidelity** at the coordinator (Stage 6 regression).
 *
 * The coordinator merges the live registry state with the request-bound configuration snapshot
 * and skips every blocked target. When a chain is exhausted by kills, the terminal error must
 * carry the verdict's true reason (`KILL_SWITCH_GLOBAL` / `KILL_SWITCH_CAPABILITY` /
 * `KILL_SWITCH_PROVIDER`) — the closed vocabulary distinguishes them deliberately, and an
 * operator debugging a global shutdown must not be sent hunting for a provider switch.
 *
 * The scenario is deterministic: the live registry is clean while the bound snapshot carries the
 * kill, so candidate enumeration (registry-only) admits targets and the merged check blocks them
 * at dispatch time — exactly the path that used to fabricate `KILL_SWITCH_PROVIDER`.
 */
import { describe, expect, it } from 'vitest';
import { KillSwitchRegistry } from '@aibridge/core';
import type { FakeStep } from '../helpers/reliability.js';
import { callerContext, makeHarness, textTurn } from '../helpers/reliability.js';

const neverUsed = (): FakeStep => ({ kind: 'text', text: 'never used' });

describe('chain-exhausted kill-switch errors', () => {
  it('a global kill in the bound snapshot surfaces KILL_SWITCH_GLOBAL', async () => {
    const harness = makeHarness({
      providers: [{ id: 'primary', behavior: neverUsed }],
      governance: { killSwitch: { global: true, providers: [], capabilities: [] } },
      killSwitches: new KillSwitchRegistry(),
    });
    const result = await harness.runtime.execute(textTurn(1), callerContext);
    expect(result.status).toBe('FAILED');
    expect(result.error?.code).toBe('MODEL_UNAVAILABLE');
    expect(result.error?.reason).toBe('KILL_SWITCH_GLOBAL');
  });

  it('a capability kill in the bound snapshot surfaces KILL_SWITCH_CAPABILITY', async () => {
    const harness = makeHarness({
      providers: [{ id: 'primary', behavior: neverUsed }],
      governance: { killSwitch: { global: false, providers: [], capabilities: ['ai.text.generate'] } },
      killSwitches: new KillSwitchRegistry(),
    });
    const result = await harness.runtime.execute(textTurn(1), callerContext);
    expect(result.status).toBe('FAILED');
    expect(result.error?.reason).toBe('KILL_SWITCH_CAPABILITY');
    expect(result.error?.details?.['capability']).toBe('ai.text.generate');
  });

  it('a provider kill in the bound snapshot surfaces KILL_SWITCH_PROVIDER naming the provider', async () => {
    const harness = makeHarness({
      providers: [
        { id: 'primary', behavior: neverUsed },
        { id: 'secondary', behavior: neverUsed },
      ],
      governance: {
        killSwitch: { global: false, providers: ['primary', 'secondary'], capabilities: [] },
      },
      killSwitches: new KillSwitchRegistry(),
    });
    const result = await harness.runtime.execute(textTurn(1), callerContext);
    expect(result.status).toBe('FAILED');
    expect(result.error?.reason).toBe('KILL_SWITCH_PROVIDER');
  });

  it('the live registry still outranks everything and keeps its own reason', async () => {
    const live = new KillSwitchRegistry();
    live.apply({ global: false, providers: [], capabilities: ['ai.text.generate'] });
    const harness = makeHarness({
      providers: [{ id: 'primary', behavior: neverUsed }],
      killSwitches: live,
    });
    const result = await harness.runtime.execute(textTurn(1), callerContext);
    expect(result.status).toBe('FAILED');
    expect(result.error?.reason).toBe('KILL_SWITCH_CAPABILITY');
  });
});
