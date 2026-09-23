# AI Bridge — Reliability

> **Stage 5 implementation.** This document specifies retry, fallback, output repair and the
> failure semantics exactly as implemented in `@aibridge/governance` and
> `packages/runtime/src/coordinator.ts`. Every claim is verified against the code. The frozen
> consumer contract is unchanged ([`INTEGRATION_CONTRACT_V1.md`](INTEGRATION_CONTRACT_V1.md) §5.3,
> §7.2, §9).

Companion documents: [`ARCHITECTURE.md`](ARCHITECTURE.md) §10 for the design rationale,
[`GOVERNANCE.md`](GOVERNANCE.md) for idempotency, limits, budget and the usage ledger.

---

## 1. Three mechanisms, never conflated

Retry, fallback and output repair are three different questions with three different budgets.
Conflating them is how one learning turn becomes thirty billed calls
([`ARCHITECTURE.md`](ARCHITECTURE.md) §10).

| Mechanism | Question it answers | What is re-sent | Decided by | Hard bound |
| --- | --- | --- | --- | --- |
| **Retry** (same provider) | may the *same* provider be asked again? | the identical request | `decideRetry` (`packages/governance/src/retry-policy.ts`) | ≤ **1** same-provider retry |
| **Fallback** (another provider) | may *another* provider serve this failure? | the identical request, next hop | `decideFallback` (`packages/governance/src/fallback-policy.ts`) then `nextFallback` (`packages/runtime/src/fallback.ts`) | ≤ **8** hops, one overall budget |
| **Output repair** (re-ask) | may the same provider be re-asked **with feedback**? | a changed request (feedback appended) | `outputRepair: 'NONE' \| 'ONCE'` | exactly **one** repair |

**Never** merge the counters: each attempt is labelled `PRIMARY | RETRY | FALLBACK | REPAIR`
(`packages/governance/src/usage-ledger.ts`) and counted separately in `ReliabilityProvenance`.

---

## 2. Logical request vs provider attempt

One consumer call is one **logical request**. Each real provider dispatch beneath it is one
**provider attempt** (Phase 2). One consumer response may legitimately be the product of several
attempts; all of them are accounted.

`ReliabilityProvenance` and `ProviderAttemptProvenance` (`packages/governance/src/provenance.ts`)
carry:

| Field group | `ProviderAttemptProvenance` | Notes |
| --- | --- | --- |
| Identity | `attemptId`, `logicalRequestId`, `sequence` | `sequence` is 1-based across the whole logical request |
| Lineage | `parentAttemptId` | a repair is a **child** of the attempt it repairs |
| Target | `providerId`, `modelAlias`, `providerModelId`, `modelClass`, `routeDepth` | `providerModelId` is **operator-side**; consumers see the safe projection only ([`ARCHITECTURE.md`](ARCHITECTURE.md) §5.2) |
| Config | `routeConfigVersion` | the snapshot the attempt ran against |
| Timing | `startedAtMs`, `finishedAtMs` | |
| Outcome | `status`, `errorCode`, `errorReason` | the closed generic vocabulary only |
| Decision | `retryRule`, `fallbackRule`, `skipReason` | the closed rule that spawned (or skipped) the attempt — **never** prose |
| Accounting | `usage`, `usageKnown`, `estimatedCost` | `usageKnown: false` when the provider reported nothing |

`ReliabilityProvenance` adds `fallbackCount`, `retryCount`, `repairCount`, `skippedCount` and
`idempotencyOutcome` (`EXECUTED | REPLAYED | JOINED`). `GovernanceSummary` (`summarize`) totals
usage and cost across **every** attempt, while the frozen `AiResult.usage` stays the final
result's usage.

> **Never recorded** (Phase 3): the prompt, learner data, the raw response, any credential, or
> reasoning content. There is no content field to fill in.

### 2.1 Trade-off, stated honestly

Per-attempt provenance is operator-side truth, not a consumer API. A consumer sees one result
plus warnings; an operator sees every attempt, including the ones that failed and the ones that
were skipped. The cost is storage per attempt record — accepted, because "which providers did we
pay for this turn" must always have an answer.

