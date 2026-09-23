/**
 * `AiRuntime` — the Stage 3 runtime layer.
 *
 * The one path every consumer call takes:
 *
 * ```text
 * Consumer → Generic AI Contract → AiRuntime → Provider Adapter → Real Provider → normalized Generic Result
 * ```
 *
 * The runtime owns, in this order (ROADMAP Stage 3 §1):
 *
 *  1. **contract validation** — `parseConsumerAiRequest` (the security boundary) plus
 *     `composeAiRequest` against the host-bound `TrustedDispatchContext`;
 *  2. **capability validation** — registry lookup, governance, policy selection, schema ownership,
 *     `inputAllowList`, and the feature/requirement check against the resolved **model** — all
 *     before any provider call. A request the provider cannot serve fails locally;
 *  3. **provider resolution** — `resolveRoute` over the configured profile route chain;
 *  4. **trusted secret resolution** — a `credentialRef` handle resolves through the host's secret
 *     port at registration and is bound to the adapter. A credential value never enters this
 *     class's state, a `ProviderRequest`, a result, an error or the operator log;
 *  5. **request execution** with **timeout** (the frozen three-deadline arithmetic) and
 *     **cancellation** (terminal, idempotent, propagated to the adapter);
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
  createIssue,
  extractStructuredCandidate,
  invalid,
  makeAiError,
  makeFailureResult,
  makeStreamCompleted,
  makeStreamFailed,
  makeStreamStarted,
  makeStreamTextDelta,
  makeSuccessResult,
  parseConsumerAiRequest,
  parseStructuredGenerateInput,
  parseTextGenerateInput,
  parseTrustedDispatchContext,
  providerDeadlineAt,
  isCapabilityGranted,
  renderOutputFormatInstruction,
  valid,
  type AiError,
  type AiFinishReason,
  type AiProviderAdapter,
  type AiResult,
  type AiStreamEvent,
  type AiUsage,
  type AiWarning,
  type CancellationToken,
  type CapabilityRequirements,
  type ComposedAiRequest,
  type ContextBundle,
  type ModelClass,
  type OutputSchema,
  type OutputSchemaRef,
  type ProviderDescriptor,
  type ProviderRequest,
  type ProviderStructuredResult,
  type ProviderTextResult,
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
  TurnCallCounter,
  allowsCallerOutputSchema,
  guardStructuredOutput,
  isRecord,
  screenAiInput,
  utf8ByteLength,
  type CapabilityRegistration,
} from '@aibridge/core';
import type { Clock, SecretStorePort } from '@aibridge/host-sdk';
import {
  budgetExhaustedError,
  cancelledByCallerError,
  normalizeProviderError,
  normalizeThrown,
  providerTimeoutError,
  validationFailureToAiError,
} from './errors.js';
import { nullOperatorLog, redactOperatorDetail, type OperatorLogSink } from './operator-log.js';
import {
  classifyModel,
  resolveRoute,
  type BoundProvider,
  type ResolvedRoute,
  type RuntimeRoutes,
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

type DispatchPlan = {
  readonly identity: ResultIdentity;
  readonly composed: ComposedAiRequest<unknown>;
  readonly registration: CapabilityRegistration;
  readonly route: ResolvedRoute;
  readonly modelClass: ModelClass;
  readonly providerRequest: ProviderRequest;
  readonly deadlineAtMs: number;
  readonly providerDeadlineAtMs: number;
  readonly budget: TimeoutBudget;
  readonly warnings: readonly AiWarning[];
  /** Resolved inline schema, for a capability whose output schema is caller-owned. */
  readonly outputSchema?: OutputSchema;
  readonly maxOutputBytes: number;
};

type Prepared =
  | { readonly ok: true; readonly plan: DispatchPlan }
  | { readonly ok: false; readonly identity: ResultIdentity; readonly error: AiError; readonly warnings: readonly AiWarning[] };

type ValueOutcome = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: AiError };

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

export type RuntimeOptions = {
  /** Trusted bootstrap: the providers this runtime may dispatch to. */
  readonly providers?: readonly RuntimeProviderRegistration[];
  readonly routes: RuntimeRoutes;
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
  readonly cancellation?: CancellationToken;
};

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

type AttemptOutcome<T> =
  | { readonly kind: 'completed'; readonly value: T }
  | { readonly kind: 'deadline' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'threw'; readonly error: unknown };

/**
 * Race one attempt against its deadline and the cancellation token.
 *
 * Settles exactly once — which is what makes cancellation *terminal*: a provider answer that
 * arrives after `CANCELLED` is discarded rather than resurrecting the call.
 */
