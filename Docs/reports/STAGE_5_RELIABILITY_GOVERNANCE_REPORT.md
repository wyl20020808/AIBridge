# AI BRIDGE V1 — STAGE 5

# RELIABILITY, FALLBACK & GOVERNANCE

**`AIBRIDGE_STAGE_5 = PASS`**

The multi-provider runtime can now be run **long-term, stably and governably**. Stage 4 proved four
provider paths can be called correctly; Stage 5 makes one logical request survive the ugly cases —
a provider that times out after it may already have billed, two callers racing one turn, a route
chain that must share one deadline, a price table that changes next month, a config reload in the
middle of a call. The mechanism is one `ExecutionCoordinator` under `AiRuntime` (which stays the
public entry) plus a new host-neutral package `@aibridge/governance` — retry, fallback, repair,
breaker, health, idempotency, rate limit, quota, usage ledger, cost, budget, config snapshots and
safe observability, every stateful piece behind a port with an in-memory reference implementation.
No provider was added. No UI. Production runtime unchanged.

## EXECUTION

- Logical requests: `ExecutionPlan` (validated, route-independent) → `ExecutionCoordinator.execute`
  → one terminal `AiResult` **plus** `ReliabilityProvenance` and `GovernanceSummary`
  (`AiRuntime.executeObserved`; `AiRuntime.execute` keeps its Stage 3 signature and returns the
  result alone).
- Provider attempts: each real dispatch is a `ProviderAttemptProvenance` —
  `attemptId · logicalRequestId · sequence · parentAttemptId? (repair) · attemptKind
  (PRIMARY/RETRY/FALLBACK/REPAIR) · providerId · modelAlias · providerModelId (operator-side) ·
  modelClass · routeDepth · routeConfigVersion · startedAt/finishedAt · status ·
  errorCode/errorReason · retryRule/fallbackRule/skipReason · usage · usageKnown · estimatedCost`.
- Coordinator: `packages/runtime/src/coordinator.ts`. Logical request vs attempt is a first-class
  type distinction (Phase 2): one consumer response may be the product of several attempts, and
  every one is accounted.
- Never recorded (Phase 3): prompt, learner data, raw response, credential, reasoning content.

## FALLBACK

- Policy: reason-aware `decideFallback` (Phase 4) over the closed code/reason/stage vocabulary —
  never provider prose. Eligible: `PROVIDER_UNAVAILABLE`, `PROVIDER_OVERLOADED`,
  `PROVIDER_TIMEOUT`, `MODEL_UNAVAILABLE`. Opt-in: provider-originated throttling
  (`fallbackOnRateLimit`) and provider-scoped quota (`fallbackOnQuotaExceeded`). TIMEOUT after an
  unknown outcome only per `crossProviderFallbackOnUnknownOutcome` (default **true** — the frozen
  §7.2 table marks `TIMEOUT` chaseable). **Never**: the caller's own `RATE_LIMIT_*` /
  `QUOTA_SUBJECT|CALLER|CAPABILITY|GLOBAL` / `COST_BUDGET_EXHAUSTED` / kill switches (Phase 53–54),
  request/content/permission failures, `PROVIDER_AUTH_FAILED` and other config faults, `CANCELLED`.
- Automatic execution: Phase 68 matrix green — DeepSeek unavailable → OpenAI succeeds (routeDepth 1,
  `FALLBACK_USED`), content blocked → no fallback, relay 429 → fallback only when configured, all
  candidates failed → stable terminal, candidate disabled / breaker open → skipped and recorded.
- Capability preservation: a fallback target must satisfy the original requirement set — candidate
  enumeration drops unmet hops (`reasoning` never lands on a fast model); `allowCapabilityDegrade`
  is **rejected by config validation** in Stage 5 (only `false` exists). No silent degrade.
- Deadline: one overall deadline shared by the chain; each attempt's deadline is
  `min(providerMs, remaining − reserve)` (Phase 7). Asserted: two hops under a 2 500 ms budget both
  dispatch with deadlines ≤ 2 500 ms — a chain never costs n × budget.

