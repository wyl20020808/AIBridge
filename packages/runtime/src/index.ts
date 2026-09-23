/**
 * `@aibridge/runtime` — the Stage 3 runtime layer, extended in Stage 5 with reliability,
 * fallback and governance.
 *
 * Sits between the generic AI contracts and a provider adapter:
 *
 * ```text
 * Consumer → Generic AI Contract → AiRuntime → ExecutionCoordinator → Provider Adapter → Real Provider
 *          ← normalized Generic Result + reliability provenance ←
 * ```
 *
 * Depends on `@aibridge/contracts`, `@aibridge/core`, `@aibridge/host-sdk` (host ports only) and
 * `@aibridge/governance` (reliability primitives). It owns no provider, no host and no consumer:
 * providers arrive through the `AiProviderAdapter` port and credentials through the trusted secret
 * port (ARCHITECTURE.md §2).
 */

export {
  AiRuntime,
  defaultCapabilityRegistry,
  projectionFor,
  systemClock,
  type BoundProvider,
  type ExecuteOptions,
  type ExecutionOutcome,
  type PlanTarget,
  type ResolvedRoute,
  type RouteEntry,
  type RuntimeGovernanceServices,
  type RuntimeLimits,
  type RuntimeOptions,
  type RuntimeProviderRegistration,
  type RuntimeRoutes,
} from './runtime.js';

export {
  ExecutionCoordinator,
  buildProviderRequest,
  nextFallbackVerdict,
  raceAttempt,
  type AttemptOutcome,
  type AttemptTarget,
  type CoordinatorServices,
  type ExecutionPlan,
} from './coordinator.js';

export {
  budgetExhaustedError,
  cancelledByCallerError,
  cancelledByHostError,
  normalizeProviderError,
  normalizeThrown,
  providerTimeoutError,
  validationFailureToAiError,
} from './errors.js';

export {
  repairExhaustedError,
  structuredOutputOutcome,
  textOutputOutcome,
  type ShapedOutput,
  type ValueOutcome,
} from './output.js';

export {
  OPERATOR_DETAIL_MAX_LENGTH,
  OPERATOR_LOG_EVENTS,
  RecordingOperatorLog,
  nullOperatorLog,
  redactOperatorDetail,
  type OperatorLogEntry,
  type OperatorLogEvent,
  type OperatorLogSink,
} from './operator-log.js';

export {
  classifyModel,
  enumerateRouteCandidates,
  resolveRoute,
  unmetRequirements,
  type RouteCandidateScan,
  type RouteResolution,
  type SkippedCandidate,
} from './routes.js';

export {
  CREDENTIAL_REF_PATTERN,
  CONFIG_AUTH_SCHEMES,
  CONFIG_WIRE_PROTOCOLS,
  CONFIG_XIAOMI_CLUSTERS,
  FEATURE_ASSURANCE,
  MODEL_ALIAS_PATTERN,
  PROVIDER_ID_PATTERN,
  PROVIDER_PRESETS,
  featureStatus,
  parseProviderSuiteConfig,
  resolveModelAlias,
  semanticIssues,
  type ConfigAuthScheme,
  type ConfigWireProtocol,
  type ConfigXiaomiCluster,
  type FeatureAssurance,
  type ModelAliasConfig,
  type ProviderConfig,
  type ProviderEndpointConfig,
  type ProviderPreset,
  type ProviderSuiteConfig,
  type RouteConfig,
} from './config.js';

export {
  ConfigManager,
  InMemoryConfigSnapshotStore,
  canonicalJson,
  compileFallbackIssues,
  compileRoutes,
  compileRuntimeSnapshot,
  isModelAlias,
  parseRuntimeConfig,
  syntheticSnapshot,
  GOVERNANCE_CONFIG_KEYS,
  OUTPUT_REPAIR_POLICY_VALUES,
  type CompileSnapshotOptions,
  type ConfigManagerOptions,
  type ConfigSnapshotStorePort,
  type IdempotencyConfigInput,
  type OutputRepairPolicy,
  type ResolvedRuntimeGovernance,
  type RuntimeConfigInput,
  type RuntimeConfigSnapshot,
  type RuntimeGovernanceConfigInput,
} from './config-manager.js';

export {
  buildRuntimeRoutes,
  defaultAuthSchemeForPreset,
  materializeProviderSuite,
  protocolForPreset,
  type AdapterFactory,
  type AdapterFactorySpec,
  type AdapterFactories,
  type MaterializeOptions,
  type MaterializedProvider,
  type ModelDiagnostic,
  type ProviderDiagnostic,
  type ProviderSuiteRuntime,
} from './suite.js';

export {
  nextFallback,
  validateFallbackChain,
  MAX_FALLBACK_CHAIN_LENGTH,
  type FallbackVerdict,
} from './fallback.js';
