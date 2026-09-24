/**
 * Runtime configuration: immutable snapshots, atomic reload, rollback (ROADMAP Stage 5 Phase 39–43).
 *
 * Every logical request binds **one** snapshot and reads everything from it — routes, fallback,
 * retry, breaker tuning, rate policies, quota policies, pricing, repair policy, kill switches. A
 * request can never mix "route v1" with "pricing v2" (Phase 42), because there is only one
 * `configVersion` on the object it holds.
 *
 * `reload` is validated-first and atomic (Phase 41): parse → validate the **whole** candidate →
 * cross-reference checks → fallback-chain compilation → pricing validation → quota validation →
 * SSRF endpoint validation (inside `parseProviderSuiteConfig`). Only when every step passes does
 * the snapshot swap. Any failure leaves the previous snapshot **active** and reports issues —
 * never a half-applied route table (ARCHITECTURE.md §17.2).
 *
 * **Secret safety** (Phase 72): a snapshot holds `credentialRef` handles only. A raw credential in
 * configuration fails the `secret://` pattern check and is rejected before it could become state.
 */
import {
  createIssue,
  emptyKillSwitch,
  invalid,
  parseKillSwitchState,
  valid,
  type KillSwitchState,
  type ValidationIssue,
  type ValidationResult,
} from '@aibridge/contracts';
import type { Clock } from '@aibridge/host-sdk';
import {
  PricingTable,
  nullOperationalEventSink,
  resolveBreakerConfig,
  resolveFallbackPolicy,
  resolveRetryPolicy,
  type BreakerConfig,
  type BudgetPolicy,
  type OperationalEventSink,
  type QuotaPolicy,
  type RateLimitPolicy,
  type ResolvedFallbackPolicy,
  type ResolvedRetryPolicy,
  type PricingRecord,
  type UnknownUsagePolicy,
} from '@aibridge/governance';
import {
  MODEL_ALIAS_PATTERN,
  PROVIDER_ID_PATTERN,
  parseProviderSuiteConfig,
  resolveModelAlias,
  type ProviderSuiteConfig,
} from './config.js';
import { validateFallbackChain } from './fallback.js';
import type { RouteEntry, RuntimeRoutes } from './routes.js';

/** The governance half of the runtime configuration. */
export type RuntimeGovernanceConfigInput = {
  readonly fallback?: FallbackPolicyInput;
  readonly retry?: RetryPolicyInput;
  readonly breaker?: BreakerConfig;
  readonly rateLimits?: readonly RateLimitPolicy[];
  readonly quotas?: readonly QuotaPolicy[];
  readonly budget?: BudgetPolicy;
  readonly pricing?: readonly PricingRecord[];
  readonly idempotency?: IdempotencyConfigInput;
  readonly outputRepair?: OutputRepairPolicy;
  readonly unknownUsage?: UnknownUsagePolicy;
  readonly killSwitch?: KillSwitchState;
};

type FallbackPolicyInput = {
  readonly fallbackOnRateLimit?: boolean;
  readonly fallbackOnQuotaExceeded?: boolean;
  /** Stage 5 implements `false` only: `true` is a config error, never a silent degrade (Phase 5). */
  readonly allowCapabilityDegrade?: boolean;
  readonly crossProviderFallbackOnUnknownOutcome?: boolean;
};

type RetryPolicyInput = {
  readonly maxSameProviderRetries?: number;
  readonly retryBeforeDispatch?: boolean;
  readonly retryKnownNotAccepted?: boolean;
  readonly retryUnknownOutcome?: boolean;
  readonly baseBackoffMs?: number;
  readonly maxBackoffMs?: number;
};

export type IdempotencyConfigInput = {
  readonly enabled?: boolean;
  readonly retentionMs?: number;
  readonly capacity?: number;
};

export const OUTPUT_REPAIR_POLICY_VALUES = ['NONE', 'ONCE'] as const;

export type OutputRepairPolicy = (typeof OUTPUT_REPAIR_POLICY_VALUES)[number];

/** The whole runtime configuration document: provider suite + governance. */
export type RuntimeConfigInput = {
  readonly suite: ProviderSuiteConfig;
  readonly governance: RuntimeGovernanceConfigInput;
};

/** Everything a request needs from configuration, resolved and immutable. */
export type ResolvedRuntimeGovernance = {
  readonly fallback: ResolvedFallbackPolicy;
  readonly retry: ResolvedRetryPolicy;
  readonly breaker: Required<BreakerConfig>;
  readonly rateLimits: readonly RateLimitPolicy[];
  readonly quotas: readonly QuotaPolicy[];
  readonly budget: BudgetPolicy;
  readonly pricing: PricingTable;
  readonly idempotency: { readonly enabled: boolean; readonly retentionMs?: number; readonly capacity?: number };
  readonly outputRepair: OutputRepairPolicy;
  readonly unknownUsage: UnknownUsagePolicy;
};

/** One immutable configuration generation (Phase 39–40). */
export type RuntimeConfigSnapshot = {
  /** Monotonic per manager: `cfg-1`, `cfg-2`, … */
  readonly configVersion: string;
  /** Digest of the canonical config text. Never includes a credential (Phase 72). */
  readonly contentDigest: string;
  readonly createdAtMs: number;
  readonly input: RuntimeConfigInput;
  readonly routes: RuntimeRoutes;
  readonly governance: ResolvedRuntimeGovernance;
  readonly killSwitch: KillSwitchState;
};

