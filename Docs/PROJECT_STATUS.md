# AI Bridge — Project Status

Authoritative technical documents: [`ARCHITECTURE.md`](ARCHITECTURE.md),
[`CAPABILITIES.md`](CAPABILITIES.md), [`CONTRACTS.md`](CONTRACTS.md),
[`INTEGRATION_CONTRACT_V1.md`](INTEGRATION_CONTRACT_V1.md), [`SECURITY.md`](SECURITY.md).
Per-stage acceptance reports are in [`reports/`](reports/).

| Stage | Scope | State |
| --- | --- | --- |
| 1 | Plugin architecture (boundaries, capability model, provider boundaries, security, routing, configuration, portability, versioning) | **PASS** |
| 2 | Generic AI contracts | **PASS** |
| 3 | Provider runtime & reference adapter | **PASS** |
| 4 | Provider suite & multi-provider qualification | **PASS** |
| 5 | Reliability, Fallback & Governance | **PASS** |
| 6 | OJPlatform host integration + site-wide AI capability broker (includes the durable host-store adapters from the old "Reliability durability" row — see the ROADMAP renumbering notes) | **PASS** |
| 7 | Usage + cost durability (pricing-history retention, operator reporting exports) | not started |
| 8 | Specialized capability packs | not started |
| 9 | AlgoQuest real-AI E2E | not started — explicitly **not** started after Stage 6 |
| 10 | — | — |

See [`ROADMAP.md`](ROADMAP.md) for the stage definitions and the Stage 2 checklist.

## What exists today

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — responsibility split (`AI_BRIDGE_`, `HOST_`,
  `CONSUMER_PLUGIN_`), request/response envelopes, the twelve-code error model with the
  non-penetration rule, provider + model abstraction, profile routing, fallback/retry/repair,
  three-deadline timeout model, idempotency, rate limit vs quota, usage/cost, storage split,
  kill switches, portability rules, package structure, manifest identity, six-part versioning,
  and the eight-item Host Capability Gap list.
- [`CAPABILITIES.md`](CAPABILITIES.md) — two-layer capability model, the two V1 generic
  primitives, the deferred/rejected primitive list, specialized pack definitions for education,
  code, problem and learning, the generic-vs-specialized decision table, `CapabilityRegistry`,
  and capability discovery.
- [`INTEGRATION_CONTRACT_V1.md`](INTEGRATION_CONTRACT_V1.md) — the **frozen** parallel contract
  with the `GenericAiPort` mapping and the AlgoQuest failure semantics.
- [`SECURITY.md`](SECURITY.md) — trust boundaries, secret custody, input safety (reject secrets,
  redact PII), context security with deny-by-default allow-lists, caller identity, permission
  model, log redaction, structural vs business output safety, denial-of-wallet controls.
- [`CONTRACTS.md`](CONTRACTS.md) — the Stage 2 contract reference: what each package exports, the
  consumer/trusted split, schema ownership, the error model, and the gates that enforce them.
- [`TESTING.md`](TESTING.md) — eleven test layers including mechanically asserted secret-leak,
  raw-error non-penetration and `callerPluginId` unforgeability tests.
- [`RELIABILITY.md`](RELIABILITY.md) — fallback, bounded retry and output repair as implemented by
  `ExecutionCoordinator`.
- [`GOVERNANCE.md`](GOVERNANCE.md) — circuit breaker, runtime health, idempotency, rate limit, quota
  and budget.
- [`USAGE_AND_COST.md`](USAGE_AND_COST.md) — usage ledger, pinned pricing records, cost estimation.
- [`CONFIG_RELOAD.md`](CONFIG_RELOAD.md) — runtime config snapshots, atomic reload and rollback.
- [`fixtures/`](fixtures/) — ten compatibility fixtures across two capability families.
- [`ROADMAP.md`](ROADMAP.md) — Stages 1–10, the Stage 2 checklist, the AlgoQuest parallel plan.
- `plugin.manifest.json` — host-neutral identity `ai.bridge`, `"entry": null`.

Stage 2 added three portable packages (`npm` workspaces, ESM, strict TypeScript, project
references):

- `packages/contracts` (`@aibridge/contracts`) — **zero runtime dependencies**. Versions,
  envelopes, the twelve-code error model, strict parsers returning sorted rooted issues,
  capability/descriptor types, the `aibridge.fields/v1` dialect, extraction/validation/repair.
