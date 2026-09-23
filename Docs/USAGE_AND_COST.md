# AI Bridge — Usage and Cost

> **Stage 5 implementation.** The usage ledger, versioned pricing, cost estimation and budget
> gates in `@aibridge/governance`, written by `ExecutionCoordinator` and queried through
> `AiRuntime`. Everything on this page is operator-side governance data. No production runtime
> change; no UI.

Companion documents: [`ARCHITECTURE.md`](ARCHITECTURE.md) §16 for the usage/cost/observability
model, [`CONFIG_RELOAD.md`](CONFIG_RELOAD.md) for the snapshot a price is pinned against,
[`PROVIDER_CONFIGURATION.md`](PROVIDER_CONFIGURATION.md) §9 for dated model pricing metadata,
[`INTEGRATION_CONTRACT_V1.md`](INTEGRATION_CONTRACT_V1.md) for the frozen `AiUsage` the cost
basis projects into.

---

## 1. Two record shapes (Phase 28)

`UsageLedgerPort` is an append-only seam: AI Bridge owns the shape, the host owns persistence
([`ARCHITECTURE.md`](ARCHITECTURE.md) §19). One **logical request** appends exactly one
`LogicalRequestUsageRecord`; every **provider attempt** appends one `ProviderAttemptUsageRecord`,
so a fallback chain is fully accounted — every provider that was paid is visible (Phase 26).
Records are **never** rewritten.

### 1.1 `ProviderAttemptUsageRecord`

| Field | Type | Meaning |
| --- | --- | --- |
| `usageRecordId` | string | unique id of this ledger record |
| `logicalRequestId` | string | the logical request this attempt belongs to |
| `attemptId` | string | unique id of the attempt |
| `parentAttemptId?` | string | the attempt that spawned this one — a repair is a child of the attempt it repairs |
| `sequence` | number | 1-based order across the whole logical request |
| `attemptKind` | `PRIMARY` \| `RETRY` \| `FALLBACK` \| `REPAIR` | why the dispatch happened |
| `callerPluginId` | string | host-bound caller identity |
| `subjectHash?` | string | opaque, hashed subject reference. **Never** the token ([`SECURITY.md`](SECURITY.md) §16.1) |
| `capability` / `capabilityVersion` | string | what was called |
| `profile` | `ModelProfile` | the requested profile |
| `providerId` | string | operator-named instance id |
| `modelAlias` | string | routing name, never a vendor model id |
| `providerModelId` | string | the real model id — operator-side only, never consumer-visible |
| `routeConfigVersion` | string | the config snapshot version the attempt ran against |
| `startedAtMs` / `finishedAtMs` / `latencyMs` | number | attempt timing |
| `status` | `SUCCEEDED` \| `FAILED` \| `CANCELLED` \| `SKIPPED` | attempt outcome. An attempt whose output was rejected is **`FAILED`** |
| `errorCode?` / `errorReason?` | closed enums | the normalized failure — never provider prose |
| `retryRule?` / `fallbackRule?` | string | the closed decision rule that spawned the attempt. Never prose |
| `skipReason?` | `KILL_SWITCH` \| `BREAKER_OPEN` \| `CAPABILITY_UNMET` \| `NOT_REGISTERED` \| `DEADLINE_EXHAUSTED` \| `QUOTA_INELIGIBLE` \| `CHAIN_EXHAUSTED` | why a candidate was skipped |
| `usage` | `AiUsage` | this attempt's usage counts (§3) |
| `usageKnown` | boolean | `false` when the provider reported no usage. **Never silently zero** (Phase 24) |
| `cost?` | `CostEstimate` | this attempt's cost (§4–5) |
| `pricingId?` / `pricingVersion?` | string | the pinned rate card — the provenance anchor (Phase 32) |

### 1.2 `LogicalRequestUsageRecord`

| Field | Type | Meaning |
| --- | --- | --- |
| `usageRecordId` / `logicalRequestId` | string | record id and logical request id |
| `requestId` | string | the consumer's `requestId`, echoed |
| `callerPluginId` / `subjectHash?` | string | attribution (§1.1) |
| `capability` / `capabilityVersion` / `profile` | | what was called |
| `configVersion` / `configDigest` | string | the one snapshot generation this request ran against ([`CONFIG_RELOAD.md`](CONFIG_RELOAD.md) §1) |
| `startedAtMs` / `finishedAtMs` / `latencyMs` | number | end-to-end timing, including routing and validation |
| `status` | `SUCCEEDED` \| `FAILED` | binary, like the frozen `AiResult` |
| `errorCode?` / `errorReason?` | closed enums | the terminal failure |
| `attemptCount` / `fallbackCount` / `retryCount` / `repairCount` | number | what the chain spent |
| `finalUsage` | `AiUsage` | the **final** attempt's usage — the frozen `AiResult.usage` semantics (Phase 58) |
| `totalUsage` | `AiUsage` | every attempt, including the ones that failed (Phase 26) |
| `totalUsageComplete` | boolean | `false` when any attempt reported no usage |
| `totalCost` | `CostEstimate` | the whole chain's cost (§4.3) |
| `idempotencyOutcome` | `EXECUTED` \| `REPLAYED` \| `JOINED` | one logical turn, one billable execution |