## RETRY

- Policy: `RetryPolicy` with the three outcome phases `BEFORE_DISPATCH` /
  `KNOWN_NOT_ACCEPTED` / `UNKNOWN_OUTCOME_AFTER_DISPATCH`, derived from the adapter's
  `ProviderRawError.dispatched` marker (true / false / **absent = unknown**).
- Safe retries: `BEFORE_DISPATCH` (nothing was spent) retries by default; `KNOWN_NOT_ACCEPTED`
  retries only when the route opts in (`retryKnownNotAccepted`, default **false** — a provider that
  answered is not re-asked automatically). Hard cap **1** same-provider retry (Phase 9) — no
  3/5/10 exponential storm.
- Unknown outcome: **no same-provider automatic retry** unless
  `ProviderDescriptor.supportsReliableIdempotency === true` and the adapter really implements it
  (Phase 8). Tested both ways.
- Backoff: a projected `Retry-After` wins (capped at 4 × ceiling); otherwise deterministic
  `min(250 × 2^(n−1), 2 000)` ms. All waits go through the `Sleeper`/`Clock` seams — no test sleeps
  real time (Phase 62). `RATE_LIMITED` is never retried in process (Phase 10 policy note).

## CIRCUIT BREAKER

- Key: `providerId + modelAlias` (Phase 11) — one bad model never disables a provider's others.
- States: `CLOSED → OPEN → HALF_OPEN → CLOSED|OPEN` (Phase 14).
- Threshold: configurable `failureThreshold` (5) / `windowMs` (60 000) / `cooldownMs` (30 000) /
  `halfOpenProbeLimit` (1). No adaptive statistics (Phase 13).
- Half-open: cooldown → bounded probe traffic; success closes, failure re-opens.
- Only provider/system transient failure counts (Phase 12): `PROVIDER_UNAVAILABLE`,
  `PROVIDER_OVERLOADED`, `PROVIDER_TIMEOUT`. Caller errors, content blocks, cancellations and
  schema faults never move it.
- Health: `RuntimeHealthRegistry` composes observed calls + breaker + operator switch into
  `HEALTHY / DEGRADED / OPEN_CIRCUIT / DISABLED / UNKNOWN` (Phase 15). Health ≠ capability
  (Phase 16). One 429 is never a permanent verdict: a single transient failure stays `HEALTHY` and
  a success ends the episode.

## IDEMPOTENCY

- Registry: `IdempotencyRegistry` over `IdempotencyStorePort` (in-memory reference: TTL 15 min,
  capacity 10 000, LRU — ARCHITECTURE §14.3).
- Fingerprint: `consumerRequestDigest` **hashed** before storage (`hashRequestFingerprint`) — a raw
  digest embeds the request body, and the replay cache is not a prompt archive (Phase 19).
- Duplicate handling (Phase 18): `IN_FLIGHT` → the second caller **joins** (one provider execution
  chain serves both, proven by test); `SUCCEEDED`/`FAILED_FINAL` within retention → the stored
  result is replayed with `IDEMPOTENT_REPLAY`; a replay consumes no quota and no rate budget
  (Phase 51).
- Conflict (Phase 20): the same key with a different fingerprint → `IDEMPOTENCY_CONFLICT`, never a
  stale answer.
- Retention: 15 minutes; trade-off stated honestly — a failed turn replays as failed until it
  expires (one turn is one billable chain).

## RATE LIMIT

- Dimensions: `subject · callerPlugin · capability · provider · global` (Phase 21).
- Algorithm: sliding window over event timestamps (deterministic under a fake clock; no Redis).
- Retry-after: `RATE_LIMITED` + a safe `retryAfterMs` from the window; checked **before** dispatch —
  a refusal makes **zero** provider calls (Phase 22, asserted). The caller's own rate limit never
  silently falls back to a richer provider (Phase 53).