- `packages/core` (`@aibridge/core`) — input-safety boundary, structural output safety,
  `CapabilityRegistry`, `AiCapabilityDirectory`, kill switches, provider/model registries. No
  concrete provider, host or consumer.
- `packages/host-sdk` (`@aibridge/host-sdk`) — host port interfaces, in-memory + mutant fakes, a
  scripted provider, and the host/provider conformance kits.
- Five gates: `check-adapter-coupling.mjs`, `check-no-secret-leak.mjs`, `check-runtime-deps.mjs`,
  a portability gate (`npm run check:portability`), and CI
  (`.github/workflows/verify.yml`).

**Not present, deliberately:** any UI, any host modification, any provider in a production user
flow. `entry` is still `null`.

Stage 4 added three provider packages and hardened the fourth, plus deterministic multi-provider
configuration:

- `packages/provider-openai` (`@aibridge/provider-openai`) — OpenAI Official, **Responses API**
  wire path (independent of the chat adapter): native strict JSON Schema gated on declared
  features, semantic streaming events, reasoning isolation, official error mapping. Official API
  credentials only — subscription web login is explicitly unsupported.
- `packages/provider-deepseek` (`@aibridge/provider-deepseek`) — DeepSeek Official: explicit
  thinking / reasoning-effort mapping (never a silent high), reasoning-content isolation, JSON
  Output as valid-JSON-only, the official error table.
- `packages/provider-xiaomi-tokenplan` (`@aibridge/provider-xiaomi-tokenplan`) — Xiaomi MiMo
  Token Plan: `api-key` auth, `CN`/`SGP`/`EU` cluster presets, `tp-` diagnostics,
  `max_completion_tokens`, thinking toggle.
- `packages/provider-openai-compatible` — repositioned as the **Generic Relay** provider and the
  home of the internal reusable OpenAI-compatible wire layer (three adapters genuinely share it):
  `AuthScheme` enum, SSRF-safe endpoints with bounded re-validated redirects, dialect knobs.
- `@aibridge/runtime` — deterministic multi-provider configuration: presets, model aliases,
  strict config validation, no-silent-degrade profile routing, the fallback chain contract
  (`nextFallback`), declared-vs-verified qualification and credential-free `ProviderDiagnostic`.
- `@aibridge/core` — `endpoint-safety` (fail-closed SSRF checks for operator endpoints).
- Live harness: `npm run test:live-providers` + `test:live:{openai,deepseek,xiaomi-tokenplan,relay}`
  — opt-in, environment-only credentials, `SKIP`/`LIVE_NOT_RUN` without credentials.

Stage 3 added two more portable packages and paid down the ESLint deferral:

- `packages/runtime` (`@aibridge/runtime`) — the trusted execution layer: contract + capability
  validation, provider resolution, trusted secret resolution (`credentialRef` → host secret port →
  `bindCredentials`), execution with the frozen three-deadline timeout arithmetic and terminal
  cancellation, response normalization, generic error propagation, and the operator-only redacted
  diagnostic channel. `execute`/`stream` never throw.
- `packages/provider-openai-compatible` (`@aibridge/provider-openai-compatible`) — the **one**
  reference adapter: `/chat/completions` payload, headers, base URL, authentication, response and
  error-body translation, SSE streaming. Every provider-specific fact stays inside it, and its
  transport seam is self-declared (declaration-hygiene gate).
- `npm run lint` (ESLint) inside `npm run verify`; `npm run test:live-provider` as an **opt-in**
  real-provider smoke (`SKIP` without credentials, never in PR CI).

Stage 5 added one package and extended the runtime — no provider, no UI, no production change:

- `packages/governance` (`@aibridge/governance`) — host-neutral reliability and governance
  primitives (depends only on `@aibridge/contracts` + `@aibridge/host-sdk`): fallback policy,
  bounded retry, circuit breaker + runtime health, idempotency, rate limit, quota with
  reservations, usage ledger, versioned pricing + cost estimation, budget, reliability provenance,
  terminal error selection and safe observability — every stateful piece behind a port
  (`IdempotencyStorePort`, `RateLimitStorePort`, `QuotaStorePort`, `UsageLedgerPort`,
  `ConfigSnapshotStorePort`) with an in-memory reference implementation.
