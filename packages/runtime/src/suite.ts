/**
 * Materializing a provider suite: config → adapters → `AiRuntime` (ROADMAP Stage 4 §21–23, §27, §44).
 *
 * The runtime package must not depend on any provider package, so adapter construction arrives as
 * an injected **factory table** keyed by preset: the trusted bootstrap (a test, the live harness, a
 * future host integration) owns the concrete `new OpenAiAdapter(…)` calls; this module owns the
 * deterministic wiring — endpoint resolution, alias → model resolution, profile routing, and the
 * safe diagnostics projection.
 *
 * `ProviderDiagnostic` is operator-facing and credential-free by construction: it may show ids,
 * aliases, declared/verified features and probe status; it can never show a key, a credential, an
 * Authorization header or a raw provider error body (Phase 44).
 */
import {
  type AiProviderAdapter,
  type ModelProfile,
  type ProviderFeature,
  type ValidationResult,
  createIssue,
  invalid,
  valid,
} from '@aibridge/contracts';
import { KillSwitchRegistry, type CapabilityRegistry } from '@aibridge/core';
import type { Clock, SecretStorePort } from '@aibridge/host-sdk';
import { AiRuntime, type RuntimeRoutes, type RuntimeOptions } from './runtime.js';
import type { OperatorLogSink } from './operator-log.js';
import {
  featureStatus,
  resolveModelAlias,
  type ConfigAuthScheme,
  type ConfigWireProtocol,
  type FeatureAssurance,
  type ModelAliasConfig,
  type ProviderConfig,
  type ProviderPreset,
  type ProviderSuiteConfig,
} from './config.js';

/** What a factory needs to build one adapter. Endpoint text is resolved here, never guessed. */
export type AdapterFactorySpec = {
  readonly providerId: string;
  readonly preset: ProviderPreset;
  readonly baseUrl: string;
  readonly authScheme: ConfigAuthScheme;
  readonly wireProtocol: ConfigWireProtocol;
  readonly allowPrivateNetworkForDevelopment: boolean;
  /** Operator-side model specs (alias → real model id mapping included). */
  readonly models: readonly ModelAliasConfig[];
};

export type AdapterFactory = (spec: AdapterFactorySpec) => AiProviderAdapter;

export type AdapterFactories = Partial<Record<ProviderPreset, AdapterFactory>>;

export type MaterializeOptions = {
  readonly factories: AdapterFactories;
  readonly secrets?: SecretStorePort;
  readonly clock?: Clock;
  readonly killSwitches?: KillSwitchRegistry;
  readonly capabilities?: CapabilityRegistry;
  readonly operatorLog?: OperatorLogSink;
  /** Resolve a preset/cluster endpoint. The provider packages own their endpoint tables. */
  readonly resolveEndpoint: (provider: ProviderConfig) => string;
  /** Non-generative probe is opt-in only; nothing here ever probes (Phase 26). */
  readonly fetch?: never;
};

export type MaterializedProvider = {
  readonly config: ProviderConfig;
  readonly adapter: AiProviderAdapter;
};

export type ProviderSuiteRuntime = {
  readonly runtime: AiRuntime;
  readonly providers: readonly MaterializedProvider[];
  readonly routes: RuntimeRoutes;
  /** The safe diagnostics projection (operator channel). */
  diagnostics(): readonly ProviderDiagnostic[];
  /**
   * Record qualification evidence: mark declared features as VERIFIED for one model alias.
   * Evidence is per-model and per-feature — one probe never validates every capability (Phase 27).
   */
  recordQualification(alias: string, verified: readonly ProviderFeature[]): void;
};

export type ModelDiagnostic = {
  readonly alias: string;
  /** Operator-side real model id. Never consumer-visible. */
  readonly providerModelId: string;
  readonly profiles: readonly ModelProfile[];
  readonly declaredFeatures: readonly ProviderFeature[];
  readonly verifiedFeatures: readonly ProviderFeature[];
  readonly featureStatus: Readonly<Partial<Record<ProviderFeature, FeatureAssurance>>>;
};

export type ProviderDiagnostic = {
  readonly providerId: string;
  readonly preset: ProviderPreset;
  readonly family: string;
  readonly enabled: boolean;
  readonly authScheme: ConfigAuthScheme;
  readonly wireProtocol: ConfigWireProtocol;
  /** The resolved endpoint (operator channel). Never a credential. */
  readonly endpoint: string;
  /** The credential **handle** and whether one is bound. Never the value. */
  readonly credential: { readonly handle: string; readonly bound: boolean };
  readonly models: readonly ModelDiagnostic[];
  /** Non-generative probe outcome, when one was run manually. */
  readonly lastProbe: { readonly status: string; readonly atMs: number } | null;
};

/** The wire protocol each preset speaks. A mismatch is rejected at config validation. */
export function protocolForPreset(preset: ProviderPreset): ConfigWireProtocol {
  return preset === 'OPENAI_OFFICIAL' ? 'OPENAI_RESPONSES' : 'OPENAI_CHAT_COMPLETIONS';
}