function raceAttempt<T>(
  work: Promise<T>,
  timeoutMs: number,
  cancellation: CancellationToken | undefined,
): Promise<AttemptOutcome<T>> {
  return new Promise<AttemptOutcome<T>>((resolve) => {
    let settled = false;
    let unsubscribe: (() => void) | undefined;
    function settle(outcome: AttemptOutcome<T>): void {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (unsubscribe !== undefined) {
        unsubscribe();
      }
      resolve(outcome);
    }
    const timer = setTimeout(() => settle({ kind: 'deadline' }), Math.max(0, timeoutMs));
    if (cancellation !== undefined) {
      if (cancellation.cancelled) {
        settle({ kind: 'cancelled' });
        return;
      }
      unsubscribe = cancellation.onCancel(() => settle({ kind: 'cancelled' }));
    }
    work.then(
      (value) => settle({ kind: 'completed', value }),
      (error: unknown) => settle({ kind: 'threw', error }),
    );
  });
}

export class AiRuntime {
  readonly #routes: RuntimeRoutes;
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

  constructor(options: RuntimeOptions) {
    this.#routes = options.routes;
    this.#capabilities = options.capabilities ?? defaultCapabilityRegistry();
    this.#secrets = options.secrets;
    this.#clock = options.clock ?? systemClock();
    this.#killSwitches = options.killSwitches;
    this.#limits = options.limits ?? {};
    this.#schemaResolver = options.schemaResolver;
    this.#log = options.operatorLog ?? nullOperatorLog();
    for (const registration of options.providers ?? []) {
      // A registration is async (it may resolve a credential). Every call path awaits
      // `#pendingRegistrations` first, so a dispatch can never race its own binding.
      this.#pendingRegistrations.push(this.registerProvider(registration));
    }
  }