## QUOTA

- Dimensions: scopes `subject · callerPlugin · capability · provider · global` × meters
  `REQUESTS · TOKENS · ESTIMATED_COST` × periods `DAY · MONTH` (calendar buckets) — Phase 23.
- Reservation: reserve the policy amount before dispatch, settle the actual figure after (Phase 25).
  Concurrency test: 10 racing reservations against a 1 000-token limit grant exactly 4 × 250.
- Settlement: **every attempt** settles — failed, retried, fallback and repair attempts included
  (Phase 26). Unknown usage settles at the conservative reservation, recorded `usageKnown: false`,
  **never zero** (Phase 24).
- Fallback interaction: provider-scoped quota may move the call (`fallbackOnQuotaExceeded` opt-in,
  Phase 54); subject/caller/capability/global quotas cannot be routed around — asserted with a
  fallback chain under a caller quota that refuses with zero dispatch.

## USAGE

- Ledger: `UsageLedgerPort` + `InMemoryUsageLedger`, append-only, two record shapes (Phase 27–28):
  `LogicalRequestUsageRecord` (totals, counts, configVersion/digest, idempotency outcome) and
  `ProviderAttemptUsageRecord` (the full attempt provenance above).
- Attempt accounting: every provider that was paid appears — a fallback chain writes one attempt
  record per dispatch plus a `SKIPPED` record per dropped candidate with its reason (Phase 52).
- Reasoning tokens: `AiUsage.reasoningTokens` (additive, Stage 5) is a **count** only; providers
  that report it (DeepSeek chat, OpenAI Responses, chat-dialect relays) project it; reasoning
  **content** stays discarded. Absent means unknown, never 0 (Phase 59).
- Unknown usage: absent fields; `usageKnown: false` in the ledger; `USAGE_ESTIMATED` only when a
  number is actually an estimate.

## COST

- Pricing: `PricingRecord` — `pricingId · version · providerId · modelAlias/modelRef ·
  validFromMs/validUntilMs · currency · input/output/cached/reasoning token prices ·
  PER_1K_TOKENS|PER_1M_TOKENS · source` (Phase 30), validated strictly (overlaps, negatives and
  unpriced records rejected).
- Versioning: the price is **pinned at request start** (Phase 32) and every estimate carries its
  `pricingId` + `pricingVersion`; a later price change cannot rewrite history (tested).
- Estimate: known usage × pinned price (cached and reasoning streams priced separately when the
  rate card says so). Provider-reported cost wins.
- Basis (Phase 31): `PROVIDER_REPORTED | ESTIMATED_FROM_PRICING | UNKNOWN`, projected into the
  frozen `AiUsage.estimatedCost.basis` as `PROVIDER_REPORTED | PRICE_TABLE | ESTIMATED`, with
  `UNKNOWN` projecting to **absent**.
- Unknown cost: **never 0, never "free"** (Phase 31/33) — asserted in result, ledger and summary.

## BUDGET

- Per request: `maxEstimatedCostPerRequest` vs a conservative pre-dispatch estimate.
- Daily/monthly: `maxEstimatedCostPerDay` / `maxEstimatedCostPerMonth`, accounted in the same
  `ESTIMATED_COST` quota buckets so budget and quota cannot disagree.
- Refusal: `COST_BUDGET_EXHAUSTED` with **zero provider dispatch** (Phase 34). The reason is not
  `BUDGET_EXHAUSTED` on purpose — that one is the **time** budget (`TIMEOUT/DEADLINE`) and
  mislabelling cost as time is exactly the semantic drift Phase 55 forbids.
- Fallback: the chain shares one logical request budget (Phase 34); repair shares it too (Phase 38).
- Cost does not drive routing (Phase 35): governance and observability only.

## STRUCTURED REPAIR

- Policy: the frozen §5.3 contract — `outputRepair: 'NONE' | 'ONCE'` (frozen default `'ONCE'`).
- Attempts: exactly **one** bounded repair, same provider and model, recorded as a **child attempt**
  (`parentAttemptId`) with `attemptKind: 'REPAIR'` (Phase 36).
