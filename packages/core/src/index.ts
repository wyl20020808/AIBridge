/**
 * `@aibridge/core` — portable AI Bridge primitives.
 *
 * Depends only on `@aibridge/contracts`. Owns input safety, structural output safety, the
 * capability registry and directory, governance switches, and provider/model registries. Owns no
 * concrete provider, host or consumer (ARCHITECTURE.md §2).
 */

export {
  canonicalize,
  isRecord,
  jsonByteLength,
  mapStrings,
  utf8ByteLength,
  walkStrings,
} from './util.js';

export {
  DEFAULT_MAX_INPUT_BYTES,
  PII_PATTERNS,
  SECRET_PATTERNS,
  findPii,
  findSecrets,
  firstSecretPath,
  screenAiInput,
  type InputFinding,
  type InputScreenFailure,
  type InputScreenOptions,
  type InputScreenResult,
  type InputScreenSuccess,
  type PiiCategory,
  type PiiPattern,
  type SecretPattern,
} from './input-safety.js';

export {
  guardStructuredOutput,
  isStructurallySafe,
  type OutputGuardFailure,
  type OutputGuardOptions,
  type OutputGuardResult,
  type OutputGuardSuccess,
} from './output-safety.js';

export {
  CapabilityRegistry,
  RETENTION_LEVELS,
  TurnCallCounter,
  authorizeCapabilityCall,
  registrationDescriptorVersion,
  toCapabilityDescriptor,
  type CallAuthorization,
  type CapabilityRegistration,
  type Retention,
} from './registry.js';

export {
  KillSwitchRegistry,
  killSwitchError,
  verdictError,
} from './killswitch.js';

export { ModelRegistry, ProviderRegistry } from './providers.js';

export {
  BUILTIN_CAPABILITY_REGISTRATIONS,
  CALLER_OWNED_OUTPUT_SCHEMA,
  CODE_DEBUG_CAPABILITY_REGISTRATION,
  GENERIC_CAPABILITY_REGISTRATIONS,
  GENERIC_STRUCTURED_POLICY,
  GENERIC_TEXT_POLICY,
  allowsCallerOutputSchema,
} from './descriptors.js';

export {
  ENDPOINT_REJECTIONS,
  checkEndpointSafety,
  endpointIssue,
  validateEndpointUrl,
  type EndpointCheck,
  type EndpointRejection,
  type EndpointSafetyOptions,
} from './endpoint-safety.js';

export { AiCapabilityDirectory, type CapabilityDirectoryOptions } from './directory.js';