### 1.3 The port

| Method | Yields |
| --- | --- |
| `appendAttempt(record)` / `appendRequest(record)` | append-only writes — there is no update or delete |
| `attempts(logicalRequestId?)` | `ProviderAttemptUsageRecord[]`, optionally scoped to one logical request |
| `requests(logicalRequestId?)` | `LogicalRequestUsageRecord[]` |

`InMemoryUsageLedger` is the reference implementation. Durable storage is host-owned later (§9).

## 2. The hard prohibition (Phase 29)

> No prompt, no student text, no AI output, no reasoning content, no credential, no provider raw
> error — in the ledger, ever.

The record shape makes the safe half convenient and the leak **impossible**: there is no content
field to fill in. Sizes, counts, timings, ids and closed codes are recorded; content is not.

| Never in the ledger | Why | Where it may go instead |
| --- | --- | --- |
| prompt / instructions / context values | content | nowhere; byte sizes only |
| student or learner text | content | nowhere |
| AI output, raw response, a repair's previous candidate | content | nowhere |
| reasoning content | content | nowhere. Only the **count** may cross (§3.2) |
| credentials, secret values, `subjectToken` | secret custody ([`SECURITY.md`](SECURITY.md) §2) | the adapter's private field, server-side. `subjectHash` is the only subject reference |
| provider raw errors, bodies, headers | not a public contract ([`ARCHITECTURE.md`](ARCHITECTURE.md) §6.4) | the operator-only redacted log, truncated and stripped of credentials |

## 3. Usage semantics (Phase 58–59)

### 3.1 Final result vs totals (Phase 58)

The frozen `AiResult.usage` does not change meaning: it stays the **final result's** usage — the
attempt that produced the returned output, including a successful **repair** attempt.

| Surface | Carries |
| --- | --- |
| `AiResult.usage` (frozen) | the final result's usage — the returned output's attempt only |
| `GovernanceSummary.finalUsage` / `LogicalRequestUsageRecord.finalUsage` | the same figure, operator-side |
| `GovernanceSummary.totalUsage` / `LogicalRequestUsageRecord.totalUsage` | **totals across every attempt** — fallback + retry + repair all counted, failed attempts included (Phase 26) |
| `totalUsageComplete` | `false` when any counted attempt reported no usage |
| `totalCost` | the chain's summed cost, `partial` when any part is unknown (§4.3) |

A consumer reading `usage` sees what its answer cost; an operator sees the whole bill. A count is
summed only over the attempts that reported it — a total can never look smaller than reality
without `totalUsageComplete` saying so.

### 3.2 `reasoningTokens` is a count (Phase 59)

`AiUsage.reasoningTokens` is an **additive** Stage 5 field within contract major 1 — a count
only. It is projected only when a provider safely reports a reasoning token count; absent means
*unknown*, **never 0**. Reasoning **content** never crosses the boundary (reasoning-content
isolation is a Stage 4 provider rule). The count feeds cost estimation (§4.3) and nothing else.

### 3.3 Unknown usage is absent

**unknown ≠ zero.** A usage fact the provider did not report stays absent (`usageIsUnknown`),
is flagged `usageKnown: false` per attempt, and never becomes a fabricated `0`. Absence is the
honest answer for "we do not know".

## 4. Cost model (Phase 30–33)

### 4.1 `PricingRecord` — the versioned rate card (Phase 30)

| Field | Type | Meaning |
| --- | --- | --- |
| `pricingId` | string | stable operator-side id; the provenance anchor of every estimate |
| `version` | string | bumped whenever the numbers change; history keeps its own version |
| `providerId` | string | target provider instance |
| `modelAlias?` / `modelRef?` | string | at least one must be present; the more specific record wins |
| `validFromMs` / `validUntilMs?` | number | inclusive start, exclusive end; absent end = still current |
| `currency` | string | ISO 4217 |
| `inputTokenPrice?` | number | price per `unit` of tokens. Absent = "not priced separately", **not** zero |
| `outputTokenPrice?` | number | as above |
| `cachedInputPrice?` | number | the cached-input discount, when the provider offers one |
| `reasoningTokenPrice?` | number | only when reasoning tokens are priced materially differently (§5) |
| `unit` | `PER_1K_TOKENS` \| `PER_1M_TOKENS` | the divisor |
| `source` | string | where the numbers come from: a URL, a contract, an operator note. Free text, operator-side |