- Usage: the repair is fully charged — attempt record, cost estimate, quota settlement and
  `GovernanceSummary.totalUsage`; the frozen `AiResult.usage` stays the final result's usage while
  the summary carries both (asserted: 15 + 6 tokens = 21 total).
- Failure: a repair that runs and fails → `VALIDATION / OUTPUT_REPAIR_EXHAUSTED` (frozen §5.3); a
  repair **skipped** for lack of budget keeps the original failure (Phase 38). No repair for
  content, permission, config or cancellation failures (Phase 37).

## CONFIG

- Snapshot: `RuntimeConfigSnapshot` — provider suite + routes + fallback + retry + breaker + rate
  + quota + budget + pricing + repair + unknown-usage + kill switches in one immutable generation
  with `configVersion` (`cfg-N`), `contentDigest` and `createdAtMs` (Phase 39–40).
- Reload: `ConfigManager.reload(candidate)` = parse → whole-config validation → cross-references →
  fallback-graph compilation (cycle / duplicate target / impossible target / unbounded chain all
  rejected, Phase 6) → pricing validation → quota validation → SSRF endpoint validation →
  **atomic swap**. Any failure keeps the previous snapshot active and emits
  `ai.config_reload_failed` (Phase 41, tested with five consecutive bad reloads).
- Rollback: `ConfigManager.rollback()` restores the previous valid snapshot (Phase 43).
- In-flight semantics: a request binds its snapshot **at ingress** (before any await) and reads
  routes, policies and pricing from that one object — a reload during an in-flight call changes
  nothing for it (tested: `cfg-1` in flight, `cfg-2` for the next request). Never a mix of route v1
  and pricing v2 (Phase 42).

## OBSERVABILITY

- Metrics (Phase 44): request/success/failure-by-reason, attempt, fallback, retry, breaker-open,
  rate-limited, quota-rejected counts, latency, tokens, estimated cost — over a **closed,
  low-cardinality label set** (`capability · providerId · modelAlias · modelClass · status ·
  errorCode · reason · attemptKind · failureClass · dimension`). No request ids, no subjects, no
  content (Phase 45).
- Events (Phase 47): all eleven — `ai.request_started`, `ai.provider_attempt_started`,
  `ai.provider_attempt_finished`, `ai.fallback_applied`, `ai.retry_applied`, `ai.breaker_opened`,
  `ai.rate_limited`, `ai.quota_rejected`, `ai.request_finished`, `ai.config_reloaded`,
  `ai.config_reload_failed` — metadata-only payloads (string/number/boolean).
- Health: `AiRuntime.getProviderHealth()` (Phase 48) — providerId, modelAlias, state, breaker
  state, generic failure-class counts, lastSuccess/lastFailure. Never a raw provider error.
- Privacy: asserted mechanically (metrics, events and health serialize without provider prose).

## SECURITY

- Secrets: no credential in ledger, metrics, events, breaker state, config history, quota state or
  the operator log — mechanically scanned with the synthetic credential set
  (`tests/security/governance-privacy.test.ts`, Phase 71). Config snapshots hold `credentialRef`
  handles only; a raw credential fails the pattern check (Phase 72).
- Prompt / response / reasoning: none in any store. The idempotency fingerprint is hashed because a
  raw digest **is** the prompt.
- PII: subject tokens appear only as `hashSubjectToken` output (`subjectHash`), never the token
  (Phase 46).
- Logs: provider raw text stays on the operator channel only, credential- and PII-stripped.
- Stated boundary (not silently skipped): the idempotency replay cache holds the consumer-visible
  result — a replay must be faithful (frozen §10.2). It is retention-limited in-memory state, never
  a log; it may not contain credentials, prompts, reasoning content or raw errors (asserted).

## PROVIDERS

