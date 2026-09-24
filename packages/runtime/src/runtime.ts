/**
 * `AiRuntime` — the trusted execution layer and **public execution entry** (Stage 3), extended in
 * Stage 5 with the reliability and governance layer.
 *
 * The one path every consumer call takes:
 *
 * ```text
 * Consumer → Generic AI Contract → AiRuntime → ExecutionCoordinator → Provider Adapter → Real Provider
 *          ← normalized Generic Result + reliability provenance ←
 * ```
 *
 * This class owns, in this order (ROADMAP Stage 3 §1, Stage 5 Phase 1):
 *
 *  1. **contract validation** — `parseConsumerAiRequest` (the security boundary) plus
 *     `composeAiRequest` against the host-bound `TrustedDispatchContext`;
 *  2. **capability validation** — registry lookup, governance, policy selection, schema ownership,
 *     `inputAllowList`, and the feature/requirement check against the resolved **model** — all
 *     before any provider call. A request the provider cannot serve fails locally;
 *  3. **provider resolution** — `enumerateRouteCandidates` over the configured profile route chain
 *     (the ordered fallback chain, with every unviable hop named and dropped);
 *  4. **trusted secret resolution** — a `credentialRef` handle resolves through the host's secret
 *     port at registration and is bound to the adapter. A credential value never enters this
 *     class's state, a `ProviderRequest`, a result, an error or the operator log;
 *  5. **request execution** — delegated to `ExecutionCoordinator`: idempotency, governance,
 *     bounded retry, deterministic fallback, bounded repair, all under one overall deadline with
 *     terminal, idempotent cancellation;
 *  6. **response normalization** — provider results become `AiResult` with the closed projection;
 *  7. **generic error propagation** — every failure below becomes the closed `AiError`
 *     vocabulary, never provider prose (AGENTS.md §4).
 */
import {
  AIBRIDGE_CONTRACT_VERSION,
  MAX_TOTAL_TIMEOUT_MS,
  PROVIDER_ADAPTER_API_VERSION,
  REQUEST_ID_PATTERN,
  clampTimeoutBudget,
  composeAiRequest,
  consumerRequestDigest,
  createIssue,
  invalid,
  makeAiError,
  makeStreamCompleted,
  makeStreamFailed,
  makeStreamStarted,
  makeStreamTextDelta,
  parseConsumerAiRequest,
  parseStructuredGenerateInput,
  parseTextGenerateInput,
  parseTrustedDispatchContext,
  providerDeadlineAt,
  isCapabilityGranted,
  valid,
  type AiError,
  type AiFinishReason,
  type AiProviderAdapter,
  type AiResult,
  type AiStreamEvent,
  type AiUsage,
  type AiWarning,
  type CapabilityRequirements,
  type ComposedAiRequest,
  type ContextBundle,
  type ModelClass,
  type OutputSchema,
  type OutputSchemaRef,
  type ProviderDescriptor,
  type ProviderRequest,
  type RequirementDelivery,
  type TimeoutBudget,
  type TrustedCredentials,
  type ValidationIssue,
  type ValidationResult,
} from '@aibridge/contracts';
import {
  CapabilityRegistry,
  GENERIC_CAPABILITY_REGISTRATIONS,
  KillSwitchRegistry,
  allowsCallerOutputSchema,
  isRecord,
  screenAiInput,
  utf8ByteLength,
  type CapabilityRegistration,
} from '@aibridge/core';
import type { Clock, SecretStorePort } from '@aibridge/host-sdk';
import {
  BudgetTracker,
  CircuitBreakerRegistry,
  IdempotencyRegistry,
  InMemoryIdempotencyStore,
  InMemoryQuotaStore,
  InMemoryRateLimitStore,
  InMemoryUsageLedger,
  QuotaManager,
  RateLimiter,
  RuntimeHealthRegistry,
  createIdMint,
  nullMetricsSink,
  nullOperationalEventSink,
  systemSleeper,
  type IdMint,
  type MetricsSink,
  type OperationalEventSink,
  type Sleeper,
  type UsageLedgerPort,
} from '@aibridge/governance';
import {
  budgetExhaustedError,
  cancelledByCallerError,
  normalizeProviderError,
  normalizeThrown,
  providerTimeoutError,
  validationFailureToAiError,
} from './errors.js';
import { ExecutionCoordinator, buildProviderRequest, raceAttempt, type ExecutionOutcome, type ExecutionPlan } from './coordinator.js';
import {
  ConfigManager,
  syntheticSnapshot,
  type RuntimeConfigInput,
  type RuntimeConfigSnapshot,
} from './config-manager.js';
import { nullOperatorLog, redactOperatorDetail, type OperatorLogSink } from './operator-log.js';
import {
  classifyModel,
  enumerateRouteCandidates,
  type BoundProvider,
  type ResolvedRoute,
  type RuntimeRoutes,
  type SkippedCandidate,
} from './routes.js';

export type { BoundProvider, ResolvedRoute, RouteEntry, RuntimeRoutes } from './routes.js';

const EXECUTABLE_CAPABILITIES = new Set(['ai.text.generate', 'ai.structured.generate']);

/** Result identity, echoed even when the request itself could not be parsed. */
type ResultIdentity = {
  readonly contractVersion: string;
  readonly requestId: string;
  readonly capability: string;
  readonly capabilityVersion: string;
};

/** One viable hop: the resolved route plus the provenance facts a fallback chain needs. */
export type PlanTarget = {
  readonly route: ResolvedRoute;
  readonly providerId: string;
  readonly modelClass: ModelClass;
  readonly modelAlias: string;
  readonly providerModelId: string;
  readonly routeDepth: number;
};

