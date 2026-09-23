/**
 * `@aibridge/host-sdk` — host ports, in-memory and mutant fakes, the scripted provider, and the
 * host/provider conformance kits.
 *
 * Depends on `@aibridge/contracts` and `@aibridge/core`. Names no host, imports no SDK, makes no
 * network call (ARCHITECTURE.md §2, §21).
 */

export {
  type Clock,
  type ConfigPort,
  type HostServices,
  type KillSwitchAuthorityPort,
  type PermissionPort,
  type PluginIdentityPort,
  type SecretStorePort,
  type SubjectTokenPort,
  type UsageRecord,
  type UsageStorePort,
} from './ports.js';

export {
  InMemoryConfigPort,
  InMemoryIdentityPort,
  InMemoryKillSwitchAuthority,
  InMemoryPermissionPort,
  InMemorySecretStore,
  InMemorySubjectTokenPort,
  InMemoryUsageStore,
  MutantBrokenClock,
  MutantDroppingUsageStore,
  MutantEmptyIdentity,
  MutantInvalidKillSwitchAuthority,
  MutantLeakySecretStore,
  MutantNonOpaqueSubjectTokens,
  MutantPermissivePermissions,
  REDACTED,
  TestClock,
  makeInMemoryHost,
  mutantHosts,
  type NamedHost,
} from './fakes.js';

export {
  ScriptedProviderAdapter,
  hangStep,
  rejectStep,
  structuredStep,
  textStep,
  type ScriptedProviderOptions,
  type ScriptedStructuredStep,
  type ScriptedTextStep,
} from './scripted-provider.js';

export {
  runHostConformance,
  type ConformanceFinding,
  type ConformanceReport,
  type HostConformanceOptions,
} from './host-conformance.js';

export {
  PROVIDER_CONFORMANCE_CASES,
  makeProviderRequest,
  runProviderConformance,
  type ProviderConformanceCase,
  type ProviderConformanceOptions,
} from './provider-conformance.js';