export const GOVERNANCE_CONFIG_KEYS = [
  'fallback',
  'retry',
  'breaker',
  'rateLimits',
  'quotas',
  'budget',
  'pricing',
  'idempotency',
  'outputRepair',
  'unknownUsage',
  'killSwitch',
] as const;

const RUNTIME_CONFIG_KEYS = ['providers', 'routes', 'governance'] as const;
const FALLBACK_KEYS = [
  'fallbackOnRateLimit',
  'fallbackOnQuotaExceeded',
  'allowCapabilityDegrade',
  'crossProviderFallbackOnUnknownOutcome',
] as const;
const RETRY_KEYS = [
  'maxSameProviderRetries',
  'retryBeforeDispatch',
  'retryKnownNotAccepted',
  'retryUnknownOutcome',
  'baseBackoffMs',
  'maxBackoffMs',
] as const;
const BREAKER_KEYS = ['failureThreshold', 'windowMs', 'cooldownMs', 'halfOpenProbeLimit'] as const;
const RATE_LIMIT_KEYS = ['dimension', 'limit', 'windowMs', 'scopeKey'] as const;
const QUOTA_KEYS = ['scope', 'meter', 'period', 'limit', 'scopeKey', 'reservationTokens', 'reservationCost'] as const;
const BUDGET_KEYS = ['maxEstimatedCostPerRequest', 'maxEstimatedCostPerDay', 'maxEstimatedCostPerMonth', 'currency'] as const;
const PRICING_KEYS = [
  'pricingId',
  'version',
  'providerId',
  'modelAlias',
  'modelRef',
  'validFromMs',
  'validUntilMs',
  'currency',
  'inputTokenPrice',
  'outputTokenPrice',
  'cachedInputPrice',
  'reasoningTokenPrice',
  'unit',
  'source',
] as const;
const IDEMPOTENCY_KEYS = ['enabled', 'retentionMs', 'capacity'] as const;

const RATE_DIMENSIONS = ['subject', 'callerPlugin', 'capability', 'provider', 'global'] as const;
const QUOTA_SCOPES = ['subject', 'callerPlugin', 'capability', 'provider', 'global'] as const;
const QUOTA_METERS = ['REQUESTS', 'TOKENS', 'ESTIMATED_COST'] as const;
const QUOTA_PERIODS = ['DAY', 'MONTH'] as const;
const PRICING_UNITS = ['PER_1K_TOKENS', 'PER_1M_TOKENS'] as const;
const UNKNOWN_USAGE_VALUES = ['CONSERVATIVE', 'RELEASE'] as const;
const SCOPE_KEY_PATTERN = /^[A-Za-z0-9._@/-]{1,128}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function issue(code: ValidationIssue['code'], path: string, message: string): ValidationIssue {
  return createIssue(code, path, message);
}

function checkKeys(record: Record<string, unknown>, allowed: readonly string[], path: string, issues: ValidationIssue[]): void {
  for (const key of Object.keys(record).sort()) {
    if (!allowed.includes(key)) {
      issues.push(issue('UNKNOWN_FIELD', `${path}.${key}`, 'unknown configuration field'));
    }
  }
}

function positiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

function nonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function nonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function parseBooleanField(record: Record<string, unknown>, key: string, path: string, issues: ValidationIssue[]): boolean | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'boolean') {
    issues.push(issue('INVALID_TYPE', `${path}.${key}`, 'must be a boolean'));
    return undefined;
  }
  return value;
}

function parseFallbackPolicy(value: unknown, path: string, issues: ValidationIssue[]): FallbackPolicyInput | undefined {
  if (!isRecord(value)) {
    issues.push(issue('INVALID_TYPE', path, 'must be an object'));
    return undefined;
  }
  checkKeys(value, FALLBACK_KEYS, path, issues);
  const allowCapabilityDegrade = parseBooleanField(value, 'allowCapabilityDegrade', path, issues);
  if (allowCapabilityDegrade === true) {
    // Phase 5: Stage 5 implements `false` only. Accepting `true` would silently promise a
    // downgrade path that does not exist.
    issues.push(issue('INVALID_VALUE', `${path}.allowCapabilityDegrade`, 'capability degrade is not implemented in Stage 5; only false is supported'));
  }
  return {
    ...(parseBooleanField(value, 'fallbackOnRateLimit', path, issues) === undefined
      ? {}
      : { fallbackOnRateLimit: value['fallbackOnRateLimit'] as boolean }),
    ...(parseBooleanField(value, 'fallbackOnQuotaExceeded', path, issues) === undefined
      ? {}
      : { fallbackOnQuotaExceeded: value['fallbackOnQuotaExceeded'] as boolean }),
    ...(allowCapabilityDegrade === undefined || allowCapabilityDegrade === false ? {} : { allowCapabilityDegrade }),
    ...(parseBooleanField(value, 'crossProviderFallbackOnUnknownOutcome', path, issues) === undefined
      ? {}
      : { crossProviderFallbackOnUnknownOutcome: value['crossProviderFallbackOnUnknownOutcome'] as boolean }),
  };
}