type DispatchPlan = {
  readonly identity: ResultIdentity;
  readonly composed: ComposedAiRequest<unknown>;
  readonly registration: CapabilityRegistration;
  readonly candidates: readonly PlanTarget[];
  readonly preSkipped: readonly SkippedCandidate[];
  readonly modelClass: ModelClass;
  readonly deadlineAtMs: number;
  readonly budget: TimeoutBudget;
  readonly warnings: readonly AiWarning[];
  /** Resolved inline schema, for a capability whose output schema is caller-owned. */
  readonly outputSchema?: OutputSchema;
  readonly maxOutputBytes: number;
  readonly instructions: string;
  readonly contextValues: ContextBundle;
  readonly requestedMaxOutputTokens: number | undefined;
  readonly requirements: CapabilityRequirements;
  readonly snapshot: RuntimeConfigSnapshot;
};

type Prepared =
  | { readonly ok: true; readonly plan: DispatchPlan }
  | { readonly ok: false; readonly identity: ResultIdentity; readonly error: AiError; readonly warnings: readonly AiWarning[] };

export type RuntimeProviderRegistration = {
  readonly adapter: AiProviderAdapter;
  /**
   * Operator-side credential handle (`secret://…`) resolved through the trusted secret port at
   * registration and bound to the adapter. Never a literal value: a literal in configuration is a
   * leak waiting to happen (SECURITY.md §2.3).
   */
  readonly credentialRef?: string;
};

export type RuntimeLimits = {
  readonly maxInputBytes?: number;
  readonly maxOutputBytes?: number;
  /** The server-side ceiling a caller's budget can never widen. */
  readonly serverTimeoutMs?: number;
};

/** Replaceable governance services. Every one has a safe in-memory default. */
export type RuntimeGovernanceServices = {
  readonly sleeper?: Sleeper;
  readonly ids?: IdMint;
  readonly idempotency?: IdempotencyRegistry;
  readonly rateLimiter?: RateLimiter;
  readonly quotas?: QuotaManager;
  readonly ledger?: UsageLedgerPort;
  readonly breakers?: CircuitBreakerRegistry;
  readonly health?: RuntimeHealthRegistry;
  readonly metrics?: MetricsSink;
  readonly events?: OperationalEventSink;
};

export type RuntimeOptions = {
  /** Trusted bootstrap: the providers this runtime may dispatch to. */
  readonly providers?: readonly RuntimeProviderRegistration[];
  /** The profile route table. Required unless a `configManager` supplies routes. */
  readonly routes?: RuntimeRoutes;
  /** Atomic, validated configuration (Stage 5). Its active snapshot binds every request. */
  readonly configManager?: ConfigManager;
  /** Governance policies for a runtime built without a config manager. */
  readonly governanceConfig?: RuntimeConfigInput['governance'];
  /** Replaceable governance services (stores, sinks). */
  readonly services?: RuntimeGovernanceServices;
  /** Defaults to the two V1 generic primitives registered as metadata. */
  readonly capabilities?: CapabilityRegistry;
  /** Trusted. The host secret store; `SecretStorePort` satisfies it structurally. */
  readonly secrets?: SecretStorePort;
  readonly clock?: Clock;
  readonly killSwitches?: KillSwitchRegistry;
  readonly limits?: RuntimeLimits;
  /** Resolves a `REF` output schema. A `REF` with no resolver is `OUTPUT_SCHEMA_UNSUPPORTED`. */
  readonly schemaResolver?: (ref: OutputSchemaRef) => OutputSchema | null;
  readonly operatorLog?: OperatorLogSink;
};

export type ExecuteOptions = {
  /** In-process only; never serializable (ARCHITECTURE.md §4.5). */
  readonly cancellation?: import('@aibridge/contracts').CancellationToken;
};

export type { ExecutionOutcome };

/** The system clock. The default; tests inject `TestClock`. */
export function systemClock(): Clock {
  return { nowMs: () => Date.now() };
}

/** The registry every V1 build starts from: the two generic primitives, as metadata. */
export function defaultCapabilityRegistry(): CapabilityRegistry {
  const registry = new CapabilityRegistry();
  for (const registration of GENERIC_CAPABILITY_REGISTRATIONS) {
    registry.register(registration);
  }
  return registry;
}

/** The projection used before a route exists. It deliberately says "nothing served this". */
function unroutedProjection() {
  return {
    providerId: 'none',
    providerFamily: 'mock',
    modelClass: 'UNKNOWN',
    routeDepth: 0,
    attemptCount: 0,
    repaired: false,
  } as const;
}

function isExecutableCapability(capability: string): boolean {
  return EXECUTABLE_CAPABILITIES.has(capability);
}

function echoString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, 64) : fallback;
}

function echoIdentity(rawRequest: unknown): ResultIdentity {
  const record = isRecord(rawRequest) ? rawRequest : {};
  const requestId =
    typeof record['requestId'] === 'string' && REQUEST_ID_PATTERN.test(record['requestId'])
      ? record['requestId']
      : 'unknown';
  return {
    contractVersion: echoString(record['contractVersion'], AIBRIDGE_CONTRACT_VERSION),
    requestId,
    capability: echoString(record['capability'], 'unknown'),
    capabilityVersion: echoString(record['capabilityVersion'], 'unknown'),
  };
}

