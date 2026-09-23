/**
 * Provider resolution and capability validation (ARCHITECTURE.md §9.2, ROADMAP Stage 3).
 *
 * Stage 3 resolves a **single** route from an explicit `profile → route chain` table. The full
 * `AiRouter` (capability routes, fallback chains, availability and budget filters as configuration)
 * is Stage 5; what is here already enforces the Stage 3 rule the exit gate demands:
 *
 * > a request that requires something the provider/model cannot do fails **locally**, before any
 * > provider call. Never "ask the provider and guess".
 *
 * Feature support is a property of the **model** (ARCHITECTURE.md §7.2), so every check reads the
 * model descriptor, not the provider's marketing.
 */
import {
  makeAiError,
  resolveKillSwitch,
  unsatisfiableRequirements,
  type AiError,
  type AiProviderAdapter,
  type CapabilityRequirements,
  type KillSwitchState,
  type ModelClass,
  type ModelDescriptor,
  type ModelProfile,
  type ProviderDescriptor,
  type ProviderFamily,
  type ProviderFeature,
  type RequirementDelivery,
} from '@aibridge/contracts';
import { killSwitchError } from '@aibridge/core';

/** One configured hop: an operator-named provider instance and an operator-side model ref. */
export type RouteEntry = {
  readonly providerId: string;
  readonly modelRef: string;
};

/** `profile → ordered route chain`. The first survivor is the route; the rest are future fallback. */
export type RuntimeRoutes = Readonly<Partial<Record<ModelProfile, readonly RouteEntry[]>>>;

/** A registered provider binding. Operator-side; never consumer-visible. */
export type BoundProvider = {
  readonly adapter: AiProviderAdapter;
  readonly descriptor: ProviderDescriptor;
};

/** The resolved route. `modelRef` is operator-side and never crosses to a consumer. */
export type ResolvedRoute = {
  readonly adapter: AiProviderAdapter;
  readonly descriptor: ProviderDescriptor;
  readonly model: ModelDescriptor;
  readonly providerId: string;
  readonly modelRef: string;
  readonly profile: ModelProfile;
};

export type RouteResolution = { readonly ok: true; readonly route: ResolvedRoute } | { readonly ok: false; readonly error: AiError };

/**
 * The quality class a consumer may rely on (INTEGRATION_CONTRACT_V1.md §12.3): what **actually**
 * served the request, never what was asked for.
 */
export function classifyModel(model: ModelDescriptor, family: ProviderFamily): ModelClass {
  if (family === 'local') {
    return 'LOCAL';
  }
  if (model.features.includes('reasoning')) {
    return 'REASONING';
  }
  if (model.features.includes('text')) {
    return 'FAST';
  }
  return 'UNKNOWN';
}

function hasFeature(model: ModelDescriptor, feature: ProviderFeature): boolean {
  return model.features.includes(feature);
}

/** The requirements one candidate cannot satisfy. Empty means the candidate is acceptable. */
export function unmetRequirements(
  model: ModelDescriptor,
  adapter: AiProviderAdapter,
  requirements: CapabilityRequirements,
  options: { readonly capability: string; readonly delivery: RequirementDelivery },
): readonly string[] {
  const unmet: string[] = [];
  if (!hasFeature(model, 'text')) {
    unmet.push('text');
  }
  if (options.capability === 'ai.structured.generate' && !hasFeature(model, 'structuredJson')) {
    unmet.push('structuredOutput');
  }
  if (requirements.structuredOutput === true && !hasFeature(model, 'structuredJson')) {
    unmet.push('structuredOutput');
  }
  if (requirements.reasoning === true && !hasFeature(model, 'reasoning')) {
    unmet.push('reasoning');
  }
  if (options.delivery === 'STREAM') {
    if (typeof adapter.streamText !== 'function' || !hasFeature(model, 'streaming')) {
      unmet.push('streaming');
    }
  }
  if (requirements.minContextTokens !== undefined && model.maxContextTokens < requirements.minContextTokens) {
    unmet.push('minContextTokens');
  }
  if (requirements.maxOutputTokens !== undefined && model.maxOutputTokens < requirements.maxOutputTokens) {
    unmet.push('maxOutputTokens');
  }
  return unmet;
}

export type ResolveRouteInput = {
  readonly routes: RuntimeRoutes;
  readonly providers: ReadonlyMap<string, BoundProvider>;
  readonly capability: string;
  readonly capabilityVersion: string;
  readonly profile: ModelProfile;
  readonly requirements: CapabilityRequirements;
  readonly delivery: RequirementDelivery;
  readonly killSwitches?: KillSwitchState;
};

/**
 * Resolve `(capability, profile, requirements)` to one concrete route.
 *
 * Order: unsatisfiable requirements → kill switches (global / capability / provider) → candidate
 * walk in configured order, dropping every candidate that fails the feature, context or output
 * caps. Nothing survives is `NO_ROUTE`; a switch that killed every candidate names itself.
 */
export function resolveRoute(input: ResolveRouteInput): RouteResolution {
  const unsatisfiable = unsatisfiableRequirements(input.requirements, input.delivery);
  if (unsatisfiable.length > 0) {
    return {
      ok: false,
      error: makeAiError({
        reason: 'NO_ROUTE',
        message: `No V1 route can satisfy the requirement(s): ${unsatisfiable.join(', ')}. A requirement is never quietly downgraded.`,
        details: { profile: input.profile },
      }),
    };
  }

  const chain = input.routes[input.profile] ?? [];
  const candidateProviders = chain.map((entry) => entry.providerId);

  const state = input.killSwitches ?? { global: false, providers: [], capabilities: [] };
  const verdict = resolveKillSwitch(state, {
    capability: input.capability,
    capabilityVersion: input.capabilityVersion,
    candidateProviders,
  });
  if (!verdict.allowed) {
    return { ok: false, error: killSwitchError(verdict) };
  }

  for (const entry of chain) {
    if (!verdict.availableProviders.includes(entry.providerId)) {
      continue;
    }
    const bound = input.providers.get(entry.providerId);
    if (bound === undefined) {
      continue;
    }
    const model = bound.descriptor.models.find((candidate) => candidate.modelRef === entry.modelRef);
    if (model === undefined) {
      continue;
    }
    if (!model.profiles.includes(input.profile)) {
      continue;
    }
    const unmet = unmetRequirements(model, bound.adapter, input.requirements, {
      capability: input.capability,
      delivery: input.delivery,
    });
    if (unmet.length > 0) {
      continue;
    }
    return {
      ok: true,
      route: {
        adapter: bound.adapter,
        descriptor: bound.descriptor,
        model,
        providerId: entry.providerId,
        modelRef: entry.modelRef,
        profile: input.profile,
      },
    };
  }

  return {
    ok: false,
    error: makeAiError({
      reason: 'NO_ROUTE',
      message: 'No configured route satisfies this profile and requirement set.',
      details: { profile: input.profile },
    }),
  };
}