---

## 3. Fallback policy — per error reason

`decideFallback` reads only the closed `code` / `reason` / `stage`
([`ARCHITECTURE.md`](ARCHITECTURE.md) §10.1–10.2). Classification is **never** made from provider
prose (AGENTS.md §4).

| Failure (code / reason) | Fallback | Rule recorded | Rationale |
| --- | --- | --- | --- |
| `PROVIDER_ERROR` / `PROVIDER_UNAVAILABLE`, `PROVIDER_OVERLOADED` | **eligible by default** | `PROVIDER_TRANSIENT` | a provider-shaped failure may pass on another provider |
| `TIMEOUT` / `PROVIDER_TIMEOUT`, known outcome | **eligible by default** | `PROVIDER_TRANSIENT` | nothing was billed |
| `TIMEOUT` / `PROVIDER_TIMEOUT`, unknown outcome | **opt-in**: `crossProviderFallbackOnUnknownOutcome` (default **true**) | `TIMEOUT` | the provider may already have generated and billed; the extra spend is real |
| `MODEL_UNAVAILABLE` / `MODEL_UNAVAILABLE` | **eligible by default** | `MODEL_UNAVAILABLE` | a routing problem is fixed by re-routing |
| `RATE_LIMITED` / `PROVIDER_THROTTLED` | **opt-in**: `fallbackOnRateLimit` (default **false**) | `RATE_LIMIT_POLICY` | provider-originated throttling only |
| `QUOTA_EXCEEDED` / `QUOTA_PROVIDER` | **opt-in**: `fallbackOnQuotaExceeded` (default **false**) | `PROVIDER_QUOTA_POLICY` | a provider-scoped quota limits one provider (Phase 54) |
| `RATE_LIMITED` / `RATE_LIMIT_SUBJECT \| CALLER \| CAPABILITY \| PROVIDER` | **never** | `OWN_LIMIT_NOT_DODGED` | our own rate limit is not routed around (Phase 53) |
| `QUOTA_EXCEEDED` / `QUOTA_SUBJECT \| CALLER \| CAPABILITY \| GLOBAL`, `COST_BUDGET_EXHAUSTED` | **never** | `OWN_LIMIT_NOT_DODGED` | hopping providers to dodge our own budget is a bug, not resilience (Phase 53–54) |
| `MODEL_UNAVAILABLE` / `KILL_SWITCH_GLOBAL \| PROVIDER \| CAPABILITY` | **never** | `OWN_LIMIT_NOT_DODGED` | an operator switch outranks every recovery mechanism (Phase 49) |
| `TIMEOUT` / `BUDGET_EXHAUSTED` | **never** | `DEADLINE_EXHAUSTED` | the caller's own time ran out |
| `INVALID_RESPONSE` / `PROVIDER_BAD_RESPONSE` | **never** | `NOT_RETRYABLE_CODE` | the frozen classification table refuses cross-provider chasing ([`INTEGRATION_CONTRACT_V1.md`](INTEGRATION_CONTRACT_V1.md) §7.2) |
| `INVALID_RESPONSE` / `EXTRACTION_FAILED`, `JSON_PARSE_FAILED`; `SCHEMA_MISMATCH` / `SCHEMA_VALIDATION_FAILED`, `OUTPUT_REPAIR_EXHAUSTED`, `OUTPUT_TOO_LARGE` | **never** | `CONTENT_PROPERTY` | repair is the only sanctioned answer (§10) |
| `CONTENT_BLOCKED` / `PROVIDER_CONTENT_FILTER`, `POLICY_VIOLATION` | **never** | `CONTENT_PROPERTY` | re-asking a blocked input elsewhere is content-policy shopping |
| `INVALID_REQUEST` (whole family), `PROVIDER_REQUEST_REJECTED` | **never** | `REQUEST_PROPERTY` | another provider would reject the same request |
| `INVALID_REQUEST` / `CALLER_NOT_PERMITTED`, `SUBJECT_MISSING` | **never** | `PERMISSION_PROPERTY` | permission is not a provider property |
| `PROVIDER_ERROR` / `PROVIDER_AUTH_FAILED` | **never** | `CONFIG_OR_INTERNAL` | a broken credential is a deployment problem |
| `INTERNAL` / `INTERNAL_ERROR` | **never** | `CONFIG_OR_INTERNAL` | another provider's money must not paper over our bug |
| `CANCELLED` / `CANCELLED_BY_CALLER \| HOST` | **never** | `CANCELLED` | cancellation is terminal |
| `UNAVAILABLE` / `NO_ROUTE`, `ROUTE_EXHAUSTED` | **never** | `NOT_RETRYABLE_CODE` | the chain is already done |