export class AiRuntime {
  readonly #capabilities: CapabilityRegistry;
  readonly #secrets: SecretStorePort | undefined;
  readonly #clock: Clock;
  readonly #killSwitches: KillSwitchRegistry | undefined;
  readonly #limits: RuntimeLimits;
  readonly #schemaResolver: ((ref: OutputSchemaRef) => OutputSchema | null) | undefined;
  readonly #log: OperatorLogSink;
  readonly #providers = new Map<string, BoundProvider>();
  /** Constructor-started registrations; every call path awaits them first. */
  readonly #pendingRegistrations: Promise<unknown>[] = [];
  /**
   * Resolved credential values, held **only** so operator-log detail can be stripped of them.
   * Never serialized, never returned, never logged (SECURITY.md §2.3).
   */
  readonly #boundSecrets: string[] = [];
  readonly #configManager: ConfigManager | undefined;
  readonly #snapshot: RuntimeConfigSnapshot;
  readonly #coordinator: ExecutionCoordinator;
  readonly #ledger: UsageLedgerPort;
  readonly #metrics: MetricsSink;
  readonly #events: OperationalEventSink;
  readonly #breakers: CircuitBreakerRegistry;
  readonly #health: RuntimeHealthRegistry;
  readonly #quotas: QuotaManager;
  readonly #idempotency: IdempotencyRegistry;