/** The safe default auth scheme per preset (overridable per provider). */
export function defaultAuthSchemeForPreset(preset: ProviderPreset): ConfigAuthScheme {
  return preset === 'XIAOMI_TOKENPLAN' ? 'API_KEY_HEADER' : 'BEARER';
}

/** Build the profile → alias-resolved route table the existing `resolveRoute` consumes. */
export function buildRuntimeRoutes(config: ProviderSuiteConfig): RuntimeRoutes {
  const routes: Partial<Record<ModelProfile, readonly { providerId: string; modelRef: string }[]>> = {};
  for (const route of config.routes) {
    const entries = route.chain.flatMap((alias) => {
      const resolved = resolveModelAlias(config, alias);
      return resolved === null
        ? []
        : [{ providerId: resolved.provider.providerId, modelRef: resolved.model.providerModelId }];
    });
    routes[route.profile] = entries;
  }
  return routes;
}

/**
 * Materialize a suite: construct adapters through the injected factories (enabled providers only),
 * bind credentials through the trusted secret port, and build one `AiRuntime` over the routes.
 */
export async function materializeProviderSuite(
  config: ProviderSuiteConfig,
  options: MaterializeOptions,
): Promise<ValidationResult<ProviderSuiteRuntime>> {
  const routes = buildRuntimeRoutes(config);
  const runtime = new AiRuntime({
    routes,
    ...(options.capabilities === undefined ? {} : { capabilities: options.capabilities }),
    ...(options.secrets === undefined ? {} : { secrets: options.secrets }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.killSwitches === undefined ? {} : { killSwitches: options.killSwitches }),
    ...(options.operatorLog === undefined ? {} : { operatorLog: options.operatorLog }),
  });

  const materialized: MaterializedProvider[] = [];
  const qualifications = new Map<string, Readonly<Partial<Record<ProviderFeature, FeatureAssurance>>>>();
  const probes = new Map<string, { readonly status: string; readonly atMs: number }>();

  for (const provider of config.providers) {
    if (!provider.enabled) {
      continue;
    }
    const factory = options.factories[provider.preset];
    if (factory === undefined) {
      return invalid('MALFORMED_ENVELOPE', [
        createIssue('MISSING_FIELD', `$.providers.${provider.providerId}`, `no adapter factory for preset "${provider.preset}"`),
      ]);
    }
    const adapter = factory({
      providerId: provider.providerId,
      preset: provider.preset,
      baseUrl: options.resolveEndpoint(provider),
      authScheme: provider.authScheme ?? defaultAuthSchemeForPreset(provider.preset),
      wireProtocol: provider.wireProtocol ?? protocolForPreset(provider.preset),
      allowPrivateNetworkForDevelopment: provider.allowPrivateNetworkForDevelopment === true,
      models: provider.models,
    });
    // Adapters built by the factory carry their own descriptors; align the runtime's model view
    // with the config's alias declarations so routing and diagnostics cannot drift.
    for (const model of provider.models) {
      qualifications.set(model.alias, featureStatus(model));
    }
    const registration = await runtime.registerProvider({
      adapter,
      credentialRef: provider.credentialRef,
    });
    if (!registration.ok) {
      return invalid(registration.failure.reason, registration.failure.issues);
    }
    materialized.push({ config: provider, adapter });
  }

  return valid({
    runtime,
    providers: materialized,
    routes,
    diagnostics(): readonly ProviderDiagnostic[] {
      return materialized.map((entry) => ({
        providerId: entry.config.providerId,
        preset: entry.config.preset,
        family: entry.adapter.family,
        enabled: entry.config.enabled,
        authScheme: entry.config.authScheme ?? defaultAuthSchemeForPreset(entry.config.preset),
        wireProtocol: entry.config.wireProtocol ?? protocolForPreset(entry.config.preset),
        endpoint: options.resolveEndpoint(entry.config),
        credential: { handle: entry.config.credentialRef, bound: true },
        models: entry.config.models.map((model) => ({
          alias: model.alias,
          providerModelId: model.providerModelId,
          profiles: [...model.profiles],
          declaredFeatures: [...model.features],
          verifiedFeatures: [...(model.verifiedFeatures ?? [])],
          featureStatus: qualifications.get(model.alias) ?? featureStatus(model),
        })),
        lastProbe: probes.get(entry.config.providerId) ?? null,
      }));
    },
    recordQualification(alias: string, verified: readonly ProviderFeature[]): void {
      const current = qualifications.get(alias);
      if (current === undefined) {
        return;
      }
      const next: Partial<Record<ProviderFeature, FeatureAssurance>> = { ...current };
      for (const feature of verified) {
        if (current[feature] !== undefined) {
          next[feature] = 'VERIFIED';
        }
      }
      qualifications.set(alias, next);
    },
  });
}

/** The runtime options a suite consumer may extend (kept for hosts that wire manually). */
export type SuiteRuntimeOptions = RuntimeOptions;
