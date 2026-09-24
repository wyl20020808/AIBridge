/**
 * Multi-provider configuration — the operator's declaration of the provider suite
 * (ROADMAP Stage 4 §21–22, §41–43).
 *
 * This is a **config contract plus in-memory/fixture support only** — durable host configuration
 * is an integration-stage concern and OJPlatform's config system is untouched. Everything here is
 * trusted operator input; nothing in it is consumer-visible.
 *
 * Design rules enforced here:
 *  - **Model aliases, not model ids, in routes** (`openai.reasoning.primary`, …). The real model
 *    id is operator-side data resolved from this config.
 *  - **No silent degrade**: a route's fallback chain may only name models declared for that
 *    profile — a `reasoning` route can never quietly land on a `fast` model.
 *  - **Strict validation**: duplicate ids/aliases, unknown presets/profiles/features, unsafe
 *    endpoints, missing credential handles and invalid combinations are rejected outright.
 *  - **No raw credentials, ever.** Only `credentialRef` handles (`secret://…`).
 */
import {
  createIssue,
  invalid,
  isModelProfile,
  isProviderFeature,
  valid,
  type ModelProfile,
  type ProviderFeature,
  type ProviderPricing,
  type ValidationIssue,
  type ValidationResult,
} from '@aibridge/contracts';
import { checkEndpointSafety } from '@aibridge/core';

/** The four supported presets. A preset decides wire defaults and safe auth defaults only. */
export const PROVIDER_PRESETS = [
  'OPENAI_OFFICIAL',
  'DEEPSEEK_OFFICIAL',
  'XIAOMI_TOKENPLAN',
  'OPENAI_COMPATIBLE_CUSTOM',
] as const;

export type ProviderPreset = (typeof PROVIDER_PRESETS)[number];

export const CONFIG_WIRE_PROTOCOLS = ['OPENAI_RESPONSES', 'OPENAI_CHAT_COMPLETIONS'] as const;

export type ConfigWireProtocol = (typeof CONFIG_WIRE_PROTOCOLS)[number];

export const CONFIG_AUTH_SCHEMES = ['BEARER', 'API_KEY_HEADER'] as const;

export type ConfigAuthScheme = (typeof CONFIG_AUTH_SCHEMES)[number];

/** The Xiaomi Token Plan regional clusters. Endpoint text lives in the provider package preset. */
export const CONFIG_XIAOMI_CLUSTERS = ['CN', 'SGP', 'EU'] as const;

export type ConfigXiaomiCluster = (typeof CONFIG_XIAOMI_CLUSTERS)[number];

/** Feature assurance (Phase 27): what the operator declared vs what qualification verified. */
export const FEATURE_ASSURANCE = ['DECLARED', 'VERIFIED'] as const;

export type FeatureAssurance = (typeof FEATURE_ASSURANCE)[number];

export const MODEL_ALIAS_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*){1,3}$/;
export const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9._-]{1,127}$/;
export const CREDENTIAL_REF_PATTERN = /^secret:\/\/[A-Za-z0-9._/~+=-]{1,256}$/;

export type ModelAliasConfig = {
  /** Routing name, e.g. `openai.reasoning.primary`. Never a vendor model id. */
  readonly alias: string;
  readonly providerId: string;
  /** The real model id. Operator-side; never consumer-visible. */
  readonly providerModelId: string;
  /** Profiles this model is declared able to serve. Drives routing and the no-silent-degrade rule. */
  readonly profiles: readonly ModelProfile[];
  /** DECLARED features. Never inferred from a model name (Phase 15). */
  readonly features: readonly ProviderFeature[];
  /** VERIFIED features — the subset a probe/live qualification confirmed. Never assumed permanent. */
  readonly verifiedFeatures?: readonly ProviderFeature[];
  readonly contextLimit?: number;
  readonly outputLimit?: number;
  /** Optional, dated price metadata. Absent cost stays unknown (Phase 47). */
  readonly pricing?: ProviderPricing;
};

export type ProviderEndpointConfig =
  | { readonly kind: 'PRESET'; readonly cluster?: ConfigXiaomiCluster }
  | { readonly kind: 'CUSTOM'; readonly baseUrl: string };