The two Stage 5 sharpenings: **own limits are never dodged**, and a **provider-scoped** quota may
move — when the route says so. Both read the stable reason, never string matching.

---

## 4. Chain discipline (Phase 6)

`nextFallback` (`packages/runtime/src/fallback.ts`) is the reused Stage 4 chain contract:
`decideFallback` answers "may this failure be chased at all?", `nextFallback` answers "which hop
is next, and is the chain done?". The coordinator feeds it the chain **including** the hop that
just failed and consumes the queue strictly forward.

Chains are validated at **config compile** by `validateFallbackChain`, wired through
`compileFallbackIssues` (`packages/runtime/src/config-manager.ts`). A bad chain never reaches a
request:

| Config error | Rejected with | Why |
| --- | --- | --- |
| cycle (a target revisited) | `DUPLICATE_FIELD` | a loop is not a fallback chain |
| duplicate target | `DUPLICATE_FIELD` | one hop serves once |
| impossible target (unresolvable alias) | `UNKNOWN_FIELD` | a route that cannot exist |
| more than 8 hops | `OUT_OF_RANGE` | `MAX_FALLBACK_CHAIN_LENGTH = 8` — finite, always |
| empty chain | `INVALID_TYPE` | at least one hop |

An invalid configuration is rejected **in full**; the previous snapshot stays live
([`ARCHITECTURE.md`](ARCHITECTURE.md) §17.2).

---

## 5. One overall deadline (Phase 7)

Every attempt inherits what is **left** of the overall budget; none is ever given a fresh one.

| Rule | Implementation |
| --- | --- |
| per-attempt deadline = `min(providerMs, remaining − VALIDATION_RESERVE_MS)` | `providerDeadlineAt` (`packages/contracts/src/timeout.ts`) |
| no viable attempt left ⇒ `TIMEOUT` / `BUDGET_EXHAUSTED` | `providerDeadlineAt` returns `null` under `MIN_VIABLE_PROVIDER_MS` |
| a retry must fit its backoff **and** a viable attempt | `decideRetry` stops at `NO_TIME_LEFT` |
| a repair shares the parent's deadline | `#attemptRepair` recomputes from the same `deadlineAtMs` |

> A chain of `n` hops can **never** make a caller wait `n × budget`
> ([`ARCHITECTURE.md`](ARCHITECTURE.md) §12.1). A caller waits one budget.

---

## 6. Retry policy (Phase 8–10)

Retry is **same provider**. The load-bearing distinction is what is known about the outcome,
driven by the adapter's `ProviderRawError.dispatched` marker:

| Phase | `dispatched` | Meaning | Default |
| --- | --- | --- | --- |
| `BEFORE_DISPATCH` | `false` | nothing left this process | retried (`retryBeforeDispatch: true`) |
| `KNOWN_NOT_ACCEPTED` | `true` | the provider answered, with a transient refusal | **not** retried (`retryKnownNotAccepted: false`) |
| `UNKNOWN_OUTCOME_AFTER_DISPATCH` | absent | sent, then lost — it may already be billed | `retryUnknownOutcome: true`, effective **only** with `supportsReliableIdempotency` |

Resolved defaults (`resolveRetryPolicy`):