function parseRetryPolicy(value: unknown, path: string, issues: ValidationIssue[]): RetryPolicyInput | undefined {
  if (!isRecord(value)) {
    issues.push(issue('INVALID_TYPE', path, 'must be an object'));
    return undefined;
  }
  checkKeys(value, RETRY_KEYS, path, issues);
  const maxSameProviderRetries = value['maxSameProviderRetries'];
  if (maxSameProviderRetries !== undefined && !nonNegativeInt(maxSameProviderRetries)) {
    issues.push(issue('INVALID_TYPE', `${path}.maxSameProviderRetries`, 'must be a non-negative integer (V1 caps it at 1)'));
  }
  for (const key of ['baseBackoffMs', 'maxBackoffMs'] as const) {
    if (value[key] !== undefined && !positiveInt(value[key])) {
      issues.push(issue('INVALID_TYPE', `${path}.${key}`, 'must be a positive integer of milliseconds'));
    }
  }
  return {
    ...(typeof maxSameProviderRetries === 'number' ? { maxSameProviderRetries } : {}),
    ...(parseBooleanField(value, 'retryBeforeDispatch', path, issues) === undefined
      ? {}
      : { retryBeforeDispatch: value['retryBeforeDispatch'] as boolean }),
    ...(parseBooleanField(value, 'retryKnownNotAccepted', path, issues) === undefined
      ? {}
      : { retryKnownNotAccepted: value['retryKnownNotAccepted'] as boolean }),
    ...(parseBooleanField(value, 'retryUnknownOutcome', path, issues) === undefined
      ? {}
      : { retryUnknownOutcome: value['retryUnknownOutcome'] as boolean }),
    ...(positiveInt(value['baseBackoffMs']) ? { baseBackoffMs: value['baseBackoffMs'] as number } : {}),
    ...(positiveInt(value['maxBackoffMs']) ? { maxBackoffMs: value['maxBackoffMs'] as number } : {}),
  };
}

function parseBreakerConfig(value: unknown, path: string, issues: ValidationIssue[]): BreakerConfig | undefined {
  if (!isRecord(value)) {
    issues.push(issue('INVALID_TYPE', path, 'must be an object'));
    return undefined;
  }
  checkKeys(value, BREAKER_KEYS, path, issues);
  for (const key of ['failureThreshold', 'windowMs', 'halfOpenProbeLimit'] as const) {
    if (value[key] !== undefined && !positiveInt(value[key])) {
      issues.push(issue('INVALID_TYPE', `${path}.${key}`, 'must be a positive integer'));
    }
  }
  if (value['cooldownMs'] !== undefined && !nonNegativeInt(value['cooldownMs'])) {
    issues.push(issue('INVALID_TYPE', `${path}.cooldownMs`, 'must be a non-negative integer of milliseconds'));
  }
  return {
    ...(positiveInt(value['failureThreshold']) ? { failureThreshold: value['failureThreshold'] as number } : {}),
    ...(positiveInt(value['windowMs']) ? { windowMs: value['windowMs'] as number } : {}),
    ...(nonNegativeInt(value['cooldownMs']) ? { cooldownMs: value['cooldownMs'] as number } : {}),
    ...(positiveInt(value['halfOpenProbeLimit']) ? { halfOpenProbeLimit: value['halfOpenProbeLimit'] as number } : {}),
  };
}

function parseRateLimits(value: unknown, path: string, issues: ValidationIssue[]): RateLimitPolicy[] {
  if (!Array.isArray(value)) {
    issues.push(issue('INVALID_TYPE', path, 'must be an array of rate limit policies'));
    return [];
  }
  const policies: RateLimitPolicy[] = [];
  value.forEach((entry, index) => {
    const at = `${path}[${index}]`;
    if (!isRecord(entry)) {
      issues.push(issue('INVALID_TYPE', at, 'must be an object'));
      return;
    }
    checkKeys(entry, RATE_LIMIT_KEYS, at, issues);
    const dimension = entry['dimension'];
    if (typeof dimension !== 'string' || !(RATE_DIMENSIONS as readonly string[]).includes(dimension)) {
      issues.push(issue('INVALID_VALUE', `${at}.dimension`, `must be one of ${RATE_DIMENSIONS.join(', ')}`));
      return;
    }
    if (!positiveInt(entry['limit'])) {
      issues.push(issue('INVALID_TYPE', `${at}.limit`, 'must be a positive integer'));
      return;
    }
    if (!positiveInt(entry['windowMs'])) {
      issues.push(issue('INVALID_TYPE', `${at}.windowMs`, 'must be a positive integer of milliseconds'));
      return;
    }
    const scopeKey = entry['scopeKey'];
    if (scopeKey !== undefined && (typeof scopeKey !== 'string' || !SCOPE_KEY_PATTERN.test(scopeKey))) {
      issues.push(issue('PATTERN_MISMATCH', `${at}.scopeKey`, 'must be a stable scope key'));
      return;
    }
    policies.push({
      dimension: dimension as RateLimitPolicy['dimension'],
      limit: entry['limit'] as number,
      windowMs: entry['windowMs'] as number,
      ...(typeof scopeKey === 'string' ? { scopeKey } : {}),
    });
  });
  return policies;
}