- `@aibridge/runtime` — `ExecutionCoordinator` (logical request → attempts → result + provenance),
  `AiRuntime.executeObserved` / `getProviderHealth()`, `ConfigManager` + `RuntimeConfigSnapshot`
  (validated-first atomic reload and rollback), shared output shaping + bounded repair,
  `enumerateRouteCandidates`, `validateFallbackChain`.
- `@aibridge/contracts` — additive only: `AiUsage.reasoningTokens`, warning `RETRY_USED`, reasons
  `QUOTA_CAPABILITY` / `QUOTA_PROVIDER` / `COST_BUDGET_EXHAUSTED`, versions `1.1`
  ([`INTEGRATION_CONTRACT_V1.md`](INTEGRATION_CONTRACT_V1.md) compatibility note).

## Stage 1 exit gate

`AIBRIDGE_STAGE_1 = PASS`

| Requirement | Evidence |
| --- | --- |
| AI Bridge responsibilities explicit | [`ARCHITECTURE.md`](ARCHITECTURE.md) §1.1 (20 items) |
| Host responsibilities explicit | §1.2 (8 items) |
| Consumer responsibilities explicit | §1.3 (7 items) |
| Generic capability model explicit | [`CAPABILITIES.md`](CAPABILITIES.md) §1 |
| Specialized capability model explicit | §2, §5 |
| `structured.generate` V1 explicit | §1.1 + [`ARCHITECTURE.md`](ARCHITECTURE.md) §11 |
| Request envelope explicit | [`ARCHITECTURE.md`](ARCHITECTURE.md) §4 |
| Response envelope explicit | §5 |
| Error model explicit | §6 (12 codes, 38 reasons, retryability table, non-penetration rule) |
| Model/profile abstraction explicit | §8 |
| Provider abstraction explicit | §7 |
| Routing/fallback semantics explicit | §9, §10 |
| Secret boundary explicit | [`SECURITY.md`](SECURITY.md) §2 |
| Rate/quota model explicit | [`ARCHITECTURE.md`](ARCHITECTURE.md) §15 |
| Usage model explicit | §16 |
| Capability discovery explicit | [`CAPABILITIES.md`](CAPABILITIES.md) §6 |
| Versioning explicit | [`ARCHITECTURE.md`](ARCHITECTURE.md) §24 |
| Host gaps explicit | §25.2 (8 recorded gaps) |
| AlgoQuest integration contract explicit | [`INTEGRATION_CONTRACT_V1.md`](INTEGRATION_CONTRACT_V1.md) §12–13 |
| Parallel development contract frozen | §0–11 + §15.2 `Safe for AlgoQuest Stage 6: YES` |
| Security architecture explicit | [`SECURITY.md`](SECURITY.md) |
| Stage 2 plan explicit | [`ROADMAP.md`](ROADMAP.md) checklist |
| OJPlatform untouched | read-only audit only |
| AlgoQuest untouched | read-only audit only |
| Working tree clean | `git status` clean at the Stage 1 commit |

## Stage 2 exit gate

`AIBRIDGE_STAGE_2 = PASS`

| Requirement | Evidence |
| --- | --- |
| Contracts package compiles, zero runtime deps | `packages/contracts/package.json` (no `dependencies`); `scripts/check-runtime-deps.mjs` |
| Strict parsers, closed key sets, sorted rooted issues | [`CONTRACTS.md`](CONTRACTS.md) §3; `tests/contracts/` |
| Twelve codes, closed reasons, retryability table | [`CONTRACTS.md`](CONTRACTS.md) §4; `tests/contracts/error-model.test.ts` |
| Consumer/trusted split enforced | `parseConsumerAiRequest` rejects `callerPluginId`/`subjectToken`/`permissions`; `tests/security/boundaries.test.ts` |
| Response invariants, no partial results | `tests/contracts/response.test.ts`; `tests/properties/invariants.test.ts` |
| Schema ownership locked | [`CONTRACTS.md`](CONTRACTS.md) §6; `tests/core/registry.test.ts` |
| Every fixture yields its declared `expect` + `reason` | `tests/fixtures/fixtures.test.ts` (9 fixtures) |
| Security tests exist and fail on a synthetic leak | [`TESTING.md`](TESTING.md) §2; `tests/security/`, `check-no-secret-leak.mjs` |
| Coupling + secret-leak checks run in `verify` | `package.json` scripts; `scripts/check-adapter-coupling.mjs` |
| Unknown-major rejection demonstrated | `tests/contracts/versions.test.ts`; `tests/contracts/request.test.ts` |
| Portability proven | `npm run check:portability` (pack → offline install → typecheck → smoke) |
| OJPlatform untouched | read-only audit only |
| AlgoQuest untouched | read-only audit only |
| Working tree clean | `git status` clean at the Stage 2 commit |
| Full report | [`reports/STAGE_2_GENERIC_AI_CONTRACTS_REPORT.md`](reports/STAGE_2_GENERIC_AI_CONTRACTS_REPORT.md) |