| Setting | Default | Bound |
| --- | --- | --- |
| `maxSameProviderRetries` | 1 | hard cap `MAX_SAME_PROVIDER_RETRIES = 1` — a larger config is **clamped**, never obeyed |
| `retryBeforeDispatch` | `true` | nothing was spent |
| `retryKnownNotAccepted` | `false` | a provider that answered is not re-asked by default; the fallback chain is the recovery path |
| `retryUnknownOutcome` | `true` | without reliable idempotency a repeat is a second charge |
| `baseBackoffMs` / `maxBackoffMs` | 250 / 2 000 | deterministic |

- `RATE_LIMITED` is **never** retried in process (`RATE_LIMITED_NO_IN_PROCESS_RETRY`): the
  provider said "slow down", and `retryAfterMs` is the honest answer.
- Backoff is `min(base × 2^(n−1), max)` = 250 ms → 2 s. A projected `Retry-After` is honoured but
  capped at `4 × maxBackoffMs` (8 s), so a hostile or broken header cannot park a request.
- Every delay goes through the `Sleeper` seam and every timestamp through the `Clock` seam
  (`packages/governance/src/sleeper.ts`): **no test ever sleeps**; `instantSleeper` advances a fake
  clock.

---

## 7. No silent capability degrade (Phase 5)

A fallback target must satisfy the **original** requirement set. Two mechanisms enforce it:

- `enumerateRouteCandidates` (`packages/runtime/src/routes.ts`) drops any hop that fails the
  feature, context or output checks, recording `CAPABILITY_UNMET` — a hop is dropped, never
  softened. `maxOutputTokens`, `minContextTokens`, `reasoning`, `structuredOutput` and `streaming`
  are all checked against the **model** descriptor.
- `allowCapabilityDegrade` is **rejected by config validation** in Stage 5
  (`parseFallbackPolicy`, `packages/runtime/src/config-manager.ts`): only `false` exists. A config
  asking for `true` is an invalid configuration, not a silent promise.

> A requirement is **never** quietly downgraded: silently serving `cheap` where `reasoning` was
> asked for would quietly change the quality of a child's feedback.

---

## 8. Terminal error selection (Phase 55)

One stable terminal error is chosen by `selectTerminalError`
(`packages/governance/src/terminal.ts`). Turning everything into `INTERNAL` would hide the only
fact a consumer can act on. Priority, highest first:

1. **Cancellation** — somebody stopped the call; that is always the truth.
2. **Request / content / permission** — the root cause that would fail everywhere; the **earliest**
   such failure wins (`REQUEST` → `CONTENT` → `PERMISSION`).
3. **Deadline** — the caller's own budget ran out; the last provider error would mislead.
4. **Governance** — our own limit refused; the **most recent** refusal is the operative one.
5. **The last attempt's error** — the freshest evidence about the provider world.
6. **The supplied fallback error** — when nothing was ever dispatched (`NO_ROUTE`,
   `ROUTE_EXHAUSTED` and friends). If the overall deadline elapsed while deciding, this is used
   too: `deadlineExhausted` overrides provider evidence.

---

## 9. Warnings (Phase 56–57)

Warnings are additive: a consumer that ignores them still behaves safely
([`ARCHITECTURE.md`](ARCHITECTURE.md) §5.4).

| Code | Meaning | Emitted when |
| --- | --- | --- |
| `FALLBACK_USED` | a non-first-choice route served the result | `fallbackCount > 0` |
| `RETRY_USED` | a bounded same-provider retry ran | `retryCount > 0` (Stage 5 additive code, contract `1.1`) |
| `OUTPUT_REPAIRED` | one bounded repair attempt changed the payload | a repair child attempt ran (§10) |
| `IDEMPOTENT_REPLAY` | this result was replayed from a stored turn, or joined an in-flight duplicate | the idempotency gate returned `REPLAY` / `JOIN`; no provider was called by **this** call |
| `USAGE_ESTIMATED` | usage or cost for the turn is partial; totals are conservative | any attempt reported no usage while some facts exist, or the merged cost is `partial` |

