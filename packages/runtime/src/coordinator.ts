/**
 * `ExecutionCoordinator` — the Stage 5 execution layer (ROADMAP Phase 1–3, 7–9, 36–38, 50–58).
 *
 * `AiRuntime` stays the public execution entry; this class owns everything that happens **between**
 * a validated plan and a final result:
 *
 * ```text
 * logical request → idempotency gate → governance (budget, quota, rate)
 *   → provider attempts (bounded retry / deterministic fallback under one overall deadline)
 *   → bounded output repair → final result + reliability provenance
 * ```
 *
 * The distinction that structures it: one **logical request** is the consumer's call; each real
 * dispatch is one **provider attempt** (Phase 2). One consumer response may be the product of
 * several attempts, and every one of them is accounted — in the usage ledger, in the cost total and
 * in `ReliabilityProvenance`.
 *
 * Invariants this class maintains:
 *
 *  - **One overall deadline** (Phase 7): every attempt inherits what is *left*, never a fresh
 *    budget. A chain of `n` hops can never make a caller wait `n × budget`.
 *  - **Idempotency before governance** (Phase 51): a replayed or joined call consumes no quota, no
 *    rate budget and no provider money.
 *  - **Own limits are never dodged** (Phase 53–54): a fallback may move around a provider's
 *    failure, never around the caller's own rate limit or quota.
 *  - **No silent capability degrade** (Phase 5): a fallback target must still satisfy the original
 *    requirement set — `enumerateRouteCandidates` already dropped anything that cannot.
 *  - **Exactly one terminal result** (Phase 55): one `AiResult` is built and settled, and the
 *    terminal error is chosen by `selectTerminalError`, never by accident.
 */
import {
  makeAiError,
  makeFailureResult,
  makeStreamCompleted,
  makeStreamFailed,
  makeStreamTextDelta,
  makeSuccessResult,
  makeWarning,
  providerDeadlineAt,
  renderOutputFormatInstruction,
  resolveKillSwitch,
  type AiError,
  type AiErrorCode,
  type AiErrorReason,
  type AiFinishReason,
  type AiResult,
  type AiStreamCompleted,
  type AiStreamEvent,
  type AiStreamFailed,
  type AiUsage,
  type AiWarning,
  type CancellationToken,
  type FallbackOptions,
  type KillSwitchBlocked,
  type KillSwitchState,
  type KillSwitchVerdict,
  type ModelClass,
  type ModelProfile,
  type ProviderBoundValue,
  type ProviderRequest,
  type ProviderStreamEvent,
  type ProviderStructuredResult,
  type ProviderTextResult,
  type ValidationIssue,
} from '@aibridge/contracts';
import type { Clock } from '@aibridge/host-sdk';
import {
  aggregateUsage,
  decideFallback,
  decideRetry,
  estimateCost,
  fallbackOptionsOf,
  mergeCosts,
  safeSubjectRef,
  selectTerminalError,
  summarize,
  usageIsUnknown,
  type AttemptKind,
  type AttemptSkipReason,
  type AttemptStatus,
  type BudgetTracker,
  type CircuitBreakerRegistry,
  type CostEstimate,
  type IdempotencyRegistry,
  type IdMint,
  type LogicalRequestUsageRecord,
  type MetricsSink,
  type OperationalEventSink,
  type PricingSnapshot,
  type PromptProvenance,
  type ProviderAttemptProvenance,
  type ProviderAttemptUsageRecord,
  type QuotaManager,
  type QuotaPolicy,
  type QuotaRequest,
  type QuotaReservation,
  type RateLimiter,
  type ReliabilityProvenance,
  type RuntimeHealthRegistry,
  type Sleeper,
  type GovernanceSummary,
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
import { killSwitchError, utf8ByteLength } from '@aibridge/core';
import { nextFallback } from './fallback.js';
import type { RuntimeConfigSnapshot } from './config-manager.js';
import { validateCodeDebugOutput } from './code-debug.js';
import {
  repairExhaustedError,
  structuredOutputOutcome,
  textOutputOutcome,
  type ShapedOutput,
} from './output.js';
import { nullOperatorLog, redactOperatorDetail, type OperatorLogSink } from './operator-log.js';
import type { ResolvedRoute, SkippedCandidate } from './routes.js';

export type AttemptTarget = {
  readonly route: ResolvedRoute;
  readonly providerId: string;
  readonly modelClass: ModelClass;
  readonly modelAlias: string;
  readonly providerModelId: string;
  readonly routeDepth: number;
};

/** Everything the coordinator needs — already validated, already route-independent. */
export type ExecutionPlan = {
  readonly contractVersion: string;
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly capability: string;
  readonly capabilityVersion: string;
  /** Physical primitive used for provider dispatch; capability remains logical identity. */
  readonly requiredPrimitive: string;
  readonly profile: ModelProfile;
  readonly callerPluginId: string;
  readonly subjectToken?: string;
  /** `consumerRequestDigest` — the idempotency fingerprint (Phase 20). */
  readonly fingerprint: string;
  readonly maxCallsPerTurn: number;
  readonly candidates: readonly AttemptTarget[];
  /** Hops already dropped at prepare time and why (Phase 52). */
  readonly preSkipped: readonly SkippedCandidate[];
  readonly instructions: string;
  readonly context: import('@aibridge/contracts').ContextBundle;
  readonly outputSchema?: import('@aibridge/contracts').OutputSchema;
  readonly maxOutputBytes: number;
  readonly requestedMaxOutputTokens?: number;
  readonly requirements: import('@aibridge/contracts').CapabilityRequirements;
  readonly budget: import('@aibridge/contracts').TimeoutBudget;
  readonly deadlineAtMs: number;
  /** Input-screening warnings from prepare. */
  readonly warnings: readonly AiWarning[];
  /** The one config snapshot this request runs against (Phase 40–42). */
  readonly snapshot: RuntimeConfigSnapshot;
  /** Prompt provenance labels (Stage 6, additive): opaque pass-through, never content. */
  readonly promptApplied?: boolean;
  readonly promptVersion?: string;
};

export type ExecutionOutcome = {
  readonly result: AiResult<unknown>;
  readonly provenance: ReliabilityProvenance;
  readonly governance: GovernanceSummary;
};

export type ExecuteOptions = {
  readonly cancellation?: CancellationToken;
};

export type CoordinatorServices = {
  readonly clock: Clock;
  readonly sleeper: Sleeper;
  readonly ids: IdMint;
  readonly idempotency: IdempotencyRegistry;
  readonly rateLimiter: RateLimiter;
  readonly quotas: QuotaManager;
  readonly budget: BudgetTracker;
  readonly ledger: UsageLedgerPort;
  readonly breakers: CircuitBreakerRegistry;
  readonly health: RuntimeHealthRegistry;
  readonly metrics: MetricsSink;
  readonly events: OperationalEventSink;
  readonly killSwitchState: () => KillSwitchState;
  readonly log?: OperatorLogSink;
  readonly boundSecrets?: () => readonly string[];
};

type RepairFeedback = {
  readonly issues: readonly ValidationIssue[];
  readonly rawText: string;
};

type RawAttemptOutcome =
  | { readonly kind: 'completed'; readonly value: ProviderTextResult | ProviderStructuredResult }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'threw'; readonly error: unknown };

type AttemptFailure = {
  readonly error: AiError;
  readonly usage: AiUsage;
  readonly dispatched: boolean | undefined;
  readonly unknownOutcome: boolean;
  readonly finishReason: AiFinishReason;
};

type SkipEntry = {
  readonly target: AttemptTarget | null;
  readonly skip: SkippedCandidate;
  /**
   * The exact kill-switch verdict that blocked this target. Carried so the terminal error can
   * surface the true reason (`KILL_SWITCH_GLOBAL` / `KILL_SWITCH_CAPABILITY` / `KILL_SWITCH_PROVIDER`)
   * instead of collapsing every kill into the provider flavour. Never recorded in the ledger —
   * the durable skip vocabulary stays `KILL_SWITCH`.
   */
  readonly killSwitchBlocked?: KillSwitchBlocked;
};

/** `nextFallback`'s verdict, adapted for the coordinator's queue shape. */
type HopVerdict = { readonly kind: 'FALLBACK' } | { readonly kind: 'STOP'; readonly rule: string };

/**
 * The Stage 4 chain contract, applied to the coordinator's queue: `nextFallback` sees the chain
 * **including the hop that just failed**, so its verdict is exactly "may the next hop serve?".
 * The queue itself is consumed strictly forward — finite, no cycles, no duplicate targets (Phase 6).
 */
export function nextFallbackVerdict(current: AttemptTarget, queue: readonly AttemptTarget[], error: AiError, options: FallbackOptions): HopVerdict {
  const verdict = nextFallback([current, ...queue], error, options);
  return verdict.kind === 'FALLBACK' ? { kind: 'FALLBACK' } : { kind: 'STOP', rule: verdict.rule };
}

export class ExecutionCoordinator {
  readonly #services: CoordinatorServices;
  readonly #log: OperatorLogSink;

  constructor(services: CoordinatorServices) {
    this.#services = services;
    this.#log = services.log ?? nullOperatorLog();
  }