## Stage 3 exit gate

`AIBRIDGE_STAGE_3 = PASS`

| Requirement | Evidence |
| --- | --- |
| Generic contract validation | `AiRuntime.#prepare` — `parseConsumerAiRequest` + `composeAiRequest`; `tests/runtime/pipeline.test.ts` |
| Capability validation | registry/version/policy/schema-ownership/`inputAllowList`/requirement checks, all pre-dispatch; `tests/runtime/pipeline.test.ts` |
| Trusted secret boundary | `credentialRef` → `SecretStorePort` → `bindCredentials`; `tests/security/runtime-secrets.test.ts` |
| Reference adapter | [`provider-openai-compatible`](../packages/provider-openai-compatible) — one adapter only |
| Request translation | generic request → `/chat/completions` payload + headers; `tests/provider-openai-compatible/adapter.test.ts` |
| Response normalization | finish reason / usage / projection mapping; adapter + `tests/runtime/pipeline.test.ts` |
| Generic error mapping | full table incl. 401/403, 404 model, 429, 5xx, malformed, internal; `tests/runtime/errors.test.ts` |
| Streaming | `STARTED → TEXT_DELTA* → COMPLETED\|FAILED`, deterministic; `tests/runtime/streaming.test.ts`, `tests/contracts/stream.test.ts` |
| Timeout | `BUDGET_EXHAUSTED` vs `PROVIDER_TIMEOUT`; outbound call abandoned; `tests/runtime/timeout-cancellation.test.ts` |
| Cancellation | pre-dispatch no-charge, in-flight terminal, late answer discarded, outbound abort; same file |
| Secret leakage regression | result/error/stream/request/log/snapshot surfaces; `tests/security/runtime-secrets.test.ts` |
| Negative security test | planted credential file makes `check-no-secret-leak.mjs` exit 1 (asserted as a test and re-run manually) |
| Fake provider tests | success, malformed, 401/403, 404 model, 429, 5xx, timeout, cancellation, stream success, stream error, capability rejection — no network |
| Provider conformance | 9 cases against two adapters via two injection seams; `tests/host-sdk/provider-conformance.test.ts` |
| Package portability | `npm run check:portability` — 5 packages packed, offline-installed, typechecked (no `node` types), declaration-hygiene scanned, smoke-tested |
| Linux CI compatibility | `.github/workflows/verify.yml` (ubuntu-latest) |
| Windows CI compatibility | `.github/workflows/verify.yml` (windows-latest) |
| ESLint | `npm run lint` in `verify` |
| `npm run verify` | green end to end |
| Live provider smoke | `npm run test:live-provider` executed **manually against a real provider** — recorded in [`reports/STAGE_3_PROVIDER_RUNTIME_REPORT.md`](reports/STAGE_3_PROVIDER_RUNTIME_REPORT.md) |
| No UI changes | UI gate untouched |
| No production runtime change | `plugin.manifest.json` unchanged, `entry: null`, `deploy/` untouched |
| Working tree clean | `git status` clean at the Stage 3 commits |
| Full report | [`reports/STAGE_3_PROVIDER_RUNTIME_REPORT.md`](reports/STAGE_3_PROVIDER_RUNTIME_REPORT.md) |

## Stage 4 exit gate

`AIBRIDGE_STAGE_4 = PASS`