When nobody reported usage at all there are no numbers to distrust — absent fields already mean
*unknown*, never zero ([`ARCHITECTURE.md`](ARCHITECTURE.md) §16.2), so `USAGE_ESTIMATED` is **not**
emitted for a wholly unknown turn.

---

## 10. Output repair (Phase 36–38)

Repair keeps its **frozen** semantics ([`INTEGRATION_CONTRACT_V1.md`](INTEGRATION_CONTRACT_V1.md)
§5.3). It is not a retry (the request changed) and not a fallback (the provider did not).

| Rule | Behaviour |
| --- | --- |
| bound | exactly one repair, `outputRepair: 'NONE' \| 'ONCE'` (default `'ONCE'`) |
| target | the **same** provider and model that produced the bad payload |
| lineage | recorded as a **child attempt** with `parentAttemptId` in provenance and the ledger |
| cost | shares the parent's deadline, budget and quota reservation scope (§5, [`GOVERNANCE.md`](GOVERNANCE.md) §5) |
| request change | exactly two untrusted feedback values: `repair_feedback` (issue paths + codes) and `repair_previous_candidate` |
| eligibility | extraction / schema failures only: `EXTRACTION_FAILED`, `JSON_PARSE_FAILED`, `SCHEMA_VALIDATION_FAILED`. A size breach (`OUTPUT_TOO_LARGE`) and a missing schema are **not** repairable |
| skipped repair | no viable budget or no quota reservation ⇒ **no repair runs and the ORIGINAL error stands** (Phase 38) |
| failed repair | `VALIDATION` / `OUTPUT_REPAIR_EXHAUSTED` — the contract's stable answer |
| report | `warnings: [{ code: 'OUTPUT_REPAIRED' }]` on success |

Repair is the only sanctioned response to non-conformance, because "the model nearly complied"
and one clarifying re-ask is materially different from a blind retry.

---

## 11. Cancellation and kill switch

**Cancellation (Phase 50)** is terminal and idempotent ([`ARCHITECTURE.md`](ARCHITECTURE.md)
§13.2):

- it stops retry (`decideRetry` refuses), fallback and repair before any of them start — the
  attempt loop checks the token before every candidate;
- a cancelled sleep aborts (`Sleeper.sleep(ms, cancellation)`);
- `raceAttempt` settles **exactly once**, so a provider answer arriving after `CANCELLED` is
  discarded rather than resurrecting the call;
- a call cancelled at ingress is rejected before any meter or ledger record exists.

**Kill switch (Phase 49)** outranks breaker, retry and fallback:

- the switch check is step 1 of candidate selection (`#pickCandidate`): a `DISABLED` target is
  **never** dispatched, and its skip is recorded as `KILL_SWITCH`;
- runtime health composes `DISABLED` above every observed state — `setDisabled` outranks
  `OPEN_CIRCUIT`, `DEGRADED` and `HEALTHY` alike (`packages/governance/src/health.ts`);
- live operator state and the configured snapshot state are merged per attempt, so a switch thrown
  mid-request applies to the next candidate;
- resolution precedence is `global → capability → provider`
  (`packages/contracts/src/killswitch.ts`).

---

## 12. Streaming boundary

Stated plainly (`packages/runtime/src/runtime.ts`, `AiRuntime.stream`): a `stream` is a
**single attempt**. Governance applies; retry, fallback and repair **do not**, because partial
output has already been delivered to the caller. A consumer that needs reliability chains uses
`execute`. Only `ai.text.generate` streams; a structured judgement is returned complete or not at
all.

---

## 13. The failure semantics table (Phase 78)

Every reason family of the closed vocabulary
(`REASON_META`, `packages/contracts/src/errors.ts`), with its complete reliability semantics.
Classification reads only `code` / `reason` / `stage` — never provider prose.