`PricingTable.validate()` rejects an ambiguous card outright: a record with no model target, no
input **or** output price, a bad currency, a negative price, `validUntilMs ≤ validFromMs`, or two
records overlapping for one `(provider, model, version)` target — a pin must be deterministic.
`snapshotFor()` returns `null` for an unpriced model, and `null` means **unknown pricing**, never
a zero price.

### 4.2 Pricing is pinned at request start (Phase 32)

The price is pinned when the call starts and **never** re-read: the estimate is computed against
one `PricingSnapshot` resolved from the request's bound configuration snapshot
([`CONFIG_RELOAD.md`](CONFIG_RELOAD.md) §3). Every estimate carries its `pricingId` +
`pricingVersion`, so a later price change — a new rate card or a config reload — **never**
rewrites a historical record. Of overlapping cards, the most specific wins (a model-alias record
beats a provider-wide one), then the newest.

### 4.3 Estimation rules (Phase 33)

Ordered; no invented precision:

1. A **provider-reported** cost wins and is copied faithfully (`basis: PROVIDER_REPORTED`).
2. No pinned price, or no input/output counts at all ⇒ `basis: UNKNOWN`, no amount. A reasoning
   count alone is not enough to compute a cost.
3. Otherwise: `amount = (uncachedInput × inputPrice + cached × cachedPrice + plainOutput ×
   outputPrice + reasoning × reasoningPrice) / unit`, where
   - cached tokens are priced at `cachedInputPrice` **when priced**; an un-reported split counts
     as 0 — conservative for cached, i.e. undiscounted;
   - reasoning tokens are priced at `reasoningTokenPrice` **when priced** and are a **subset of
     output**, never additive to it (`plainOutput = outputTokens − reasoningTokens`); when the
     card does not price them, the whole output count is priced at `outputTokenPrice`.
4. `partial: true` when exactly one of `inputTokens` / `outputTokens` is missing — the amount is
   a **lower bound**, not a total.

Chain totals (`mergeCosts`) sum every attempt's amount; the total is `partial` when any attempt's
cost is unknown, itself partial, or the currencies mix, and `UNKNOWN` when no attempt produced an
amount. An unknown part is flagged — never silently zeroed into "2 of 2".

## 5. Cost basis (Phase 31)

### 5.1 The basis table and its projection

`CostEstimate.basis` answers "who says so"; it projects into the frozen
`AiUsage.estimatedCost.basis` as follows:

| Governance (`CostEstimate.basis`) | Condition | Frozen (`estimatedCost.basis`) |
| --- | --- | --- |
| `PROVIDER_REPORTED` | the provider reported the cost | `PROVIDER_REPORTED` |
| `ESTIMATED_FROM_PRICING`, not `partial` | usage fully known × pinned price | `PRICE_TABLE` |
| `ESTIMATED_FROM_PRICING`, `partial: true` | only part of the usage known | `ESTIMATED` |
| `UNKNOWN` | nobody knows | **absent** — the frozen contract reads absent as *unknown* |

### 5.2 Rate-card rule

A rate card sets `reasoningTokenPrice` only for providers that report `reasoningTokens` — an
unpriced split is priced within output (§4.3), and pricing a split nobody reports invites an
estimate that looks precise and is not.

### 5.3 Invariants

- **Unknown cost is never 0 and never "free".** An absent amount is the honest answer for "we do
  not know"; `projectCostToUsage` returns `undefined`, so the frozen `estimatedCost` is simply
  absent.
- `basis` is mandatory whenever a cost is present: a consumer can never mistake a price-table
  guess for a provider invoice.

## 6. Unknown usage (Phase 24)

### 6.1 Quota settlement policy

Quota is reserved before dispatch and settled after (Phase 25). When an attempt's usage never
arrived, settlement follows one policy:

| Policy | Settlement for unknown usage | Default |
| --- | --- | --- |
| `CONSERVATIVE` | settle at the **reserved** amount — the budget never under-counts | yes |
| `RELEASE` | the reservation consumes nothing | opt-in |

`CONSERVATIVE` is the default because `unknown = 0` is a lie that breaks budgets. `RELEASE` is
the single, explicit operator choice that lets an unknown settle at zero.

### 6.2 `usageKnown: false` is recorded

The ledger records `usageKnown: false` on the attempt and `totalUsageComplete: false` on the
request (§1). Settlement knows which meter went quiet: `REQUESTS` always settles at 1, `TOKENS`
needs `totalTokens`, `ESTIMATED_COST` needs an amount. Reservations released before dispatch
(cancelled or rejected) consume nothing at all.