function parseQuotas(value: unknown, path: string, issues: ValidationIssue[]): QuotaPolicy[] {
  if (!Array.isArray(value)) {
    issues.push(issue('INVALID_TYPE', path, 'must be an array of quota policies'));
    return [];
  }
  const policies: QuotaPolicy[] = [];
  value.forEach((entry, index) => {
    const at = `${path}[${index}]`;
    if (!isRecord(entry)) {
      issues.push(issue('INVALID_TYPE', at, 'must be an object'));
      return;
    }
    checkKeys(entry, QUOTA_KEYS, at, issues);
    const scope = entry['scope'];
    const meter = entry['meter'];
    const period = entry['period'];
    if (typeof scope !== 'string' || !(QUOTA_SCOPES as readonly string[]).includes(scope)) {
      issues.push(issue('INVALID_VALUE', `${at}.scope`, `must be one of ${QUOTA_SCOPES.join(', ')}`));
      return;
    }
    if (typeof meter !== 'string' || !(QUOTA_METERS as readonly string[]).includes(meter)) {
      issues.push(issue('INVALID_VALUE', `${at}.meter`, `must be one of ${QUOTA_METERS.join(', ')}`));
      return;
    }
    if (typeof period !== 'string' || !(QUOTA_PERIODS as readonly string[]).includes(period)) {
      issues.push(issue('INVALID_VALUE', `${at}.period`, `must be one of ${QUOTA_PERIODS.join(', ')}`));
      return;
    }
    if (!nonNegativeNumber(entry['limit'])) {
      issues.push(issue('INVALID_TYPE', `${at}.limit`, 'must be a finite, non-negative number'));
      return;
    }
    const scopeKey = entry['scopeKey'];
    if (scopeKey !== undefined && (typeof scopeKey !== 'string' || !SCOPE_KEY_PATTERN.test(scopeKey))) {
      issues.push(issue('PATTERN_MISMATCH', `${at}.scopeKey`, 'must be a stable scope key'));
      return;
    }
    for (const key of ['reservationTokens', 'reservationCost'] as const) {
      if (entry[key] !== undefined && !nonNegativeNumber(entry[key])) {
        issues.push(issue('INVALID_TYPE', `${at}.${key}`, 'must be a finite, non-negative number'));
        return;
      }
    }
    policies.push({
      scope: scope as QuotaPolicy['scope'],
      meter: meter as QuotaPolicy['meter'],
      period: period as QuotaPolicy['period'],
      limit: entry['limit'] as number,
      ...(typeof scopeKey === 'string' ? { scopeKey } : {}),
      ...(nonNegativeNumber(entry['reservationTokens']) ? { reservationTokens: entry['reservationTokens'] as number } : {}),
      ...(nonNegativeNumber(entry['reservationCost']) ? { reservationCost: entry['reservationCost'] as number } : {}),
    });
  });
  return policies;
}

function parseBudget(value: unknown, path: string, issues: ValidationIssue[]): BudgetPolicy {
  if (!isRecord(value)) {
    issues.push(issue('INVALID_TYPE', path, 'must be an object'));
    return {};
  }
  checkKeys(value, BUDGET_KEYS, path, issues);
  for (const key of ['maxEstimatedCostPerRequest', 'maxEstimatedCostPerDay', 'maxEstimatedCostPerMonth'] as const) {
    if (value[key] !== undefined && !nonNegativeNumber(value[key])) {
      issues.push(issue('INVALID_TYPE', `${path}.${key}`, 'must be a finite, non-negative number'));
    }
  }
  const currency = value['currency'];
  if (currency !== undefined && (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency))) {
    issues.push(issue('PATTERN_MISMATCH', `${path}.currency`, 'must be an ISO 4217 currency code, e.g. USD'));
  }
  return {
    ...(nonNegativeNumber(value['maxEstimatedCostPerRequest']) ? { maxEstimatedCostPerRequest: value['maxEstimatedCostPerRequest'] as number } : {}),
    ...(nonNegativeNumber(value['maxEstimatedCostPerDay']) ? { maxEstimatedCostPerDay: value['maxEstimatedCostPerDay'] as number } : {}),
    ...(nonNegativeNumber(value['maxEstimatedCostPerMonth']) ? { maxEstimatedCostPerMonth: value['maxEstimatedCostPerMonth'] as number } : {}),
    ...(typeof currency === 'string' ? { currency } : {}),
  };
}