export type ProviderConfig = {
  readonly providerId: string;
  readonly preset: ProviderPreset;
  readonly enabled: boolean;
  /** A handle (`secret://…`), never a value. */
  readonly credentialRef: string;
  readonly endpoint: ProviderEndpointConfig;
  readonly authScheme?: ConfigAuthScheme;
  readonly wireProtocol?: ConfigWireProtocol;
  /** Development only, default `false`. */
  readonly allowPrivateNetworkForDevelopment?: boolean;
  readonly models: readonly ModelAliasConfig[];
};

export type RouteConfig = {
  readonly profile: ModelProfile;
  /**
   * Ordered model aliases: the first is the route, the rest are the deterministic fallback chain.
   * Every alias must be declared for this profile — that is the no-silent-degrade rule.
   */
  readonly chain: readonly string[];
};

export type ProviderSuiteConfig = {
  readonly providers: readonly ProviderConfig[];
  readonly routes: readonly RouteConfig[];
};

/* -------------------------------------------------------------------------------------------------
 * Strict parsing — closed key sets, deny-by-default.
 * ----------------------------------------------------------------------------------------------- */

const SUITE_KEYS = ['providers', 'routes'] as const;
const PROVIDER_KEYS = [
  'providerId',
  'preset',
  'enabled',
  'credentialRef',
  'endpoint',
  'authScheme',
  'wireProtocol',
  'allowPrivateNetworkForDevelopment',
  'models',
] as const;
const MODEL_KEYS = [
  'alias',
  'providerId',
  'providerModelId',
  'profiles',
  'features',
  'verifiedFeatures',
  'contextLimit',
  'outputLimit',
  'pricing',
] as const;
const ENDPOINT_PRESET_KEYS = ['kind', 'cluster'] as const;
const ENDPOINT_CUSTOM_KEYS = ['kind', 'baseUrl'] as const;
const ROUTE_KEYS = ['profile', 'chain'] as const;

function issue(code: ValidationIssue['code'], path: string, message: string): ValidationIssue {
  return createIssue(code, path, message);
}

function parseFeatures(value: unknown, path: string, issues: ValidationIssue[]): readonly ProviderFeature[] {
  if (!Array.isArray(value)) {
    issues.push(issue('INVALID_TYPE', path, 'must be an array of provider features'));
    return [];
  }
  const seen = new Set<string>();
  const features: ProviderFeature[] = [];
  value.forEach((entry, index) => {
    if (!isProviderFeature(entry)) {
      issues.push(issue('INVALID_VALUE', `${path}[${index}]`, 'unknown provider feature'));
      return;
    }
    if (seen.has(entry)) {
      issues.push(issue('DUPLICATE_FIELD', `${path}[${index}]`, `duplicate feature "${entry}"`));
      return;
    }
    seen.add(entry);
    features.push(entry);
  });
  return features;
}

function parseProfiles(value: unknown, path: string, issues: ValidationIssue[]): readonly ModelProfile[] {
  if (!Array.isArray(value)) {
    issues.push(issue('INVALID_TYPE', path, 'must be an array of profiles'));
    return [];
  }
  const seen = new Set<string>();
  const profiles: ModelProfile[] = [];
  value.forEach((entry, index) => {
    if (!isModelProfile(entry)) {
      issues.push(issue('INVALID_VALUE', `${path}[${index}]`, 'unknown profile'));
      return;
    }
    if (seen.has(entry)) {
      issues.push(issue('DUPLICATE_FIELD', `${path}[${index}]`, `duplicate profile "${entry}"`));
      return;
    }
    seen.add(entry);
    profiles.push(entry);
  });
  return profiles;
}