  constructor(options: RuntimeOptions) {
    this.#capabilities = options.capabilities ?? defaultCapabilityRegistry();
    this.#secrets = options.secrets;
    this.#clock = options.clock ?? systemClock();
    this.#killSwitches = options.killSwitches;
    this.#limits = options.limits ?? {};
    this.#schemaResolver = options.schemaResolver;
    this.#log = options.operatorLog ?? nullOperatorLog();
    this.#configManager = options.configManager;
    this.#snapshot =
      options.configManager?.active() ??
      syntheticSnapshot(options.routes ?? {}, { clock: this.#clock, ...(options.governanceConfig === undefined ? {} : { governance: options.governanceConfig }) });

    const services = options.services ?? {};
    this.#ledger = services.ledger ?? new InMemoryUsageLedger();
    this.#metrics = services.metrics ?? nullMetricsSink();
    this.#events = services.events ?? nullOperationalEventSink();
    this.#quotas =
      services.quotas ?? new QuotaManager({ store: new InMemoryQuotaStore(), clock: this.#clock, policies: this.#snapshot.governance.quotas });
    this.#idempotency =
      services.idempotency ??
      new IdempotencyRegistry({
        store: new InMemoryIdempotencyStore({ clock: this.#clock }),
        clock: this.#clock,
      });
    this.#breakers =
      services.breakers ?? new CircuitBreakerRegistry({ config: this.#snapshot.governance.breaker, clock: this.#clock });
    this.#health = services.health ?? new RuntimeHealthRegistry({ clock: this.#clock, breakers: this.#breakers });

    this.#coordinator = new ExecutionCoordinator({
      clock: this.#clock,
      sleeper: services.sleeper ?? systemSleeper(),
      ids: services.ids ?? createIdMint(),
      idempotency: this.#idempotency,
      rateLimiter: services.rateLimiter ?? new RateLimiter({ store: new InMemoryRateLimitStore(), clock: this.#clock }),
      quotas: this.#quotas,
      budget: new BudgetTracker({ policy: this.#snapshot.governance.budget, quotas: this.#quotas, clock: this.#clock }),
      ledger: this.#ledger,
      breakers: this.#breakers,
      health: this.#health,
      metrics: this.#metrics,
      events: this.#events,
      killSwitchState: () => this.#killSwitches?.state ?? { global: false, providers: [], capabilities: [] },
      log: this.#log,
      boundSecrets: () => this.#boundSecrets,
    });

    for (const registration of options.providers ?? []) {
      // A registration is async (it may resolve a credential). Every call path awaits
      // `#pendingRegistrations` first, so a dispatch can never race its own binding.
      this.#pendingRegistrations.push(this.registerProvider(registration));
    }
  }

  get providerIds(): readonly string[] {
    return [...this.#providers.keys()].sort();
  }

  /** The active configuration snapshot (Stage 5). */
  get configSnapshot(): RuntimeConfigSnapshot {
    return this.#configManager?.active() ?? this.#snapshot;
  }

  /** The append-only usage ledger (operator-side). */
  get usageLedger(): UsageLedgerPort {
    return this.#ledger;
  }

  /** The metrics sink, for an operator-side exporter. */
  get metrics(): MetricsSink {
    return this.#metrics;
  }

  /** The operational event sink. */
  get events(): OperationalEventSink {
    return this.#events;
  }

  /**
   * Safe runtime health per provider/model target (Phase 48). Generic failure classes only — never
   * a raw provider error, never content.
   */
  getProviderHealth(): ReturnType<RuntimeHealthRegistry['list']> {
    return this.#health.list();
  }

  /**
   * Trusted bootstrap — the **only** way a provider binding enters the runtime and the only place
   * a credential value is resolved. Not reachable from a consumer request.
   *
   * A `credentialRef` is resolved through the trusted secret port and handed straight to the
   * adapter's `bindCredentials`; this class never stores the value in its own state.
   */
  async registerProvider(registration: RuntimeProviderRegistration): Promise<ValidationResult<ProviderDescriptor>> {
    const adapter = registration.adapter;
    const issues: ValidationIssue[] = [];
    if (adapter.adapterApiVersion !== PROVIDER_ADAPTER_API_VERSION) {
      issues.push(createIssue('UNSUPPORTED_VERSION', '$.adapterApiVersion', `must be ${PROVIDER_ADAPTER_API_VERSION}`));
    }
    if (typeof adapter.id !== 'string' || adapter.id.length === 0) {
      issues.push(createIssue('INVALID_TYPE', '$.id', 'must be a non-empty provider id'));
    }
    if (adapter.descriptor.id !== adapter.id) {
      issues.push(createIssue('INVALID_VALUE', '$.descriptor.id', 'must match the adapter id'));
    }
    const existing = this.#providers.get(adapter.id);
    if (existing !== undefined && existing.adapter !== adapter) {
      issues.push(
        createIssue('CONFLICTING_REGISTRATION', '$', `a different adapter is already bound to provider "${adapter.id}"`),
      );
    }
    if (issues.length > 0) {
      return invalid('MALFORMED_ENVELOPE', issues);
    }

    if (registration.credentialRef !== undefined) {
      const bind = adapter.bindCredentials;
      if (typeof bind !== 'function') {
        return invalid('MALFORMED_ENVELOPE', [
          createIssue('FORBIDDEN_FIELD', '$.credentialRef', 'the adapter cannot bind a credential; refusing to resolve one'),
        ]);
      }
      if (this.#secrets === undefined) {
        return invalid('MALFORMED_ENVELOPE', [
          createIssue('MISSING_FIELD', '$.secrets', 'a credentialRef requires a trusted secret port'),
        ]);
      }
      let secret: string | null;
      try {
        secret = await this.#secrets.resolve(registration.credentialRef);
      } catch {
        return invalid('INTERNAL_ERROR', [
          createIssue('MISSING_FIELD', '$.credentialRef', 'the trusted secret port failed to resolve the handle'),
        ]);
      }
      if (secret === null || secret.length === 0) {
        return invalid('MALFORMED_ENVELOPE', [
          createIssue('MISSING_FIELD', '$.credentialRef', 'the credential handle did not resolve to a value'),
        ]);
      }
      const credentials: TrustedCredentials = { handle: registration.credentialRef, secret };
      bind.call(adapter, credentials);
      this.#boundSecrets.push(secret);
    }

    this.#providers.set(adapter.id, { adapter, descriptor: adapter.descriptor });
    return valid(adapter.descriptor);
  }

  /**
   * Execute one non-streaming call. Returns an `AiResult` — **never throws**. A `FAILED` result is
   * the only failure channel (ARCHITECTURE.md §5).
   */
  async execute(request: unknown, trustedContext: unknown, options: ExecuteOptions = {}): Promise<AiResult<unknown>> {
    const outcome = await this.executeObserved(request, trustedContext, options);
    return outcome.result;
  }

  /**
   * Execute one call and return the result **with** its reliability provenance and governance
   * summary (Phase 58): the public `AiResult.usage` stays the final result's usage; totals across
   * every provider attempt live here and in the usage ledger.
   */
  async executeObserved(request: unknown, trustedContext: unknown, options: ExecuteOptions = {}): Promise<ExecutionOutcome> {
    // Bind the configuration snapshot at **ingress**, before any await: a reload that lands while
    // this call is being scheduled can never change the generation a request runs against
    // (Phase 42 — one request, one snapshot).
    const boundSnapshot = this.configSnapshot;
    await Promise.all(this.#pendingRegistrations);
    const startedAtMs = this.#clock.nowMs();
    const prepared = this.#prepare(request, trustedContext, 'GENERATE', options, boundSnapshot);
    if (!prepared.ok) {
      this.#log.write({
        level: 'warn',
        event: 'runtime.rejected',
        atMs: this.#clock.nowMs(),
        requestId: prepared.identity.requestId,
        capability: prepared.identity.capability,
        detail: `${prepared.error.reason ?? prepared.error.code} ${prepared.error.stage}`,
      });
      return this.#rejectedOutcome(prepared, startedAtMs, boundSnapshot);
    }
    return this.#coordinator.execute(this.#executionPlan(prepared.plan), options);
  }

  /**
   * Execute one call with incremental delivery. Yields the frozen stream sequence
   * `STARTED → TEXT_DELTA* → (COMPLETED | FAILED)` — always terminated, including on error,
   * timeout and cancellation.
   *
   * Only `ai.text.generate` streams in V1: a token stream of a partial *judgement* is dangerous
   * (CAPABILITIES.md §4), so structured generation fails locally here rather than degrading.
   *
   * Stage 5 boundary, stated plainly: a stream is a **single attempt** — governance (kill switch,
   * breaker, rate limit, quota, budget) and the usage ledger apply, but retry, fallback and repair
   * do not, because partial output has already been delivered to the caller. A consumer that needs
   * reliability chains uses `execute`.
   */
  async *stream(request: unknown, trustedContext: unknown, options: ExecuteOptions = {}): AsyncIterable<AiStreamEvent> {
    const boundSnapshot = this.configSnapshot;
    await Promise.all(this.#pendingRegistrations);
    const startedAtMs = this.#clock.nowMs();
    const identity = echoIdentity(request);
    yield makeStreamStarted({
      contractVersion: identity.contractVersion,
      requestId: identity.requestId,
      capability: identity.capability,
      capabilityVersion: identity.capabilityVersion,
    });

    const prepared = this.#prepare(request, trustedContext, 'STREAM', options, boundSnapshot);
    if (!prepared.ok) {
      yield makeStreamFailed({
        error: prepared.error,
        usage: {},
        finishReason: 'UNKNOWN',
        providerMetadata: unroutedProjection(),
        latencyMs: Math.max(0, this.#clock.nowMs() - startedAtMs),
        warnings: prepared.warnings,
      });
      return;
    }

    const plan = prepared.plan;
    const target = plan.candidates[0];
    if (target === undefined) {
      yield makeStreamFailed({
        error: makeAiError({
          reason: 'NO_ROUTE',
          message: 'No configured route satisfies this profile and requirement set.',
          details: { profile: plan.composed.profile },
        }),
        usage: {},
        finishReason: 'UNKNOWN',
        providerMetadata: unroutedProjection(),
        latencyMs: Math.max(0, this.#clock.nowMs() - startedAtMs),
        warnings: plan.warnings,
      });
      return;
    }

    const providerDeadlineAtMs = providerDeadlineAt(plan.deadlineAtMs, this.#clock.nowMs(), plan.budget.providerMs);
    if (providerDeadlineAtMs === null) {
      yield makeStreamFailed({
        error: budgetExhaustedError(Math.max(0, plan.deadlineAtMs - this.#clock.nowMs())),
        usage: {},
        finishReason: 'UNKNOWN',
        providerMetadata: projectionFor(target, 0, false),
        latencyMs: Math.max(0, this.#clock.nowMs() - startedAtMs),
        warnings: plan.warnings,
      });
      return;
    }

    const streamText = target.route.adapter.streamText;
    if (streamText === undefined) {
      // `enumerateRouteCandidates` already refuses a non-streaming route; this is defence in depth.
      yield makeStreamFailed({
        error: makeAiError({
          reason: 'NO_ROUTE',
          message: 'The resolved route cannot deliver a stream.',
          details: { profile: plan.composed.profile },
        }),
        usage: {},
        finishReason: 'UNKNOWN',
        providerMetadata: projectionFor(target, 0, false),
        latencyMs: Math.max(0, this.#clock.nowMs() - startedAtMs),
        warnings: plan.warnings,
      });
      return;
    }

    const providerRequest = buildProviderRequest(this.#executionPlan(plan), target, providerDeadlineAtMs, options.cancellation, undefined);
    const iterator = streamText.call(target.route.adapter, providerRequest)[Symbol.asyncIterator]();
    let accumulated = '';
    let usage: AiUsage = {};
    let finishReason: AiFinishReason = 'UNKNOWN';
    let finished = false;

    const failStream = (error: AiError, finish: AiFinishReason = 'UNKNOWN'): AiStreamEvent =>
      makeStreamFailed({
        error,
        usage,
        finishReason: finish,
        providerMetadata: projectionFor(target, 1, false),
        latencyMs: Math.max(0, this.#clock.nowMs() - startedAtMs),
        warnings: plan.warnings,
      });

    try {
      for (;;) {
        const timeoutMs = Math.max(0, providerDeadlineAtMs - this.#clock.nowMs());
        const step = await raceAttempt(iterator.next(), timeoutMs, options.cancellation);
        if (step.kind === 'cancelled') {
          yield failStream(cancelledByCallerError());
          return;
        }
        if (step.kind === 'deadline') {
          const error = this.#clock.nowMs() >= plan.deadlineAtMs ? budgetExhaustedError(0) : providerTimeoutError();
          yield failStream(error);
          return;
        }
        if (step.kind === 'threw') {
          yield failStream(normalizeThrown(step.error));
          return;
        }
        if (step.value.done) {
          break;
        }
        const event = step.value.value;
        if (event.kind === 'TEXT_DELTA') {
          if (event.text.length === 0) {
            continue;
          }
          accumulated += event.text;
          yield makeStreamTextDelta(event.text);
          continue;
        }
        if (event.kind === 'FINISH') {
          usage = event.usage;
          finishReason = event.finishReason;
          finished = true;
          break;
        }
        this.#rawErrorLog(plan.identity, target.providerId, event.error);
        yield failStream(normalizeProviderError(event.error));
        return;
      }
    } finally {
      // Termination is terminal first, producer cleanup second: a generator parked on an `await`
      // only processes `return()` once that settles, and a cancelled consumer must not wait for it.
      void Promise.resolve(iterator.return?.()).catch(() => undefined);
    }

    if (!finished) {
      yield failStream(
        normalizeProviderError({
          category: 'UPSTREAM',
          reason: 'PROVIDER_BAD_RESPONSE',
          rawMessage: 'provider stream ended without a finish event',
        }),
      );
      return;
    }

    const bytes = utf8ByteLength(accumulated);
    if (bytes > plan.maxOutputBytes) {
      yield failStream(
        validationFailureToAiError(
          {
            reason: 'OUTPUT_TOO_LARGE',
            code: 'SCHEMA_MISMATCH',
            stage: 'EXTRACTION',
            issues: [{ code: 'SIZE_EXCEEDED', path: '$', message: 'streamed output exceeded the cap' }],
          },
          'The streamed answer exceeds the declared output size cap.',
        ),
        finishReason,
      );
      return;
    }

    yield makeStreamCompleted({
      text: accumulated,
      usage,
      finishReason,
      providerMetadata: projectionFor(target, 1, false),
      latencyMs: Math.max(0, this.#clock.nowMs() - startedAtMs),
      warnings: plan.warnings,
    });
  }

  /* -------------------------------------------------------------------------------------------
   * Internals
   * ---------------------------------------------------------------------------------------- */

  #rawErrorLog(identity: ResultIdentity, providerId: string, raw: { readonly rawMessage?: string }): void {
    this.#log.write({
      level: 'error',
      event: 'provider.raw_error',
      atMs: this.#clock.nowMs(),
      requestId: identity.requestId,
      capability: identity.capability,
      providerId,
      ...(raw.rawMessage === undefined ? {} : { detail: redactOperatorDetail(raw.rawMessage, this.#boundSecrets) }),
    });
  }

  /** A rejected call never reached the coordinator; say so honestly in the provenance. */
  #rejectedOutcome(
    prepared: Extract<Prepared, { readonly ok: false }>,
    startedAtMs: number,
    snapshot: RuntimeConfigSnapshot,
  ): Promise<ExecutionOutcome> {
    const finishedAtMs = this.#clock.nowMs();
    const result: AiResult<never> = {
      contractVersion: prepared.identity.contractVersion,
      requestId: prepared.identity.requestId,
      capability: prepared.identity.capability,
      capabilityVersion: prepared.identity.capabilityVersion,
      status: 'FAILED',
      error: prepared.error,
      usage: {},
      providerMetadata: unroutedProjection(),
      latencyMs: Math.max(0, finishedAtMs - startedAtMs),
      finishReason: 'UNKNOWN',
      warnings: prepared.warnings,
    };
    return Promise.resolve({
      result,
      provenance: {
        logicalRequestId: `lreq-${prepared.identity.requestId}`,
        requestId: prepared.identity.requestId,
        callerPluginId: 'unknown',
        capability: prepared.identity.capability,
        capabilityVersion: prepared.identity.capabilityVersion,
        profile: 'balanced',
        configVersion: snapshot.configVersion,
        configDigest: snapshot.contentDigest,
        startedAtMs,
        finishedAtMs,
        status: 'FAILED',
        errorCode: prepared.error.code,
        ...(prepared.error.reason === undefined ? {} : { errorReason: prepared.error.reason }),
        attempts: [],
        fallbackCount: 0,
        retryCount: 0,
        repairCount: 0,
        skippedCount: 0,
        idempotencyOutcome: 'EXECUTED',
      },
      governance: {
        logicalRequestId: `lreq-${prepared.identity.requestId}`,
        attemptCount: 0,
        fallbackCount: 0,
        retryCount: 0,
        repairCount: 0,
        skippedCount: 0,
        totalUsage: {},
        totalUsageComplete: false,
        totalCost: { basis: 'UNKNOWN' },
        finalUsage: {},
      },
    });
  }

  /** The plan shape the coordinator consumes. */
  #executionPlan(plan: DispatchPlan): ExecutionPlan {
    return {
      contractVersion: plan.identity.contractVersion,
      requestId: plan.identity.requestId,
      idempotencyKey: plan.composed.idempotencyKey,
      capability: plan.identity.capability,
      capabilityVersion: plan.identity.capabilityVersion,
      profile: plan.composed.profile,
      callerPluginId: plan.composed.callerPluginId,
      ...(plan.composed.subjectToken === undefined ? {} : { subjectToken: plan.composed.subjectToken }),
      fingerprint: consumerRequestDigest(plan.composed),
      maxCallsPerTurn: plan.registration.limits.maxCallsPerTurn,
      candidates: plan.candidates,
      preSkipped: plan.preSkipped,
      instructions: plan.instructions,
      context: plan.contextValues,
      ...(plan.outputSchema === undefined ? {} : { outputSchema: plan.outputSchema }),
      maxOutputBytes: plan.maxOutputBytes,
      ...(plan.requestedMaxOutputTokens === undefined ? {} : { requestedMaxOutputTokens: plan.requestedMaxOutputTokens }),
      requirements: plan.requirements,
      budget: plan.budget,
      deadlineAtMs: plan.deadlineAtMs,
      warnings: plan.warnings,
      snapshot: plan.snapshot,
      ...(plan.composed.promptApplied === undefined ? {} : { promptApplied: plan.composed.promptApplied }),
      ...(plan.composed.promptVersion === undefined ? {} : { promptVersion: plan.composed.promptVersion }),
    };
  }

  /** Contract validation → capability validation → provider resolution. No provider is contacted. */
  #prepare(
    request: unknown,
    trustedContext: unknown,
    delivery: RequirementDelivery,
    options: ExecuteOptions,
    snapshot: RuntimeConfigSnapshot,
  ): Prepared {
    const identity = echoIdentity(request);
    const fail = (error: AiError, warnings: readonly AiWarning[] = []): Prepared => ({
      ok: false,
      identity,
      error,
      warnings,
    });

    // Cancelled before dispatch ⇒ `CANCELLED`, **no charge** (ARCHITECTURE.md §13.2). Checked
    // first so a pre-cancelled call never reaches a provider, never a capability, never a meter.
    if (options.cancellation?.cancelled === true) {
      return fail(cancelledByCallerError());
    }

    // An absent or unbound identity is a permission failure, not a malformed document
    // (SECURITY.md §4): there must never be a self-declared fallback identity.
    const rawCallerId = isRecord(trustedContext) ? trustedContext['callerPluginId'] : undefined;
    if (typeof rawCallerId !== 'string' || rawCallerId.length === 0) {
      return fail(
        validationFailureToAiError(
          {
            reason: 'CALLER_NOT_PERMITTED',
            code: 'INVALID_REQUEST',
            stage: 'PERMISSION',
            issues: [{ code: 'PERMISSION_DENIED', path: '$callerPluginId', message: 'identity was not bound by the host' }],
          },
          'No host-bound caller identity was supplied.',
        ),
      );
    }

    const parsedContext = parseTrustedDispatchContext(trustedContext);
    if (!parsedContext.ok) {
      return fail(validationFailureToAiError(parsedContext.failure, 'The trusted dispatch context is invalid.'));
    }
    const parsedRequest = parseConsumerAiRequest(request);
    if (!parsedRequest.ok) {
      return fail(validationFailureToAiError(parsedRequest.failure, 'The request does not conform to the generic AI contract.'));
    }
    const composed = composeAiRequest(parsedRequest.value, parsedContext.value);
    if (!composed.ok) {
      return fail(validationFailureToAiError(composed.failure, 'The caller is not permitted to make this call.'));
    }
    const call = composed.value;

    // Defence in depth (SECURITY.md §5.2): the host decided already; AI Bridge enforces again.
    if (!isCapabilityGranted(parsedContext.value.grantedPermissions, call.capability, call.capabilityVersion)) {
      return fail(
        validationFailureToAiError(
          {
            reason: 'CALLER_NOT_PERMITTED',
            code: 'INVALID_REQUEST',
            stage: 'PERMISSION',
            issues: [{ code: 'PERMISSION_DENIED', path: '$.capability', message: 'not granted to this caller' }],
          },
          'The caller has not declared this capability.',
        ),
      );
    }

    const registration = this.#capabilities.getRegistration(call.capability, call.capabilityVersion);
    if (registration === null) {
      // Known id at another major is a version problem; an unknown id is an envelope problem.
      const knownAtAnyMajor = this.#capabilities.has(call.capability);
      return fail(
        knownAtAnyMajor
          ? validationFailureToAiError(
              {
                reason: 'CAPABILITY_VERSION_UNSUPPORTED',
                code: 'INVALID_REQUEST',
                stage: 'ENVELOPE',
                issues: [
                  { code: 'UNSUPPORTED_VERSION', path: '$.capabilityVersion', message: 'major is not supported' },
                ],
              },
              'That capability major is not supported.',
            )
          : validationFailureToAiError(
              {
                reason: 'CAPABILITY_UNKNOWN',
                code: 'INVALID_REQUEST',
                stage: 'ENVELOPE',
                issues: [{ code: 'UNKNOWN_CAPABILITY', path: '$.capability', message: 'no such capability is registered' }],
              },
              'No such capability is registered.',
            ),
      );
    }
    if (!isExecutableCapability(call.capability)) {
      return fail(
        validationFailureToAiError(
          {
            reason: 'MODEL_UNAVAILABLE',
            code: 'MODEL_UNAVAILABLE',
            stage: 'ROUTING',
            issues: [{ code: 'UNKNOWN_CAPABILITY', path: '$.capability', message: 'not executable in this build' }],
          },
          'This capability is not executable by this build of AI Bridge.',
        ),
      );
    }

    // Streaming is offered for `ai.text.generate` only: a token stream of a partial *judgement* is
    // dangerous (CAPABILITIES.md §4). Refused locally, never degraded (ROADMAP Stage 3 §6).
    if (delivery === 'STREAM' && call.capability !== 'ai.text.generate') {
      return fail(
        makeAiError({
          reason: 'NO_ROUTE',
          message: 'Stream delivery is offered for ai.text.generate only; a structured judgement is returned complete or not at all.',
          details: { profile: call.profile },
          retryable: false,
        }),
      );
    }

    // Policy selection: a caller may select a registered policy, never supply one.
    if (call.policyId !== undefined && call.policyId !== registration.policy.id) {
      return fail(
        validationFailureToAiError(
          {
            reason: 'MALFORMED_ENVELOPE',
            code: 'INVALID_REQUEST',
            stage: 'ENVELOPE',
            issues: [{ code: 'UNKNOWN_FIELD', path: '$.policyId', message: 'no such policy is registered for this capability' }],
          },
          'The requested policy is not registered for this capability.',
        ),
      );
    }

    // Schema ownership (CONTRACTS.md §6).
    let outputSchema: OutputSchema | undefined;
    if (allowsCallerOutputSchema(registration.schemaOwnership)) {
      const requested = call.outputSchema;
      if (requested === undefined) {
        return fail(
          validationFailureToAiError(
            {
              reason: 'MALFORMED_ENVELOPE',
              code: 'INVALID_REQUEST',
              stage: 'ENVELOPE',
              issues: [
                { code: 'MISSING_FIELD', path: '$.outputSchema', message: 'this capability requires a caller-supplied output schema' },
              ],
            },
            'This capability requires a caller-supplied output schema.',
          ),
        );
      }
      const resolved = this.#resolveSchema(requested);
      if (resolved === null) {
        return fail(
          validationFailureToAiError(
            {
              reason: 'OUTPUT_SCHEMA_UNSUPPORTED',
              code: 'INVALID_REQUEST',
              stage: 'ENVELOPE',
              issues: [{ code: 'MISSING_FIELD', path: '$.outputSchema', message: 'the referenced schema could not be resolved' }],
            },
            'The referenced output schema could not be resolved.',
          ),
        );
      }
      outputSchema = resolved;
    } else if (call.outputSchema !== undefined) {
      return fail(
        validationFailureToAiError(
          {
            reason: 'OUTPUT_SCHEMA_OVERRIDE_FORBIDDEN',
            code: 'INVALID_REQUEST',
            stage: 'ENVELOPE',
            issues: [{ code: 'FORBIDDEN_FIELD', path: '$.outputSchema', message: 'the capability owns its output schema' }],
          },
          'This capability owns its output schema; a caller may not supply one.',
        ),
      );
    }

    // Input safety (size → secrets → PII), then the policy allow-list, then the payload shape.
    const screened = screenAiInput(call.input, {
      maxInputBytes: this.#limits.maxInputBytes ?? registration.limits.maxInputBytes,
    });
    const warnings: AiWarning[] = screened.ok ? [...screened.warnings] : [];
    if (!screened.ok) {
      return fail(screened.error, warnings);
    }
    const inputRecord = screened.value;
    if (!isRecord(inputRecord)) {
      return fail(
        validationFailureToAiError(
          {
            reason: 'MALFORMED_ENVELOPE',
            code: 'INVALID_REQUEST',
            stage: 'ENVELOPE',
            issues: [{ code: 'INVALID_TYPE', path: '$.input', message: 'must be an object' }],
          },
          'The capability input must be an object.',
        ),
        warnings,
      );
    }
    for (const key of Object.keys(inputRecord).sort()) {
      if (!registration.policy.inputAllowList.includes(key)) {
        return fail(
          validationFailureToAiError(
            {
              reason: 'MALFORMED_ENVELOPE',
              code: 'INVALID_REQUEST',
              stage: 'ENVELOPE',
              issues: [{ code: 'UNKNOWN_FIELD', path: `$.input.${key}`, message: 'outside the capability input allow-list' }],
            },
            'An input key is outside the capability input allow-list.',
          ),
          warnings,
        );
      }
    }

    let instructions: string;
    let contextValues: ContextBundle;
    let requestedMaxOutputTokens: number | undefined;
    if (call.capability === 'ai.structured.generate') {
      const parsedInput = parseStructuredGenerateInput(inputRecord, '$.input');
      if (!parsedInput.ok) {
        return fail(validationFailureToAiError(parsedInput.failure, 'The capability input is malformed.'), warnings);
      }
      instructions = parsedInput.value.instructions;
      contextValues = parsedInput.value.context;
    } else {
      const parsedInput = parseTextGenerateInput(inputRecord, '$.input');
      if (!parsedInput.ok) {
        return fail(validationFailureToAiError(parsedInput.failure, 'The capability input is malformed.'), warnings);
      }
      instructions = parsedInput.value.instructions;
      contextValues = parsedInput.value.context;
      requestedMaxOutputTokens = parsedInput.value.maxOutputTokens;
    }

    // Requirement + provider resolution. Local failures only — no provider is contacted yet.
    const requirements: CapabilityRequirements = call.requirements ?? {};
    const scan = enumerateRouteCandidates({
      routes: snapshot.routes,
      providers: this.#providers,
      capability: call.capability,
      capabilityVersion: call.capabilityVersion,
      profile: call.profile,
      requirements,
      delivery,
      ...(this.#killSwitches === undefined ? {} : { killSwitches: this.#killSwitches.state }),
    });
    if (!scan.ok) {
      return fail(scan.error, warnings);
    }
    const candidates: PlanTarget[] = scan.candidates.map((route, index) => ({
      route,
      providerId: route.providerId,
      modelClass: classifyModel(route.model, route.descriptor.family),
      modelAlias: route.modelAlias ?? route.modelRef,
      providerModelId: route.modelRef,
      routeDepth: index,
    }));
    if (candidates.length === 0) {
      return fail(
        makeAiError({
          reason: 'NO_ROUTE',
          message: 'No configured route satisfies this profile and requirement set.',
          details: { profile: call.profile },
        }),
        warnings,
      );
    }

    // Three-deadline arithmetic (ARCHITECTURE.md §12): clamped **down**, never widened.
    const budget = clampTimeoutBudget(
      call.timeoutBudget === undefined
        ? undefined
        : {
            totalMs: call.timeoutBudget.totalMs,
            ...(call.timeoutBudget.providerMs === undefined ? {} : { providerMs: call.timeoutBudget.providerMs }),
          },
      registration.limits.totalTimeoutMs,
      this.#limits.serverTimeoutMs ?? MAX_TOTAL_TIMEOUT_MS,
    );
    const totalMs =
      requirements.maxLatencyMs === undefined ? budget.totalMs : Math.min(budget.totalMs, requirements.maxLatencyMs);
    const deadlineAtMs = this.#clock.nowMs() + totalMs;
    const providerDeadline = providerDeadlineAt(deadlineAtMs, this.#clock.nowMs(), budget.providerMs);
    if (providerDeadline === null) {
      return fail(budgetExhaustedError(Math.max(0, deadlineAtMs - this.#clock.nowMs())), warnings);
    }

    return {
      ok: true,
      plan: {
        identity,
        composed: call,
        registration,
        candidates,
        preSkipped: scan.skipped,
        modelClass: candidates[0]?.modelClass ?? 'UNKNOWN',
        deadlineAtMs,
        budget: { totalMs, ...(budget.providerMs === undefined ? {} : { providerMs: budget.providerMs }) },
        warnings,
        ...(outputSchema === undefined ? {} : { outputSchema }),
        maxOutputBytes: Math.min(
          this.#limits.maxOutputBytes ?? registration.limits.maxOutputBytes,
          registration.limits.maxOutputBytes,
          registration.policy.maxOutputBytes,
        ),
        instructions,
        contextValues,
        requestedMaxOutputTokens,
        requirements,
        snapshot,
      },
    };
  }

  #resolveSchema(schema: OutputSchema): OutputSchema | null {
    if (schema.kind === 'INLINE') {
      return schema;
    }
    return this.#schemaResolver === undefined ? null : this.#schemaResolver(schema.ref);
  }
}

/** The safe projection for one attempt target (frozen `ProviderMetadataProjection`). */
export function projectionFor(
  target: { readonly providerId: string; readonly route: { readonly descriptor: { readonly family: import('@aibridge/contracts').ProviderFamily } }; readonly modelClass: ModelClass },
  attemptCount: number,
  repaired: boolean,
) {
  return {
    providerId: target.providerId,
    providerFamily: target.route.descriptor.family,
    modelClass: target.modelClass,
    routeDepth: 0,
    attemptCount,
    repaired,
  } as const;
}

export { buildProviderRequest, raceAttempt, ExecutionCoordinator } from './coordinator.js';
export { structuredOutputOutcome, textOutputOutcome } from './output.js';
export type { ProviderRequest };