function parsePricing(value: unknown, path: string, issues: ValidationIssue[]): PricingRecord[] {
  if (!Array.isArray(value)) {
    issues.push(issue('INVALID_TYPE', path, 'must be an array of pricing records'));
    return [];
  }
  const records: PricingRecord[] = [];
  value.forEach((entry, index) => {
    const at = `${path}[${index}]`;
    if (!isRecord(entry)) {
      issues.push(issue('INVALID_TYPE', at, 'must be an object'));
      return;
    }
    checkKeys(entry, PRICING_KEYS, at, issues);
    for (const key of ['pricingId', 'version', 'providerId', 'currency', 'source'] as const) {
      if (typeof entry[key] !== 'string' || entry[key].length === 0) {
        issues.push(issue('MISSING_FIELD', `${at}.${key}`, 'must be a non-empty string'));
      }
    }
    for (const key of ['modelAlias', 'modelRef'] as const) {
      const target = entry[key];
      if (target !== undefined && (typeof target !== 'string' || target.length === 0)) {
        issues.push(issue('INVALID_TYPE', `${at}.${key}`, 'must be a non-empty string'));
      }
    }
    if (entry['modelAlias'] === undefined && entry['modelRef'] === undefined) {
      issues.push(issue('MISSING_FIELD', at, 'must name a modelAlias or a modelRef'));
    }
    if (!nonNegativeInt(entry['validFromMs'])) {
      issues.push(issue('INVALID_TYPE', `${at}.validFromMs`, 'must be a non-negative integer of milliseconds'));
    }
    if (entry['validUntilMs'] !== undefined && !nonNegativeInt(entry['validUntilMs'])) {
      issues.push(issue('INVALID_TYPE', `${at}.validUntilMs`, 'must be a non-negative integer of milliseconds'));
    }
    for (const key of ['inputTokenPrice', 'outputTokenPrice', 'cachedInputPrice', 'reasoningTokenPrice'] as const) {
      if (entry[key] !== undefined && !nonNegativeNumber(entry[key])) {
        issues.push(issue('INVALID_TYPE', `${at}.${key}`, 'must be a finite, non-negative number'));
      }
    }
    const unit = entry['unit'];
    if (typeof unit !== 'string' || !(PRICING_UNITS as readonly string[]).includes(unit)) {
      issues.push(issue('INVALID_VALUE', `${at}.unit`, `must be one of ${PRICING_UNITS.join(', ')}`));
      return;
    }
    if (issues.some((existing) => existing.path.startsWith(at))) {
      return;
    }
    records.push({
      pricingId: entry['pricingId'] as string,
      version: entry['version'] as string,
      providerId: entry['providerId'] as string,
      currency: entry['currency'] as string,
      source: entry['source'] as string,
      unit: unit as PricingRecord['unit'],
      validFromMs: entry['validFromMs'] as number,
      ...(typeof entry['modelAlias'] === 'string' ? { modelAlias: entry['modelAlias'] } : {}),
      ...(typeof entry['modelRef'] === 'string' ? { modelRef: entry['modelRef'] } : {}),
      ...(nonNegativeInt(entry['validUntilMs']) ? { validUntilMs: entry['validUntilMs'] as number } : {}),
      ...(nonNegativeNumber(entry['inputTokenPrice']) ? { inputTokenPrice: entry['inputTokenPrice'] as number } : {}),
      ...(nonNegativeNumber(entry['outputTokenPrice']) ? { outputTokenPrice: entry['outputTokenPrice'] as number } : {}),
      ...(nonNegativeNumber(entry['cachedInputPrice']) ? { cachedInputPrice: entry['cachedInputPrice'] as number } : {}),
      ...(nonNegativeNumber(entry['reasoningTokenPrice']) ? { reasoningTokenPrice: entry['reasoningTokenPrice'] as number } : {}),
    });
  });
  return records;
}

function parseIdempotency(value: unknown, path: string, issues: ValidationIssue[]): RuntimeGovernanceConfigInput['idempotency'] {
  if (!isRecord(value)) {
    issues.push(issue('INVALID_TYPE', path, 'must be an object'));
    return undefined;
  }
  checkKeys(value, IDEMPOTENCY_KEYS, path, issues);
  const enabled = parseBooleanField(value, 'enabled', path, issues);
  if (value['retentionMs'] !== undefined && !positiveInt(value['retentionMs'])) {
    issues.push(issue('INVALID_TYPE', `${path}.retentionMs`, 'must be a positive integer of milliseconds'));
  }
  if (value['capacity'] !== undefined && !positiveInt(value['capacity'])) {
    issues.push(issue('INVALID_TYPE', `${path}.capacity`, 'must be a positive integer'));
  }
  return {
    ...(enabled === undefined ? {} : { enabled }),
    ...(positiveInt(value['retentionMs']) ? { retentionMs: value['retentionMs'] as number } : {}),
    ...(positiveInt(value['capacity']) ? { capacity: value['capacity'] as number } : {}),
  };
}