function parseModelAlias(value: unknown, path: string, issues: ValidationIssue[]): ModelAliasConfig | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    issues.push(issue('INVALID_TYPE', path, 'must be an object'));
    return null;
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record).sort()) {
    if (!(MODEL_KEYS as readonly string[]).includes(key)) {
      issues.push(issue('UNKNOWN_FIELD', `${path}.${key}`, 'unknown model config field'));
    }
  }
  const alias = record['alias'];
  if (typeof alias !== 'string' || !MODEL_ALIAS_PATTERN.test(alias)) {
    issues.push(issue('PATTERN_MISMATCH', `${path}.alias`, 'must be a dotted lower-case alias, e.g. openai.reasoning.primary'));
  }
  const providerId = record['providerId'];
  if (typeof providerId !== 'string' || !PROVIDER_ID_PATTERN.test(providerId)) {
    issues.push(issue('PATTERN_MISMATCH', `${path}.providerId`, 'must be a valid provider id'));
  }
  const providerModelId = record['providerModelId'];
  if (typeof providerModelId !== 'string' || providerModelId.length === 0) {
    issues.push(issue('INVALID_TYPE', `${path}.providerModelId`, 'must be the operator-side model id'));
  }
  const profiles = parseProfiles(record['profiles'], `${path}.profiles`, issues);
  const features = parseFeatures(record['features'], `${path}.features`, issues);
  const verifiedFeatures =
    record['verifiedFeatures'] === undefined
      ? undefined
      : parseFeatures(record['verifiedFeatures'], `${path}.verifiedFeatures`, issues);
  if (verifiedFeatures !== undefined) {
    for (const feature of verifiedFeatures) {
      if (!features.includes(feature)) {
        // Verifying something that was never declared is a config error, not a promotion.
        issues.push(
          issue('INVALID_VALUE', `${path}.verifiedFeatures`, `"${feature}" was never declared in features`),
        );
      }
    }
  }
  for (const key of ['contextLimit', 'outputLimit'] as const) {
    const entry = record[key];
    if (entry !== undefined && (typeof entry !== 'number' || !Number.isInteger(entry) || entry < 1)) {
      issues.push(issue('INVALID_TYPE', `${path}.${key}`, 'must be a positive integer (a negative limit is a config error)'));
    }
  }
  if (issues.length > 0) {
    return null;
  }
  return {
    alias: alias as string,
    providerId: providerId as string,
    providerModelId: providerModelId as string,
    profiles,
    features,
    ...(verifiedFeatures === undefined ? {} : { verifiedFeatures }),
    ...(typeof record['contextLimit'] === 'number' ? { contextLimit: record['contextLimit'] } : {}),
    ...(typeof record['outputLimit'] === 'number' ? { outputLimit: record['outputLimit'] } : {}),
    ...(record['pricing'] === undefined ? {} : { pricing: record['pricing'] as ProviderPricing }),
  };
}

function parseEndpoint(value: unknown, path: string, issues: ValidationIssue[]): ProviderEndpointConfig | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    issues.push(issue('INVALID_TYPE', path, 'must be an endpoint object'));
    return null;
  }
  const record = value as Record<string, unknown>;
  const kind = record['kind'];
  if (kind === 'PRESET') {
    for (const key of Object.keys(record).sort()) {
      if (!(ENDPOINT_PRESET_KEYS as readonly string[]).includes(key)) {
        issues.push(issue('UNKNOWN_FIELD', `${path}.${key}`, 'unknown endpoint field'));
      }
    }
    const cluster = record['cluster'];
    if (cluster !== undefined && !(CONFIG_XIAOMI_CLUSTERS as readonly string[]).includes(cluster as string)) {
      issues.push(issue('INVALID_VALUE', `${path}.cluster`, `must be one of ${CONFIG_XIAOMI_CLUSTERS.join(', ')}`));
    }
    return issues.length > 0
      ? null
      : { kind: 'PRESET', ...(cluster === undefined ? {} : { cluster: cluster as ConfigXiaomiCluster }) };
  }
  if (kind === 'CUSTOM') {
    for (const key of Object.keys(record).sort()) {
      if (!(ENDPOINT_CUSTOM_KEYS as readonly string[]).includes(key)) {
        issues.push(issue('UNKNOWN_FIELD', `${path}.${key}`, 'unknown endpoint field'));
      }
    }
    const baseUrl = record['baseUrl'];
    if (typeof baseUrl !== 'string' || baseUrl.length === 0) {
      issues.push(issue('INVALID_TYPE', `${path}.baseUrl`, 'must be a non-empty URL'));
      return null;
    }
    return issues.length > 0 ? null : { kind: 'CUSTOM', baseUrl };
  }
  issues.push(issue('INVALID_VALUE', `${path}.kind`, 'must be PRESET or CUSTOM'));
  return null;
}