| Error (code / reason) | Retry? | Fallback? | Breaker impact? | Quota effect? | Usage record? |
| --- | --- | --- | --- | --- | --- |
| `INVALID_REQUEST` / `CONTRACT_VERSION_UNSUPPORTED`, `MALFORMED_ENVELOPE`, `CAPABILITY_UNKNOWN`, `CAPABILITY_VERSION_UNSUPPORTED`, `OUTPUT_SCHEMA_UNSUPPORTED`, `OUTPUT_SCHEMA_OVERRIDE_FORBIDDEN`, `METADATA_NOT_ALLOWED`, `TRUSTED_FIELD_IN_CONSUMER_REQUEST` | never | never | no | none — `— (ingress)` | `— (ingress)` |
| `INVALID_REQUEST` / `IDEMPOTENCY_CONFLICT` | never | never | no | none — refused at the idempotency gate, before any reservation | `request, 0 dispatch` |
| `INVALID_REQUEST` / `CALLER_NOT_PERMITTED`, `SUBJECT_MISSING` | never | never | no | none — `— (ingress)` | `— (ingress)` |
| `INVALID_REQUEST` / `INPUT_TOO_LARGE`, `SECRET_LIKE_INPUT` | never | never | no | none — `— (ingress)` | `— (ingress)` |
| `MODEL_UNAVAILABLE` / `KILL_SWITCH_GLOBAL`, `KILL_SWITCH_CAPABILITY` | never | never | no | none — `— (ingress)` | `— (ingress)` |
| `MODEL_UNAVAILABLE` / `KILL_SWITCH_PROVIDER` | never | never | no | per-target skip opens nothing; a fully-killed chain settles its request reservation (0 dispatch) | `— (ingress)` or `request, 0 dispatch` + `SKIPPED` records |
| `RATE_LIMITED` / `RATE_LIMIT_SUBJECT`, `RATE_LIMIT_CALLER`, `RATE_LIMIT_CAPABILITY`, `RATE_LIMIT_PROVIDER` (ours) | never (in process) | **never** — own limit, not dodged | no | reservations **released** | `request, 0 dispatch` |
| `RATE_LIMITED` / `PROVIDER_THROTTLED` (provider-originated) | never (in process) — `retryAfterMs` is the honest answer | opt-in: `fallbackOnRateLimit` | no | attempt settles (reported usage; unknown ⇒ conservative) | `attempt + request` |
| `QUOTA_EXCEEDED` / `QUOTA_SUBJECT`, `QUOTA_CALLER`, `QUOTA_CAPABILITY`, `QUOTA_GLOBAL` | never | **never** — own limit | no | refused pre-dispatch — reservation never opened | `request, 0 dispatch` |
| `QUOTA_EXCEEDED` / `QUOTA_PROVIDER` | never | opt-in: `fallbackOnQuotaExceeded` | no | refused at the per-attempt reservation (candidate skipped `QUOTA_INELIGIBLE`) | `request, 0 dispatch` + `SKIPPED` records |
| `QUOTA_EXCEEDED` / `COST_BUDGET_EXHAUSTED` (**cost** budget) | never | **never** | no | refused pre-dispatch — zero provider calls | `request, 0 dispatch` |
| `TIMEOUT` / `BUDGET_EXHAUSTED` (**time** budget) | never | never | no | every attempt that ran settles; the request reservation settles at totals (unknown ⇒ conservative) | `attempt + request` (0 dispatch when the budget died first) |
| `UNAVAILABLE` / `NO_ROUTE`, `ROUTE_EXHAUSTED` | never | never | no | `NO_ROUTE`: none (ingress); `ROUTE_EXHAUSTED`: request reservation settles (0 dispatch) | `— (ingress)` / `request, 0 dispatch` + `SKIPPED` records |
| `MODEL_UNAVAILABLE` / `MODEL_UNAVAILABLE` (routing) | never — a route problem is chased by fallback, never by re-asking | **yes** | no | ingress: none; dispatched: attempt settles | `— (ingress)` / `attempt + request` |
| `PROVIDER_ERROR` / `PROVIDER_UNAVAILABLE`, `PROVIDER_OVERLOADED` | per policy (§6: known/unknown phases) | **yes** | **yes** | attempt settles (reported usage; unknown ⇒ conservative) | `attempt + request` |
| `TIMEOUT` / `PROVIDER_TIMEOUT` | per policy — unknown outcome only with `supportsReliableIdempotency` | **yes**; unknown outcome only per `crossProviderFallbackOnUnknownOutcome` (default true) | **yes** | attempt settles (unknown ⇒ conservative) | `attempt + request` |
| `INVALID_RESPONSE` / `PROVIDER_BAD_RESPONSE` | never | never | no | attempt settles | `attempt + request` |
| `PROVIDER_ERROR` / `PROVIDER_AUTH_FAILED` | never | never — deployment problem | no | attempt settles | `attempt + request` |
| `INVALID_REQUEST` / `PROVIDER_REQUEST_REJECTED` | never | never | no | attempt settles (a dispatch happened, unlike ingress rejections) | `attempt + request` |
| `CONTENT_BLOCKED` / `PROVIDER_CONTENT_FILTER` | never | never | no | attempt settles | `attempt + request` |
| `CONTENT_BLOCKED` / `POLICY_VIOLATION` (e.g. `maxCallsPerTurn`) | never | never | no | the refused call opens nothing; calls already made settle | `attempt + request` |
| `INVALID_RESPONSE` / `EXTRACTION_FAILED`, `JSON_PARSE_FAILED`; `SCHEMA_MISMATCH` / `SCHEMA_VALIDATION_FAILED` | never — repair is the sanctioned answer | never — content property | no — a non-conforming answer records breaker **success** | attempt settles (the tokens were really spent) | `attempt + request`; a repair is a child attempt record |
| `SCHEMA_MISMATCH` / `OUTPUT_TOO_LARGE`, `OUTPUT_REPAIR_EXHAUSTED` | never | never | no — breaker **success** | attempt settles | `attempt + request` |
| `CANCELLED` / `CANCELLED_BY_CALLER`, `CANCELLED_BY_HOST` | never | never | no | ingress cancellation is never metered; a dispatched attempt settles (unknown ⇒ conservative) | `attempt + request` |
| `INTERNAL` / `INTERNAL_ERROR` | never | never | no | a dispatched attempt settles | `attempt + request` |