function parseGovernance(value: unknown, path: string, issues: ValidationIssue[]): RuntimeGovernanceConfigInput {
  if (!isRecord(value)) {
    issues.push(issue('INVALID_TYPE', path, 'must be an object'));
    return {};
  }
  checkKeys(value, GOVERNANCE_CONFIG_KEYS, path, issues);
  const outputRepair = value['outputRepair'];
  if (outputRepair !== undefined && !(OUTPUT_REPAIR_POLICY_VALUES as readonly string[]).includes(outputRepair as string)) {
    issues.push(issue('INVALID_VALUE', `${path}.outputRepair`, `must be one of ${OUTPUT_REPAIR_POLICY_VALUES.join(', ')}`));
  }
  const unknownUsage = value['unknownUsage'];
  if (unknownUsage !== undefined && !(UNKNOWN_USAGE_VALUES as readonly string[]).includes(unknownUsage as string)) {
    issues.push(issue('INVALID_VALUE', `${path}.unknownUsage`, `must be one of ${UNKNOWN_USAGE_VALUES.join(', ')}`));
  }
  let killSwitch: KillSwitchState | undefined;
  if (value['killSwitch'] !== undefined) {
    const parsed = parseKillSwitchState(value['killSwitch'], `${path}.killSwitch`);
    if (parsed.ok) {
      killSwitch = parsed.value;
    } else {
      issues.push(...parsed.failure.issues);
    }
  }
  return {
    ...(value['fallback'] === undefined ? {} : withFallback(value['fallback'], path, issues)),
    ...(value['retry'] === undefined ? {} : withRetry(value['retry'], path, issues)),
    ...(value['breaker'] === undefined ? {} : withBreaker(value['breaker'], path, issues)),
    rateLimits: value['rateLimits'] === undefined ? [] : parseRateLimits(value['rateLimits'], `${path}.rateLimits`, issues),
    quotas: value['quotas'] === undefined ? [] : parseQuotas(value['quotas'], `${path}.quotas`, issues),
    budget: value['budget'] === undefined ? {} : parseBudget(value['budget'], `${path}.budget`, issues),
    pricing: value['pricing'] === undefined ? [] : parsePricing(value['pricing'], `${path}.pricing`, issues),
    ...(value['idempotency'] === undefined ? {} : withIdempotency(value['idempotency'], path, issues)),
    ...(outputRepair === undefined ? {} : { outputRepair: outputRepair as OutputRepairPolicy }),
    ...(unknownUsage === undefined ? {} : { unknownUsage: unknownUsage as UnknownUsagePolicy }),
    ...(killSwitch === undefined ? {} : { killSwitch }),
  };
}

function withFallback(value: unknown, path: string, issues: ValidationIssue[]): { fallback?: FallbackPolicyInput } {
  const parsed = parseFallbackPolicy(value, `${path}.fallback`, issues);
  return parsed === undefined ? {} : { fallback: parsed };
}

function withRetry(value: unknown, path: string, issues: ValidationIssue[]): { retry?: RetryPolicyInput } {
  const parsed = parseRetryPolicy(value, `${path}.retry`, issues);
  return parsed === undefined ? {} : { retry: parsed };
}

function withBreaker(value: unknown, path: string, issues: ValidationIssue[]): { breaker?: BreakerConfig } {
  const parsed = parseBreakerConfig(value, `${path}.breaker`, issues);
  return parsed === undefined ? {} : { breaker: parsed };
}

function withIdempotency(value: unknown, path: string, issues: ValidationIssue[]): { idempotency?: IdempotencyConfigInput } {
  const parsed = parseIdempotency(value, `${path}.idempotency`, issues);
  return parsed === undefined ? {} : { idempotency: parsed };
}

/**
 * Parse the whole runtime configuration document. Closed key sets throughout (`providers`,
 * `routes`, `governance`); the provider suite's own strict rules and SSRF checks run unchanged.
 */
export function parseRuntimeConfig(value: unknown, path = '$'): ValidationResult<RuntimeConfigInput> {
  if (!isRecord(value)) {
    return invalid('MALFORMED_ENVELOPE', [issue('INVALID_TYPE', path, 'must be an object')]);
  }
  const issues: ValidationIssue[] = [];
  checkKeys(value, RUNTIME_CONFIG_KEYS, path, issues);

  const suite = parseProviderSuiteConfig({ providers: value['providers'], routes: value['routes'] }, path);
  if (!suite.ok) {
    issues.push(...suite.failure.issues);
  }
  const governance = parseGovernance(value['governance'] ?? {}, `${path}.governance`, issues);
  if (issues.length > 0 || !suite.ok) {
    return invalid('MALFORMED_ENVELOPE', issues);
  }
  return valid({ suite: suite.value, governance });
}

/** The profile → alias-resolved route table with aliases preserved for provenance. */
export function compileRoutes(config: ProviderSuiteConfig): RuntimeRoutes {
  const routes: Partial<Record<string, readonly RouteEntry[]>> = {};
  for (const route of config.routes) {
    routes[route.profile] = route.chain.map((alias) => {
      const resolved = resolveModelAlias(config, alias);
      return {
        providerId: resolved?.provider.providerId ?? alias,
        modelRef: resolved?.model.providerModelId ?? alias,
        modelAlias: alias,
      };
    });
  }
  return routes as RuntimeRoutes;
}

/** Fallback-chain compilation (Phase 6): cycle, duplicate target and impossible target all fail. */
export function compileFallbackIssues(config: ProviderSuiteConfig): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  config.routes.forEach((route, index) => {
    const chainIssues = validateFallbackChain(
      route.chain,
      (alias) => {
        const resolved = resolveModelAlias(config, alias);
        return resolved === null ? null : `${resolved.provider.providerId}::${resolved.model.providerModelId}`;
      },
      `$.routes[${index}].chain`,
    );
    issues.push(...chainIssues);
  });
  return issues;
}

/** Canonical JSON: object keys sorted, so the digest does not depend on authoring order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  }
  if (isRecord(value)) {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function stableDigest(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let index = 0; index < text.length; index += 1) {
    a ^= text.charCodeAt(index) & 0xff;
    a = Math.imul(a, 0x01000193) >>> 0;
    b ^= text.charCodeAt(index) >>> 8;
    b = Math.imul(b, 0x01000193) >>> 0;
  }
  return `dgst-${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}`;
}

export type CompileSnapshotOptions = {
  readonly clock: Clock;
  readonly configVersion: number;
};

/**
 * Compile a parsed configuration into an immutable snapshot. Runs **every** validation step
 * (Phase 41): suite semantics + SSRF, fallback-chain compilation, pricing validation, quota
 * validation. A snapshot comes back only when all of them pass.
 */
