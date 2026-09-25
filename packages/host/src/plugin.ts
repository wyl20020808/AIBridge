/**
 * The host-bindable AI Bridge server plugin entry (ROADMAP Stage 6, ARCHITECTURE.md §1.2/§21).
 *
 * This is the **only** surface a host needs: it accepts host ports (secrets, governance stores,
 * observability sinks, a clock), a configuration document, and an injected adapter-factory table;
 * it constructs the runtime, registers the generic capabilities, and hands back a small object
 * with `execute`, discovery, `reload`, diagnostics and `dispose`.
 *
 * What it deliberately does **not** do:
 *
 *  - it names no host and imports no host internals (AGENTS.md §1);
 *  - it resolves no credential itself — credentials flow from the trusted secret port to the
 *    adapter's `bindCredentials` inside `AiRuntime.registerProvider` (SECURITY.md §2.3);
 *  - it never widens a caller's budget, permission or identity — those arrive in the trusted
 *    dispatch context the host mints (INTEGRATION_CONTRACT_V1 §8).
 *
 * A host that loads this entry stays in charge of: identity binding, permission decisions,
 * subject tokens, secret storage, persistence, and lifecycle.
 */
import {
  AIBRIDGE_CONTRACT_VERSION,
  createIssue,
  makeAiError,
  type AiBridgeStatus,
  type AiResult,
  type AiStreamEvent,
  type CapabilityDescriptor,
  type ValidationFailure,
  type ValidationResult,
} from '@aibridge/contracts';import { AiCapabilityDirectory, KillSwitchRegistry, type CapabilityRegistry } from '@aibridge/core';
import type { Clock, SecretStorePort } from '@aibridge/host-sdk';
import {
  IdempotencyRegistry,
  InMemoryIdempotencyStore,
  InMemoryQuotaStore,
  InMemoryRateLimitStore,
  QuotaManager,
  RateLimiter,
  type IdempotencyStorePort,
  type MetricsSink,
  type OperationalEventSink,
  type QuotaStorePort,
  type RateLimitStorePort,
  type UsageLedgerPort,
} from '@aibridge/governance';
import {
  AiRuntime,
  ConfigManager,
  canonicalJson,
  defaultAuthSchemeForPreset,
  defaultCapabilityRegistry,
  protocolForPreset,
  systemClock,
  type AdapterFactories,
  type AdapterFactorySpec,
  type ConfigSnapshotStorePort,
  type ExecuteOptions,
  type OperatorLogSink,
  type ProviderConfig,
  type ProviderDiagnostic,
  type RuntimeConfigSnapshot,
  type RuntimeLimits,
} from '@aibridge/runtime';
import { AIBRIDGE_PLUGIN_ID, aibridgePluginManifest, type AiBridgePluginManifest } from './manifest.js';

/** Host-owned state seams. Every one has a safe in-process default. */
export type AiBridgeHostStores = {
  /** Durable-enough idempotency (atomic claim required). Default: in-process, TTL-bounded. */
  readonly idempotency?: IdempotencyStorePort;
  /** Site-wide rate limiting (atomic window required). Default: in-process sliding window. */
  readonly rateLimit?: RateLimitStorePort;
  /** Quota reservations (atomic reserve required). Default: in-process bookkeeping. */
  readonly quota?: QuotaStorePort;
  /** Durable usage accounting. Default: in-process append-only ledger. */
  readonly usageLedger?: UsageLedgerPort;
  readonly metrics?: MetricsSink;
  readonly events?: OperationalEventSink;
  readonly operatorLog?: OperatorLogSink;
};