function parseProvider(value: unknown, path: string, issues: ValidationIssue[]): ProviderConfig | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    issues.push(issue('INVALID_TYPE', path, 'must be an object'));
    return null;
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record).sort()) {
    if (!(PROVIDER_KEYS as readonly string[]).includes(key)) {
      issues.push(issue('UNKNOWN_FIELD', `${path}.${key}`, 'unknown provider config field'));
    }
  }
  const providerId = record['providerId'];
  if (typeof providerId !== 'string' || !PROVIDER_ID_PATTERN.test(providerId)) {
    issues.push(issue('PATTERN_MISMATCH', `${path}.providerId`, 'must be a valid provider id'));
  }
  const preset = record['preset'];
  if (typeof preset !== 'string' || !(PROVIDER_PRESETS as readonly string[]).includes(preset)) {
    issues.push(issue('INVALID_VALUE', `${path}.preset`, `must be one of ${PROVIDER_PRESETS.join(', ')}`));
  }
  if (typeof record['enabled'] !== 'boolean') {
    issues.push(issue('INVALID_TYPE', `${path}.enabled`, 'must be a boolean'));
  }
  const credentialRef = record['credentialRef'];
  if (typeof credentialRef !== 'string' || !CREDENTIAL_REF_PATTERN.test(credentialRef)) {
    // A raw credential here would also fail this pattern: handles only, never values.
    issues.push(issue('PATTERN_MISMATCH', `${path}.credentialRef`, 'must be a secret:// handle — never a raw credential'));
  }
  const endpoint = parseEndpoint(record['endpoint'], `${path}.endpoint`, issues);
  const authScheme = record['authScheme'];
  if (authScheme !== undefined && !(CONFIG_AUTH_SCHEMES as readonly string[]).includes(authScheme as string)) {
    issues.push(issue('INVALID_VALUE', `${path}.authScheme`, `must be one of ${CONFIG_AUTH_SCHEMES.join(', ')}`));
  }
  const wireProtocol = record['wireProtocol'];
  if (wireProtocol !== undefined && !(CONFIG_WIRE_PROTOCOLS as readonly string[]).includes(wireProtocol as string)) {
    issues.push(issue('INVALID_VALUE', `${path}.wireProtocol`, `must be one of ${CONFIG_WIRE_PROTOCOLS.join(', ')}`));
  }
  if (
    record['allowPrivateNetworkForDevelopment'] !== undefined &&
    typeof record['allowPrivateNetworkForDevelopment'] !== 'boolean'
  ) {
    issues.push(issue('INVALID_TYPE', `${path}.allowPrivateNetworkForDevelopment`, 'must be a boolean'));
  }
  const rawModels = record['models'];
  const models: ModelAliasConfig[] = [];
  if (!Array.isArray(rawModels) || rawModels.length === 0) {
    issues.push(issue('INVALID_TYPE', `${path}.models`, 'must be a non-empty array of model configs'));
  } else {
    rawModels.forEach((entry, index) => {
      const parsed = parseModelAlias(entry, `${path}.models[${index}]`, issues);
      if (parsed !== null) {
        models.push(parsed);
      }
    });
  }
  if (issues.length > 0 || endpoint === null) {
    return null;
  }
  return {
    providerId: providerId as string,
    preset: preset as ProviderPreset,
    enabled: record['enabled'] === true,
    credentialRef: credentialRef as string,
    endpoint,
    ...(authScheme === undefined ? {} : { authScheme: authScheme as ConfigAuthScheme }),
    ...(wireProtocol === undefined ? {} : { wireProtocol: wireProtocol as ConfigWireProtocol }),
    ...(record['allowPrivateNetworkForDevelopment'] === true ? { allowPrivateNetworkForDevelopment: true } : {}),
    models,
  };
}