export function compileRuntimeSnapshot(input: RuntimeConfigInput, options: CompileSnapshotOptions): ValidationResult<RuntimeConfigSnapshot> {
  const issues: ValidationIssue[] = [];
  issues.push(...compileFallbackIssues(input.suite));

  const pricing = new PricingTable(input.governance.pricing ?? []);
  issues.push(...pricing.validate('$.governance.pricing'));

  const quotas = input.governance.quotas ?? [];
  quotas.forEach((quota, index) => {
    if (quota.meter === 'ESTIMATED_COST' && quota.reservationCost !== undefined && quota.reservationCost > quota.limit) {
      issues.push(
        issue('INVALID_VALUE', `$.governance.quotas[${index}].reservationCost`, 'a reservation larger than the limit can never be granted'),
      );
    }
    if (quota.meter === 'TOKENS' && quota.reservationTokens !== undefined && quota.reservationTokens > quota.limit) {
      issues.push(
        issue('INVALID_VALUE', `$.governance.quotas[${index}].reservationTokens`, 'a reservation larger than the limit can never be granted'),
      );
    }
  });

  const rateLimits = input.governance.rateLimits ?? [];
  rateLimits.forEach((policy, index) => {
    if (policy.limit < 1 || policy.windowMs < 1) {
      issues.push(issue('INVALID_VALUE', `$.governance.rateLimits[${index}]`, 'limit and windowMs must be positive'));
    }
    if ((policy.dimension === 'provider' || policy.dimension === 'capability') && policy.scopeKey === undefined) {
      // Not fatal: the key falls back to the request's own provider/capability. Recorded nowhere —
      // deliberately silent, because it is a valid shorthand.
    }
  });

  if (issues.length > 0) {
    return invalid('MALFORMED_ENVELOPE', issues);
  }

  const governance: ResolvedRuntimeGovernance = {
    fallback: resolveFallbackPolicy(input.governance.fallback ?? {}),
    retry: resolveRetryPolicy(input.governance.retry ?? {}),
    breaker: resolveBreakerConfig(input.governance.breaker ?? {}),
    rateLimits: [...rateLimits],
    quotas: [...quotas],
    budget: input.governance.budget ?? {},
    pricing,
    idempotency: {
      enabled: input.governance.idempotency?.enabled ?? true,
      ...(input.governance.idempotency?.retentionMs === undefined ? {} : { retentionMs: input.governance.idempotency.retentionMs }),
      ...(input.governance.idempotency?.capacity === undefined ? {} : { capacity: input.governance.idempotency.capacity }),
    },
    outputRepair: input.governance.outputRepair ?? 'ONCE',
    unknownUsage: input.governance.unknownUsage ?? 'CONSERVATIVE',
  };

  return valid({
    configVersion: `cfg-${options.configVersion}`,
    contentDigest: stableDigest(canonicalJson(input)),
    createdAtMs: options.clock.nowMs(),
    input,
    routes: compileRoutes(input.suite),
    governance,
    killSwitch: input.governance.killSwitch ?? emptyKillSwitch(),
  });
}

/** Durable-enough snapshot history. `rollback` reads it (Phase 43). */
export interface ConfigSnapshotStorePort {
  push(snapshot: RuntimeConfigSnapshot): Promise<void>;
  list(): Promise<readonly RuntimeConfigSnapshot[]>;
}

/** The in-memory reference store. V1 keeps history in process (Phase 43). */
export class InMemoryConfigSnapshotStore implements ConfigSnapshotStorePort {
  readonly #snapshots: RuntimeConfigSnapshot[] = [];

  push(snapshot: RuntimeConfigSnapshot): Promise<void> {
    this.#snapshots.push(snapshot);
    return Promise.resolve();
  }

