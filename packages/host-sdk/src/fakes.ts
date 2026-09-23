/**
 * In-memory ports and **mutant** ports.
 *
 * The in-memory implementations are deterministic and dependency-free: good enough for contract
 * tests and for a host that has not been built yet. The mutants are deliberately wrong in exactly
 * one way each, so the host conformance kit can be shown to *catch* a violation rather than merely
 * assert a happy path.
 */
import type { KillSwitchState } from '@aibridge/contracts';
import { emptyKillSwitch } from '@aibridge/contracts';
import type {
  Clock,
  ConfigPort,
  HostServices,
  KillSwitchAuthorityPort,
  PermissionPort,
  PluginIdentityPort,
  SecretStorePort,
  SubjectTokenPort,
  UsageRecord,
  UsageStorePort,
} from './ports.js';

/** A redaction marker. Never the value it stands for. */
export const REDACTED = '[REDACTED]';

export class InMemoryIdentityPort implements PluginIdentityPort {
  #callerPluginId: string | null = null;

  bind(callerPluginId: string): void {
    this.#callerPluginId = callerPluginId;
  }

  unbind(): void {
    this.#callerPluginId = null;
  }

  currentCallerPluginId(): string | null {
    return this.#callerPluginId;
  }
}

export class InMemoryPermissionPort implements PermissionPort {
  readonly #granted = new Map<string, Set<string>>();

  grant(callerPluginId: string, capability: string): void {
    const set = this.#granted.get(callerPluginId) ?? new Set<string>();
    set.add(capability);
    this.#granted.set(callerPluginId, set);
  }

  revoke(callerPluginId: string, capability: string): void {
    this.#granted.get(callerPluginId)?.delete(capability);
  }

  isCapabilityGranted(callerPluginId: string, capability: string, capabilityVersion?: string): boolean {
    const set = this.#granted.get(callerPluginId);
    if (set === undefined) {
      return false;
    }
    if (set.has(capability)) {
      return true;
    }
    if (capabilityVersion !== undefined) {
      const major = capabilityVersion.split('.')[0];
      if (major !== undefined && set.has(`${capability}@${major}`)) {
        return true;
      }
    }
    return false;
  }