  /** Execute one logical request to exactly one terminal result. Never throws. */
  async execute(plan: ExecutionPlan, options: ExecuteOptions = {}): Promise<ExecutionOutcome> {
    const startedAtMs = this.#services.clock.nowMs();
    const logicalRequestId = this.#services.ids.next('lreq');
    const snapshot = plan.snapshot;
    const governance = snapshot.governance;
    const subjectRef = safeSubjectRef(plan.subjectToken);
    const primary = plan.candidates[0];

    this.#services.events.emit({
      type: 'ai.request_started',
      atMs: startedAtMs,
      payload: {
        requestId: plan.requestId,
        capability: plan.capability,
        callerPluginId: plan.callerPluginId,
        configVersion: snapshot.configVersion,
      },
    });
    this.#services.metrics.record({ name: 'ai.request.count', value: 1, labels: { capability: plan.capability } });

    // Shared, mutable attempt bookkeeping — all of it local to this call (Phase 61).
    const attemptRecords: ProviderAttemptProvenance[] = [];
    const ledgerAttempts: ProviderAttemptUsageRecord[] = [];
    const attemptErrors: { readonly error: AiError; readonly sequence: number }[] = [];
    const attemptCosts: (CostEstimate | undefined)[] = [];
    const attemptUsage: { readonly usage: AiUsage; readonly known: boolean }[] = [];
    const skipped: SkipEntry[] = [];
    const counts = { fallback: 0, retry: 0, repair: 0, dispatched: 0 };
    let sequence = 0;
    let finishReason: AiFinishReason = 'UNKNOWN';
    let finalUsage: AiUsage = {};
    let finalTarget: AttemptTarget | null = null;
    let finalOutput: ShapedOutput | null = null;
    let terminalError: AiError | null = null;
    let repaired = false;
    let primaryQuotaRefusal: AiError | null = null;

    const provenanceBase = {
      logicalRequestId,
      requestId: plan.requestId,
      callerPluginId: plan.callerPluginId,
      capability: plan.capability,
      capabilityVersion: plan.capabilityVersion,
      profile: plan.profile,
      configVersion: snapshot.configVersion,
      configDigest: snapshot.contentDigest,
      startedAtMs,
    };
    const planPromptProvenance: PromptProvenance | undefined =
      plan.promptApplied === undefined
        ? undefined
        : {
            promptApplied: plan.promptApplied,
            ...(plan.promptVersion === undefined ? {} : { promptVersion: plan.promptVersion }),
          };

    const finish = async (
      result: AiResult<unknown>,
      idempotencyOutcome: 'EXECUTED' | 'REPLAYED' | 'JOINED',
      settleGate: ((value: AiResult<unknown>) => Promise<void>) | null,
      provenanceOverride?: { readonly promptProvenance: PromptProvenance | undefined },
    ): Promise<ExecutionOutcome> => {
      const finishedAtMs = this.#services.clock.nowMs();
      const promptProvenance = provenanceOverride === undefined ? planPromptProvenance : provenanceOverride.promptProvenance;
      const allSkips: SkipEntry[] = [...plan.preSkipped.map((skip) => ({ target: null, skip })), ...skipped];
      const skipRecords = allSkips.map(({ target, skip }, index) =>
        this.#skipRecord(logicalRequestId, attemptRecords.length + index + 1, target, skip),
      );
      const provenance: ReliabilityProvenance = {
        ...provenanceBase,
        ...(promptProvenance ?? {}),
        finishedAtMs,
        status: result.status,
        ...(result.error?.code === undefined ? {} : { errorCode: result.error.code }),
        ...(result.error?.reason === undefined ? {} : { errorReason: result.error.reason }),
        attempts: [...attemptRecords, ...skipRecords],
        fallbackCount: counts.fallback,
        retryCount: counts.retry,
        repairCount: counts.repair,
        skippedCount: allSkips.length,
        idempotencyOutcome,
      };
      const summary = summarize(provenance);
      await this.#services.ledger.appendRequest(this.#requestRecord(plan, provenance, summary, idempotencyOutcome, startedAtMs, finishedAtMs, result));
      for (const record of ledgerAttempts) {
        await this.#services.ledger.appendAttempt(record);
      }
      this.#services.events.emit({
        type: 'ai.request_finished',
        atMs: finishedAtMs,
        payload: {
          requestId: plan.requestId,
          capability: plan.capability,
          status: result.status,
          attemptCount: counts.dispatched,
          fallbackCount: counts.fallback,
          retryCount: counts.retry,
          ...(result.error?.code === undefined ? {} : { errorCode: result.error.code }),
          ...(result.error?.reason === undefined ? {} : { reason: result.error.reason }),
        },
      });
      this.#services.metrics.record({
        name: result.status === 'SUCCEEDED' ? 'ai.request.success.count' : 'ai.failure.count',
        value: 1,
        labels: {
          capability: plan.capability,
          status: result.status,
          ...(result.error?.code === undefined ? {} : { errorCode: result.error.code }),
          ...(result.error?.reason === undefined ? {} : { reason: result.error.reason }),
        },
      });
      this.#services.metrics.record({
        name: 'ai.latency.ms',
        value: Math.max(0, finishedAtMs - startedAtMs),
        labels: { capability: plan.capability },
      });
      if (summary.totalUsage.totalTokens !== undefined) {
        this.#services.metrics.record({ name: 'ai.tokens.total', value: summary.totalUsage.totalTokens, labels: { capability: plan.capability } });
      }
      if (summary.totalCost.amount !== undefined) {
        this.#services.metrics.record({ name: 'ai.cost.estimated', value: summary.totalCost.amount, labels: { capability: plan.capability } });
      }
      if (settleGate !== null) {
        await settleGate(result);
      }
      return { result, provenance, governance: summary };
    };

    /* -----------------------------------------------------------------------------------------
     * Phase 51 — identity and fingerprint come **before** governance and before any dispatch.
     * A replayed or joined call consumes no quota, no rate budget and no provider money.
     * -------------------------------------------------------------------------------------- */
    let settleGate: ((value: AiResult<unknown>) => Promise<void>) | null = null;
    if (governance.idempotency.enabled) {
      const gate = await this.#services.idempotency.gate(
        {
          callerPluginId: plan.callerPluginId,
          capability: plan.capability,
          capabilityVersion: plan.capabilityVersion,
          idempotencyKey: plan.idempotencyKey,
        },
        plan.fingerprint,
        logicalRequestId,
        planPromptProvenance,
      );
      if (gate.kind === 'CONFLICT') {
        // Same key, different request (Phase 20): never return the old answer, never dispatch again.
        const error = makeAiError({
          reason: 'IDEMPOTENCY_CONFLICT',
          message: 'This idempotency key was already used for a different request body.',
        });
        return finish(this.#failureResult(plan, error, startedAtMs, [], { finalTarget, attemptCount: 0, finalUsage }), 'EXECUTED', null);
      }
      if (gate.kind === 'REPLAY') {
        const result = this.#withWarnings(gate.result, [
          makeWarning('IDEMPOTENT_REPLAY', 'a stored result was returned; no provider was called'),
        ]);
        return finish(result, 'REPLAYED', null, { promptProvenance: gate.promptProvenance });
      }
      if (gate.kind === 'JOIN') {
        // A joiner must not hang past its own deadline or ignore its own cancellation: race
        // the leader's promise the same way an attempt is raced.
        const remainingMs = Math.max(0, plan.deadlineAtMs - this.#services.clock.nowMs());
        const joined = await raceAttempt(gate.result, remainingMs, options.cancellation);
        if (joined.kind === 'completed') {
          const result = this.#withWarnings(joined.value, [
            makeWarning('IDEMPOTENT_REPLAY', 'joined an in-flight duplicate; one provider execution served both'),
          ]);
          return finish(result, 'JOINED', null, { promptProvenance: gate.promptProvenance });
        }
        const error =
          joined.kind === 'cancelled'
            ? cancelledByCallerError()
            : joined.kind === 'deadline'
              ? this.#services.clock.nowMs() >= plan.deadlineAtMs
                ? budgetExhaustedError(0)
                : providerTimeoutError()
              : makeAiError({ reason: 'INTERNAL_ERROR', message: 'The in-flight call this duplicate joined did not complete.' });
        return finish(this.#failureResult(plan, error, startedAtMs, [], { finalTarget, attemptCount: 0, finalUsage }), 'EXECUTED', null);
      }
      settleGate = gate.settle;
    }

    /* -----------------------------------------------------------------------------------------
     * Governance — budget pre-check, quota reservation, rate limit. All before the first
     * dispatch; a refusal here means **zero** provider calls (Phase 22/34/51).
     * -------------------------------------------------------------------------------------- */
    const quotaRequest: QuotaRequest = {
      callerPluginId: plan.callerPluginId,
      capability: plan.capability,
      ...(subjectRef === undefined ? {} : { subjectRef }),
      ...(primary === undefined ? {} : { providerId: primary.providerId }),
    };
    const requestQuotaPolicies = governance.quotas.filter((policy) => policy.scope !== 'provider');
    const providerQuotaPolicies = governance.quotas.filter((policy) => policy.scope === 'provider');
    const budgetPolicies = this.#budgetQuotaPolicies(governance.budget);
    const estimateTokens = this.#tokenReservation(requestQuotaPolicies, plan);
    const primaryPricing = this.#pinPricing(plan, primary ?? null, startedAtMs);
    const estimatedCost = this.#conservativeCost(primaryPricing, estimateTokens);
    const estimate = {
      tokens: estimateTokens,
      ...(estimatedCost.amount === undefined ? {} : { cost: estimatedCost.amount }),
    };

    const budgetDecision = await this.#services.budget.check(quotaRequest, estimatedCost, governance.budget);
    if (!budgetDecision.ok) {
      this.#services.events.emit({
        type: 'ai.quota_rejected',
        atMs: this.#services.clock.nowMs(),
        payload: { dimension: 'ESTIMATED_COST', scope: 'budget', reason: 'COST_BUDGET_EXHAUSTED' },
      });
      return finish(this.#failureResult(plan, budgetDecision.error, startedAtMs, [], { finalTarget, attemptCount: 0, finalUsage }), 'EXECUTED', settleGate);
    }

    const reservations: QuotaReservation[] = [];
    const requestReservation = await this.#services.quotas.reserve(quotaRequest, estimate, requestQuotaPolicies);
    if (!requestReservation.ok) {
      this.#emitQuotaRejected(requestReservation.error, requestReservation.policy);
      return finish(this.#failureResult(plan, requestReservation.error, startedAtMs, [], { finalTarget, attemptCount: 0, finalUsage }), 'EXECUTED', settleGate);
    }
    reservations.push(requestReservation.reservation);

    const budgetReservation = await this.#services.quotas.reserve(quotaRequest, estimate, budgetPolicies);
    if (!budgetReservation.ok) {
      await this.#services.quotas.release(requestReservation.reservation);
      this.#emitQuotaRejected(costBudgetExhaustedError(), { meter: 'ESTIMATED_COST', scope: 'global' });
      return finish(this.#failureResult(plan, costBudgetExhaustedError(), startedAtMs, [], { finalTarget, attemptCount: 0, finalUsage }), 'EXECUTED', settleGate);
    }
    reservations.push(budgetReservation.reservation);

    const rate = await this.#services.rateLimiter.consume(quotaRequest, governance.rateLimits);
    if (!rate.allowed) {
      // Our own limit: never silently moved to another provider (Phase 53).
      await this.#services.quotas.release(requestReservation.reservation);
      await this.#services.quotas.release(budgetReservation.reservation);
      this.#services.events.emit({
        type: 'ai.rate_limited',
        atMs: this.#services.clock.nowMs(),
        payload: { dimension: rate.dimension, reason: rate.error.reason ?? 'RATE_LIMIT_SUBJECT', retryAfterMs: rate.retryAfterMs },
      });
      this.#services.metrics.record({ name: 'ai.rate_limited.count', value: 1, labels: { capability: plan.capability, dimension: 'REQUESTS' } });
      return finish(this.#failureResult(plan, rate.error, startedAtMs, [], { finalTarget, attemptCount: 0, finalUsage }), 'EXECUTED', settleGate);
    }

    /* -----------------------------------------------------------------------------------------
     * The attempt loop: kill switch → breaker → capability → remaining budget → quota eligibility
     * (Phase 52), one shared overall deadline (Phase 7), bounded retry (Phase 8–10) and
     * deterministic fallback (Phase 4–6).
     * -------------------------------------------------------------------------------------- */
    const queue = [...plan.candidates];
    let nextKind: AttemptKind = 'PRIMARY';
    let nextRetryRule: string | undefined;
    let nextFallbackRule: string | undefined;
    let retryTarget: AttemptTarget | null = null;
    let retriesUsed = 0;

    attemptLoop: for (;;) {
      if (options.cancellation?.cancelled === true) {
        terminalError = cancelledByCallerError();
        break attemptLoop;
      }

      let target: AttemptTarget | null;
      if (retryTarget !== null) {
        target = retryTarget;
        retryTarget = null;
      } else {
        retriesUsed = 0;
        target = this.#pickCandidate(plan, queue, skipped);
        if (target === null) {
          break attemptLoop;
        }
      }

      const providerDeadlineAtMs = providerDeadlineAt(plan.deadlineAtMs, this.#services.clock.nowMs(), plan.budget.providerMs);
      if (providerDeadlineAtMs === null) {
        skipped.push({ target, skip: this.#skipOf(target, 'DEADLINE_EXHAUSTED') });
        terminalError = budgetExhaustedError(Math.max(0, plan.deadlineAtMs - this.#services.clock.nowMs()));
        break attemptLoop;
      }

      // Provider-scoped quota eligibility **and** reservation for this attempt (Phase 25/52/54).
      // A policy pinned to another provider does not apply to this candidate at all.
      const targetQuotaPolicies = providerQuotaPolicies.filter((policy) => policy.scopeKey === undefined || policy.scopeKey === target.providerId);
      const providerReservation = await this.#services.quotas.reserve(
        { ...quotaRequest, providerId: target.providerId },
        estimate,
        targetQuotaPolicies,
      );
      if (!providerReservation.ok) {
        skipped.push({ target, skip: this.#skipOf(target, 'QUOTA_INELIGIBLE') });
        primaryQuotaRefusal = providerReservation.error;
        continue attemptLoop;
      }

      sequence += 1;
      counts.dispatched += 1;
      const attemptId = this.#services.ids.next('att');
      const attemptKind = nextKind;
      const attemptStartedAtMs = this.#services.clock.nowMs();
      const breaker = this.#services.breakers.for(target.providerId, target.modelAlias);
      const pricing = this.#pinPricing(plan, target, startedAtMs);

      this.#services.events.emit({
        type: 'ai.provider_attempt_started',
        atMs: attemptStartedAtMs,
        payload: { requestId: plan.requestId, attemptId, sequence, providerId: target.providerId, modelAlias: target.modelAlias, attemptKind },
      });
      this.#log.write({
        level: 'info',
        event: 'provider.dispatched',
        atMs: attemptStartedAtMs,
        requestId: plan.requestId,
        capability: plan.capability,
        providerId: target.providerId,
      });

      const raw = await this.#dispatch(plan, target, providerDeadlineAtMs, options.cancellation, undefined);
      const attemptFinishedAtMs = this.#services.clock.nowMs();
      const failure = this.#interpretFailure(raw, plan);
      // Shape before recording: an attempt whose output was rejected is a **failed** attempt, and
      // the ledger must say so (Phase 28).
      const shaped = failure === null && raw.kind === 'completed' ? this.#shapeOutput(plan, raw.value) : null;
      const recordError = failure?.error ?? (shaped !== null && !shaped.ok ? shaped.error : undefined);
      const usage = raw.kind === 'completed' ? raw.value.usage : {};
      const usageKnown = !usageIsUnknown(usage);
      const cost = estimateCost(usage, pricing, usage.estimatedCost);

      // This attempt's own quota is settled immediately: every provider that was paid is counted,
      // including the ones that failed (Phase 26).
      await this.#services.quotas.settle(providerReservation.reservation, {
        usageKnown,
        ...(this.#reportedTokens(usage) === undefined ? {} : { tokens: this.#reportedTokens(usage) as number }),
        ...(cost.amount === undefined ? {} : { cost: cost.amount }),
      });
      attemptUsage.push({ usage, known: usageKnown });
      attemptCosts.push(cost);

      let status: AttemptStatus;
      if (failure !== null) {
        status = failure.error.code === 'CANCELLED' ? 'CANCELLED' : 'FAILED';
        attemptErrors.push({ error: failure.error, sequence });
        finishReason = failure.finishReason;
        finalUsage = usage;
        finalTarget = target;
        breaker.recordFailure(failure.error);
        this.#services.health.recordFailure(target.providerId, target.modelAlias, failure.error);
        if (breaker.snapshot().state === 'OPEN') {
          this.#services.events.emit({
            type: 'ai.breaker_opened',
            atMs: this.#services.clock.nowMs(),
            payload: { providerId: target.providerId, modelAlias: target.modelAlias },
          });
          this.#services.metrics.record({ name: 'ai.breaker_open.count', value: 1, labels: { providerId: target.providerId, modelAlias: target.modelAlias } });
        }
        if (failure.error.code === 'CANCELLED') {
          terminalError = failure.error;
        }
      } else if (shaped !== null && shaped.ok) {
        status = 'SUCCEEDED';
        breaker.recordSuccess();
        this.#services.health.recordSuccess(target.providerId, target.modelAlias);
        finishReason = raw.kind === 'completed' ? raw.value.finishReason : 'UNKNOWN';
        finalUsage = usage;
        finalTarget = target;
      } else {
        // The provider call worked; the answer did not conform. Provider health is unaffected.
        status = 'FAILED';
        breaker.recordSuccess();
        this.#services.health.recordSuccess(target.providerId, target.modelAlias);
        finishReason = raw.kind === 'completed' ? raw.value.finishReason : 'UNKNOWN';
        finalUsage = usage;
        finalTarget = target;
      }

      this.#recordAttempt(ledgerAttempts, attemptRecords, {
        plan,
        logicalRequestId,
        attemptId,
        sequence,
        attemptKind,
        target,
        startedAtMs: attemptStartedAtMs,
        finishedAtMs: attemptFinishedAtMs,
        status,
        ...(recordError === undefined ? {} : { errorCode: recordError.code, errorReason: recordError.reason }),
        ...(nextRetryRule === undefined ? {} : { retryRule: nextRetryRule }),
        ...(nextFallbackRule === undefined ? {} : { fallbackRule: nextFallbackRule }),
        usage,
        usageKnown,
        cost,
        pricing,
      });
      this.#services.metrics.record({
        name: 'ai.attempt.count',
        value: 1,
        labels: { capability: plan.capability, providerId: target.providerId, modelAlias: target.modelAlias, attemptKind },
      });
      this.#services.events.emit({
        type: 'ai.provider_attempt_finished',
        atMs: attemptFinishedAtMs,
        payload: {
          requestId: plan.requestId,
          attemptId,
          sequence,
          providerId: target.providerId,
          status,
          ...(failure === null ? {} : { errorCode: failure.error.code }),
          ...(failure === null || failure.error.reason === undefined ? {} : { reason: failure.error.reason }),
        },
      });

      if (terminalError !== null) {
        break attemptLoop;
      }

      if (failure === null && shaped !== null) {
        // The provider answered. Shape the output — and maybe repair it (Phase 36–38).
        if (shaped.ok) {
          finalOutput = shaped;
          break attemptLoop;
        }
        const canRepair = shaped.repairable && governance.outputRepair === 'ONCE' && !repaired;
        if (canRepair) {
          const repair = await this.#attemptRepair(plan, target, shaped, {
            logicalRequestId,
            parentAttemptId: attemptId,
            parentSequence: sequence,
            ...(options.cancellation === undefined ? {} : { cancellation: options.cancellation }),
            pricing,
            quotaRequest,
            providerQuotaPolicies,
            estimate,
            ledgerAttempts,
            attemptRecords,
            attemptUsage,
            attemptCosts,
            counts,
          });
          if (repair.kind === 'skipped') {
            // Phase 38: no budget for a repair — the original failure stands and is not a repair.
            attemptErrors.push({ error: repair.error, sequence });
            terminalError = repair.error;
            break attemptLoop;
          }
          sequence = repair.sequence;
          counts.repair += 1;
          repaired = true;
          if (repair.kind === 'succeeded') {
            finalOutput = repair.output;
            finalUsage = repair.usage;
            finishReason = repair.finishReason;
            break attemptLoop;
          }
          terminalError = repair.error;
          attemptErrors.push({ error: repair.error, sequence });
          break attemptLoop;
        }
        // Not repairable (or repair is off): this is the terminal answer for the request.
        attemptErrors.push({ error: shaped.error, sequence });
        terminalError = shaped.error;
        break attemptLoop;
      }

      const attemptFailure = failure as AttemptFailure;

      // Bounded same-provider retry (Phase 8–10)…
      const retryDecision = decideRetry({
        error: attemptFailure.error,
        ...(attemptFailure.dispatched === undefined ? {} : { dispatched: attemptFailure.dispatched }),
        retriesUsed,
        policy: governance.retry,
        supportsReliableIdempotency: target.route.descriptor.supportsReliableIdempotency === true,
        ...(attemptFailure.error.retryAfterMs === undefined ? {} : { retryAfterMs: attemptFailure.error.retryAfterMs }),
        remainingMs: Math.max(0, plan.deadlineAtMs - this.#services.clock.nowMs()),
        ...(options.cancellation === undefined ? {} : { cancellation: options.cancellation }),
      });
      if (retryDecision.retry) {
        counts.retry += 1;
        retriesUsed += 1;
        nextKind = 'RETRY';
        nextRetryRule = retryDecision.reason;
        this.#services.events.emit({
          type: 'ai.retry_applied',
          atMs: this.#services.clock.nowMs(),
          payload: { requestId: plan.requestId, providerId: target.providerId, rule: retryDecision.reason, delayMs: retryDecision.delayMs },
        });
        this.#services.metrics.record({ name: 'ai.retry.count', value: 1, labels: { capability: plan.capability, providerId: target.providerId } });
        const sleep = await this.#services.sleeper.sleep(retryDecision.delayMs, options.cancellation);
        if (sleep === 'CANCELLED') {
          terminalError = cancelledByCallerError();
          break attemptLoop;
        }
        retryTarget = target;
        continue attemptLoop;
      }

      // …then deterministic fallback to another provider (Phase 4–6).
      const fallbackDecision = decideFallback(attemptFailure.error, governance.fallback, {
        unknownOutcome: attemptFailure.unknownOutcome,
      });
      if (!fallbackDecision.eligible) {
        break attemptLoop;
      }
      const verdict = nextFallbackVerdict(target, queue, attemptFailure.error, fallbackOptionsOf(governance.fallback));
      if (verdict.kind !== 'FALLBACK' || queue.length === 0) {
        break attemptLoop;
      }
      counts.fallback += 1;
      nextKind = 'FALLBACK';
      nextFallbackRule = fallbackDecision.rule;
      this.#services.events.emit({
        type: 'ai.fallback_applied',
        atMs: this.#services.clock.nowMs(),
        payload: {
          requestId: plan.requestId,
          fromProviderId: target.providerId,
          toProviderId: queue[0]?.providerId ?? 'none',
          rule: fallbackDecision.rule,
        },
      });
      this.#services.metrics.record({ name: 'ai.fallback.count', value: 1, labels: { capability: plan.capability, providerId: target.providerId } });
    }

    /* -----------------------------------------------------------------------------------------
     * Settle governance and build exactly one terminal result (Phase 55/58).
     * -------------------------------------------------------------------------------------- */
    const total = aggregateUsage(attemptUsage);
    const totalCost = mergeCosts(attemptCosts);
    // A terminal reached with zero dispatches releases — never charges — the request-scope
    // reservations: a pre-dispatch cancel or refusal paid nothing, so settling the conservative
    // estimate would burn quota for work that never happened.
    for (const reservation of reservations) {
      if (counts.dispatched === 0) {
        await this.#services.quotas.release(reservation);
        continue;
      }
      await this.#services.quotas.settle(reservation, {
        usageKnown: total.complete,
        ...(this.#reportedTokens(total.usage) === undefined ? {} : { tokens: this.#reportedTokens(total.usage) as number }),
        ...(totalCost.amount === undefined ? {} : { cost: totalCost.amount }),
      });
    }

    const warnings = [...plan.warnings, ...this.#reliabilityWarnings(counts, repaired, total, totalCost)];
    if (terminalError === null && finalOutput !== null && finalOutput.ok) {
      const result = makeSuccessResult({
        contractVersion: plan.contractVersion,
        requestId: plan.requestId,
        capability: plan.capability,
        capabilityVersion: plan.capabilityVersion,
        output: finalOutput.value,
        usage: finalUsage,
        providerMetadata: this.#projection(finalTarget, counts.dispatched, repaired),
        latencyMs: Math.max(0, this.#services.clock.nowMs() - startedAtMs),
        finishReason,
        warnings,
      });
      return finish(result, 'EXECUTED', settleGate);
    }

    const error =
      terminalError ??
      selectTerminalError({
        candidates: attemptErrors,
        fallbackError: this.#chainExhaustedError(plan, skipped, primaryQuotaRefusal),
        deadlineExhausted: this.#services.clock.nowMs() >= plan.deadlineAtMs,
      });
    const failureResult = makeFailureResult({
      contractVersion: plan.contractVersion,
      requestId: plan.requestId,
      capability: plan.capability,
      capabilityVersion: plan.capabilityVersion,
      error,
      usage: finalUsage,
      providerMetadata: this.#projection(finalTarget, counts.dispatched, repaired),
      latencyMs: Math.max(0, this.#services.clock.nowMs() - startedAtMs),
      finishReason,
      warnings,
    });
    return finish(failureResult, 'EXECUTED', settleGate);
  }

  /* -----------------------------------------------------------------------------------------------
   * Governed streaming — the same pre-dispatch governance as `execute`, exactly one attempt.
   * -------------------------------------------------------------------------------------------- */

  /**
   * Stream one logical request as a single governed attempt. Never throws: every terminal path
   * settles fully (ledger, metrics, quota, idempotency) and then yields exactly one COMPLETED or
   * FAILED event.
   *
   * Retry, fallback and repair do not apply — partial output may already be delivered — but
   * idempotency, budget, quota, rate limit, kill switch, breaker and the usage ledger apply
   * exactly as in `execute`. The caller yields STARTED first; this generator yields zero or more
   * TEXT_DELTAs and then one terminal event.
   */
  async *stream(plan: ExecutionPlan, options: ExecuteOptions = {}): AsyncIterable<AiStreamEvent> {
    const startedAtMs = this.#services.clock.nowMs();
    const logicalRequestId = this.#services.ids.next('lreq');
    const snapshot = plan.snapshot;
    const governance = snapshot.governance;
    const subjectRef = safeSubjectRef(plan.subjectToken);
    const primary = plan.candidates[0];

    this.#services.events.emit({
      type: 'ai.request_started',
      atMs: startedAtMs,
      payload: {
        requestId: plan.requestId,
        capability: plan.capability,
        callerPluginId: plan.callerPluginId,
        configVersion: snapshot.configVersion,
      },
    });
    this.#services.metrics.record({ name: 'ai.request.count', value: 1, labels: { capability: plan.capability } });

    const attemptRecords: ProviderAttemptProvenance[] = [];
    const ledgerAttempts: ProviderAttemptUsageRecord[] = [];
    const skipped: SkipEntry[] = [];
    const planPromptProvenance: PromptProvenance | undefined =
      plan.promptApplied === undefined
        ? undefined
        : {
            promptApplied: plan.promptApplied,
            ...(plan.promptVersion === undefined ? {} : { promptVersion: plan.promptVersion }),
          };
    const latencyMs = (): number => Math.max(0, this.#services.clock.nowMs() - startedAtMs);

    // Settle a terminal stream event the same way `execute` settles a terminal result: one
    // request ledger record, the attempt records, request events/metrics and the idempotency
    // settlement — all before the terminal event reaches the consumer.
    const settleStream = async (input: {
      readonly terminal: AiStreamCompleted | AiStreamFailed;
      readonly result: AiResult<unknown>;
      readonly idempotencyOutcome: 'EXECUTED' | 'REPLAYED' | 'JOINED';
      readonly settleGate: ((value: AiResult<unknown>) => Promise<void>) | null;
      readonly promptProvenance: PromptProvenance | undefined;
      readonly dispatched: number;
      readonly reservations: readonly QuotaReservation[];
      readonly usage: AiUsage;
      readonly usageComplete: boolean;
      readonly cost: CostEstimate;
    }): Promise<AiStreamCompleted | AiStreamFailed> => {
      await this.#settleStream({
        plan,
        logicalRequestId,
        startedAtMs,
        terminal: input.terminal,
        result: input.result,
        idempotencyOutcome: input.idempotencyOutcome,
        settleGate: input.settleGate,
        promptProvenance: input.promptProvenance,
        attemptRecords,
        ledgerAttempts,
        skipped,
        dispatched: input.dispatched,
        reservations: input.reservations,
        usage: input.usage,
        usageComplete: input.usageComplete,
        cost: input.cost,
      });
      return input.terminal;
    };

    const failedStream = (
      error: AiError,
      usage: AiUsage,
      finishReason: AiFinishReason,
      warnings: readonly AiWarning[],
    ): { readonly terminal: AiStreamFailed; readonly result: AiResult<never> } => {
      const terminal = makeStreamFailed({
        error,
        usage,
        finishReason,
        providerMetadata: this.#projection(primary ?? null, 1, false),
        latencyMs: latencyMs(),
        warnings,
      });
      const result = makeFailureResult({
        contractVersion: plan.contractVersion,
        requestId: plan.requestId,
        capability: plan.capability,
        capabilityVersion: plan.capabilityVersion,
        error,
        usage,
        providerMetadata: this.#projection(primary ?? null, 1, false),
        latencyMs: latencyMs(),
        finishReason,
        warnings,
      });
      return { terminal, result };
    };

    // Deliver a stored idempotent result as stream events: a succeeded text result replays its
    // text as deltas, anything else replays as the stored failure. No provider is called.
    const deliverStored = (
      stored: AiResult<unknown>,
      idempotencyOutcome: 'REPLAYED' | 'JOINED',
      promptProvenance: PromptProvenance | undefined,
    ): AsyncGenerator<AiStreamEvent> =>
      this.#deliverStoredStream({
        plan,
        logicalRequestId,
        startedAtMs,
        primary: primary ?? null,
        stored,
        idempotencyOutcome,
        promptProvenance,
        attemptRecords,
        ledgerAttempts,
        skipped,
      });

    /* -- Phase 51 — idempotency before governance, before any dispatch. -- */
    let settleGate: ((value: AiResult<unknown>) => Promise<void>) | null = null;
    if (governance.idempotency.enabled) {
      const gate = await this.#services.idempotency.gate(
        {
          callerPluginId: plan.callerPluginId,
          capability: plan.capability,
          capabilityVersion: plan.capabilityVersion,
          idempotencyKey: plan.idempotencyKey,
        },
        plan.fingerprint,
        logicalRequestId,
        planPromptProvenance,
      );
      if (gate.kind === 'CONFLICT') {
        const { terminal, result } = failedStream(
          makeAiError({ reason: 'IDEMPOTENCY_CONFLICT', message: 'This idempotency key was already used for a different request body.' }),
          {},
          'UNKNOWN',
          [...plan.warnings],
        );
        yield await settleStream({
          terminal,
          result,
          idempotencyOutcome: 'EXECUTED',
          settleGate: null,
          promptProvenance: planPromptProvenance,
          dispatched: 0,
          reservations: [],
          usage: {},
          usageComplete: false,
          cost: { basis: 'UNKNOWN' },
        });
        return;
      }
      if (gate.kind === 'REPLAY') {
        yield* deliverStored(gate.result, 'REPLAYED', gate.promptProvenance);
        return;
      }
      if (gate.kind === 'JOIN') {
        // A joiner must not hang past its own deadline or ignore its own cancellation: race
        // the leader's promise the same way an attempt is raced.
        const remainingMs = Math.max(0, plan.deadlineAtMs - this.#services.clock.nowMs());
        const joined = await raceAttempt(gate.result, remainingMs, options.cancellation);
        if (joined.kind === 'completed') {
          yield* deliverStored(joined.value, 'JOINED', gate.promptProvenance);
          return;
        }
        const error =
          joined.kind === 'cancelled'
            ? cancelledByCallerError()
            : joined.kind === 'deadline'
              ? this.#services.clock.nowMs() >= plan.deadlineAtMs
                ? budgetExhaustedError(0)
                : providerTimeoutError()
              : makeAiError({ reason: 'INTERNAL_ERROR', message: 'The in-flight call this duplicate joined did not complete.' });
        const { terminal, result } = failedStream(error, {}, 'UNKNOWN', [...plan.warnings]);
        yield await settleStream({
          terminal,
          result,
          idempotencyOutcome: 'JOINED',
          settleGate: null,
          promptProvenance: gate.promptProvenance,
          dispatched: 0,
          reservations: [],
          usage: {},
          usageComplete: false,
          cost: { basis: 'UNKNOWN' },
        });
        return;
      }
      settleGate = gate.settle;
    }

    /* -- Governance — budget pre-check, quota reservation, rate limit. All before dispatch. -- */
    const quotaRequest: QuotaRequest = {
      callerPluginId: plan.callerPluginId,
      capability: plan.capability,
      ...(subjectRef === undefined ? {} : { subjectRef }),
      ...(primary === undefined ? {} : { providerId: primary.providerId }),
    };
    const requestQuotaPolicies = governance.quotas.filter((policy) => policy.scope !== 'provider');
    const providerQuotaPolicies = governance.quotas.filter((policy) => policy.scope === 'provider');
    const budgetPolicies = this.#budgetQuotaPolicies(governance.budget);
    const estimateTokens = this.#tokenReservation(requestQuotaPolicies, plan);
    const primaryPricing = this.#pinPricing(plan, primary ?? null, startedAtMs);
    const estimatedCost = this.#conservativeCost(primaryPricing, estimateTokens);
    const estimate = {
      tokens: estimateTokens,
      ...(estimatedCost.amount === undefined ? {} : { cost: estimatedCost.amount }),
    };
    const reservations: QuotaReservation[] = [];

    // A refusal below settles with zero dispatches, which releases (never charges) the
    // reservations held so far: nothing was paid, so nothing is counted.
    const refuse = async (error: AiError): Promise<AiStreamFailed> => {
      const { terminal, result } = failedStream(error, {}, 'UNKNOWN', [...plan.warnings]);
      await settleStream({
        terminal,
        result,
        idempotencyOutcome: 'EXECUTED',
        settleGate,
        promptProvenance: planPromptProvenance,
        dispatched: 0,
        reservations,
        usage: {},
        usageComplete: false,
        cost: { basis: 'UNKNOWN' },
      });
      return terminal;
    };

    const budgetDecision = await this.#services.budget.check(quotaRequest, estimatedCost, governance.budget);
    if (!budgetDecision.ok) {
      this.#services.events.emit({
        type: 'ai.quota_rejected',
        atMs: this.#services.clock.nowMs(),
        payload: { dimension: 'ESTIMATED_COST', scope: 'budget', reason: 'COST_BUDGET_EXHAUSTED' },
      });
      yield await refuse(budgetDecision.error);
      return;
    }

    const requestReservation = await this.#services.quotas.reserve(quotaRequest, estimate, requestQuotaPolicies);
    if (!requestReservation.ok) {
      this.#emitQuotaRejected(requestReservation.error, requestReservation.policy);
      yield await refuse(requestReservation.error);
      return;
    }
    reservations.push(requestReservation.reservation);

    const budgetReservation = await this.#services.quotas.reserve(quotaRequest, estimate, budgetPolicies);
    if (!budgetReservation.ok) {
      await this.#services.quotas.release(requestReservation.reservation);
      reservations.pop();
      this.#emitQuotaRejected(costBudgetExhaustedError(), { meter: 'ESTIMATED_COST', scope: 'global' });
      yield await refuse(costBudgetExhaustedError());
      return;
    }
    reservations.push(budgetReservation.reservation);

    const rate = await this.#services.rateLimiter.consume(quotaRequest, governance.rateLimits);
    if (!rate.allowed) {
      await this.#services.quotas.release(requestReservation.reservation);
      await this.#services.quotas.release(budgetReservation.reservation);
      reservations.length = 0;
      this.#services.events.emit({
        type: 'ai.rate_limited',
        atMs: this.#services.clock.nowMs(),
        payload: { dimension: rate.dimension, reason: rate.error.reason ?? 'RATE_LIMIT_SUBJECT', retryAfterMs: rate.retryAfterMs },
      });
      this.#services.metrics.record({ name: 'ai.rate_limited.count', value: 1, labels: { capability: plan.capability, dimension: 'REQUESTS' } });
      yield await refuse(rate.error);
      return;
    }

    /* -- Single-target selection: kill switch, then breaker. No retry, no fallback. -- */
    const target = this.#pickCandidate(plan, [...plan.candidates], skipped);
    if (target === null) {
      yield await refuse(this.#chainExhaustedError(plan, skipped, null));
      return;
    }

    const providerDeadlineAtMs = providerDeadlineAt(plan.deadlineAtMs, this.#services.clock.nowMs(), plan.budget.providerMs);
    if (providerDeadlineAtMs === null) {
      skipped.push({ target, skip: this.#skipOf(target, 'DEADLINE_EXHAUSTED') });
      yield await refuse(budgetExhaustedError(Math.max(0, plan.deadlineAtMs - this.#services.clock.nowMs())));
      return;
    }

    const streamText = target.route.adapter.streamText;
    if (streamText === undefined) {
      skipped.push({ target, skip: this.#skipOf(target, 'CAPABILITY_UNMET') });
      yield await refuse(
        makeAiError({ reason: 'NO_ROUTE', message: 'The resolved route cannot deliver a stream.', details: { profile: plan.profile } }),
      );
      return;
    }

    const targetQuotaPolicies = providerQuotaPolicies.filter((policy) => policy.scopeKey === undefined || policy.scopeKey === target.providerId);
    const providerReservation = await this.#services.quotas.reserve(
      { ...quotaRequest, providerId: target.providerId },
      estimate,
      targetQuotaPolicies,
    );
    if (!providerReservation.ok) {
      skipped.push({ target, skip: this.#skipOf(target, 'QUOTA_INELIGIBLE') });
      yield await refuse(this.#chainExhaustedError(plan, skipped, providerReservation.error));
      return;
    }

    if (options.cancellation?.cancelled === true) {
      await this.#services.quotas.release(providerReservation.reservation);
      yield await refuse(cancelledByCallerError());
      return;
    }

    /* -- The single attempt, raced per step against its deadline and cancellation. -- */
    const sequence = 1;
    const attemptId = this.#services.ids.next('att');
    const attemptStartedAtMs = this.#services.clock.nowMs();
    const breaker = this.#services.breakers.for(target.providerId, target.modelAlias);
    const pricing = this.#pinPricing(plan, target, startedAtMs);
    this.#services.events.emit({
      type: 'ai.provider_attempt_started',
      atMs: attemptStartedAtMs,
      payload: { requestId: plan.requestId, attemptId, sequence, providerId: target.providerId, modelAlias: target.modelAlias, attemptKind: 'PRIMARY' },
    });
    this.#log.write({
      level: 'info',
      event: 'provider.dispatched',
      atMs: attemptStartedAtMs,
      requestId: plan.requestId,
      capability: plan.capability,
      providerId: target.providerId,
    });

    const providerRequest = buildProviderRequest(plan, target, providerDeadlineAtMs, options.cancellation, undefined);
    let iterator: AsyncIterator<ProviderStreamEvent>;
    try {
      iterator = streamText.call(target.route.adapter, providerRequest)[Symbol.asyncIterator]();
    } catch (error: unknown) {
      await this.#services.quotas.release(providerReservation.reservation);
      const normalized = normalizeThrown(error);
      breaker.recordFailure(normalized);
      this.#services.health.recordFailure(target.providerId, target.modelAlias, normalized);
      const { terminal, result } = failedStream(normalized, {}, 'UNKNOWN', [...plan.warnings]);
      yield await settleStream({
        terminal,
        result,
        idempotencyOutcome: 'EXECUTED',
        settleGate,
        promptProvenance: planPromptProvenance,
        dispatched: 0,
        reservations,
        usage: {},
        usageComplete: false,
        cost: { basis: 'UNKNOWN' },
      });
      return;
    }

    let accumulated = '';
    let accumulatedBytes = 0;
    let usage: AiUsage = {};
    let finishReason: AiFinishReason = 'UNKNOWN';
    let finished = false;
    let streamError: AiError | null = null;
    // True once the provider demonstrably did billable work: usage arrived, or output text was
    // accepted. A cancel/timeout before either is settled as zero-dispatch (release, not charge).
    let providerWorkObserved = false;

    try {
      for (;;) {
        const timeoutMs = Math.max(0, providerDeadlineAtMs - this.#services.clock.nowMs());
        const step = await raceAttempt(iterator.next(), timeoutMs, options.cancellation);
        if (step.kind === 'cancelled') {
          streamError = cancelledByCallerError();
          break;
        }
        if (step.kind === 'deadline') {
          streamError = this.#services.clock.nowMs() >= plan.deadlineAtMs ? budgetExhaustedError(0) : providerTimeoutError();
          break;
        }
        if (step.kind === 'threw') {
          streamError = normalizeThrown(step.error);
          break;
        }
        if (step.value.done === true) {
          break;
        }
        const event = step.value.value;
        if (event.kind === 'TEXT_DELTA') {
          if (event.text.length === 0) {
            continue;
          }
          // Incremental output cap: a malicious provider must not be able to grow the
          // accumulation without bound before the cap fires. A single over-cap delta fails
          // without being yielded; deltas already delivered stay honest (a FAILED terminal
          // follows them, exactly as a mid-stream provider error behaves).
          const deltaBytes = utf8ByteLength(event.text);
          if (deltaBytes > plan.maxOutputBytes || accumulatedBytes + deltaBytes > plan.maxOutputBytes) {
            streamError = validationFailureToAiError(
              {
                reason: 'OUTPUT_TOO_LARGE',
                code: 'SCHEMA_MISMATCH',
                stage: 'EXTRACTION',
                issues: [{ code: 'SIZE_EXCEEDED', path: '$', message: 'streamed output exceeded the cap' }],
              },
              'The streamed answer exceeds the declared output size cap.',
            );
            break;
          }
          accumulated += event.text;
          accumulatedBytes += deltaBytes;
          providerWorkObserved = true;
          yield makeStreamTextDelta(event.text);
          continue;
        }
        if (event.kind === 'FINISH') {
          usage = event.usage;
          finishReason = event.finishReason;
          finished = true;
          if (!usageIsUnknown(usage)) {
            providerWorkObserved = true;
          }
          break;
        }
        this.#logRawError(plan, event.error.rawMessage);
        streamError = normalizeProviderError(event.error);
        break;
      }
    } finally {
      void Promise.resolve(iterator.return?.()).catch(() => undefined);
    }

    const attemptFinishedAtMs = this.#services.clock.nowMs();
    if (streamError === null && !finished) {
      streamError = normalizeProviderError({
        category: 'UPSTREAM',
        reason: 'PROVIDER_BAD_RESPONSE',
        dispatched: true,
        rawMessage: 'provider stream ended without a finish event',
      });
    }

    const usageKnown = !usageIsUnknown(usage);
    const cost = estimateCost(usage, pricing, usage.estimatedCost);
    const overCap = streamError?.reason === 'OUTPUT_TOO_LARGE';
    const status: AttemptStatus =
      streamError === null ? 'SUCCEEDED' : streamError.code === 'CANCELLED' ? 'CANCELLED' : 'FAILED';
    if (streamError === null || overCap === true) {
      // The provider call worked; an over-cap answer is rejected output, not provider failure.
      breaker.recordSuccess();
      this.#services.health.recordSuccess(target.providerId, target.modelAlias);
    } else {
      breaker.recordFailure(streamError);
      this.#services.health.recordFailure(target.providerId, target.modelAlias, streamError);
      if (breaker.snapshot().state === 'OPEN') {
        this.#services.events.emit({
          type: 'ai.breaker_opened',
          atMs: this.#services.clock.nowMs(),
          payload: { providerId: target.providerId, modelAlias: target.modelAlias },
        });
        this.#services.metrics.record({ name: 'ai.breaker_open.count', value: 1, labels: { providerId: target.providerId, modelAlias: target.modelAlias } });
      }
    }

    // This attempt's own quota settles immediately — including failed attempts, because every
    // provider that was paid is counted. A terminal reached with no observed provider work
    // releases instead of charging the conservative estimate.
    const dispatched = providerWorkObserved ? 1 : 0;
    if (dispatched === 0) {
      await this.#services.quotas.release(providerReservation.reservation);
    } else {
      await this.#services.quotas.settle(providerReservation.reservation, {
        usageKnown,
        ...(this.#reportedTokens(usage) === undefined ? {} : { tokens: this.#reportedTokens(usage) as number }),
        ...(cost.amount === undefined ? {} : { cost: cost.amount }),
      });
    }

    this.#recordAttempt(ledgerAttempts, attemptRecords, {
      plan,
      logicalRequestId,
      attemptId,
      sequence,
      attemptKind: 'PRIMARY',
      target,
      startedAtMs: attemptStartedAtMs,
      finishedAtMs: attemptFinishedAtMs,
      status,
      ...(streamError === undefined || streamError === null ? {} : { errorCode: streamError.code, errorReason: streamError.reason }),
      usage,
      usageKnown,
      cost,
      pricing,
    });
    this.#services.metrics.record({
      name: 'ai.attempt.count',
      value: 1,
      labels: { capability: plan.capability, providerId: target.providerId, modelAlias: target.modelAlias, attemptKind: 'PRIMARY' },
    });
    this.#services.events.emit({
      type: 'ai.provider_attempt_finished',
      atMs: attemptFinishedAtMs,
      payload: {
        requestId: plan.requestId,
        attemptId,
        sequence,
        providerId: target.providerId,
        status,
        ...(streamError === null ? {} : { errorCode: streamError.code }),
        ...(streamError === null || streamError.reason === undefined ? {} : { reason: streamError.reason }),
      },
    });

    const streamWarnings = [...plan.warnings];
    if (cost.partial === true || (!usageKnown && Object.keys(usage).length > 0)) {
      streamWarnings.push(makeWarning('USAGE_ESTIMATED', 'usage or cost for this turn is partial; totals are conservative'));
    }
    if (streamError !== null) {
      const { terminal, result } = failedStream(streamError, usage, finishReason, streamWarnings);
      yield await settleStream({
        terminal,
        result,
        idempotencyOutcome: 'EXECUTED',
        settleGate,
        promptProvenance: planPromptProvenance,
        dispatched,
        reservations,
        usage,
        usageComplete: usageKnown,
        cost,
      });
      return;
    }
    const terminal = makeStreamCompleted({
      text: accumulated,
      usage,
      finishReason,
      providerMetadata: this.#projection(target, 1, false),
      latencyMs: latencyMs(),
      warnings: streamWarnings,
    });
    const result = makeSuccessResult({
      contractVersion: plan.contractVersion,
      requestId: plan.requestId,
      capability: plan.capability,
      capabilityVersion: plan.capabilityVersion,
      output: accumulated,
      usage,
      providerMetadata: this.#projection(target, 1, false),
      latencyMs: latencyMs(),
      finishReason,
      warnings: streamWarnings,
    });
    yield await settleStream({
      terminal,
      result,
      idempotencyOutcome: 'EXECUTED',
      settleGate,
      promptProvenance: planPromptProvenance,
      dispatched,
      reservations,
      usage,
      usageComplete: usageKnown,
      cost,
    });
  }

  /**
   * Replay a stored idempotent result as stream events. A succeeded text result replays its text
   * as deltas; a stored failure (or a non-text stored output, which a text stream can never have
   * produced) replays as the stored failure. No provider is called and nothing is charged.
   */
  async *#deliverStoredStream(input: {
    readonly plan: ExecutionPlan;
    readonly logicalRequestId: string;
    readonly startedAtMs: number;
    readonly primary: AttemptTarget | null;
    readonly stored: AiResult<unknown>;
    readonly idempotencyOutcome: 'REPLAYED' | 'JOINED';
    readonly promptProvenance: PromptProvenance | undefined;
    readonly attemptRecords: ProviderAttemptProvenance[];
    readonly ledgerAttempts: ProviderAttemptUsageRecord[];
    readonly skipped: readonly SkipEntry[];
  }): AsyncGenerator<AiStreamEvent> {
    const { plan, stored } = input;
    const latencyMs = Math.max(0, this.#services.clock.nowMs() - input.startedAtMs);
    const replayWarning = makeWarning('IDEMPOTENT_REPLAY', 'a stored result was returned; no provider was called');
    const warnings = [...plan.warnings, replayWarning];
    const settle = async (
      terminal: AiStreamCompleted | AiStreamFailed,
      result: AiResult<unknown>,
      usage: AiUsage,
    ): Promise<AiStreamCompleted | AiStreamFailed> => {
      await this.#settleStream({
        plan,
        logicalRequestId: input.logicalRequestId,
        startedAtMs: input.startedAtMs,
        terminal,
        result,
        idempotencyOutcome: input.idempotencyOutcome,
        settleGate: null,
        promptProvenance: input.promptProvenance,
        attemptRecords: input.attemptRecords,
        ledgerAttempts: input.ledgerAttempts,
        skipped: input.skipped,
        dispatched: 0,
        reservations: [],
        usage,
        usageComplete: !usageIsUnknown(usage),
        cost: { basis: 'UNKNOWN' },
      });
      return terminal;
    };
    if (stored.status === 'SUCCEEDED' && typeof stored.output === 'string') {
      const text = stored.output;
      if (text.length > 0) {
        yield makeStreamTextDelta(text);
      }
      yield await settle(
        makeStreamCompleted({
          text,
          usage: stored.usage,
          finishReason: stored.finishReason,
          providerMetadata: stored.providerMetadata,
          latencyMs,
          warnings,
        }),
        this.#withWarnings(stored, [replayWarning]),
        stored.usage,
      );
      return;
    }
    const error =
      stored.status === 'FAILED' && stored.error !== undefined
        ? stored.error
        : makeAiError({ reason: 'INTERNAL_ERROR', message: 'The stored result for this idempotency key is not streamable text.' });
    const usage = stored.status === 'FAILED' ? stored.usage : {};
    yield await settle(
      makeStreamFailed({
        error,
        usage,
        finishReason: stored.finishReason,
        providerMetadata: stored.providerMetadata,
        latencyMs,
        warnings,
      }),
      stored.status === 'FAILED'
        ? this.#withWarnings(stored, [replayWarning])
        : makeFailureResult({
            contractVersion: plan.contractVersion,
            requestId: plan.requestId,
            capability: plan.capability,
            capabilityVersion: plan.capabilityVersion,
            error,
            usage,
            providerMetadata: this.#projection(input.primary, 0, false),
            latencyMs,
            finishReason: stored.finishReason,
            warnings,
          }),
      usage,
    );
  }

  /**
   * Settle one streamed logical request: one request ledger record plus the attempt records,
   * request events/metrics and the idempotency settlement. Request-scope quota reservations are
   * settled with the observed totals — or released when nothing was dispatched, so a refusal or
   * a pre-work cancel never charges the conservative estimate.
   */
  async #settleStream(input: {
    readonly plan: ExecutionPlan;
    readonly logicalRequestId: string;
    readonly startedAtMs: number;
    readonly terminal: AiStreamCompleted | AiStreamFailed;
    readonly result: AiResult<unknown>;
    readonly idempotencyOutcome: 'EXECUTED' | 'REPLAYED' | 'JOINED';
    readonly settleGate: ((value: AiResult<unknown>) => Promise<void>) | null;
    readonly promptProvenance: PromptProvenance | undefined;
    readonly attemptRecords: readonly ProviderAttemptProvenance[];
    readonly ledgerAttempts: readonly ProviderAttemptUsageRecord[];
    readonly skipped: readonly SkipEntry[];
    readonly dispatched: number;
    readonly reservations: readonly QuotaReservation[];
    readonly usage: AiUsage;
    readonly usageComplete: boolean;
    readonly cost: CostEstimate;
  }): Promise<void> {
    const { plan, logicalRequestId, startedAtMs, result } = input;
    const finishedAtMs = this.#services.clock.nowMs();
    const allSkips: SkipEntry[] = [...plan.preSkipped.map((skip) => ({ target: null, skip })), ...input.skipped];
    const skipRecords = allSkips.map(({ target, skip }, index) =>
      this.#skipRecord(logicalRequestId, input.attemptRecords.length + index + 1, target, skip),
    );
    const provenance: ReliabilityProvenance = {
      logicalRequestId,
      requestId: plan.requestId,
      callerPluginId: plan.callerPluginId,
      capability: plan.capability,
      capabilityVersion: plan.capabilityVersion,
      profile: plan.profile,
      configVersion: plan.snapshot.configVersion,
      configDigest: plan.snapshot.contentDigest,
      startedAtMs,
      ...(input.promptProvenance ?? {}),
      finishedAtMs,
      status: result.status,
      ...(result.error?.code === undefined ? {} : { errorCode: result.error.code }),
      ...(result.error?.reason === undefined ? {} : { errorReason: result.error.reason }),
      attempts: [...input.attemptRecords, ...skipRecords],
      fallbackCount: 0,
      retryCount: 0,
      repairCount: 0,
      skippedCount: allSkips.length,
      idempotencyOutcome: input.idempotencyOutcome,
    };
    const summary = summarize(provenance);
    await this.#services.ledger.appendRequest(this.#requestRecord(plan, provenance, summary, input.idempotencyOutcome, startedAtMs, finishedAtMs, result));
    for (const record of input.ledgerAttempts) {
      await this.#services.ledger.appendAttempt(record);
    }
    this.#services.events.emit({
      type: 'ai.request_finished',
      atMs: finishedAtMs,
      payload: {
        requestId: plan.requestId,
        capability: plan.capability,
        status: result.status,
        attemptCount: input.dispatched,
        fallbackCount: 0,
        retryCount: 0,
        ...(result.error?.code === undefined ? {} : { errorCode: result.error.code }),
        ...(result.error?.reason === undefined ? {} : { reason: result.error.reason }),
      },
    });
    this.#services.metrics.record({
      name: result.status === 'SUCCEEDED' ? 'ai.request.success.count' : 'ai.failure.count',
      value: 1,
      labels: {
        capability: plan.capability,
        status: result.status,
        ...(result.error?.code === undefined ? {} : { errorCode: result.error.code }),
        ...(result.error?.reason === undefined ? {} : { reason: result.error.reason }),
      },
    });
    this.#services.metrics.record({
      name: 'ai.latency.ms',
      value: Math.max(0, finishedAtMs - startedAtMs),
      labels: { capability: plan.capability },
    });
    if (summary.totalUsage.totalTokens !== undefined) {
      this.#services.metrics.record({ name: 'ai.tokens.total', value: summary.totalUsage.totalTokens, labels: { capability: plan.capability } });
    }
    if (summary.totalCost.amount !== undefined) {
      this.#services.metrics.record({ name: 'ai.cost.estimated', value: summary.totalCost.amount, labels: { capability: plan.capability } });
    }
    if (input.dispatched === 0) {
      for (const reservation of input.reservations) {
        await this.#services.quotas.release(reservation);
      }
    } else {
      for (const reservation of input.reservations) {
        await this.#services.quotas.settle(reservation, {
          usageKnown: input.usageComplete,
          ...(input.usage.totalTokens === undefined ? {} : { tokens: input.usage.totalTokens }),
          ...(input.cost.amount === undefined ? {} : { cost: input.cost.amount }),
        });
      }
    }
    if (input.settleGate !== null) {
      await input.settleGate(result);
    }
  }

  /* -----------------------------------------------------------------------------------------------
   * Governance helpers
   * -------------------------------------------------------------------------------------------- */

  #emitQuotaRejected(error: AiError, policy: { readonly meter: string; readonly scope: string }): void {
    this.#services.events.emit({
      type: 'ai.quota_rejected',
      atMs: this.#services.clock.nowMs(),
      payload: { dimension: policy.meter, scope: policy.scope, reason: error.reason ?? 'QUOTA_GLOBAL' },
    });
    this.#services.metrics.record({ name: 'ai.quota_rejected.count', value: 1, labels: { dimension: policy.meter } });
  }

  #tokenReservation(policies: readonly QuotaPolicy[], plan: ExecutionPlan): number {
    const fromPolicy = policies.find((policy) => policy.meter === 'TOKENS')?.reservationTokens;
    return fromPolicy ?? plan.requestedMaxOutputTokens ?? 4_096;
  }

  /**
   * Reported token count for `TOKENS` quota settlement: `totalTokens` when the provider
   * reports it, else `inputTokens + outputTokens` when both are known (GOVERNANCE.md §5).
   * Anything less precise stays unknown and settles conservatively — never zero.
   */
  #reportedTokens(usage: AiUsage): number | undefined {
    if (usage.totalTokens !== undefined) {
      return usage.totalTokens;
    }
    if (usage.inputTokens !== undefined && usage.outputTokens !== undefined) {
      return usage.inputTokens + usage.outputTokens;
    }
    return undefined;
  }

  #pinPricing(plan: ExecutionPlan, target: AttemptTarget | null, atMs: number): PricingSnapshot | null {
    if (target === null) {
      return null;
    }
    // The price is pinned when the call starts and never re-read (Phase 32): validity is
    // evaluated against request-start time, never the snapshot's creation time, so a
    // long-lived snapshot cannot serve a price past `validUntilMs`.
    return plan.snapshot.governance.pricing.snapshotFor(
      target.providerId,
      { modelAlias: target.modelAlias, modelRef: target.providerModelId },
      atMs,
    );
  }

  /** A conservative upper-bound-ish estimate, used only for pre-dispatch budget checks. */
  #conservativeCost(pricing: PricingSnapshot | null, tokenEstimate: number): CostEstimate {
    if (pricing === null) {
      return { basis: 'UNKNOWN' };
    }
    const prices = [pricing.inputTokenPrice, pricing.outputTokenPrice, pricing.cachedInputPrice, pricing.reasoningTokenPrice].filter(
      (value): value is number => value !== undefined,
    );
    if (prices.length === 0) {
      return { basis: 'UNKNOWN', pricingId: pricing.pricingId, pricingVersion: pricing.version };
    }
    const divisor = pricing.unit === 'PER_1K_TOKENS' ? 1_000 : 1_000_000;
    return {
      amount: (Math.max(...prices) * tokenEstimate) / divisor,
      currency: pricing.currency,
      basis: 'ESTIMATED_FROM_PRICING',
      pricingId: pricing.pricingId,
      pricingVersion: pricing.version,
      partial: true,
    };
  }

  #budgetQuotaPolicies(policy: {
    readonly maxEstimatedCostPerDay?: number;
    readonly maxEstimatedCostPerMonth?: number;
    readonly maxEstimatedCostPerRequest?: number;
  }): QuotaPolicy[] {
    const policies: QuotaPolicy[] = [];
    const reservationCost = policy.maxEstimatedCostPerRequest ?? 0;
    if (policy.maxEstimatedCostPerDay !== undefined) {
      policies.push({ scope: 'global', meter: 'ESTIMATED_COST', period: 'DAY', limit: policy.maxEstimatedCostPerDay, reservationCost });
    }
    if (policy.maxEstimatedCostPerMonth !== undefined) {
      policies.push({ scope: 'global', meter: 'ESTIMATED_COST', period: 'MONTH', limit: policy.maxEstimatedCostPerMonth, reservationCost });
    }
    return policies;
  }

  /* -----------------------------------------------------------------------------------------------
   * Candidate selection (Phase 52)
   * -------------------------------------------------------------------------------------------- */

  #pickCandidate(plan: ExecutionPlan, queue: AttemptTarget[], skipped: SkipEntry[]): AttemptTarget | null {
    for (;;) {
      const next = queue.shift();
      if (next === undefined) {
        return null;
      }
      // 1. Kill switch outranks everything (Phase 49): a DISABLED target is never dispatched.
      const killVerdict = this.#killSwitchVerdict(plan, next);
      if (!killVerdict.allowed) {
        skipped.push({
          target: next,
          skip: this.#skipOf(next, 'KILL_SWITCH'),
          killSwitchBlocked: killVerdict,
        });
        continue;
      }
      // 2. An OPEN breaker never dispatches (Phase 11/52).
      const verdict = this.#services.breakers.for(next.providerId, next.modelAlias).dispatchVerdict();
      if (!verdict.allowed) {
        skipped.push({ target: next, skip: this.#skipOf(next, 'BREAKER_OPEN') });
        continue;
      }
      // 3. Capability fit was enforced at candidate enumeration (Phase 5 — no silent degrade).
      // 4. Remaining budget is checked just before dispatch (the caller does it next).
      // 5. Provider-scoped quota eligibility is enforced at reservation time.
      return next;
    }
  }

  #skipOf(target: AttemptTarget, skipReason: AttemptSkipReason): SkippedCandidate {
    return {
      providerId: target.providerId,
      modelRef: target.providerModelId,
      ...(target.route.modelAlias === undefined ? {} : { modelAlias: target.route.modelAlias }),
      skipReason,
    };
  }

  #killSwitchVerdict(plan: ExecutionPlan, target: AttemptTarget): KillSwitchVerdict {
    const live = this.#services.killSwitchState();
    const configured = plan.snapshot.killSwitch;
    const merged: KillSwitchState = {
      global: live.global || configured.global,
      providers: [...new Set([...live.providers, ...configured.providers])].sort(),
      capabilities: [...new Set([...live.capabilities, ...configured.capabilities])].sort(),
    };
    return resolveKillSwitch(merged, {
      capability: plan.capability,
      capabilityVersion: plan.capabilityVersion,
      candidateProviders: [target.providerId],
    });
  }

  #chainExhaustedError(plan: ExecutionPlan, skipped: readonly SkipEntry[], quotaRefusal: AiError | null): AiError {
    if (quotaRefusal !== null) {
      return quotaRefusal;
    }
    const killSwitchSkip = skipped.find((entry) => entry.skip.skipReason === 'KILL_SWITCH');
    if (killSwitchSkip !== undefined) {
      // The verdict's own reason is authoritative: a global kill is `KILL_SWITCH_GLOBAL`, a
      // capability kill is `KILL_SWITCH_CAPABILITY` — never collapsed into the provider flavour.
      if (killSwitchSkip.killSwitchBlocked !== undefined) {
        return killSwitchError(killSwitchSkip.killSwitchBlocked);
      }
      return makeAiError({
        reason: 'KILL_SWITCH_PROVIDER',
        message: 'Every provider that could serve this capability is switched off.',
        details: { providerId: killSwitchSkip.skip.providerId },
      });
    }
    return makeAiError({
      reason: 'ROUTE_EXHAUSTED',
      message: 'Every configured route is currently unavailable for this request.',
      details: { profile: plan.profile },
    });
  }

  /* -----------------------------------------------------------------------------------------------
   * Attempts, repair and shaping
   * -------------------------------------------------------------------------------------------- */

  #interpretFailure(raw: RawAttemptOutcome, plan: ExecutionPlan): AttemptFailure | null {
    switch (raw.kind) {
      case 'completed':
        if (raw.value.rawError !== undefined) {
          this.#logRawError(plan, raw.value.rawError.rawMessage);
          const error = normalizeProviderError(raw.value.rawError);
          return {
            error,
            usage: raw.value.usage,
            dispatched: raw.value.rawError.dispatched,
            // Only a missing dispatch marker is an unknown outcome. `dispatched: false` is
            // provably pre-dispatch (nothing left this process), so a repeat is free of
            // double-billing risk and must not be gated behind the unknown-outcome policy.
            unknownOutcome: raw.value.rawError.dispatched === undefined,
            finishReason: raw.value.finishReason,
          };
        }
        return null;
      case 'timeout': {
        const error = this.#services.clock.nowMs() >= plan.deadlineAtMs ? budgetExhaustedError(0) : providerTimeoutError();
        return { error, usage: {}, dispatched: undefined, unknownOutcome: true, finishReason: 'UNKNOWN' };
      }
      case 'cancelled':
        return { error: cancelledByCallerError(), usage: {}, dispatched: undefined, unknownOutcome: false, finishReason: 'UNKNOWN' };
      case 'threw': {
        const rawError = providerRawErrorOf(raw.error);
        return {
          error: normalizeThrown(raw.error),
          usage: {},
          dispatched: rawError?.dispatched,
          unknownOutcome: rawError?.dispatched === undefined,
          finishReason: 'UNKNOWN',
        };
      }
      default: {
        const exhaustive: never = raw;
        void exhaustive;
        return null;
      }
    }
  }

  #logRawError(plan: ExecutionPlan, rawMessage: string | undefined): void {
    this.#log.write({
      level: 'error',
      event: 'provider.raw_error',
      atMs: this.#services.clock.nowMs(),
      requestId: plan.requestId,
      capability: plan.capability,
      ...(rawMessage === undefined
        ? {}
        : { detail: redactOperatorDetail(rawMessage, this.#services.boundSecrets?.() ?? []) }),
    });
  }

  #shapeOutput(plan: ExecutionPlan, value: ProviderTextResult | ProviderStructuredResult): ShapedOutput {
    if (plan.requiredPrimitive !== 'ai.structured.generate') {
      return textOutputOutcome(value.text, plan.maxOutputBytes);
    }

    const shaped = structuredOutputOutcome(value.text, plan.outputSchema, plan.maxOutputBytes);
    if (!shaped.ok || plan.capability !== 'code.debug.analyze') {
      return shaped;
    }

    const validated = validateCodeDebugOutput(shaped.value, {
      instructions: plan.instructions,
      context: plan.context,
    });
    if (validated.ok) {
      return { ok: true, value: validated.value };
    }
    return {
      ok: false,
      error: validationFailureToAiError(validated.failure, 'The generated answer did not conform to this capability.'),
      issues: validated.failure.issues,
      rawText: value.text,
      repairable: validated.failure.reason === 'SCHEMA_VALIDATION_FAILED',
    };
  }

  /**
   * One bounded repair attempt (Phase 36–38): same provider and model, a child of the attempt it
   * repairs, fully accounted in usage and cost. Never runs for content, permission, config or
   * cancellation failures — only for "the model answered but the payload did not conform".
   */
  async #attemptRepair(
    plan: ExecutionPlan,
    target: AttemptTarget,
    failed: { readonly error: AiError; readonly issues: readonly ValidationIssue[]; readonly rawText: string },
    context: {
      readonly logicalRequestId: string;
      readonly parentAttemptId: string;
      readonly parentSequence: number;
      readonly cancellation?: CancellationToken;
      readonly pricing: PricingSnapshot | null;
      readonly quotaRequest: QuotaRequest;
      readonly providerQuotaPolicies: readonly QuotaPolicy[];
      readonly estimate: { readonly tokens: number; readonly cost?: number };
      readonly ledgerAttempts: ProviderAttemptUsageRecord[];
      readonly attemptRecords: ProviderAttemptProvenance[];
      readonly attemptUsage: { readonly usage: AiUsage; readonly known: boolean }[];
      readonly attemptCosts: (CostEstimate | undefined)[];
      readonly counts: { dispatched: number };
    },
  ): Promise<
    | { readonly kind: 'succeeded'; readonly output: Extract<ShapedOutput, { readonly ok: true }>; readonly usage: AiUsage; readonly sequence: number; readonly finishReason: AiFinishReason }
    | { readonly kind: 'failed'; readonly error: AiError; readonly sequence: number }
    | { readonly kind: 'skipped'; readonly error: AiError; readonly sequence: number }
  > {
    // Phase 38: no budget (or no quota reservation) ⇒ no repair. The **original** failure stands:
    // repair exhaustion is only reported when a repair actually ran and failed (frozen §5.3).
    const providerDeadlineAtMs = providerDeadlineAt(plan.deadlineAtMs, this.#services.clock.nowMs(), plan.budget.providerMs);
    if (providerDeadlineAtMs === null) {
      return { kind: 'skipped', error: failed.error, sequence: context.parentSequence };
    }
    const sequence = context.parentSequence + 1;
    const attemptId = this.#services.ids.next('att');
    const startedAtMs = this.#services.clock.nowMs();

    const targetQuotaPolicies = context.providerQuotaPolicies.filter((policy) => policy.scopeKey === undefined || policy.scopeKey === target.providerId);
    const reservation = await this.#services.quotas.reserve(
      { ...context.quotaRequest, providerId: target.providerId },
      context.estimate,
      targetQuotaPolicies,
    );
    if (!reservation.ok) {
      return { kind: 'skipped', error: failed.error, sequence: context.parentSequence };
    }

    this.#services.events.emit({
      type: 'ai.provider_attempt_started',
      atMs: startedAtMs,
      payload: { requestId: plan.requestId, attemptId, sequence, providerId: target.providerId, modelAlias: target.modelAlias, attemptKind: 'REPAIR' },
    });

    const raw = await this.#dispatch(plan, target, providerDeadlineAtMs, context.cancellation, {
      issues: failed.issues,
      rawText: failed.rawText,
    });
    const finishedAtMs = this.#services.clock.nowMs();
    context.counts.dispatched += 1;
    const usage = raw.kind === 'completed' ? raw.value.usage : {};
    const usageKnown = !usageIsUnknown(usage);
    const cost = estimateCost(usage, context.pricing, usage.estimatedCost);
    context.attemptUsage.push({ usage, known: usageKnown });
    context.attemptCosts.push(cost);
    await this.#services.quotas.settle(reservation.reservation, {
      usageKnown,
      ...(usage.totalTokens === undefined ? {} : { tokens: usage.totalTokens }),
      ...(cost.amount === undefined ? {} : { cost: cost.amount }),
    });

    const failure = this.#interpretFailure(raw, plan);
    let outcome: ShapedOutput | null = null;
    if (failure === null && raw.kind === 'completed') {
      outcome = this.#shapeOutput(plan, raw.value);
    }
    const status: AttemptStatus = outcome?.ok === true ? 'SUCCEEDED' : failure?.error.code === 'CANCELLED' ? 'CANCELLED' : 'FAILED';
    this.#recordAttempt(context.ledgerAttempts, context.attemptRecords, {
      plan,
      logicalRequestId: context.logicalRequestId,
      attemptId,
      sequence,
      attemptKind: 'REPAIR',
      parentAttemptId: context.parentAttemptId,
      target,
      startedAtMs,
      finishedAtMs,
      status,
      ...(failure === null || outcome?.ok === true ? {} : { errorCode: failure.error.code, errorReason: failure.error.reason }),
      usage,
      usageKnown,
      cost,
      pricing: context.pricing,
    });
    this.#services.metrics.record({
      name: 'ai.attempt.count',
      value: 1,
      labels: { capability: plan.capability, providerId: target.providerId, modelAlias: target.modelAlias, attemptKind: 'REPAIR' },
    });

    if (outcome?.ok === true) {
      return { kind: 'succeeded', output: outcome, usage, sequence, finishReason: raw.kind === 'completed' ? raw.value.finishReason : 'UNKNOWN' };
    }
    if (failure?.error.code === 'CANCELLED') {
      return { kind: 'failed', error: failure.error, sequence };
    }
    // Phase 37/§5.3: a repair that itself failed is repair exhaustion — the contract's stable answer.
    return { kind: 'failed', error: repairExhaustedError(failed.issues), sequence };
  }

  /* -----------------------------------------------------------------------------------------------
   * Records and projections
   * -------------------------------------------------------------------------------------------- */

  #projection(target: AttemptTarget | null, attemptCount: number, repaired: boolean) {
    if (target === null) {
      return { providerId: 'none', providerFamily: 'mock' as const, modelClass: 'UNKNOWN' as const, routeDepth: 0, attemptCount, repaired };
    }
    return {
      providerId: target.providerId,
      providerFamily: target.route.descriptor.family,
      modelClass: target.modelClass,
      routeDepth: target.routeDepth,
      attemptCount,
      repaired,
    };
  }

  #failureResult(
    plan: ExecutionPlan,
    error: AiError,
    startedAtMs: number,
    warnings: readonly AiWarning[],
    input: {
      readonly finalTarget: AttemptTarget | null;
      readonly attemptCount: number;
      readonly finalUsage: AiUsage;
      readonly finishReason?: AiFinishReason;
    },
  ): AiResult<never> {
    return makeFailureResult({
      contractVersion: plan.contractVersion,
      requestId: plan.requestId,
      capability: plan.capability,
      capabilityVersion: plan.capabilityVersion,
      error,
      usage: input.finalUsage,
      providerMetadata: this.#projection(input.finalTarget, input.attemptCount, false),
      latencyMs: Math.max(0, this.#services.clock.nowMs() - startedAtMs),
      finishReason: input.finishReason ?? 'UNKNOWN',
      warnings: [...plan.warnings, ...warnings],
    });
  }

  #withWarnings(result: AiResult<unknown>, extra: readonly AiWarning[]): AiResult<unknown> {
    return { ...result, warnings: [...result.warnings, ...extra] };
  }

  #reliabilityWarnings(
    counts: { readonly fallback: number; readonly retry: number; readonly repair: number; readonly dispatched: number },
    repaired: boolean,
    total: { readonly usage: AiUsage; readonly complete: boolean },
    totalCost: CostEstimate,
  ): readonly AiWarning[] {
    const warnings: AiWarning[] = [];
    if (counts.fallback > 0) {
      warnings.push(makeWarning('FALLBACK_USED', `a fallback served this result (attempts: ${counts.dispatched}, fallbacks: ${counts.fallback})`));
    }
    if (counts.retry > 0) {
      warnings.push(makeWarning('RETRY_USED', `a bounded same-provider retry ran (retries: ${counts.retry})`));
    }
    if (repaired) {
      warnings.push(makeWarning('OUTPUT_REPAIRED', 'one bounded repair attempt changed the payload'));
    }
    // `USAGE_ESTIMATED` flags numbers that are estimates. When nobody reported usage at all there
    // are no numbers to distrust — absent fields already say "unknown" (ARCHITECTURE.md §16.2).
    const hasUsageFacts = Object.keys(total.usage).length > 0;
    if (totalCost.partial === true || (!total.complete && hasUsageFacts)) {
      warnings.push(makeWarning('USAGE_ESTIMATED', 'usage or cost for this turn is partial; totals are conservative'));
    }
    return warnings;
  }

  #skipRecord(logicalRequestId: string, sequence: number, target: AttemptTarget | null, skip: SkippedCandidate): ProviderAttemptProvenance {
    return {
      attemptId: `skip-${sequence}`,
      logicalRequestId,
      sequence,
      attemptKind: 'PRIMARY',
      providerId: skip.providerId,
      modelAlias: skip.modelAlias ?? skip.modelRef,
      providerModelId: skip.modelRef,
      modelClass: target?.modelClass ?? 'UNKNOWN',
      routeDepth: target?.routeDepth ?? 0,
      routeConfigVersion: '',
      startedAtMs: 0,
      finishedAtMs: 0,
      status: 'SKIPPED',
      skipReason: skip.skipReason as AttemptSkipReason,
      usageKnown: false,
    };
  }

  #recordAttempt(
    ledgerAttempts: ProviderAttemptUsageRecord[],
    attemptRecords: ProviderAttemptProvenance[],
    input: {
      readonly plan: ExecutionPlan;
      readonly logicalRequestId: string;
      readonly attemptId: string;
      readonly sequence: number;
      readonly attemptKind: AttemptKind;
      readonly parentAttemptId?: string;
      readonly target: AttemptTarget;
      readonly startedAtMs: number;
      readonly finishedAtMs: number;
      readonly status: AttemptStatus;
      readonly errorCode?: AiErrorCode;
      readonly errorReason?: AiErrorReason;
      readonly retryRule?: string;
      readonly fallbackRule?: string;
      readonly usage: AiUsage;
      readonly usageKnown: boolean;
      readonly cost: CostEstimate;
      readonly pricing: PricingSnapshot | null;
    },
  ): void {
    const latencyMs = Math.max(0, input.finishedAtMs - input.startedAtMs);
    const subjectHash = safeSubjectRef(input.plan.subjectToken);
    ledgerAttempts.push({
      usageRecordId: this.#services.ids.next('use'),
      logicalRequestId: input.logicalRequestId,
      attemptId: input.attemptId,
      ...(input.parentAttemptId === undefined ? {} : { parentAttemptId: input.parentAttemptId }),
      sequence: input.sequence,
      attemptKind: input.attemptKind,
      callerPluginId: input.plan.callerPluginId,
      ...(subjectHash === undefined ? {} : { subjectHash }),
      capability: input.plan.capability,
      capabilityVersion: input.plan.capabilityVersion,
      profile: input.plan.profile,
      providerId: input.target.providerId,
      modelAlias: input.target.modelAlias,
      providerModelId: input.target.providerModelId,
      routeConfigVersion: input.plan.snapshot.configVersion,
      startedAtMs: input.startedAtMs,
      finishedAtMs: input.finishedAtMs,
      latencyMs,
      status: input.status,
      ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
      ...(input.errorReason === undefined ? {} : { errorReason: input.errorReason }),
      ...(input.retryRule === undefined ? {} : { retryRule: input.retryRule }),
      ...(input.fallbackRule === undefined ? {} : { fallbackRule: input.fallbackRule }),
      usage: input.usage,
      usageKnown: input.usageKnown,
      cost: input.cost,
      ...(input.pricing === null ? {} : { pricingId: input.pricing.pricingId, pricingVersion: input.pricing.version }),
    });
    attemptRecords.push({
      attemptId: input.attemptId,
      logicalRequestId: input.logicalRequestId,
      sequence: input.sequence,
      ...(input.parentAttemptId === undefined ? {} : { parentAttemptId: input.parentAttemptId }),
      attemptKind: input.attemptKind,
      providerId: input.target.providerId,
      modelAlias: input.target.modelAlias,
      providerModelId: input.target.providerModelId,
      modelClass: input.target.modelClass,
      routeDepth: input.target.routeDepth,
      routeConfigVersion: input.plan.snapshot.configVersion,
      startedAtMs: input.startedAtMs,
      finishedAtMs: input.finishedAtMs,
      status: input.status,
      ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
      ...(input.errorReason === undefined ? {} : { errorReason: input.errorReason }),
      ...(input.retryRule === undefined ? {} : { retryRule: input.retryRule }),
      ...(input.fallbackRule === undefined ? {} : { fallbackRule: input.fallbackRule }),
      usage: input.usage,
      usageKnown: input.usageKnown,
      estimatedCost: input.cost,
    });
  }

  #requestRecord(
    plan: ExecutionPlan,
    provenance: ReliabilityProvenance,
    summary: GovernanceSummary,
    idempotencyOutcome: 'EXECUTED' | 'REPLAYED' | 'JOINED',
    startedAtMs: number,
    finishedAtMs: number,
    result: AiResult<unknown>,
  ): LogicalRequestUsageRecord {
    const subjectHash = safeSubjectRef(plan.subjectToken);
    return {
      usageRecordId: this.#services.ids.next('use'),
      logicalRequestId: provenance.logicalRequestId,
      requestId: plan.requestId,
      callerPluginId: plan.callerPluginId,
      ...(subjectHash === undefined ? {} : { subjectHash }),
      capability: plan.capability,
      capabilityVersion: plan.capabilityVersion,
      profile: plan.profile,
      configVersion: provenance.configVersion,
      configDigest: provenance.configDigest,
      startedAtMs,
      finishedAtMs,
      latencyMs: Math.max(0, finishedAtMs - startedAtMs),
      status: result.status,
      ...(result.error?.code === undefined ? {} : { errorCode: result.error.code }),
      ...(result.error?.reason === undefined ? {} : { errorReason: result.error.reason }),
      attemptCount: summary.attemptCount,
      fallbackCount: summary.fallbackCount,
      retryCount: summary.retryCount,
      repairCount: summary.repairCount,
      finalUsage: summary.finalUsage,
      totalUsage: summary.totalUsage,
      totalUsageComplete: summary.totalUsageComplete,
      totalCost: summary.totalCost,
      idempotencyOutcome,
      ...(provenance.promptApplied === undefined ? {} : { promptApplied: provenance.promptApplied }),
      ...(provenance.promptVersion === undefined ? {} : { promptVersion: provenance.promptVersion }),
    };
  }

  /** One provider dispatch, raced against its per-attempt deadline and cancellation. */
  async #dispatch(
    plan: ExecutionPlan,
    target: AttemptTarget,
    providerDeadlineAtMs: number,
    cancellation: CancellationToken | undefined,
    repair: RepairFeedback | undefined,
  ): Promise<RawAttemptOutcome> {
    const request = this.#providerRequest(plan, target, providerDeadlineAtMs, cancellation, repair);
    let work: Promise<ProviderTextResult | ProviderStructuredResult>;
    try {
      work = plan.requiredPrimitive === 'ai.structured.generate' ? target.route.adapter.generateStructured(request) : target.route.adapter.generateText(request);
    } catch (error: unknown) {
      return { kind: 'threw', error };
    }
    const timeoutMs = Math.max(0, providerDeadlineAtMs - this.#services.clock.nowMs());
    const outcome = await raceAttempt(work, timeoutMs, cancellation);
    switch (outcome.kind) {
      case 'completed':
        return { kind: 'completed', value: outcome.value };
      case 'deadline':
        return { kind: 'timeout' };
      case 'cancelled':
        return { kind: 'cancelled' };
      default:
        return { kind: 'threw', error: outcome.error };
    }
  }

  #providerRequest(
    plan: ExecutionPlan,
    target: AttemptTarget,
    providerDeadlineAtMs: number,
    cancellation: CancellationToken | undefined,
    repair: RepairFeedback | undefined,
  ): ProviderRequest {
    return buildProviderRequest(plan, target, providerDeadlineAtMs, cancellation, repair);
  }
}