- OpenAI: IMPLEMENTED / LIVE_NOT_RUN (unchanged). Now projects `output_tokens_details.
  reasoning_tokens` as a count.
- DeepSeek: IMPLEMENTED / LIVE_NOT_RUN (unchanged). Now projects `completion_tokens_details.
  reasoning_tokens` as a count.
- Xiaomi Token Plan: IMPLEMENTED / LIVE_NOT_RUN (unchanged).
- Relay: IMPLEMENTED / LIVE_QUALIFIED (unchanged).
- Wire-level carry-over only: an honest `dispatched` marker (true = a response arrived,
  false = provably nothing left, absent = unknown) drives retry safety; no provider added, no wire
  shape frozen.

No new providers: **YES**

## TESTS

- Baseline: 353 (Stage 4) → Final: **473** (120 new: governance 58, runtime reliability 45,
  properties/fuzz/chaos 12, security 4, fixtures 1). Stage 1–4 suites all green — three test files
  adjusted with intent preserved (distinct idempotency keys per logical turn per frozen §10, repair
  explicitly `'NONE'` in the Stage 3 pipeline cases, version constant from the contract).
- Property (Phase 63, `tests/properties/reliability.test.ts`): one execution chain per fingerprint;
  a different fingerprint never returns the old result; cancellation never falls back; an invalid
  request never falls back; consumer quota is not routeable-around; the deadline never grows with
  fallback; an open-breaker candidate never dispatches; a failed reload keeps the snapshot; an
  unknown cost never becomes zero; the ledger never contains prompt or raw response text.
- Fuzz (Phase 64): 25 seeded runs over random failures/graphs/breaker/quota/rate/repair — chain
  finite (< 12 attempts), unique attempt ids, monotone sequences, non-negative quota, ledger
  consistent with the provenance, exactly one terminal result.
- Chaos (Phase 65): 12 seeded runs over timeouts, malformed payloads, late answers, 429/503 and
  before-dispatch breaks — the runtime never throws, never loops, never double-terminates.
- Typecheck: strict, PASS. Lint: PASS. Gates (coupling / secrets / deps): PASS. Build: PASS.
- Portability: **9 packages** packed, installed `--offline`, typechecked with `types: []` and
  smoke-tested outside the repo — including a packed-runtime governance smoke (fallback execution,
  provenance, ledger, idempotent replay).
- Verify: `npm run verify` PASS.

## LIVE

- OpenAI: LIVE_NOT_RUN (no credential in this environment — unchanged).
- DeepSeek: LIVE_NOT_RUN (unchanged).
- Xiaomi: LIVE_NOT_RUN (unchanged).
- Relay: LIVE_QUALIFIED (Stage 4, unchanged).
- Reliability smoke: `npm run test:live:reliability` — **SKIP** (`a fallback smoke needs two
  configured providers; found 0`). Opt-in, never part of `verify`, and SKIP never fails the stage
  (Phase 69). No credential was requested or used.

## DEPLOYMENT

Production runtime changed: **NO**. No `D:\OJPlatform` change, no `deploy/`, `compose`, `.env.*`
example or installer touched, `plugin.manifest.json` unchanged (`"entry": null`). No Redis, no
database migration, no env var, no API route.

## UI

**NOT ALLOWED** — no usage dashboard, quota settings, provider health page, routing UI or cost
chart. All governance remains file/config based.

## GIT

- HEAD: see `git log` (Stage 5 slice commits below).
- Commits: `feat(contracts): add additive usage, warning and error extensions for governance` ·
  `feat(governance): add the reliability and governance primitives` ·
  `feat(config): add immutable runtime configuration snapshots with atomic reload` ·
  `feat(runtime): add the execution coordinator with deterministic fallback, bounded retry and repair` ·
  `test(runtime): add fallback, chaos and governance coverage` ·
  `docs: document reliability and the governance model`.
- Status: clean working tree, no remote, OJPlatform and AlgoQuest untouched.

## NEXT