**Column vocabulary.** `— (ingress)` = refused before the logical request begins (prepare): no
meter, no reservation, **no usage-ledger record** — the outcome is still *recorded*, in the
returned `ReliabilityProvenance` and the operator log, just never in the ledger.
`request, 0 dispatch` = one `LogicalRequestUsageRecord` with `attemptCount: 0`; no attempt
records; no provider money. `attempt + request` = one `ProviderAttemptUsageRecord` per dispatched
attempt (`REPAIR` children and `SKIPPED` candidates included) plus the logical request record.
"Unknown ⇒ conservative" = an attempt whose usage never arrived settles its reservation at the
conservative amount, never zero, and the ledger records `usageKnown: false`
([`GOVERNANCE.md`](GOVERNANCE.md) §5).

### 13.1 So the semantics cannot drift

This table is a projection of code that already exists: `REASON_META` (code / stage /
retryability), `classifyFailure` + `breakerImpact` (`packages/governance/src/failure-class.ts`),
`decideFallback`, `decideRetry`, `selectTerminalError`, and the settlement paths in
`ExecutionCoordinator` (`finish`, per-attempt settle, `#rejectedOutcome`). The classification
half is pinned by `tests/governance/policy.test.ts`. A new reason must land in `REASON_META`, in
exactly one row of this table, and in the tests — or it does not ship. A change to any column is a
change to this table in the same change set.

---

## 14. Out of scope for Stage 5 (explicitly)

- adaptive / ML routing — non-reproducible answers are unacceptable when a child's feedback is at
  stake ([`ARCHITECTURE.md`](ARCHITECTURE.md) §9.1);
- cost-driven routing — cost informs governance and observability only, **never** provider choice
  (Phase 35);
- distributed circuit breakers — one process, one breaker table;
- durable stores for idempotency, counters or the usage ledger — in-memory reference
  implementations only ([`GOVERNANCE.md`](GOVERNANCE.md) §9).