| Requirement | Evidence |
| --- | --- |
| OpenAI Official adapter implemented | `@aibridge/provider-openai` (Responses API path) |
| OpenAI Responses / structured / streaming PASS | `tests/provider-openai/adapter.test.ts` + the matrix rows |
| DeepSeek adapter implemented | `@aibridge/provider-deepseek` |
| DeepSeek thinking mapping PASS | `tests/provider-deepseek/adapter.test.ts` (explicit, configurable, no silent high) |
| DeepSeek structured handling PASS | JSON Output = valid JSON only; empty/missing content rows |
| Reasoning content not leaked | shared wire isolation + provider tests + matrix security row |
| Xiaomi Token Plan adapter implemented | `@aibridge/provider-xiaomi-tokenplan` |
| Xiaomi auth / cluster / structured PASS | `tests/provider-xiaomi-tokenplan/adapter.test.ts` |
| Generic Relay PASS | `tests/provider-openai-compatible/*` |
| Trusted custom endpoint + SSRF + consumer cannot override URL | `tests/core/endpoint-safety.test.ts`, wire relay tests, config tests |
| Model IDs are config, not hardcoded | config contract + tests (`MODEL_FROM_CONFIG` ids) |
| Profile routes deterministic, no silent degrade | `tests/runtime/provider-suite.test.ts` |
| Provider raw errors sanitized, credentials never leak | malicious-error matrix row × 4 + `tests/security/runtime-secrets.test.ts` |
| All provider conformance PASS | `tests/provider-suite/conformance.test.ts` (5 adapters) + base table × 4 |
| Package portability PASS | `npm run check:portability` — 8 packages, declaration hygiene, smoke |
| Strict typecheck / lint / gates / tests / build / `npm run verify` | green |
| Live rows | relay `LIVE_QUALIFIED`; OpenAI/DeepSeek/Xiaomi `LIVE_NOT_RUN` (no credentials) |
| OJPlatform / AlgoQuest untouched | read-only audit (report §AlgoQuest) |
| Working tree clean | `git status` clean at the Stage 4 commits |
| Full report | [`reports/STAGE_4_PROVIDER_SUITE_REPORT.md`](reports/STAGE_4_PROVIDER_SUITE_REPORT.md) |

## Stage 5 exit gate

`AIBRIDGE_STAGE_5 = PASS`