### 6.3 `USAGE_ESTIMATED` warning rules

| Condition on the finished turn | Warning |
| --- | --- |
| total cost is `partial` (an unknown, partial or mixed-currency part) | `USAGE_ESTIMATED` |
| some attempt reported no usage **and** some usage facts exist | `USAGE_ESTIMATED` |
| nobody reported anything at all | **no** warning — absent fields already say *unknown* |

### 6.4 Trade-off, stated honestly

`CONSERVATIVE` over-counts on purpose: a provider that silently bills tokens the bridge never saw
still consumes budget. The alternative — trusting silence to mean zero — turns one quiet provider
into an unbounded spend. Operators who know their provider reports usage faithfully can opt into
`RELEASE` per snapshot ([`CONFIG_RELOAD.md`](CONFIG_RELOAD.md) §5.1).

## 7. Budget (Phase 34–35)

### 7.1 `BudgetPolicy` and the pre-dispatch check

| Field / meter | Meaning |
| --- | --- |
| `maxEstimatedCostPerRequest` | hard ceiling for one logical request, including every attempt (fallback + repair share it) |
| `maxEstimatedCostPerDay` / `maxEstimatedCostPerMonth` | period ceilings over the quota store's `ESTIMATED_COST` buckets — budget and quota can never disagree about what was spent |
| `currency` | ISO 4217 |

`checkRequestBudget` is a pure, conservative pre-dispatch test: a request is refused only when its
**conservative estimate** already exceeds what is left. That estimate is `max(pinned prices) ×
reserved tokens` — an upper-bound-ish figure, marked `partial`, used only for this gate. A
refusal is `COST_BUDGET_EXHAUSTED` and **zero** provider calls have been made. Where the caller
knows the estimate's currency does not match the budget's, it says so and the period comparison
refuses to guess — an unknown budget is never a silently-zero one.

### 7.2 `COST_BUDGET_EXHAUSTED` — not `BUDGET_EXHAUSTED`

| | `COST_BUDGET_EXHAUSTED` | `BUDGET_EXHAUSTED` |
| --- | --- | --- |
| means | no **money** left | no **time** left |
| code / stage | `QUOTA_EXCEEDED` / `GOVERNANCE` | `TIMEOUT` / `DEADLINE` |
| retryable | false — retrying does not refill a wallet | true |
| details | `dimension`, `period`, `limit` | `remainingMs` |

The reason is deliberately not `BUDGET_EXHAUSTED`: that one is the **time** budget
([`ARCHITECTURE.md`](ARCHITECTURE.md) §12.1). Mislabelling cost as time is semantic drift — "no
money left" and "no time left" demand opposite responses from a caller.

### 7.3 Cost is governance data only (Phase 35)

Stage 5 never routes *because* something is cheaper. Cost influences budget and observability;
provider choice stays deterministic and configuration-driven. A cost/quality optimizer is a future
stage's decision, not a quiet default.

## 8. Query surfaces

| Surface | Yields |
| --- | --- |
| `UsageLedgerPort.attempts(logicalRequestId?)` / `.requests(logicalRequestId?)` | the two record shapes of §1 |
| `AiRuntime.usageLedger` | the runtime's bound ledger port |
| `AiRuntime.executeObserved(...)` → `ExecutionOutcome.governance` | `GovernanceSummary`: attempt/fallback/retry/repair/skip counts, `finalUsage`, `totalUsage`, `totalUsageComplete`, `totalCost` |
| `ExecutionOutcome.provenance` | `ReliabilityProvenance`, per-attempt ids and closed rules |
| `MetricsSink` (`ai.tokens.total`, `ai.cost.estimated`, …) | low-cardinality aggregates ([`ARCHITECTURE.md`](ARCHITECTURE.md) §16.4) |

**No UI, no dashboard.** Both are NOT ALLOWED this stage ([`AGENTS.md`](../AGENTS.md) §6); an
admin cost dashboard is a recorded future requirement, not a task. These are programmatic,
operator-side surfaces only.

## 9. Out of scope (explicitly)

- billing and payment processing;
- invoices, receipts, statements;
- auto-recharge;
- currency conversion — mixed currencies make a total `partial`, never silently converted;
- per-learner billing — `subjectHash` attributes usage; it does not bill anyone;
- dashboards and admin consoles (UI gate closed);
- durable ledger storage — the host owns persistence later ([`ARCHITECTURE.md`](ARCHITECTURE.md)
  §19); the reference `InMemoryUsageLedger` is volatile by design;
- cost-driven routing (§7.3).