  list(): Promise<readonly RuntimeConfigSnapshot[]> {
    return Promise.resolve([...this.#snapshots]);
  }
}

export type ConfigManagerOptions = {
  readonly clock: Clock;
  readonly events?: OperationalEventSink;
  readonly store?: ConfigSnapshotStorePort;
};

/** Walk-back window for `history()`/`rollback()`: generations accumulate on every reload. */
export const CONFIG_HISTORY_LIMIT = 20;

/**
 * The configuration manager: validated-first, atomic, rollback-able (Phase 41–43).
 *
 * In-flight requests keep the snapshot object they bound at ingress — a reload only affects
 * requests that arrive after the swap (Phase 42).
 */
export class ConfigManager {
  readonly #clock: Clock;
  readonly #events: OperationalEventSink;
  readonly #store: ConfigSnapshotStorePort;
  readonly #history: RuntimeConfigSnapshot[] = [];
  #active: RuntimeConfigSnapshot | null = null;
  #counter = 0;

  private constructor(options: ConfigManagerOptions) {
    this.#clock = options.clock;
    this.#events = options.events ?? nullOperationalEventSink();
    this.#store = options.store ?? new InMemoryConfigSnapshotStore();
  }

  /** Validate and activate the first configuration. Fails without side effects. */
  static bootstrap(candidate: unknown, options: ConfigManagerOptions): ValidationResult<ConfigManager> {
    const manager = new ConfigManager(options);
    const compiled = manager.#compile(candidate);
    if (!compiled.ok) {
      return invalid(compiled.failure.reason, compiled.failure.issues);
    }
    manager.#activate(compiled.value);
    return valid(manager);
  }

  /** The currently active snapshot. Never null after a successful bootstrap. */
  active(): RuntimeConfigSnapshot {
    if (this.#active === null) {
      throw new Error('ConfigManager: no active configuration');
    }
    return this.#active;
  }

  /** Every previously active snapshot, oldest first. */
  history(): readonly RuntimeConfigSnapshot[] {
    return [...this.#history];
  }

  /**
   * Atomic reload (Phase 41). Every step validates first; only a full pass swaps the snapshot.
   * Any failure keeps the previous snapshot active and emits `ai.config_reload_failed`.
   */
  async reload(candidate: unknown): Promise<ValidationResult<RuntimeConfigSnapshot>> {
    const compiled = this.#compile(candidate);
    if (!compiled.ok) {
      const first = compiled.failure.issues[0];
      this.#events.emit({
        type: 'ai.config_reload_failed',
        atMs: this.#clock.nowMs(),
        payload: {
          issueCount: compiled.failure.issues.length,
          ...(first === undefined ? {} : { firstPath: first.path, firstIssueCode: first.code }),
        },
      });
      return compiled;
    }
    this.#activate(compiled.value);
    await this.#store.push(compiled.value);
    this.#events.emit({
      type: 'ai.config_reloaded',
      atMs: this.#clock.nowMs(),
      payload: { configVersion: compiled.value.configVersion, contentDigest: compiled.value.contentDigest },
    });
    return compiled;
  }

  /** Roll back to the previously active snapshot (Phase 43). */
  async rollback(): Promise<ValidationResult<RuntimeConfigSnapshot>> {
    const previous = this.#history.pop();
    if (previous === undefined || this.#active === null) {
      return invalid('MALFORMED_ENVELOPE', [
        issue('MISSING_FIELD', '$', 'there is no previous configuration to roll back to'),
      ]);
    }
    // The restored entry leaves the history: consecutive rollbacks walk back through
    // generations (N → N-1 → N-2) instead of replaying one. The displaced generation is
    // dropped — rollback is revert, not undo/redo — and a later reload pushes fresh history.
    this.#active = previous;
    await this.#store.push(previous);
    this.#events.emit({
      type: 'ai.config_reloaded',
      atMs: this.#clock.nowMs(),
      payload: { configVersion: `${previous.configVersion} (rollback)`, contentDigest: previous.contentDigest },
    });
    return valid(previous);
  }

  #compile(candidate: unknown): ValidationResult<RuntimeConfigSnapshot> {
    const parsed = parseRuntimeConfig(candidate);
    if (!parsed.ok) {
      return parsed;
    }
    return compileRuntimeSnapshot(parsed.value, { clock: this.#clock, configVersion: this.#counter + 1 });
  }

  #activate(snapshot: RuntimeConfigSnapshot): void {
    if (this.#active !== null) {
      this.#history.push(this.#active);
      // Generations accumulate on every reload; keep the walk-back window bounded.
      while (this.#history.length > CONFIG_HISTORY_LIMIT) {
        this.#history.shift();
      }
    }
    this.#active = snapshot;
    this.#counter += 1;
  }
}

/** A synthetic snapshot for runtimes built from `RuntimeRoutes` without a config manager. */
export function syntheticSnapshot(
  routes: RuntimeRoutes,
  options: { readonly clock: Clock; readonly governance?: RuntimeGovernanceConfigInput },
): RuntimeConfigSnapshot {
  const governance = options.governance ?? {};
  return {
    configVersion: 'cfg-0',
    contentDigest: stableDigest(canonicalJson({ routes, governance })),
    createdAtMs: options.clock.nowMs(),
    input: { suite: { providers: [], routes: [] }, governance },
    routes,
    governance: {
      fallback: resolveFallbackPolicy(governance.fallback ?? {}),
      retry: resolveRetryPolicy(governance.retry ?? {}),
      breaker: resolveBreakerConfig(governance.breaker ?? {}),
      rateLimits: governance.rateLimits ?? [],
      quotas: governance.quotas ?? [],
      budget: governance.budget ?? {},
      pricing: new PricingTable(governance.pricing ?? []),
      idempotency: {
        enabled: governance.idempotency?.enabled ?? true,
        ...(governance.idempotency?.retentionMs === undefined ? {} : { retentionMs: governance.idempotency.retentionMs }),
        ...(governance.idempotency?.capacity === undefined ? {} : { capacity: governance.idempotency.capacity }),
      },
      outputRepair: governance.outputRepair ?? 'ONCE',
      unknownUsage: governance.unknownUsage ?? 'CONSERVATIVE',
    },
    killSwitch: governance.killSwitch ?? emptyKillSwitch(),
  };
}

/** Guard: an alias pattern is checked so a model alias can never smuggle a model id. */
export function isModelAlias(value: string): boolean {
  return MODEL_ALIAS_PATTERN.test(value) || PROVIDER_ID_PATTERN.test(value);
}
