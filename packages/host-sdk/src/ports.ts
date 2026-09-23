/**
 * Host ports (ARCHITECTURE.md §1.2, ROADMAP Stage 2).
 *
 * These are **interfaces only**: the shape a host must satisfy, and nothing about how it does so.
 * No host is named, no HTTP client is referenced, no database driver is imported. Where a host
 * offers more than AI Bridge needs, its adapter narrows; where it offers less, the adapter says so
 * rather than faking it (ARCHITECTURE.md §21).
 */
import type {
  AiErrorCode,
  AiUsage,
  KillSwitchState,
  ModelClass,
  RequestMetadata,
} from '@aibridge/contracts';

/** Who is calling. Minted by the host at the plugin runtime boundary; never self-declared. */
export interface PluginIdentityPort {
  /**
   * The host-bound plugin id for the current call, or `null` when identity is not bound.
   *
   * Returning `null` is honest and must lead to `CALLER_NOT_PERMITTED`; returning a caller-supplied
   * value would launder a forged identity (SECURITY.md §4).
   */
  currentCallerPluginId(): string | null;
}

/** The host's permission decision. AI Bridge re-checks it as defence in depth (SECURITY.md §5). */
export interface PermissionPort {
  isCapabilityGranted(callerPluginId: string, capability: string, capabilityVersion?: string): boolean;
  declaredCapabilities(callerPluginId: string): readonly string[];
}

/** Mints an opaque, AI-Bridge-scoped subject handle. Never an email, never a session token. */
export interface SubjectTokenPort {
  mintSubjectToken(): string | null;
}

/** Resolves a credential handle (`secret://…`) to its value. The value must never be logged. */
export interface SecretStorePort {
  resolve(handle: string): Promise<string | null>;
  has(handle: string): Promise<boolean>;
}

/**
 * One usage record: cost and capacity evidence only.
 *
 * Deliberately has **no** prompt, output, learner text or message field. Nothing here may influence
 * a learning judgement (SECURITY.md §6.1).
 */
export type UsageRecord = {
  readonly capability: string;
  readonly capabilityVersion: string;
  readonly callerPluginId: string;
  /** A hashed subject handle, never the token itself. */
  readonly subjectHash?: string;
  readonly providerId: string;
  readonly modelClass: ModelClass;
  readonly status: 'SUCCEEDED' | 'FAILED';
  readonly errorCode?: AiErrorCode;
  readonly latencyMs: number;
  readonly usage: AiUsage;
  readonly atMs: number;
  /** Routing metadata only (locale/surface/trace). Never prompt content. */
  readonly metadata?: RequestMetadata;
};

/** Durable-enough usage storage. The host owns persistence; AI Bridge owns the record shape. */
export interface UsageStorePort {
  append(record: UsageRecord): Promise<void>;
  list(): Promise<readonly UsageRecord[]>;
}

/** Configuration surface. Reload is observed, never driven, by AI Bridge. */
export interface ConfigPort<TConfig = unknown> {
  load(): Promise<TConfig>;
  onReload(callback: (config: TConfig) => void): () => void;
}

/** Who may throw the global switch: an operator, not a plugin (ARCHITECTURE.md §20). */
export interface KillSwitchAuthorityPort {
  currentState(): KillSwitchState;
  onChange(callback: (state: KillSwitchState) => void): () => void;
}

/** An injectable clock, so deadline arithmetic is testable without real time. */
export interface Clock {
  nowMs(): number;
}

/** The complete set of ports a host must satisfy. */
export type HostServices = {
  readonly identity: PluginIdentityPort;
  readonly permissions: PermissionPort;
  readonly subjectTokens: SubjectTokenPort;
  readonly secrets: SecretStorePort;
  readonly usage: UsageStorePort;
  readonly config: ConfigPort;
  readonly killSwitch: KillSwitchAuthorityPort;
  readonly clock: Clock;
};