Ready for Host Integration: **YES** — the runtime is now reliable and governable end to end, all
ports have in-memory references, and the surface a host needs (`executeObserved`, the usage ledger,
health diagnostics, `ConfigManager`) is typed, tested and portable.

Known carry-overs:

- **Streaming is single-attempt** — governance applies (kill switch, breaker, rate, quota, budget,
  ledger) but retry/fallback/repair deliberately do not, because partial output has been delivered;
  fallback-before-first-delta is a future refinement.
- **Breaker tuning is construction-time** — a reload updates policies live but not
  `failureThreshold/windowMs/cooldownMs`; changing those needs a restart.
- **Durable stores** — `IdempotencyStorePort` / `UsageLedgerPort` / `QuotaStorePort` /
  `RateLimitStorePort` / `ConfigSnapshotStorePort` have in-memory references only; a host store
  (encrypted, retained) is the integration-stage adapter.
- **Provider payment/balance exhaustion** (`402` / `insufficient_quota`) still normalizes to
  `PROVIDER_AUTH_FAILED` (Stage 4 mapping): the closed vocabulary cannot yet distinguish "broken
  key" from "no credit", so it does not fall back. Recorded as a vocabulary gap, not papered over.
- **Prompt provenance fields** (`promptApplied`/`promptVersion`) — frozen-contract additive change,
  still deferred with the AlgoQuest gap recorded.
- **Adaptive / cost-driven routing** — deliberately not attempted (Phase 35): cost is governance
  data in Stage 5 and must not choose providers until a later stage says how.
- live rows for OpenAI / DeepSeek / Xiaomi pending real credentials.

---

## Stage 4 carry-over audit — closed out this stage

| Carry-over | Status |
| --- | --- |
| automatic fallback/retry application | **DONE** — `ExecutionCoordinator` applies the Stage 4 `nextFallback` contract |
| bounded output **repair** | **DONE** — frozen §5.3, one child attempt, fully charged |
| reasoning **token counts** in usage | **DONE** — additive `AiUsage.reasoningTokens` (count only) |

## Exit gate

| Requirement | Result |
| --- | --- |
| Deterministic automatic fallback | **PASS** |
| Bounded retry | **PASS** |
| Unknown-outcome retry safety | **PASS** |
| Overall deadline preserved | **PASS** |
| No silent capability downgrade | **PASS** |
| Circuit breaker | **PASS** |
| Provider / model health | **PASS** |
| Idempotency | **PASS** |
| Concurrent duplicate suppression | **PASS** |
| Idempotency conflict | **PASS** |
| Rate limit | **PASS** |
| Quota | **PASS** |
| Quota reservation | **PASS** |
| Fallback cannot bypass consumer quota | **PASS** |
| Usage ledger | **PASS** |
| All provider attempts accounted | **PASS** |
| Reasoning token projection safe | **PASS** |
| Cost estimation | **PASS** |
| Historical pricing stable | **PASS** |
| Unknown cost ≠ 0 | **PASS** |
| Request budget | **PASS** |
| Output repair | **PASS** |
| Repair usage accounted | **PASS** |
| Atomic config reload | **PASS** |
| Invalid config preserves old snapshot | **PASS** |
| In-flight request uses one config snapshot | **PASS** |
| Config rollback | **PASS** |
| Observability | **PASS** |
| No raw prompt/response/secret in metrics or ledger | **PASS** |
| Cancellation stops retry/fallback/repair | **PASS** |
| Kill switch respected | **PASS** |
| Property tests | **PASS** |
| Fuzz | **PASS** |
| Chaos | **PASS** |
| Strict typecheck | **PASS** |
| Lint | **PASS** |
| Gates | **PASS** |
| All tests (473) | **PASS** |
| Build | **PASS** |
| Portability (9 packages) | **PASS** |
| Stage 1–4 no regressions | **PASS** |
| OJPlatform untouched | **PASS** |
| AlgoQuest untouched | **PASS** |
| Working tree clean | **PASS** |
