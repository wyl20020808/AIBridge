# AI Bridge — Governance

> **Stage 5 implementation.** This document specifies idempotency, rate limit, quota, budget,
> kill-switch precedence, the usage ledger and configuration snapshots exactly as implemented in
> `@aibridge/governance`, `packages/core` and `packages/runtime`. Every claim is verified against
> the code. The frozen consumer contract is unchanged
> ([`INTEGRATION_CONTRACT_V1.md`](INTEGRATION_CONTRACT_V1.md) §10, §11).

Companion documents: [`ARCHITECTURE.md`](ARCHITECTURE.md) §14–17 for the design rationale,
[`RELIABILITY.md`](RELIABILITY.md) for retry, fallback and the failure semantics table,
[`CONFIG_RELOAD.md`](CONFIG_RELOAD.md) for configuration snapshots and atomic reload.

---

## 1. What governance owns

| Piece | Question it answers | Module |
| --- | --- | --- |
| **Idempotency** | was this logical turn already run? | `packages/governance/src/idempotency.ts` ([`ARCHITECTURE.md`](ARCHITECTURE.md) §14) |
| **Rate limit** | how fast may a caller call? | `packages/governance/src/rate-limit.ts` (§15.1) |
| **Quota** (+ reservations) | how much per day / month? | `packages/governance/src/quota.ts` (§15.2) |
| **Budget** | how much money per request / day / month? | `packages/governance/src/budget.ts`, `cost.ts` (§16.2) |
| **Kill switch interplay** | may anything be called at all? | `packages/contracts/src/killswitch.ts`, `packages/runtime/src/coordinator.ts` (§20) |
| **Usage ledger** | what was spent, exactly? | `packages/governance/src/usage-ledger.ts` (§16.1) |
| **Config snapshots** | under which configuration did this run? | `packages/runtime/src/config-manager.ts` (§17) |

Governance answers *permission to spend*. It never answers *what to say*: no governance state
influences model choice in Stage 5 ([`RELIABILITY.md`](RELIABILITY.md) §14).

---

## 2. Idempotency (Phase 17–20)

One logical learning turn is one billable call. The frozen semantics
([`INTEGRATION_CONTRACT_V1.md`](INTEGRATION_CONTRACT_V1.md) §10) are implemented verbatim.

| Rule | Behaviour |
| --- | --- |
| scope | `(callerPluginId, capability, capabilityVersion, idempotencyKey)` — `idempotencyIdentityKey` |
| first call | executes; exactly one provider execution chain per identity |
| replay (incl. a **final failure**) | returns the stored result + `warnings: [{ code: 'IDEMPOTENT_REPLAY' }]`; nothing is dispatched |
| concurrent duplicate | **joins** (`JOIN`) the in-flight call and receives the same result — one execution chain serves both |
| same key, different request | `INVALID_REQUEST` / `IDEMPOTENCY_CONFLICT` — a stale answer is **never** returned |
| stored fingerprint | a **hash** of the request digest (`hashRequestFingerprint`). The digest embeds the input — it is **never** stored |
| retention | `IDEMPOTENCY_RETENTION_MS` = 15 min; capacity `IDEMPOTENCY_CAPACITY` = 10 000, LRU eviction |

States (`IDEMPOTENCY_STATUSES`):

| State | Meaning | A later call with the key |
| --- | --- | --- |
| `IN_FLIGHT` | one execution chain is running | joins it (`JOIN`) |
| `SUCCEEDED` | the turn produced a result | replays it (`REPLAY`) |
| `FAILED_FINAL` | the turn failed terminally | replays the failure (`REPLAY`) |

### 2.1 Trade-off, stated honestly

A turn that ended `FAILED_FINAL` is replayed as failed until retention expires. A consumer that
deliberately wants a fresh attempt at the turn mints a **new** `idempotencyKey` for a new turn;
transport retries of the same turn keep the key (frozen §10 rule 5 — the one thing that would
defeat the mechanism is regenerating a key per retry). Accepted consequences: a process restart
loses the registry, so at worst **one** duplicate billed call per turn
([`ARCHITECTURE.md`](ARCHITECTURE.md) §14.3), and the replay cache holds consumer-visible results
in memory for 15 minutes (§10).

---

## 3. Ordering (Phase 51)

The order is the contract (`ExecutionCoordinator.execute`,
`packages/runtime/src/coordinator.ts`):

1. **identity + fingerprint** — the idempotency gate (`gate`) runs first;
2. **cached terminal replay** — `REPLAY` or `JOIN` returns here;
3. **budget** — `checkRequestBudget` pre-check (`COST_BUDGET_EXHAUSTED`, zero calls);
4. **quota reservation** — request-scoped policies, then the budget's cost buckets;
5. **rate limit** — `RateLimiter.consume`;
6. **dispatch** — the attempt loop begins.

