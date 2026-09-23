/**
 * `@aibridge/runtime` — the Stage 3 runtime layer.
 *
 * Sits between the generic AI contracts and a provider adapter:
 *
 * ```text
 * Consumer → Generic AI Contract → AiRuntime → Provider Adapter → Real Provider → normalized Generic Result
 * ```
 *
 * Depends on `@aibridge/contracts`, `@aibridge/core` and `@aibridge/host-sdk` (host ports only).
 * It owns no provider, no host and no consumer: providers arrive through the `AiProviderAdapter`
 * port and credentials through the trusted secret port (ARCHITECTURE.md §2).
 */

export {
  AiRuntime,
  defaultCapabilityRegistry,
  systemClock,
  type BoundProvider,
  type ExecuteOptions,
  type ResolvedRoute,
  type RouteEntry,
  type RuntimeLimits,
  type RuntimeOptions,
  type RuntimeProviderRegistration,
  type RuntimeRoutes,
} from './runtime.js';

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
  resolveRoute,
  unmetRequirements,
  type RouteResolution,
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
  type FallbackVerdict,
} from './fallback.js';