export type AiBridgeServerPluginOptions = {
  /** The plugin version surfaced by the manifest projection. */
  readonly pluginVersion?: string;
  /**
   * The whole runtime configuration document (`RuntimeConfigInput` shape: provider suite +
   * governance). Validated here, before anything is constructed — a bad document never produces
   * a half-alive plugin.
   */
  readonly config: unknown;
  /** Trusted bootstrap: how adapters are built. The provider packages own the constructors. */
  readonly adapterFactories: AdapterFactories;
  /** Resolves a provider endpoint from trusted configuration. Provider packages own the tables. */
  readonly resolveEndpoint: (provider: ProviderConfig) => string;
  /** The host secret store. Required whenever any provider declares a `credentialRef`. */
  readonly secrets?: SecretStorePort;
  readonly clock?: Clock;
  readonly stores?: AiBridgeHostStores;
  readonly limits?: RuntimeLimits;
  /** Where configuration history is kept. Default: in-process. */
  readonly configHistory?: ConfigSnapshotStorePort;
};

export type AiBridgeServerPlugin = {
  readonly id: string;
  readonly manifest: AiBridgePluginManifest;
  /** What this plugin provides, as manifest capability references (`id@major.x`). */
  readonly providesCapabilities: readonly string[];
  /** Operator escape hatch (health, metrics exporter). Not a consumer surface. */
  readonly runtime: AiRuntime;
  readonly directory: AiCapabilityDirectory;
  execute(request: unknown, trustedContext: unknown, options?: ExecuteOptions): Promise<AiResult<unknown>>;
  stream(request: unknown, trustedContext: unknown, options?: ExecuteOptions): AsyncIterable<AiStreamEvent>;
  listCapabilities(): readonly CapabilityDescriptor[];
  getCapability(id: string, version?: string): CapabilityDescriptor | null;
  status(): AiBridgeStatus;
  /**
   * Atomic configuration reload. An invalid candidate keeps the active snapshot (the
   * `ConfigManager` guarantee); a candidate that changes the provider **shape** rebuilds the
   * runtime around the same host stores, so Redis/Postgres-backed state survives.
   */
  reload(candidate: unknown): Promise<ValidationResult<RuntimeConfigSnapshot>>;
  /** Safe, credential-free provider diagnostics (operator channel). */
  diagnostics(): readonly ProviderDiagnostic[];
  /** The active configuration snapshot. */
  configSnapshot(): RuntimeConfigSnapshot;
  /** Reject further calls. Idempotent; host-owned stores are not touched. */
  dispose(): void;
};

const unavailableResult = (message: string): AiResult<unknown> => ({
  contractVersion: AIBRIDGE_CONTRACT_VERSION,
  requestId: 'unknown',
  capability: 'unknown',
  capabilityVersion: 'unknown',
  status: 'FAILED',
  error: makeAiError({ reason: 'NO_ROUTE', message, retryable: false }),
  usage: {},
  providerMetadata: {
    providerId: 'none',
    providerFamily: 'mock',
    modelClass: 'UNKNOWN',
    routeDepth: 0,
    attemptCount: 0,
    repaired: false,
  },
  latencyMs: 0,
  finishReason: 'UNKNOWN',
  warnings: [],
});

/** The provider facts that decide whether a reload can refresh in place or must rebuild. */
function providerShapeKey(snapshot: RuntimeConfigSnapshot): string {
  return canonicalJson(
    snapshot.input.suite.providers.map((provider) => ({
      providerId: provider.providerId,
      preset: provider.preset,
      enabled: provider.enabled,
      credentialRef: provider.credentialRef,
      endpoint: provider.endpoint,
      authScheme: provider.authScheme ?? defaultAuthSchemeForPreset(provider.preset),
      wireProtocol: provider.wireProtocol ?? protocolForPreset(provider.preset),
      models: provider.models,
    })),
  );
}

class ServerPlugin implements AiBridgeServerPlugin {
  readonly id = AIBRIDGE_PLUGIN_ID;
  readonly manifest: AiBridgePluginManifest;
  readonly providesCapabilities: readonly string[];
  readonly directory: AiCapabilityDirectory;
  readonly #options: AiBridgeServerPluginOptions;
  readonly #configManager: ConfigManager;
  /**
   * The ONE kill-switch registry, shared with the runtime and the capability directory. The
   * constructor receives the instance `create()` built — a field initializer here would silently
   * fork the state: reloads would apply to a registry nothing executes against.
   */
  readonly #killSwitches: KillSwitchRegistry;
  readonly #capabilities: CapabilityRegistry;
  #runtime: AiRuntime;
  #disposed = false;
  #shapeKey: string;