> A replay consumes **no** quota and **no** rate budget. A concurrent `IN_FLIGHT` duplicate takes
> **no** second reservation: it joins before any governance check runs.

A refusal at steps 3–5 means **zero** provider calls (Phase 22/34).

---

## 4. Rate limit (Phase 21–22)

Rate limit answers *how fast* — never *how much* (that is quota, §5). A refusal yields
`RATE_LIMITED` + a safe `retryAfterMs` + a `reason` naming the dimension.

| Dimension | Keyed by | Reason |
| --- | --- | --- |
| `subject` | hashed subject reference | `RATE_LIMIT_SUBJECT` |
| `callerPlugin` | `callerPluginId` | `RATE_LIMIT_CALLER` |
| `capability` | `capability` (or `scopeKey`) | `RATE_LIMIT_CAPABILITY` |
| `provider` | `providerId` (or `scopeKey`) | `RATE_LIMIT_PROVIDER` |
| `global` | the deployment | `RATE_LIMIT_PROVIDER` |

- Algorithm: a **sliding window over event timestamps** (`InMemoryRateLimitStore`) — exact,
  deterministic under a fake clock, no distributed state.
- Checked **before** dispatch: a refused call makes **zero** provider calls (Phase 22).
- `retryAfterMs` is the oldest hit's window expiry minus now — a safe, honest projection.
- Our own rate limit **never** silently falls back (Phase 53): even with
  `fallbackOnRateLimit: true`, `RATE_LIMIT_*` is refused, not rerouted.

---

## 5. Quota (Phase 23–26)

Quota answers *how much* over a longer period. Every scope has its own stable reason — the scope
**is** the reason and is never collapsed.

| Axis | Values |
| --- | --- |
| scopes | `subject`, `callerPlugin`, `capability`, `provider`, `global` → `QUOTA_SUBJECT`, `QUOTA_CALLER`, `QUOTA_CAPABILITY`, `QUOTA_PROVIDER`, `QUOTA_GLOBAL` |
| meters | `REQUESTS`, `TOKENS`, `ESTIMATED_COST` |
| periods | `DAY`, `MONTH` — calendar buckets (`quotaBucket`: `YYYY-MM-DD` / `YYYY-MM`) |

Reservation lifecycle:

| Step | Behaviour |
| --- | --- |
| reserve | before dispatch, the estimated maximum is reserved against **every** matching policy — two concurrent calls can never both see "1000 tokens left" (Phase 25) |
| settle | after the call, at the actual figure — **every attempt of a chain settles**, fallback and repair attempts included (Phase 26) |
| release | a call stopped before dispatch releases without consuming (`Rate limit refusal`, §3) |
| unknown usage | settles at the **conservative reservation, never 0**, and the ledger records `usageKnown: false` (Phase 24) — `unknown = 0` is a lie that breaks budgets |

Routing interaction: a **provider-scoped** quota may move the call to another provider when the
route opts in (`fallbackOnQuotaExceeded`, Phase 54). Subject, caller, capability and global
quotas **cannot** be routed around (Phase 53–54).

---

## 6. Budget (Phase 34–35)

The deployment's own wallet, checked **before** any dispatch:

| Meter | Setting | Refusal |
| --- | --- | --- |
| per request | `maxEstimatedCostPerRequest` | `QUOTA_EXCEEDED` / `COST_BUDGET_EXHAUSTED`, **zero** provider calls |
| per day | `maxEstimatedCostPerDay` | same |
| per month | `maxEstimatedCostPerMonth` | same |

- Period accounting is backed by the quota store's `ESTIMATED_COST` buckets (`BudgetTracker`), so
  budget and quota can never disagree about what has been spent.
- A fallback chain and a repair share **one** logical request budget (Phase 34/38).
- A currency mismatch is an **unknown** budget, never a silently-zero one: the comparison refuses
  to guess.
- Cost informs governance and observability **only**. Stage 5 never routes *because* something is
  cheaper (Phase 35). A **cost** budget is never misreported as a time budget: `BUDGET_EXHAUSTED`
  (`TIMEOUT`/`DEADLINE`) and `COST_BUDGET_EXHAUSTED` (`QUOTA_EXCEEDED`/`GOVERNANCE`) are distinct
  reasons ([`RELIABILITY.md`](RELIABILITY.md) §13).

---

## 7. Kill switch precedence and per-candidate checks (Phase 49, 52)

