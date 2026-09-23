/**
 * `AiCapabilityDirectory` (CAPABILITIES.md §6).
 *
 * Discovery answers the question a consumer must never have to guess: **"did the school turn AI
 * off, or is AI broken?"** A kill switch reports `DISABLED` here, before a call is made, so a
 * learner sees a degraded learning turn rather than an error page (ARCHITECTURE.md §20).
 *
 * The projection is deliberately poor in information: descriptors carry no provider ids, no model
 * names, no prices, no endpoints. A consumer that learns the topology starts depending on it.
 */
import {
  AIBRIDGE_CONTRACT_VERSION,
  valid,
  type AiBridgeStatus,
  type CapabilityAvailability,
  type CapabilityDescriptor,
  type CapabilityStatusEntry,
  type ValidationResult,
} from '@aibridge/contracts';
import { KillSwitchRegistry } from './killswitch.js';
import { CapabilityRegistry, toCapabilityDescriptor } from './registry.js';

export type CapabilityDirectoryOptions = {
  /** When absent, no governance is applied and every capability reports its registered status. */
  readonly killSwitch?: KillSwitchRegistry;
};

export class AiCapabilityDirectory {
  readonly #registry: CapabilityRegistry;
  readonly #killSwitch: KillSwitchRegistry | undefined;

  constructor(registry: CapabilityRegistry, options: CapabilityDirectoryOptions = {}) {
    this.#registry = registry;
    this.#killSwitch = options.killSwitch;
  }

  /** The governance-resolved status of one capability. `DISABLED` wins over any registered status. */
  statusOf(capability: string, version: string): CapabilityAvailability | null {
    const registration = this.#registry.getRegistration(capability, version);
    if (registration === null) {
      return null;
    }
    if (this.#killSwitch?.state.global === true) {
      return 'DISABLED';
    }
    if (this.#killSwitch?.isCapabilityDisabled(capability, registration.version) === true) {
      return 'DISABLED';
    }
    return registration.status ?? 'AVAILABLE';
  }

  /** Every capability, with governance applied. */
  listCapabilities(): readonly CapabilityDescriptor[] {
    return this.#registry.listRegistrations().map((registration) =>
      toCapabilityDescriptor(registration, this.statusOf(registration.id, registration.version) ?? 'AVAILABLE'),
    );
  }

  /** One capability, or `null`. A pinned version resolves by major; an omitted one picks the highest. */
  getCapability(id: string, version?: string): CapabilityDescriptor | null {
    const registration = this.#registry.getRegistration(id, version);
    if (registration === null) {
      return null;
    }
    return toCapabilityDescriptor(registration, this.statusOf(registration.id, registration.version) ?? 'AVAILABLE');
  }

  /** The bridge's own status, including the raw switch state so "off" and "broken" stay distinct. */
  getStatus(): ValidationResult<AiBridgeStatus> {
    const capabilities: CapabilityStatusEntry[] = this.listCapabilities().map((descriptor) => ({
      id: descriptor.id,
      version: descriptor.version,
      status: descriptor.status,
    }));
    const global: CapabilityAvailability = this.#killSwitch?.state.global === true ? 'DISABLED' : 'AVAILABLE';
    const state = this.#killSwitch?.state ?? { global: false, providers: [], capabilities: [] };
    return valid({
      contractVersion: AIBRIDGE_CONTRACT_VERSION,
      global,
      killSwitch: {
        global: state.global,
        providers: [...state.providers],
        capabilities: [...state.capabilities],
      },
      capabilities,
    });
  }
}
