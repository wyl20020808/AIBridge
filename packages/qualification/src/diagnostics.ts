/**
 * Safe operator qualification diagnostics (Stage 8, Phases 30, 31, 32).
 *
 * `getQualificationStatus()` answers "what do we know about this provider/model/feature, and is it
 * still current?" without ever exposing a credential, prompt, raw response or reasoning content.
 *
 * It is explicitly **not** a health signal and **not** a routing input. Phase 31 keeps qualification
 * and health separate; Phase 32 keeps qualification from silently changing production routing. A
 * future strict-routing policy is opt-in only and defaults off (Phase 33).
 */

import type { ProviderQualificationRecord } from './record.js';
import type { QualificationFeature, QualificationStatus } from './status.js';
import { evaluateStaleness, type CurrentQualificationContext, type StalenessReason } from './staleness.js';
import { identityKey } from './identity.js';
import type { QualificationStorePort } from './store.js';
import type { QualificationFailureClass } from './status.js';

/** One feature's safe qualification view. */
export type FeatureQualificationView = {
  readonly feature: QualificationFeature;
  readonly status: QualificationStatus;
  /** True when the stored record no longer matches the current identity/adapter/config. */
  readonly stale: boolean;
  readonly stalenessReasons: readonly StalenessReason[];
  readonly qualifiedAtMs?: number;
  readonly latencyMs?: number;
  readonly usageProjection?: ProviderQualificationRecord['usageProjection'];
  readonly safeFailureReason?: QualificationFailureClass;
  readonly evidenceClass: ProviderQualificationRecord['evidenceClass'];
  readonly notes?: readonly string[];
};

/** One model's safe qualification view. */
export type ModelQualificationView = {
  readonly modelAlias: string;
  readonly providerModelSafeRef: string;
  readonly features: readonly FeatureQualificationView[];
};

/** One provider's safe qualification view. */
export type ProviderQualificationView = {
  readonly providerId: string;
  readonly models: readonly ModelQualificationView[];
};

export type QualificationStatusInput = {
  readonly store: QualificationStorePort;
  /** Current identity/context for each (model alias, feature) the operator asks about. */
  readonly contexts: readonly CurrentQualificationContext[];
};

/**
 * Build safe diagnostics from the store and the current contexts. A context with no stored record
 * reports status 'DECLARED' (nothing stronger is known) — never a fabricated PASS.
 */
export async function getQualificationStatus(
  input: QualificationStatusInput,
): Promise<readonly ProviderQualificationView[]> {
  const providers = new Map<string, Map<string, { ref: string; features: FeatureQualificationView[] }>>();

  for (const context of input.contexts) {
    const key = identityKey(context.identity);
    const record = await input.store.latest(key);
    const view = viewFor(context, record);
    const models =
      providers.get(context.identity.providerId) ??
      new Map<string, { ref: string; features: FeatureQualificationView[] }>();
    const entry = models.get(context.identity.modelAlias) ?? {
      ref: context.identity.providerModelSafeRef,
      features: [],
    };
    entry.features.push(view);
    models.set(context.identity.modelAlias, entry);
    providers.set(context.identity.providerId, models);
  }

  const out: ProviderQualificationView[] = [];
  for (const [providerId, models] of providers) {
    const modelViews: ModelQualificationView[] = [];
    for (const [modelAlias, entry] of models) {
      modelViews.push({
        modelAlias,
        providerModelSafeRef: entry.ref,
        features: [...entry.features].sort((a, b) => a.feature.localeCompare(b.feature)),
      });
    }
    out.push({ providerId, models: modelViews });
  }
  return out;
}

function viewFor(
  context: CurrentQualificationContext,
  record: ProviderQualificationRecord | null,
): FeatureQualificationView {
  if (record === null) {
    return {
      feature: context.identity.feature,
      status: 'DECLARED',
      stale: false,
      stalenessReasons: [],
      evidenceClass: 'DECLARED',
    };
  }

  const verdict = evaluateStaleness(record, context);
  const status: QualificationStatus = verdict.stale ? 'STALE' : record.status;

  return {
    feature: record.identity.feature,
    status,
    stale: verdict.stale,
    stalenessReasons: verdict.reasons,
    ...(record.qualifiedAt === undefined ? {} : { qualifiedAtMs: record.qualifiedAt }),
    ...(record.latencyMs === undefined ? {} : { latencyMs: record.latencyMs }),
    ...(record.usageProjection === undefined ? {} : { usageProjection: record.usageProjection }),
    ...(record.safeFailureReason === undefined ? {} : { safeFailureReason: record.safeFailureReason }),
    evidenceClass: record.evidenceClass,
    ...(record.notes === undefined ? {} : { notes: record.notes }),
  };
}

/**
 * Strict-routing qualification policy (Phase 33). Defaults to ALLOW_DECLARED so a credential-less
 * development environment is never blocked. REQUIRE_LIVE is opt-in only and never the default.
 */
export const QUALIFICATION_POLICIES = ['ALLOW_DECLARED', 'REQUIRE_DETERMINISTIC', 'REQUIRE_LIVE'] as const;
export type QualificationPolicy = (typeof QUALIFICATION_POLICIES)[number];

export const DEFAULT_QUALIFICATION_POLICY: QualificationPolicy = 'ALLOW_DECLARED';

const POLICY_MINIMUM: Readonly<Record<QualificationPolicy, readonly QualificationStatus[]>> = {
  ALLOW_DECLARED: ['DECLARED', 'DETERMINISTIC_TESTED', 'LIVE_QUALIFIED'],
  REQUIRE_DETERMINISTIC: ['DETERMINISTIC_TESTED', 'LIVE_QUALIFIED'],
  REQUIRE_LIVE: ['LIVE_QUALIFIED'],
};

/**
 * Does a status satisfy a policy? Purely advisory: Stage 8 does not wire this into routing. It exists
 * so a future stage can opt in without re-deriving the ladder.
 */
export function statusSatisfiesPolicy(status: QualificationStatus, policy: QualificationPolicy): boolean {
  return POLICY_MINIMUM[policy].includes(status);
}