  private constructor(
    options: AiBridgeServerPluginOptions,
    configManager: ConfigManager,
    killSwitches: KillSwitchRegistry,
    capabilities: CapabilityRegistry,
    runtime: AiRuntime,
    shapeKey: string,
  ) {
    this.#options = options;
    this.#configManager = configManager;
    this.#killSwitches = killSwitches;
    this.#capabilities = capabilities;
    this.manifest = aibridgePluginManifest(options.pluginVersion);
    this.providesCapabilities = [...this.manifest.providesCapabilities];
    this.#runtime = runtime;
    this.#shapeKey = shapeKey;
    this.directory = new AiCapabilityDirectory(capabilities, { killSwitch: killSwitches });
    this.#applyKillSwitch();
  }

  get runtime(): AiRuntime {
    return this.#runtime;
  }

  /**
   * Validate the document, then construct everything. Construction is a straight line after
   * validation, so a failure never leaves a half-alive plugin behind.
   */
  static async create(options: AiBridgeServerPluginOptions): Promise<ValidationResult<AiBridgeServerPlugin>> {
    const clock = options.clock ?? systemClock();
    const events = options.stores?.events;
    const boot = ConfigManager.bootstrap(options.config, {
      clock,
      ...(events === undefined ? {} : { events }),
      ...(options.configHistory === undefined ? {} : { store: options.configHistory }),
    });
    if (!boot.ok) {
      return boot;
    }
    const snapshot = boot.value.active();
    const killSwitches = new KillSwitchRegistry();
    killSwitches.apply(snapshot.killSwitch);
    const capabilities = defaultCapabilityRegistry();
    const plugin = new ServerPlugin(
      options,
      boot.value,
      killSwitches,
      capabilities,
      pluginRuntime(options, boot.value, killSwitches, capabilities),
      providerShapeKey(snapshot),
    );
    const failure = await plugin.#registerProvidersOn(plugin.#runtime, snapshot.input.suite.providers);
    if (failure !== null) {
      return { ok: false, failure };
    }
    return { ok: true, value: plugin };
  }

  async execute(request: unknown, trustedContext: unknown, options?: ExecuteOptions): Promise<AiResult<unknown>> {
    if (this.#disposed) {
      return unavailableResult('This AI Bridge plugin instance has been disposed.');
    }
    return this.#runtime.execute(request, trustedContext, options);
  }

  stream(request: unknown, trustedContext: unknown, options?: ExecuteOptions): AsyncIterable<AiStreamEvent> {
    if (this.#disposed) {
      throw new Error('This AI Bridge plugin instance has been disposed.');
    }
    return this.#runtime.stream(request, trustedContext, options);
  }

  listCapabilities(): readonly CapabilityDescriptor[] {
    return this.directory.listCapabilities();
  }

  getCapability(id: string, version?: string): CapabilityDescriptor | null {
    return this.directory.getCapability(id, version);
  }