function parseRoute(value: unknown, path: string, issues: ValidationIssue[]): RouteConfig | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    issues.push(issue('INVALID_TYPE', path, 'must be an object'));
    return null;
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record).sort()) {
    if (!(ROUTE_KEYS as readonly string[]).includes(key)) {
      issues.push(issue('UNKNOWN_FIELD', `${path}.${key}`, 'unknown route field'));
    }
  }
  const profile = record['profile'];
  if (!isModelProfile(profile)) {
    issues.push(issue('INVALID_VALUE', `${path}.profile`, 'unknown profile'));
  }
  const chain = record['chain'];
  const aliases: string[] = [];
  if (!Array.isArray(chain) || chain.length === 0) {
    issues.push(issue('INVALID_TYPE', `${path}.chain`, 'must be a non-empty array of model aliases'));
  } else {
    chain.forEach((entry, index) => {
      if (typeof entry !== 'string' || !MODEL_ALIAS_PATTERN.test(entry)) {
        issues.push(issue('PATTERN_MISMATCH', `${path}.chain[${index}]`, 'must be a model alias'));
        return;
      }
      aliases.push(entry);
    });
  }
  if (issues.length > 0 || !isModelProfile(profile)) {
    return null;
  }
  return { profile, chain: aliases };
}

/**
 * Parse and validate a provider suite configuration. Closed key sets throughout; every semantic
 * rule of Phase 42 is checked before a value comes back.
 */
export function parseProviderSuiteConfig(value: unknown, path = '$'): ValidationResult<ProviderSuiteConfig> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return invalid('MALFORMED_ENVELOPE', [issue('INVALID_TYPE', path, 'must be an object')]);
  }
  const record = value as Record<string, unknown>;
  const issues: ValidationIssue[] = [];
  for (const key of Object.keys(record).sort()) {
    if (!(SUITE_KEYS as readonly string[]).includes(key)) {
      issues.push(issue('UNKNOWN_FIELD', `${path}.${key}`, 'unknown suite config field'));
    }
  }

  const providers: ProviderConfig[] = [];
  const rawProviders = record['providers'];
  if (!Array.isArray(rawProviders)) {
    issues.push(issue('INVALID_TYPE', `${path}.providers`, 'must be an array'));
  } else {
    rawProviders.forEach((entry, index) => {
      const parsed = parseProvider(entry, `${path}.providers[${index}]`, issues);
      if (parsed !== null) {
        providers.push(parsed);
      }
    });
  }

  const routes: RouteConfig[] = [];
  const rawRoutes = record['routes'];
  if (!Array.isArray(rawRoutes)) {
    issues.push(issue('INVALID_TYPE', `${path}.routes`, 'must be an array'));
  } else {
    rawRoutes.forEach((entry, index) => {
      const parsed = parseRoute(entry, `${path}.routes[${index}]`, issues);
      if (parsed !== null) {
        routes.push(parsed);
      }
    });
  }

  issues.push(...semanticIssues(providers, routes, path));
  if (issues.length > 0) {
    return invalid('MALFORMED_ENVELOPE', issues);
  }
  return valid({ providers, routes });
}