  declaredCapabilities(callerPluginId: string): readonly string[] {
    return [...(this.#granted.get(callerPluginId) ?? new Set<string>())].sort();
  }
}

export class InMemorySubjectTokenPort implements SubjectTokenPort {
  #token: string | null = null;

  setToken(token: string | null): void {
    this.#token = token;
  }

  mintSubjectToken(): string | null {
    return this.#token;
  }
}

/**
 * An in-memory secret store.
 *
 * The stored value is held in a private field and is excluded from `JSON.stringify`; the store's
 * own serialization is a redaction marker. A credential that survives `JSON.stringify` is how one
 * ends up in a log line (SECURITY.md §2.3).
 */
export class InMemorySecretStore implements SecretStorePort {
  readonly #secrets = new Map<string, string>();

  put(handle: string, value: string): void {
    this.#secrets.set(handle, value);
  }

  delete(handle: string): boolean {
    return this.#secrets.delete(handle);
  }

  async resolve(handle: string): Promise<string | null> {
    return this.#secrets.get(handle) ?? null;
  }

  async has(handle: string): Promise<boolean> {
    return this.#secrets.has(handle);
  }

  toJSON(): { readonly kind: string; readonly size: number } {
    return { kind: 'InMemorySecretStore', size: this.#secrets.size };
  }

  toString(): string {
    return `${REDACTED}(${this.#secrets.size} secret handle(s))`;
  }
}

export class InMemoryUsageStore implements UsageStorePort {
  readonly #records: UsageRecord[] = [];

  async append(record: UsageRecord): Promise<void> {
    this.#records.push(record);
  }

  async list(): Promise<readonly UsageRecord[]> {
    return [...this.#records];
  }

  get size(): number {
    return this.#records.length;
  }
}

export class InMemoryConfigPort<TConfig = unknown> implements ConfigPort<TConfig> {
  #config: TConfig;
  readonly #listeners = new Set<(config: TConfig) => void>();

  constructor(initial: TConfig) {
    this.#config = initial;
  }

  async load(): Promise<TConfig> {
    return this.#config;
  }

  onReload(callback: (config: TConfig) => void): () => void {
    this.#listeners.add(callback);
    return () => {
      this.#listeners.delete(callback);
    };
  }

  /** Atomically replace the config and notify observers. */
  set(config: TConfig): void {
    this.#config = config;
    for (const listener of this.#listeners) {
      listener(config);
    }
  }
}

export class InMemoryKillSwitchAuthority implements KillSwitchAuthorityPort {
  #state: KillSwitchState = emptyKillSwitch();
  readonly #listeners = new Set<(state: KillSwitchState) => void>();

  currentState(): KillSwitchState {
    return this.#state;
  }

  onChange(callback: (state: KillSwitchState) => void): () => void {
    this.#listeners.add(callback);
    return () => {
      this.#listeners.delete(callback);
    };
  }

  set(state: KillSwitchState): void {
    this.#state = state;
    for (const listener of this.#listeners) {
      listener(state);
    }
  }
}

/** A clock the test drives. */
export class TestClock implements Clock {
  #nowMs: number;

  constructor(nowMs = 0) {
    this.#nowMs = nowMs;
  }

  nowMs(): number {
    return this.#nowMs;
  }

  advance(ms: number): void {
    this.#nowMs += ms;
  }

  set(nowMs: number): void {
    this.#nowMs = nowMs;
  }
}

/** The default host: everything in memory, nothing surprising. */
export function makeInMemoryHost(): HostServices & {
  readonly identity: InMemoryIdentityPort;
  readonly permissions: InMemoryPermissionPort;
  readonly subjectTokens: InMemorySubjectTokenPort;
  readonly secrets: InMemorySecretStore;
  readonly usage: InMemoryUsageStore;
  readonly config: InMemoryConfigPort;
  readonly killSwitch: InMemoryKillSwitchAuthority;
  readonly clock: TestClock;
} {
  return {
    identity: new InMemoryIdentityPort(),
    permissions: new InMemoryPermissionPort(),
    subjectTokens: new InMemorySubjectTokenPort(),
    secrets: new InMemorySecretStore(),
    usage: new InMemoryUsageStore(),
    config: new InMemoryConfigPort<unknown>({}),
    killSwitch: new InMemoryKillSwitchAuthority(),
    clock: new TestClock(0),
  };
}

/* -------------------------------------------------------------------------------------------------
 * Mutants — each violates exactly one host expectation.
 * ----------------------------------------------------------------------------------------------- */

/** Identity returns an empty string instead of `null` when unbound. */
export class MutantEmptyIdentity implements PluginIdentityPort {
  currentCallerPluginId(): string | null {
    return '';
  }
}

/** Grants every capability to every caller: deny-by-default is gone. */
export class MutantPermissivePermissions implements PermissionPort {
  isCapabilityGranted(): boolean {
    return true;
  }

  declaredCapabilities(): readonly string[] {
    return ['*'];
  }
}

/** Mints an email address as a "subject token": an identity, not an opaque handle. */
export class MutantNonOpaqueSubjectTokens implements SubjectTokenPort {
  mintSubjectToken(): string | null {
    return 'learner@example.invalid';
  }
}

/** Resolves secrets correctly but also exposes them through `JSON.stringify`. */
export class MutantLeakySecretStore implements SecretStorePort {
  readonly leaked: Record<string, string> = {};

  async resolve(handle: string): Promise<string | null> {
    return this.leaked[handle] ?? null;
  }

  async has(handle: string): Promise<boolean> {
    return Object.prototype.hasOwnProperty.call(this.leaked, handle);
  }
}

/** Accepts usage records and silently drops them. */
export class MutantDroppingUsageStore implements UsageStorePort {
  async append(): Promise<void> {
    // deliberately drops the record
  }

  async list(): Promise<readonly UsageRecord[]> {
    return [];
  }
}

/** Reports a kill-switch state with a duplicate provider, which the contract rejects. */
export class MutantInvalidKillSwitchAuthority implements KillSwitchAuthorityPort {
  currentState(): KillSwitchState {
    return { global: false, providers: ['main', 'main'], capabilities: [] };
  }

  onChange(): () => void {
    return () => {
      // no-op
    };
  }
}

/** A clock that returns a non-finite value. */
export class MutantBrokenClock implements Clock {
  nowMs(): number {
    return Number.NaN;
  }
}

export type NamedHost = {
  readonly name: string;
  readonly host: HostServices;
};

function hostWith(overrides: Partial<HostServices>): HostServices {
  const base = makeInMemoryHost();
  return { ...base, ...overrides };
}

/** A host per mutation, for the conformance kit's negative tests. */
export function mutantHosts(): readonly NamedHost[] {
  return [
    { name: 'empty-identity', host: hostWith({ identity: new MutantEmptyIdentity() }) },
    { name: 'permissive-permissions', host: hostWith({ permissions: new MutantPermissivePermissions() }) },
    { name: 'non-opaque-subject-token', host: hostWith({ subjectTokens: new MutantNonOpaqueSubjectTokens() }) },
    { name: 'leaky-secret-store', host: hostWith({ secrets: new MutantLeakySecretStore() }) },
    { name: 'dropping-usage-store', host: hostWith({ usage: new MutantDroppingUsageStore() }) },
    { name: 'invalid-kill-switch', host: hostWith({ killSwitch: new MutantInvalidKillSwitchAuthority() }) },
    { name: 'broken-clock', host: hostWith({ clock: new MutantBrokenClock() }) },
  ];
}