| Requirement | Evidence |
| --- | --- |
| Deterministic automatic fallback | `decideFallback` + `ExecutionCoordinator.execute` (`nextFallbackVerdict` over `nextFallback`), stable terminal via `selectTerminalError`; `tests/runtime/fallback-execution.test.ts` |
| Bounded retry + deterministic backoff | `decideRetry`, `classifyRetryPhase`, `backoffDelayMs` (`MAX_SAME_PROVIDER_RETRIES = 1`, `Clock`/`Sleeper`); `tests/runtime/retry-repair.test.ts` |
| Unknown-outcome retry safety | `ProviderRawError.dispatched` + `ProviderDescriptor.supportsReliableIdempotency`; `tests/governance/policy.test.ts` (Phase 8) |
| Overall deadline preserved | one shared budget per logical request; `tests/runtime/fallback-execution.test.ts`, `tests/properties/reliability.test.ts` |
| No silent capability downgrade | `enumerateRouteCandidates` + `validateFallbackChain`; config validation rejects `allowCapabilityDegrade`; `tests/runtime/config-reload.test.ts` |
| Circuit breaker + provider/model health | `CircuitBreaker` / `CircuitBreakerRegistry` (key `providerId`+`modelAlias`), `RuntimeHealthRegistry`, `AiRuntime.getProviderHealth()`; `tests/governance/breaker-health.test.ts` |
| Idempotent turns — replay, join, conflict | `IdempotencyRegistry.gate`, `hashRequestFingerprint` (15 min / 10 000 LRU); `tests/runtime/idempotency-governance.test.ts`, `tests/governance/idempotency-rate-quota.test.ts` |
| Rate limit, quota + reservations | `RateLimiter` (5 dimensions), `QuotaManager.reserve`/`settle`; `tests/governance/idempotency-rate-quota.test.ts` |
| Fallback cannot bypass consumer quota | `decideFallback` never chases own quota/budget limits; `tests/runtime/fallback-execution.test.ts` (Phase 54) |
| Usage ledger + attempt accounting | `InMemoryUsageLedger` (`LogicalRequestUsageRecord` / `ProviderAttemptUsageRecord`); `tests/governance/cost-ledger.test.ts` |
| Reasoning token projection safe | `AiUsage.reasoningTokens` (count only); `tests/governance/cost-ledger.test.ts` (Phase 59) |
| Cost estimation, pinned pricing, unknown ≠ 0 | `PricingTable`, `estimateCost`, `UNKNOWN_COST`; `tests/governance/cost-ledger.test.ts` (Phase 30–33) |
| Request budget | `checkRequestBudget` → `COST_BUDGET_EXHAUSTED`, zero dispatch; `tests/runtime/idempotency-governance.test.ts` (Phase 34) |
| Bounded output repair + accounting | `output.ts` shared shaping + bounded repair; `tests/runtime/retry-repair.test.ts` (Phase 36–38) |
| Atomic reload / rollback / one snapshot per request | `ConfigManager.reload`/`rollback`, `RuntimeConfigSnapshot`, `ConfigSnapshotStorePort`; `tests/runtime/config-reload.test.ts` (Phase 39–43) |
| Observability | `InMemoryMetrics`, `RecordingOperationalEvents` (closed label set, metadata-only); `tests/runtime/observability.test.ts` |
| No prompt/response/secret in metrics or ledger | `tests/security/governance-privacy.test.ts`; [`SECURITY.md`](SECURITY.md) §8 |
| Cancellation / kill switch | cancellation stops retry/fallback/repair; kill-switched candidates skipped; `tests/runtime/idempotency-governance.test.ts` (Phase 50), `tests/runtime/fallback-execution.test.ts` (Phase 49/52) |
| Property / fuzz / chaos | `tests/properties/reliability.test.ts` (Phase 63–65) |
| Additive contract change recorded | [`INTEGRATION_CONTRACT_V1.md`](INTEGRATION_CONTRACT_V1.md) Stage 5 compatibility note, versions `1.1`; `tests/contracts/versions.test.ts` |
| Test suite | **473** tests green (120 new), Stage 1–4 suites included |
| Typecheck / lint / gates / build / portability / verify | `npm run verify` green; 9 packages packed, offline-installed, declaration-hygiene scanned and smoke-tested |
| Live rows | relay `LIVE_QUALIFIED`; OpenAI/DeepSeek/Xiaomi `LIVE_NOT_RUN`; `test:live:reliability` `SKIP` without two credentials (opt-in, never in `verify`) |
| Docs | [`RELIABILITY.md`](RELIABILITY.md), [`GOVERNANCE.md`](GOVERNANCE.md), [`USAGE_AND_COST.md`](USAGE_AND_COST.md), [`CONFIG_RELOAD.md`](CONFIG_RELOAD.md); [`TESTING.md`](TESTING.md) §1.2 |
| No production runtime change | `plugin.manifest.json` unchanged, `entry: null`, `deploy/` untouched |
| OJPlatform / AlgoQuest untouched | read-only audit (report §DEPLOYMENT, §GIT) |
| Working tree clean | `git status` clean at the Stage 5 commits; no remote |
| Full report | [`reports/STAGE_5_RELIABILITY_GOVERNANCE_REPORT.md`](reports/STAGE_5_RELIABILITY_GOVERNANCE_REPORT.md) |

## Stage gates — current state

| Gate | State |
| --- | --- |
| Real provider connected | **TEST PATH ONLY** — opt-in live harness; relay row live-qualified. No provider in any production user flow |
| API key configured | **NEVER COMMITTED** — `credentialRef` handles resolved through the trusted secret boundary |
| Providers implemented | **4** (OpenAI Official, DeepSeek Official, Xiaomi Token Plan, Generic Relay) |
| Tests | **473** passing (151 suites) — Stage 1–4 suites green |
| UI | **NOT ALLOWED** ([`AGENTS.md`](../AGENTS.md) §6) |
| Production runtime changed | **NO** |
| Host modified | **NO** |
| `packages/` created | **YES** — `contracts`, `core`, `host-sdk`, `runtime`, `governance`, `provider-openai-compatible`, `provider-openai`, `provider-deepseek`, `provider-xiaomi-tokenplan` |

## Status update rules

1. One row per stage. State is `PASS`, `PARTIAL`, `FAIL`, or `not started`. No other words.
2. A stage changes to `PASS` only when its exit gate is fully satisfied and a report exists in
   [`reports/`](reports/).
3. "What exists today" is a list of **committed artifacts**, never intentions.
4. A regression re-opens the stage row and adds a note; it does not get silently edited away.
