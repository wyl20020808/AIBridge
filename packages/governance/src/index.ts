/**
 * `@aibridge/governance` — the Stage 5 reliability and governance layer.
 *
 * Host-neutral primitives the runtime composes:
 *
 * ```text
 * fallback policy → bounded retry → circuit breaker → runtime health
 * idempotency → rate limit → quota (with reservations) → budget
 * usage ledger → versioned cost estimation → provenance → observability
 * ```
 *
 * Depends only on `@aibridge/contracts` (the frozen vocabulary) and `@aibridge/host-sdk` (the
 * `Clock` port). It owns no provider, no host and no consumer — every stateful piece arrives as a
 * port with an in-memory reference implementation (ARCHITECTURE.md §19).
 */

export {
  instantSleeper,
  systemSleeper,
  SLEEP_OUTCOMES,
  type Sleeper,
  type SleepOutcome,
} from './sleeper.js';

export { hashSubjectToken, safeSubjectRef } from './subject.js';

export { createIdMint, type IdMint } from './ids.js';

export {
  breakerImpact,
  classifyFailure,
  isRequestOrContentFailure,
  FAILURE_CLASSES,
  type FailureClass,
} from './failure-class.js';

export {
  CAPABILITY_DEGRADE_NOTE,
  decideFallback,
  fallbackOptionsOf,
  resolveFallbackPolicy,
  FALLBACK_STOP_RULES,
  type FallbackDecision,
  type FallbackPolicy,
  type FallbackStopRule,
  type ResolvedFallbackPolicy,
} from './fallback-policy.js';

export {
  backoffDelayMs,
  classifyRetryPhase,
  decideRetry,
  resolveRetryPolicy,
  DEFAULT_BASE_BACKOFF_MS,
  DEFAULT_MAX_BACKOFF_MS,
  MAX_SAME_PROVIDER_RETRIES,
  MIN_RETRY_VIABLE_MS,
  RETRY_PHASES,
  RETRY_STOP_RULES,
  type ResolvedRetryPolicy,
  type RetryDecision,
  type RetryDecisionInput,
  type RetryPhase,
  type RetryPolicy,
  type RetryStopRule,
} from './retry-policy.js';

export {
  CircuitBreaker,
  CircuitBreakerRegistry,
  resolveBreakerConfig,
  BREAKER_STATES,
  DEFAULT_BREAKER_CONFIG,
  type BreakerConfig,
  type BreakerRegistryOptions,
  type BreakerSnapshot,
  type BreakerState,
  type DispatchVerdict,
} from './breaker.js';

export {
  RuntimeHealthRegistry,
  HEALTH_STATES,
  type HealthState,
  type ProviderHealthReport,
  type RuntimeHealthOptions,
} from './health.js';

export {
  InMemoryIdempotencyStore,
  IdempotencyRegistry,
  hashRequestFingerprint,
  idempotencyIdentityKey,
  IDEMPOTENCY_CAPACITY,
  IDEMPOTENCY_RETENTION_MS,
  IDEMPOTENCY_STATUSES,
  type IdempotencyClaim,
  type IdempotencyGate,
  type IdempotencyIdentity,
  type IdempotencyRecord,
  type IdempotencyRegistryOptions,
  type IdempotencyStatus,
  type IdempotencyStorePort,
  type InMemoryIdempotencyStoreOptions,
} from './idempotency.js';

export {
  InMemoryRateLimitStore,
  RateLimiter,
  rateBucketKey,
  rateLimitReason,
  RATE_LIMIT_DIMENSIONS,
  type RateLimitDecision,
  type RateLimitDimension,
  type RateLimitPolicy,
  type RateLimitRequest,
  type RateLimitStorePort,
  type RateLimiterOptions,
} from './rate-limit.js';

export {
  InMemoryQuotaStore,
  QuotaManager,
  quotaBucket,
  quotaReason,
  reservationAmount,
  DEFAULT_TOKEN_RESERVATION,
  QUOTA_METERS,
  QUOTA_PERIODS,
  QUOTA_SCOPES,
  UNKNOWN_USAGE_POLICIES,
  type QuotaDecision,
  type QuotaManagerOptions,
  type QuotaMeter,
  type QuotaPeriod,
  type QuotaPolicy,
  type QuotaRequest,
  type QuotaReservation,
  type QuotaReservationEntry,
  type QuotaScope,
  type QuotaSettlement,
  type QuotaStorePort,
  type UnknownUsagePolicy,
} from './quota.js';

export {
  aggregateUsage,
  estimateCost,
  projectCostToUsage,
  usageIsUnknown,
  PricingTable,
  GOVERNANCE_COST_BASES,
  PRICING_UNITS,
  UNKNOWN_COST,
  type CostEstimate,
  type GovernanceCostBasis,
  type PricingRecord,
  type PricingSnapshot,
  type PricingUnit,
  type UsageAggregate,
} from './cost.js';

export {
  BudgetTracker,
  checkRequestBudget,
  BUDGET_METERS,
  type BudgetCheckInput,
  type BudgetDecision,
  type BudgetMeter,
  type BudgetPolicy,
  type BudgetTrackerOptions,
} from './budget.js';

export {
  InMemoryUsageLedger,
  ATTEMPT_KINDS,
  ATTEMPT_SKIP_REASONS,
  ATTEMPT_STATUSES,
  type AttemptKind,
  type AttemptSkipReason,
  type AttemptStatus,
  type LogicalRequestUsageRecord,
  type ProviderAttemptUsageRecord,
  type UsageLedgerPort,
} from './usage-ledger.js';

export {
  InMemoryMetrics,
  RecordingOperationalEvents,
  nullMetricsSink,
  nullOperationalEventSink,
  METRIC_LABEL_KEYS,
  METRIC_NAMES,
  OPERATIONAL_EVENT_TYPES,
  type MetricLabelKey,
  type MetricLabels,
  type MetricName,
  type MetricSample,
  type MetricsSink,
  type OperationalEvent,
  type OperationalEventPayload,
  type OperationalEventSink,
  type OperationalEventType,
} from './observability.js';

export {
  mergeCosts,
  summarize,
  type GovernanceSummary,
  type ProviderAttemptProvenance,
  type ReliabilityProvenance,
} from './provenance.js';

export {
  selectTerminalError,
  type TerminalSelectionInput,
  type TerminalCandidate,
} from './terminal.js';