  status(): AiBridgeStatus {
    const status = this.directory.getStatus();
    return status.ok
      ? status.value
      : {
          contractVersion: AIBRIDGE_CONTRACT_VERSION,
          global: this.#disposed ? 'UNAVAILABLE' : 'AVAILABLE',
          killSwitch: {
            global: this.#killSwitches.state.global,
            providers: [...this.#killSwitches.state.providers],
            capabilities: [...this.#killSwitches.state.capabilities],
          },
          capabilities: [],
        };
  }

  async reload(candidate: unknown): Promise<ValidationResult<RuntimeConfigSnapshot>> {
    if (this.#disposed) {
      return {
        ok: false,
        failure: {
          reason: 'INTERNAL_ERROR',
          code: 'INTERNAL',
          stage: 'INTERNAL',
          issues: [createIssue('INVARIANT_VIOLATION', '$', 'the plugin is disposed')],
        },
      };
    }
    const reloaded = await this.#configManager.reload(candidate);
    if (!reloaded.ok) {
      // The previous snapshot stays active — the ConfigManager guarantee. Nothing else moves.
      return reloaded;
    }
    this.#applyKillSwitch();
    if (providerShapeKey(reloaded.value) !== this.#shapeKey) {
      // Provider set changed: rebuild around the previous runtime's live governance services,
      // so quota/rate/idempotency counters survive the swap (F17). Host-provided stores stay
      // referenced through those same registry objects; only a first bootstrap builds fresh
      // in-memory state. Registration touches no governance, so a failed rebuild below leaves
      // the live registries untouched.
      const previousRuntime = this.#runtime;
      const rebuilt = pluginRuntime(this.#options, this.#configManager, this.#killSwitches, this.#capabilities, previousRuntime);
      const failure = await this.#registerProvidersOn(rebuilt, reloaded.value.input.suite.providers);
      if (failure !== null) {
        // The new snapshot is active but unusable: roll back so "active" and "servable" agree.
        await this.#configManager.rollback();
        this.#applyKillSwitch();
        return { ok: false, failure };
      }
      this.#runtime = rebuilt;
      this.#shapeKey = providerShapeKey(reloaded.value);
      // The superseded runtime's adapters are released. In-flight calls already captured
      // their adapter references and run to their own terminal; governance registries are
      // shared with the rebuilt runtime and are untouched by `dispose`.
      void previousRuntime.dispose();
    }
    // Tuning-only changes (breaker thresholds, idempotency window) take effect on the live
    // runtime without dropping observed breaker state; a rebuilt runtime already matches.
    this.#runtime.syncGovernanceTuning();
    return reloaded;
  }

  diagnostics(): readonly ProviderDiagnostic[] {
    const snapshot = this.#configManager.active();
    return snapshot.input.suite.providers.map((provider) => ({
      providerId: provider.providerId,
      preset: provider.preset,
      family: familyForPreset(provider.preset),
      enabled: provider.enabled,
      authScheme: provider.authScheme ?? defaultAuthSchemeForPreset(provider.preset),
      wireProtocol: provider.wireProtocol ?? protocolForPreset(provider.preset),
      endpoint: this.#options.resolveEndpoint(provider),
      credential: { handle: provider.credentialRef, bound: this.#runtime.providerIds.includes(provider.providerId) },
      models: provider.models.map((model) => ({
        alias: model.alias,
        providerModelId: model.providerModelId,
        profiles: [...model.profiles],
        declaredFeatures: [...model.features],
        verifiedFeatures: [...(model.verifiedFeatures ?? [])],
        featureStatus: featureStatusOf(model),
      })),
      lastProbe: null,
    }));
  }

  configSnapshot(): RuntimeConfigSnapshot {
    return this.#configManager.active();
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    // Shut adapters down in the background: `AiRuntime.dispose` never rejects (adapter
    // shutdown failures are swallowed), so fire-and-forget is safe and keeps this
    // long-standing sync lifecycle signature. New calls already fail closed above.
    void this.#runtime.dispose();
  }

  #applyKillSwitch(): void {
    this.#killSwitches.apply(this.#configManager.active().killSwitch);
  }

  async #registerProvidersOn(
    runtime: AiRuntime,
    providers: readonly ProviderConfig[],
  ): Promise<ValidationFailure | null> {
    for (const provider of providers) {
      if (!provider.enabled) {
        continue;
      }
      const factory = this.#options.adapterFactories[provider.preset];
      if (factory === undefined) {
        return {
          reason: 'MALFORMED_ENVELOPE',
          code: 'INVALID_REQUEST',
          stage: 'ENVELOPE',
          issues: [
            createIssue('INVALID_VALUE', `$.suite.providers.${provider.providerId}`, `no adapter factory is registered for preset "${provider.preset}"`),
          ],
        };
      }
      const spec: AdapterFactorySpec = {
        providerId: provider.providerId,
        preset: provider.preset,
        baseUrl: this.#options.resolveEndpoint(provider),
        authScheme: provider.authScheme ?? defaultAuthSchemeForPreset(provider.preset),
        wireProtocol: provider.wireProtocol ?? protocolForPreset(provider.preset),
        allowPrivateNetworkForDevelopment: provider.allowPrivateNetworkForDevelopment === true,
        models: provider.models,
      };
      const registration = await runtime.registerProvider({
        adapter: factory(spec),
        ...(provider.credentialRef === undefined ? {} : { credentialRef: provider.credentialRef }),
      });
      if (!registration.ok) {
        return registration.failure;
      }
    }
    return null;
  }
}

function familyForPreset(preset: ProviderConfig['preset']): string {
  switch (preset) {
    case 'OPENAI_OFFICIAL':
      return 'openai';
    case 'DEEPSEEK_OFFICIAL':
      return 'deepseek';
    case 'XIAOMI_TOKENPLAN':
      return 'xiaomi';
    default:
      return 'openai-compatible';
  }
}

function featureStatusOf(model: ProviderConfig['models'][number]): Readonly<Partial<Record<string, string>>> {
  const status: Record<string, string> = {};
  for (const feature of model.features) {
    status[feature] = (model.verifiedFeatures ?? []).includes(feature) ? 'VERIFIED' : 'DECLARED';
  }
  return status;
}

/** Build the runtime over host stores. One function so bootstrap and reload construct identically. */
function pluginRuntime(
  options: AiBridgeServerPluginOptions,
  configManager: ConfigManager,
  killSwitches: KillSwitchRegistry,
  capabilities: CapabilityRegistry,
  previous?: AiRuntime,
): AiRuntime {
  const stores = options.stores ?? {};
  const clock = options.clock ?? systemClock();
  const idempotencyTuning = configManager.active().governance.idempotency;
  // F17: a rebuild reuses the live registries so counters survive the swap. Quota/rate
  // policies are passed per call from the active snapshot (quota.ts, rate-limit.ts), so
  // sharing the managers across snapshots is safe; `syncGovernanceTuning` retunes breaker
  // thresholds and the idempotency window right after the swap.
  const previousGovernance = previous?.governanceServices;
  const idempotency =
    previousGovernance?.idempotency ??
    new IdempotencyRegistry({
      store:
        stores.idempotency ??
        new InMemoryIdempotencyStore({
          clock,
          ...(idempotencyTuning.retentionMs === undefined ? {} : { retentionMs: idempotencyTuning.retentionMs }),
          ...(idempotencyTuning.capacity === undefined ? {} : { capacity: idempotencyTuning.capacity }),
        }),
      clock,
      ...(idempotencyTuning.retentionMs === undefined ? {} : { retentionMs: idempotencyTuning.retentionMs }),
    });
  const rateLimiter =
    previousGovernance?.rateLimiter ?? new RateLimiter({ store: stores.rateLimit ?? new InMemoryRateLimitStore(), clock });
  const quotas =
    previousGovernance?.quotas ??
    new QuotaManager({ store: stores.quota ?? new InMemoryQuotaStore(), clock, policies: configManager.active().governance.quotas });
  return new AiRuntime({
    configManager,
    capabilities,
    ...(options.secrets === undefined ? {} : { secrets: options.secrets }),
    clock,
    killSwitches,
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    ...(stores.operatorLog === undefined ? {} : { operatorLog: stores.operatorLog }),
    services: {
      ...(stores.metrics === undefined ? {} : { metrics: stores.metrics }),
      ...(stores.events === undefined ? {} : { events: stores.events }),
      ...(stores.usageLedger === undefined ? {} : { ledger: stores.usageLedger }),
      idempotency,
      rateLimiter,
      quotas,
    },
  });
}

/**
 * Construct the plugin. Async because provider registration resolves credentials through the
 * secret port. A failure is a validation failure — never a thrown half-constructed plugin.
 */
export async function createAiBridgeServerPlugin(
  options: AiBridgeServerPluginOptions,
): Promise<ValidationResult<AiBridgeServerPlugin>> {
  return ServerPlugin.create(options);
}
