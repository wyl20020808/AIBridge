/**
 * The governance kill-switch registry (ARCHITECTURE.md §20).
 *
 * A mutable holder around the pure contract resolver. Governance is orthogonal to execution: the
 * registry never routes, it only says whether routing may begin. Global / capability / provider
 * precedence lives in `resolveKillSwitch` so every component agrees on it.
 */
import {
  capabilityKey,
  emptyKillSwitch,
  makeAiError,
  resolveKillSwitch,
  type AiError,
  type KillSwitchBlocked,
  type KillSwitchQuery,
  type KillSwitchState,
  type KillSwitchVerdict,
} from '@aibridge/contracts';

export class KillSwitchRegistry {
  #state: KillSwitchState = emptyKillSwitch();

  get state(): KillSwitchState {
    return this.#state;
  }

  /** Replace the whole state (config load / atomic reload). */
  apply(state: KillSwitchState): void {
    this.#state = { global: state.global, providers: [...state.providers], capabilities: [...state.capabilities] };
  }

  setGlobal(enabled: boolean): void {
    this.#state = { ...this.#state, global: enabled };
  }

  setProvider(providerId: string, enabled: boolean): void {
    const providers = new Set(this.#state.providers);
    if (enabled) {
      providers.add(providerId);
    } else {
      providers.delete(providerId);
    }
    this.#state = { ...this.#state, providers: [...providers].sort() };
  }

  /** `version` may be omitted; a capability is then killed by its bare id. */
  setCapability(capability: string, enabled: boolean, version?: string): void {
    const key = version === undefined ? capability : capabilityKey(capability, version);
    const capabilities = new Set(this.#state.capabilities);
    if (enabled) {
      capabilities.add(key);
    } else {
      capabilities.delete(key);
    }
    this.#state = { ...this.#state, capabilities: [...capabilities].sort() };
  }

  isProviderDisabled(providerId: string): boolean {
    return this.#state.providers.includes(providerId);
  }

  isCapabilityDisabled(capability: string, version: string): boolean {
    if (this.#state.global) {
      return true;
    }
    const key = capabilityKey(capability, version);
    return this.#state.capabilities.includes(key) || this.#state.capabilities.includes(capability);
  }

  /** Apply the switches to one prospective call. */
  resolve(query: KillSwitchQuery): KillSwitchVerdict {
    return resolveKillSwitch(this.#state, query);
  }

  clear(): void {
    this.#state = emptyKillSwitch();
  }
}

/** Map a blocked verdict to the normalized error a consumer receives. */
export function killSwitchError(blocked: KillSwitchBlocked): AiError {
  switch (blocked.reason) {
    case 'KILL_SWITCH_GLOBAL':
      return makeAiError({
        reason: 'KILL_SWITCH_GLOBAL',
        message: 'AI is disabled by the operator for this deployment.',
      });
    case 'KILL_SWITCH_PROVIDER':
      return makeAiError({
        reason: 'KILL_SWITCH_PROVIDER',
        message: 'Every provider that could serve this capability is switched off.',
        ...(blocked.providerId === undefined ? {} : { details: { providerId: blocked.providerId } }),
      });
    case 'KILL_SWITCH_CAPABILITY':
      return makeAiError({
        reason: 'KILL_SWITCH_CAPABILITY',
        message: 'This capability is switched off by the operator.',
        ...(blocked.capability === undefined ? {} : { details: { capability: blocked.capability } }),
      });
    default: {
      const exhaustive: never = blocked.reason;
      void exhaustive;
      return makeAiError({ reason: 'KILL_SWITCH_GLOBAL', message: 'AI is disabled by the operator for this deployment.' });
    }
  }
}

/** The error for a blocked verdict, or `null` when the call may proceed. */
export function verdictError(verdict: KillSwitchVerdict): AiError | null {
  return verdict.allowed ? null : killSwitchError(verdict);
}