Kill switch outranks breaker, retry and fallback: a `DISABLED` target is **never** dispatched, and
`DISABLED` outranks every observed health state. Resolution precedence is
`global → capability → provider` (`packages/contracts/src/killswitch.ts`).

Per candidate, in order (`#pickCandidate`, `packages/runtime/src/coordinator.ts`):

| # | Check | Skip recorded |
| --- | --- | --- |
| 1 | kill switch (live state ∪ snapshot state) | `KILL_SWITCH` |
| 2 | circuit breaker (`dispatchVerdict`) | `BREAKER_OPEN` |
| 3 | capability fit (enforced at candidate enumeration) | `CAPABILITY_UNMET` |
| 4 | remaining budget (`providerDeadlineAt`) | `DEADLINE_EXHAUSTED` |
| 5 | provider-scoped quota eligibility (reservation) | `QUOTA_INELIGIBLE` |

Every skip is recorded in `ReliabilityProvenance` as a `SKIPPED` attempt with its closed
`AttemptSkipReason` (`packages/governance/src/usage-ledger.ts`) — a skipped hop is visible, never
silent.

---

## 8. Configuration governance

Configuration snapshots, the pinned pricing generation and validated-first atomic reload are
documented in [`CONFIG_RELOAD.md`](CONFIG_RELOAD.md). The governance rule here: every logical
request binds **one** snapshot at ingress and reads every policy — limits, quotas, pricing,
switches — from that snapshot alone (Phase 40–42). A reload affects only requests that arrive
after the swap.

---

## 9. Store ports

Every stateful seam is a port with an in-memory reference implementation
([`ARCHITECTURE.md`](ARCHITECTURE.md) §19). **No OJPlatform DB adapter exists in Stage 5** and
none may be added here — durable storage is a later, operator-owned host option.

| Port | Reference implementation | State held | Atomicity requirement |
| --- | --- | --- | --- |
| `IdempotencyStorePort` | `InMemoryIdempotencyStore` | fingerprint hash, terminal result | `claim` must be **atomic** — exactly one `PROCEED` per identity |
| `RateLimitStorePort` | `InMemoryRateLimitStore` | window hit timestamps | `tryConsume` must be **atomic** — never `limit + 1` through a window |
| `QuotaStorePort` | `InMemoryQuotaStore` | settled + outstanding per bucket | `reserve` must be **atomic** — two calls can never both fit through one remaining limit |
| `UsageLedgerPort` | `InMemoryUsageLedger` | append-only usage records | append-only; records are **never** rewritten |
| `ConfigSnapshotStorePort` | `InMemoryConfigSnapshotStore` | snapshot history | `push` commits a whole snapshot — never a half-applied table |

The first four live in `@aibridge/governance`; `ConfigSnapshotStorePort` lives in
`@aibridge/runtime` (`packages/runtime/src/config-manager.ts`).

### 9.1 Trade-off, stated honestly

All five stores are in-memory and volatile. A restart resets rate windows, quota counters and the
idempotency registry — a caller could exceed a daily quota after a redeploy and one duplicate turn
could bill twice. Both are bounded and accepted for V1; a durable counter is a later operator
option ([`ARCHITECTURE.md`](ARCHITECTURE.md) §19).

---

## 10. Privacy rules

| Rule | Implementation |
| --- | --- |
| opaque subject, hashed | `hashSubjectToken` (`packages/governance/src/subject.ts`) → `subj-<hex>`, two FNV-1a passes, deterministic across processes. The token itself is **never** logged, metered, or stored — usage and quota carry `subjectHash` only |
| request digest, hashed | the idempotency fingerprint is a **hash** of the digest; the digest embeds the prompt and learner text and is **never** stored (Phase 19) |
| no content in any store | ledger records are counts, ids, timings and closed codes — there is no content field to fill in (Phase 29). Metric labels are a closed low-cardinality set; event payloads are metadata-only |
| the one stated boundary | the idempotency replay cache stores the **consumer-visible terminal result** (`IdempotencyRecord.result`), because a replay must be faithful per frozen §10.2 ([`INTEGRATION_CONTRACT_V1.md`](INTEGRATION_CONTRACT_V1.md) §10). It is retention-limited in-memory state (15 min, 10 000 LRU), **never** a log |

Reasoning content is never recorded in any form — token *counts* are accounting evidence;
reasoning *content* stays with the provider.

---

## 11. Out of scope for Stage 5 (explicitly)

- UI dashboards and admin consoles (AGENTS.md §6 — the UI gate stays closed);
- durable / Redis stores for any port in §9;
- billing or payment processing — `estimatedCost` is evidence, never an invoice;
- auto-recharge or any money movement.