/** The Phase 42 semantic rules, applied to already-shaped values. */
export function semanticIssues(
  providers: readonly ProviderConfig[],
  routes: readonly RouteConfig[],
  path = '$',
): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const providerIds = new Set<string>();
  const aliases = new Map<string, ModelAliasConfig>();
  const routeProfiles = new Set<string>();

  providers.forEach((provider, index) => {
    const providerPath = `${path}.providers[${index}]`;
    if (providerIds.has(provider.providerId)) {
      issues.push(issue('DUPLICATE_FIELD', `${providerPath}.providerId`, `duplicate providerId "${provider.providerId}"`));
    }
    providerIds.add(provider.providerId);

    // Wire protocol / preset combinations are fixed: a Responses protocol on a chat preset is a
    // config error, not a surprise at call time.
    const expectedProtocol: ConfigWireProtocol = provider.preset === 'OPENAI_OFFICIAL' ? 'OPENAI_RESPONSES' : 'OPENAI_CHAT_COMPLETIONS';
    if (provider.wireProtocol !== undefined && provider.wireProtocol !== expectedProtocol) {
      issues.push(
        issue('INVALID_VALUE', `${providerPath}.wireProtocol`, `preset "${provider.preset}" requires ${expectedProtocol}`),
      );
    }
    // The OpenAI official adapter speaks Bearer over the Responses API, unconditionally: an
    // explicit auth override on that preset would be silently dropped, so it is a config error.
    if (
      provider.preset === 'OPENAI_OFFICIAL' &&
      provider.authScheme !== undefined &&
      provider.authScheme !== 'BEARER'
    ) {
      issues.push(
        issue('INVALID_VALUE', `${providerPath}.authScheme`, 'preset "OPENAI_OFFICIAL" requires BEARER'),
      );
    }
    if (provider.endpoint.kind === 'PRESET' && provider.endpoint.cluster !== undefined && provider.preset !== 'XIAOMI_TOKENPLAN') {
      issues.push(issue('INVALID_VALUE', `${providerPath}.endpoint.cluster`, 'only the XIAOMI_TOKENPLAN preset has clusters'));
    }
    if (provider.endpoint.kind === 'CUSTOM') {
      const check = checkEndpointSafety(provider.endpoint.baseUrl, {
        ...(provider.allowPrivateNetworkForDevelopment === undefined
          ? {}
          : { allowPrivateNetworkForDevelopment: provider.allowPrivateNetworkForDevelopment }),
      });
      if (!check.safe) {
        issues.push(issue('INVALID_VALUE', `${providerPath}.endpoint.baseUrl`, `unsafe endpoint (${check.rejection})`));
      }
    }

    provider.models.forEach((model, modelIndex) => {
      const modelPath = `${providerPath}.models[${modelIndex}]`;
      if (aliases.has(model.alias)) {
        issues.push(issue('DUPLICATE_FIELD', `${modelPath}.alias`, `duplicate model alias "${model.alias}"`));
      }
      aliases.set(model.alias, model);
      if (model.providerId !== provider.providerId) {
        issues.push(issue('INVALID_VALUE', `${modelPath}.providerId`, 'must match the enclosing provider'));
      }
    });
  });

  routes.forEach((route, index) => {
    const routePath = `${path}.routes[${index}]`;
    if (routeProfiles.has(route.profile)) {
      issues.push(issue('DUPLICATE_FIELD', `${routePath}.profile`, `duplicate route for profile "${route.profile}"`));
    }
    routeProfiles.add(route.profile);
    const seenInChain = new Set<string>();
    route.chain.forEach((alias, aliasIndex) => {
      const chainPath = `${routePath}.chain[${aliasIndex}]`;
      if (seenInChain.has(alias)) {
        issues.push(issue('DUPLICATE_FIELD', chainPath, `duplicate hop "${alias}" in one chain`));
      }
      seenInChain.add(alias);
      const model = aliases.get(alias);
      if (model === undefined) {
        issues.push(issue('UNKNOWN_FIELD', chainPath, `unknown model alias "${alias}"`));
        return;
      }
      // No silent degrade: every hop of a profile's chain must be declared for that profile.
      if (!model.profiles.includes(route.profile)) {
        issues.push(
          issue('INVALID_VALUE', chainPath, `model "${alias}" is not declared for profile "${route.profile}" — no silent degrade`),
        );
      }
    });
  });

  return issues;
}

/** Look up a model alias. Real model ids resolve through this, never through route tables. */
export function resolveModelAlias(
  config: ProviderSuiteConfig,
  alias: string,
): { readonly provider: ProviderConfig; readonly model: ModelAliasConfig } | null {
  for (const provider of config.providers) {
    const model = provider.models.find((candidate) => candidate.alias === alias);
    if (model !== undefined) {
      return { provider, model };
    }
  }
  return null;
}

/** Per-feature assurance (Phase 27): VERIFIED only for features a qualification actually proved. */
export function featureStatus(model: ModelAliasConfig): Readonly<Partial<Record<ProviderFeature, FeatureAssurance>>> {
  const status: Partial<Record<ProviderFeature, FeatureAssurance>> = {};
  for (const feature of model.features) {
    status[feature] = model.verifiedFeatures?.includes(feature) === true ? 'VERIFIED' : 'DECLARED';
  }
  return status;
}