/**
 * Build the `ProviderRequest` for one attempt. `modelRef` is operator-side and never crosses to a
 * consumer; a repair attempt adds exactly two untrusted feedback values and nothing else.
 */
export function buildProviderRequest(
  plan: ExecutionPlan,
  target: AttemptTarget,
  providerDeadlineAtMs: number,
  cancellation: CancellationToken | undefined,
  repair: RepairFeedback | undefined,
): ProviderRequest {
  const context: ProviderBoundValue[] = [
    ...plan.context.map((value) => ({
      name: value.name,
      label: value.label,
      untrusted: value.untrusted,
      value: value.value,
    })),
    ...(repair === undefined
      ? []
      : [
          {
            name: 'repair_feedback',
            label: 'Validation feedback (repair)',
            untrusted: true,
            value: repair.issues.map((issue) => `${issue.path}: ${issue.code}`).join('; ') || 'the previous payload did not conform',
          },
          {
            name: 'repair_previous_candidate',
            label: 'Previous candidate (repair)',
            untrusted: true,
            value: repair.rawText,
          },
        ]),
  ];
  const maxOutputTokens = Math.min(
    plan.requestedMaxOutputTokens ?? plan.requirements.maxOutputTokens ?? target.route.model.maxOutputTokens,
    plan.requirements.maxOutputTokens ?? target.route.model.maxOutputTokens,
    target.route.model.maxOutputTokens,
  );
  return {
    capability: plan.requiredPrimitive,
    profile: plan.profile,
    instructions: plan.instructions,
    context,
    ...(plan.outputSchema !== undefined && plan.outputSchema.kind === 'INLINE'
      ? {
          outputFormatInstruction: renderOutputFormatInstruction(plan.outputSchema),
          outputSchema: plan.outputSchema,
        }
      : {}),
    modelRef: target.route.modelRef,
    deadlineAtMs: providerDeadlineAtMs,
    maxOutputTokens,
    ...(cancellation === undefined ? {} : { cancellation }),
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
export function raceAttempt<T>(
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

export type { AttemptOutcome };

function providerRawErrorOf(value: unknown): { readonly dispatched?: boolean } | undefined {
  return typeof value === 'object' && value !== null && 'rawError' in value
    ? (value as { rawError?: { readonly dispatched?: boolean } }).rawError
    : undefined;
}

function costBudgetExhaustedError(): AiError {
  return makeAiError({
    reason: 'COST_BUDGET_EXHAUSTED',
    message: 'The cost budget for this deployment is exhausted; no provider was called.',
    details: { dimension: 'ESTIMATED_COST', period: 'DAY', limit: 0 },
  });
}