  get providerIds(): readonly string[] {
    return [...this.#providers.keys()].sort();
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
    await Promise.all(this.#pendingRegistrations);
    const startedAtMs = this.#clock.nowMs();
    const prepared = this.#prepare(request, trustedContext, 'GENERATE', options);
    if (!prepared.ok) {
      this.#log.write({
        level: 'warn',
        event: 'runtime.rejected',
        atMs: this.#clock.nowMs(),
        requestId: prepared.identity.requestId,
        capability: prepared.identity.capability,
        detail: `${prepared.error.reason ?? prepared.error.code} ${prepared.error.stage}`,
      });
      return this.#failure(prepared.identity, prepared.error, { startedAtMs, warnings: prepared.warnings });
    }

    const plan = prepared.plan;
    this.#log.write({
      level: 'info',
      event: 'provider.dispatched',
      atMs: this.#clock.nowMs(),
      requestId: plan.identity.requestId,
      capability: plan.identity.capability,
      providerId: plan.route.providerId,
    });

    const calls = new TurnCallCounter(plan.registration.limits.maxCallsPerTurn);
    const authorization = calls.authorize();
    if (!authorization.authorized) {
      return this.#failure(plan.identity, authorization.error, { startedAtMs, warnings: plan.warnings, plan });
    }

    const work =
      plan.identity.capability === 'ai.structured.generate'
        ? plan.route.adapter.generateStructured(plan.providerRequest)
        : plan.route.adapter.generateText(plan.providerRequest);
    const timeoutMs = Math.max(0, plan.providerDeadlineAtMs - this.#clock.nowMs());
    const outcome = await raceAttempt(work, timeoutMs, options.cancellation);

    switch (outcome.kind) {
      case 'cancelled':
        return this.#failure(plan.identity, cancelledByCallerError(), {
          startedAtMs,
          warnings: plan.warnings,
          plan,
          usage: {},
        });
      case 'deadline': {
        const error = this.#clock.nowMs() >= plan.deadlineAtMs ? budgetExhaustedError(0) : providerTimeoutError();
        return this.#failure(plan.identity, error, { startedAtMs, warnings: plan.warnings, plan, usage: {} });
      }
      case 'threw': {
        const error = normalizeThrown(outcome.error);
        return this.#failure(plan.identity, error, { startedAtMs, warnings: plan.warnings, plan, usage: {} });
      }
      case 'completed':
        return this.#complete(plan, outcome.value, startedAtMs);
    }
  }

  /**
   * Execute one call with incremental delivery. Yields the frozen stream sequence
   * `STARTED → TEXT_DELTA* → (COMPLETED | FAILED)` — always terminated, including on error,
   * timeout and cancellation.
   *
   * Only `ai.text.generate` streams in V1: a token stream of a partial *judgement* is dangerous
   * (CAPABILITIES.md §4), so structured generation fails locally here rather than degrading.
   */
  async *stream(request: unknown, trustedContext: unknown, options: ExecuteOptions = {}): AsyncIterable<AiStreamEvent> {
    await Promise.all(this.#pendingRegistrations);
    const startedAtMs = this.#clock.nowMs();
    const identity = echoIdentity(request);
    yield makeStreamStarted({
      contractVersion: identity.contractVersion,
      requestId: identity.requestId,
      capability: identity.capability,
      capabilityVersion: identity.capabilityVersion,
    });

    const prepared = this.#prepare(request, trustedContext, 'STREAM', options);
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
    const streamText = plan.route.adapter.streamText;
    if (streamText === undefined) {
      // `resolveRoute` already refuses a non-streaming route; this is defence in depth.
      yield makeStreamFailed({
        error: makeAiError({
          reason: 'NO_ROUTE',
          message: 'The resolved route cannot deliver a stream.',
          details: { profile: plan.route.profile },
          retryable: false,
        }),
        usage: {},
        finishReason: 'UNKNOWN',
        providerMetadata: this.#projection(plan),
        latencyMs: Math.max(0, this.#clock.nowMs() - startedAtMs),
        warnings: plan.warnings,
      });
      return;
    }

    const iterator = streamText.call(plan.route.adapter, plan.providerRequest)[Symbol.asyncIterator]();
    let accumulated = '';
    let usage: AiUsage = {};
    let finishReason: AiFinishReason = 'UNKNOWN';
    let finished = false;

    const failStream = (error: AiError, finish: AiFinishReason = 'UNKNOWN'): AiStreamEvent =>
      makeStreamFailed({
        error,
        usage,
        finishReason: finish,
        providerMetadata: this.#projection(plan),
        latencyMs: Math.max(0, this.#clock.nowMs() - startedAtMs),
        warnings: plan.warnings,
      });

    try {
      for (;;) {
        const timeoutMs = Math.max(0, plan.providerDeadlineAtMs - this.#clock.nowMs());
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
        this.#rawErrorLog(plan, event.error);
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
      providerMetadata: this.#projection(plan),
      latencyMs: Math.max(0, this.#clock.nowMs() - startedAtMs),
      warnings: plan.warnings,
    });
  }

  /* -------------------------------------------------------------------------------------------
   * Internals
   * ---------------------------------------------------------------------------------------- */

  #rawErrorLog(plan: DispatchPlan, raw: { readonly rawMessage?: string }): void {
    this.#log.write({
      level: 'error',
      event: 'provider.raw_error',
      atMs: this.#clock.nowMs(),
      requestId: plan.identity.requestId,
      capability: plan.identity.capability,
      providerId: plan.route.providerId,
      ...(raw.rawMessage === undefined ? {} : { detail: redactOperatorDetail(raw.rawMessage, this.#boundSecrets) }),
    });
  }

  #projection(plan: DispatchPlan) {
    return {
      providerId: plan.route.providerId,
      providerFamily: plan.route.descriptor.family,
      modelClass: plan.modelClass,
      routeDepth: 0,
      attemptCount: 1,
      repaired: false,
    } as const;
  }

  #failure(
    identity: ResultIdentity,
    error: AiError,
    input: {
      readonly startedAtMs: number;
      readonly warnings: readonly AiWarning[];
      readonly plan?: DispatchPlan;
      readonly finishReason?: AiFinishReason;
      readonly usage?: AiUsage;
    },
  ): AiResult<never> {
    return makeFailureResult({
      contractVersion: identity.contractVersion,
      requestId: identity.requestId,
      capability: identity.capability,
      capabilityVersion: identity.capabilityVersion,
      error,
      usage: input.usage ?? {},
      providerMetadata: input.plan === undefined ? unroutedProjection() : this.#projection(input.plan),
      latencyMs: Math.max(0, this.#clock.nowMs() - input.startedAtMs),
      finishReason: input.finishReason ?? 'UNKNOWN',
      warnings: input.warnings,
    });
  }

  #complete(
    plan: DispatchPlan,
    result: ProviderTextResult | ProviderStructuredResult,
    startedAtMs: number,
  ): AiResult<unknown> {
    const usage = result.usage;
    const finishReason = result.finishReason;
    if (result.rawError !== undefined) {
      this.#rawErrorLog(plan, result.rawError);
      return this.#failure(plan.identity, normalizeProviderError(result.rawError), {
        startedAtMs,
        warnings: plan.warnings,
        plan,
        finishReason,
        usage,
      });
    }

    const output =
      plan.identity.capability === 'ai.structured.generate'
        ? this.#structuredOutput(plan, result.text)
        : this.#textOutput(plan, result.text, finishReason);
    if (!output.ok) {
      return this.#failure(plan.identity, output.error, {
        startedAtMs,
        warnings: plan.warnings,
        plan,
        finishReason,
        usage,
      });
    }

    return makeSuccessResult({
      contractVersion: plan.identity.contractVersion,
      requestId: plan.identity.requestId,
      capability: plan.identity.capability,
      capabilityVersion: plan.identity.capabilityVersion,
      output: output.value,
      usage,
      providerMetadata: this.#projection(plan),
      latencyMs: Math.max(0, this.#clock.nowMs() - startedAtMs),
      finishReason,
      warnings: plan.warnings,
    });
  }

  #textOutput(plan: DispatchPlan, text: string, finishReason: AiFinishReason): ValueOutcome {
    const bytes = utf8ByteLength(text);
    if (bytes > plan.maxOutputBytes) {
      return {
        ok: false,
        error: validationFailureToAiError(
          {
            reason: 'OUTPUT_TOO_LARGE',
            code: 'SCHEMA_MISMATCH',
            stage: 'EXTRACTION',
            issues: [{ code: 'SIZE_EXCEEDED', path: '$.text', message: 'output exceeded the cap' }],
          },
          'The generated answer exceeds the declared output size cap.',
        ),
      };
    }
    return { ok: true, value: { text, finishReason } };
  }

  #structuredOutput(plan: DispatchPlan, text: string): ValueOutcome {
    const schema = plan.outputSchema;
    if (schema === undefined || schema.kind !== 'INLINE') {
      return {
        ok: false,
        error: validationFailureToAiError(
          {
            reason: 'OUTPUT_SCHEMA_UNSUPPORTED',
            code: 'INVALID_REQUEST',
            stage: 'ENVELOPE',
            issues: [{ code: 'MISSING_FIELD', path: '$.outputSchema', message: 'no inline schema resolved' }],
          },
          'The structured output schema could not be resolved.',
        ),
      };
    }
    const extracted = extractStructuredCandidate(text);
    if (!extracted.ok) {
      return {
        ok: false,
        error: validationFailureToAiError(extracted.failure, 'The provider payload could not be read as structured output.'),
      };
    }
    const guarded = guardStructuredOutput(extracted.value.parsed, schema.fields, { maxBytes: plan.maxOutputBytes });
    if (!guarded.ok) {
      return { ok: false, error: guarded.error };
    }
    return { ok: true, value: guarded.output };
  }

  /** Contract validation → capability validation → provider resolution. No provider is contacted. */
  #prepare(request: unknown, trustedContext: unknown, delivery: RequirementDelivery, options: ExecuteOptions): Prepared {
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
    const route = resolveRoute({
      routes: this.#routes,
      providers: this.#providers,
      capability: call.capability,
      capabilityVersion: call.capabilityVersion,
      profile: call.profile,
      requirements,
      delivery,
      ...(this.#killSwitches === undefined ? {} : { killSwitches: this.#killSwitches.state }),
    });
    if (!route.ok) {
      return fail(route.error, warnings);
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

    const maxOutputTokens = Math.min(
      requestedMaxOutputTokens ?? requirements.maxOutputTokens ?? route.route.model.maxOutputTokens,
      requirements.maxOutputTokens ?? route.route.model.maxOutputTokens,
      route.route.model.maxOutputTokens,
    );

    const providerRequest: ProviderRequest = {
      capability: call.capability,
      profile: call.profile,
      instructions,
      context: contextValues.map((value) => ({
        name: value.name,
        label: value.label,
        untrusted: value.untrusted,
        value: value.value,
      })),
      ...(outputSchema !== undefined && outputSchema.kind === 'INLINE'
        ? { outputFormatInstruction: renderOutputFormatInstruction(outputSchema), outputSchema }
        : {}),
      modelRef: route.route.modelRef,
      deadlineAtMs: providerDeadline,
      maxOutputTokens,
      ...(options.cancellation === undefined ? {} : { cancellation: options.cancellation }),
    };

    return {
      ok: true,
      plan: {
        identity,
        composed: call,
        registration,
        route: route.route,
        modelClass: classifyModel(route.route.model, route.route.descriptor.family),
        providerRequest,
        deadlineAtMs,
        providerDeadlineAtMs: providerDeadline,
        budget: { totalMs, ...(budget.providerMs === undefined ? {} : { providerMs: budget.providerMs }) },
        warnings,
        ...(outputSchema === undefined ? {} : { outputSchema }),
        maxOutputBytes: Math.min(
          this.#limits.maxOutputBytes ?? registration.limits.maxOutputBytes,
          registration.limits.maxOutputBytes,
          registration.policy.maxOutputBytes,
        ),
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
