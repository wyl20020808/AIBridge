# AI Bridge — Roadmap

Ten stages. Each stage is releasable and has an exit gate. No stage starts before the previous
one passes.

Stage 1 (this one) is **architecture only** — see [`PROJECT_STATUS.md`](PROJECT_STATUS.md).

---

## Workbench

| # | Stage | Delivers | Depends on |
| --- | --- | --- | --- |
| 1 | **Plugin architecture** | boundaries, capability model, provider boundaries, security, routing, configuration, portability, versioning, this roadmap | — |
| 2 | **Generic AI contracts** | `@aibridge/contracts`, `@aibridge/core` skeleton, `@aibridge/host-sdk` ports + fakes, envelope validators, error model, fixture runner, portability + secret-leak checks | 1 |
| 3 | **Provider runtime + OpenAI-compatible provider** | `@aibridge/runtime`, `@aibridge/provider-openai-compatible` + provider conformance kit + real-provider proof, streaming, ESLint | 2 |
| 4 | **Provider suite & multi-provider qualification** | `@aibridge/provider-openai` (Responses), `@aibridge/provider-deepseek`, `@aibridge/provider-xiaomi-tokenplan`, relay hardening (SSRF), presets, model aliases, profile routing, fallback contract, provider config + diagnostics, live harness | 3 |
| 5 | **Reliability, Fallback & Governance** | ExecutionCoordinator, fallback/retry/repair, circuit breaker + health, idempotency, rate limit, quota, usage ledger + cost, budget, atomic config reload, observability | 4 |
| 6 | **Reliability durability** | *(retry, fallback, repair, idempotency and the breaker were delivered in Stage 5 — see the renumbering note)* — durable idempotency/usage stores as host adapters, clustered breaker state, stream fallback before the first delta | 5 |
| 7 | **Usage + cost durability** | *(ledger, cost, rate, quota and observability were delivered in Stage 5 — see the renumbering note)* — durable quota/rate counters, pricing-history retention, operator reporting exports | 6 |
| 8 | **Specialized capability packs** | `@aibridge/capabilities`: `education.idea.evaluate`, `education.hint.generate`, `learning.summary.generate`, `code.debug.analyze`, `code.explain`; `CapabilityRegistry`; discovery (the narrow commissioned debug foundation below does not close this broader pack stage) | 7 |
| 9 | **OJPlatform integration** | `@aibridge/adapter-ojplatform`, host manifest projection, capability broker gap closure **in the host** (separate approved change) | 8 |
| 10 | **AlgoQuest real-AI E2E** | Idea Lab against a real provider through the bridge; rubric-fallback parity under real failures | 9 |

Deliberate ordering: contracts before providers, one provider before routing, routing before
reliability, reliability before cost controls, packs before any host integration. The one
provider that exists first is the OpenAI-compatible one, because `baseUrl` + `apiKey` + `model`
reaches the widest set of vendors — but only after it is **probed**, never assumed
([`ARCHITECTURE.md`](ARCHITECTURE.md) §7.3).

> **Stage renumbering note.** The approved Stage 4 plan ("Provider Suite & Multi-Provider
> Qualification") replaced the original Stage 4 slot ("Structured generation"). Structured
> extraction + validation landed early as runtime glue in Stage 3; the remaining piece — bounded
> output **repair** — moved into Stage 6 reliability, where `ARCHITECTURE.md` §10.4 already places
> it. Everything else in the track is unchanged.

> **Stage renumbering note.** Stage 5 absorbed the reliability / cost-governance material previously
> scheduled for later rows: retry, fallback, repair, idempotency and the breaker from the old
> "Stage 6" plan; the usage ledger, cost, rate limits, quotas and observability from the old
> "Stage 7" plan. The remaining work for later stages is durable storage, host integration,
> capability packs and UI.

## Commissioned Stage 7 — specialized capability foundation

This separately commissioned, AIBridge-only scope implements the bounded
`code.debug.analyze@1.0` foundation on the existing runtime and structured-generation primitive.
It preserves the historical workbench numbers above: legacy Stage 7 usage/cost durability remains
open, and legacy Stage 8 still covers broader specialized packs. This narrow foundation is
**PARTIAL** pending separately approved OJPlatform adapter/grant/provenance qualification; no real
AlgoQuest consumer E2E was run. See
[`reports/STAGE_7_SPECIALIZED_CAPABILITY_REPORT.md`](reports/STAGE_7_SPECIALIZED_CAPABILITY_REPORT.md).

---

## Stage 2 checklist — "Generic AI Contracts"

Stage 2 is complete. See
[`reports/STAGE_2_GENERIC_AI_CONTRACTS_REPORT.md`](reports/STAGE_2_GENERIC_AI_CONTRACTS_REPORT.md).

> **One deliberate deviation:** `eslint.config.mjs` was **deferred** to Stage 3. Strict TypeScript
> (`strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noUnusedLocals`,
> `verbatimModuleSyntax`), the coupling gate, the runtime-dependency gate and the portability
> typecheck already cover what a minimal ESLint config would have caught in a three-package
> workspace; adding a lint dependency before there is a provider adapter would add churn without a
> failing case to prevent. It is recorded here rather than silently skipped.
> **Paid down in Stage 3:** `npm run lint` exists and runs inside `npm run verify`.

### In scope

- [x] Repository foundation: `package.json` workspaces, `tsconfig.base.json`, `vitest.config.ts`,
      `eslint.config.mjs` (deferred — see the deviation note above), CI workflow running `verify`.
- [x] `@aibridge/contracts` — **zero runtime dependencies**.
  - [x] version constants (`AIBRIDGE_CONTRACT_VERSION` and friends), `parseMajor`,
        `checkMajorCompatibility`.
  - [x] `AiRequestEnvelope`, `AiResult`, `AiError`, `AiUsage`, `ProviderMetadataProjection`,
        `AiWarning`, `FieldSpec`, `OutputSchema`, `ModelProfile`, `CapabilityRequirements`,
        `TimeoutBudget`, `RequestMetadata`, `CancellationToken`.
  - [x] strict parsers: closed key sets everywhere, unknown fields rejected, sorted validation
        issues with rooted `path`s, never a bare throw or boolean.
  - [x] the twelve error codes, the closed reason set, the retryability defaults table
        ([`ARCHITECTURE.md`](ARCHITECTURE.md) §6).
  - [x] capability types: `CapabilityRegistration`, `CapabilityDescriptor`, `CapabilityPolicy`,
        `CapabilityLimits`, `CapabilityAvailability`, `AiBridgeStatus`.
- [x] `@aibridge/core` skeleton.
  - [x] `CapabilityRegistry` (register / get / list, `maxCallsPerTurn` enforcement).
  - [x] `AiCapabilityDirectory` (`listCapabilities`, `getCapability`, `getStatus`).
  - [x] input safety boundary: size caps, metadata allow-list, secret-pattern rejection,
        PII redaction ([`SECURITY.md`](SECURITY.md) §3).
  - [x] kill switches (global / provider / capability).
  - [x] provider + model registry types; `AiProviderAdapter` port; **no real provider**.
- [x] `@aibridge/host-sdk`.
  - [x] host port interfaces (broker, identity, permission, subject token, secret store, usage
        storage) as **ports only** — with in-memory fakes.
  - [x] a scripted provider fake for deterministic tests.
  - [x] the provider conformance kit skeleton ([`TESTING.md`](TESTING.md) §1.1).
- [x] `scripts/check-adapter-coupling.mjs` — fails on `@ojplatform/*`, `@algoquest/*`, or any
      cross-repo source import.
- [x] `scripts/check-no-secret-leak.mjs` — fails on a credential pattern in any committed file.
- [x] Fixture runner: every file in [`fixtures/`](fixtures/) yields its declared `expect` and
      `reason`.
- [x] Contract tests for every area in [`TESTING.md`](TESTING.md) §3.1.

---

## Stage 3 checklist — "Provider Runtime & Reference Adapter"

Stage 3 is complete. See
[`reports/STAGE_3_PROVIDER_RUNTIME_REPORT.md`](reports/STAGE_3_PROVIDER_RUNTIME_REPORT.md).

### In scope

- [x] `@aibridge/runtime` — the formal runtime layer: contract validation (the
      `parseConsumerAiRequest` security boundary + `composeAiRequest`), capability validation
      (registry, versions, permission defence in depth, governance, policy selection, schema
      ownership, `inputAllowList`), provider resolution (`resolveRoute`, per-model feature and
      requirement checks that fail **locally**), trusted secret resolution (`credentialRef` → host
      secret port → `bindCredentials`), execution, the frozen three-deadline timeout arithmetic,
      terminal idempotent cancellation, response normalization and generic error propagation.
- [x] `@aibridge/provider-openai-compatible` — **exactly one** reference adapter. All
      provider-specific detail (payload, headers, base URL, authentication, response shape, error
      body, SSE framing) stays inside it; its transport seam is self-declared so no platform type
      escapes into a published signature.
- [x] Contract compatibility: **additive only** — three error reasons (`PROVIDER_AUTH_FAILED`,
      `PROVIDER_REQUEST_REJECTED`, `PROVIDER_UNAVAILABLE`) and the minimal stream-event contract
      (`AiStreamEvent`), both recorded as compatibility notes in
      [`INTEGRATION_CONTRACT_V1.md`](INTEGRATION_CONTRACT_V1.md). No breaking change; the nine
      fixtures parse unchanged.
- [x] Capabilities: the Stage 2 capability/descriptor contract drives pre-dispatch validation;
      an unsatisfiable requirement is `NO_ROUTE`, never a quiet downgrade.
- [x] Errors: provider/network failures map to the existing twelve-code model
      ([`CONTRACTS.md`](CONTRACTS.md) §4) — invalid request, auth failure, permission, model not
      found, rate limit, provider unavailable, timeout, cancelled, malformed provider response,
      internal error. Provider raw error bodies never cross.
- [x] Streaming: `Provider stream → Adapter → Generic stream events`, deterministic order /
      finish / usage / error behaviour with tests; `ai.text.generate` only (a streamed partial
      judgement is dangerous — [`CAPABILITIES.md`](CAPABILITIES.md) §4).
- [x] Secrets: the credential exists only in the trusted runtime boundary and is proven absent
      from generic requests/responses, error serialization, logs, snapshots and package output.
      `screenAiInput` and the security gates do not regress.
- [x] Deterministic fake-provider tests (no real provider in CI): success, malformed response,
      401/403, 404 model, 429, 5xx, timeout, cancellation, stream success, stream error,
      capability rejection.
- [x] Opt-in live smoke (`npm run test:live-provider`) — `SKIP` without credentials; executed
      manually against a real provider for the exit gate and recorded in the report.
- [x] ESLint (`npm run lint`) inside `npm run verify` — the Stage 2 deferral is paid.
- [x] Portability + CI: the two new packages enter the pack → offline install → typecheck →
      declaration-hygiene → smoke gate; Linux and Windows CI unchanged and green.

### Out of scope for Stage 3 (explicitly)

- UI, provider settings, chat UI, agent UI (never, until the gate is lifted —
  [`AGENTS.md`](../AGENTS.md) §6);
- a provider marketplace, many-provider support, OAuth, billing, cloud sync, a telemetry platform;
- routing/fallback configuration, retry, repair, idempotency, rate limits, quotas (Stages 4–7);
- specialized capability packs (Stage 8), host integration (Stage 9);
- wiring the real provider into any production user flow — the live smoke is a **test path only**.

### Exit gate — `AIBRIDGE_STAGE_3 = PASS` requires

- a real provider answers one generic request end to end through runtime + adapter (recorded
  manually, credential-free output asserted);
- generic error mapping covers the full table and provider prose never penetrates;
- streaming order/finish/usage/error semantics are deterministic and tested;
- timeout and cancellation are terminal and tested, including late-answer discard;
- secret leakage regression tests exist and the secret gate is shown to fail when deliberately
  broken (negative test);
- fake-provider tests cover the full case list without any network;
- the new packages pass the portability gate; `npm run lint` and `npm run verify` are green;
- no UI, no production runtime change, working tree clean, report in `Docs/reports/`.

### Out of scope for Stage 2 (explicitly)

- any real provider, any API key, any network call;
- routing, fallback, retry (Stage 5–6);
- rate limit, quota, usage persistence (Stage 7);
- specialized capability packs (Stage 8);
- any UI (never, until the gate is lifted — [`AGENTS.md`](../AGENTS.md) §6);
- any host modification.

### Exit gate — `AIBRIDGE_STAGE_2 = PASS` requires

- contracts package has zero runtime dependencies and parses every fixture;
- every security test in [`TESTING.md`](TESTING.md) §2 exists and fails the build when a
  synthetic leak is introduced (verified by mutation);
- coupling check and secret-leak check run in `verify`;
- unknown-major rejection demonstrated with a test;
- working tree clean, report in `Docs/reports/`.

---

## Stage 4 checklist — "Provider Suite & Multi-Provider Qualification"

Stage 4 is complete. See
[`reports/STAGE_4_PROVIDER_SUITE_REPORT.md`](reports/STAGE_4_PROVIDER_SUITE_REPORT.md).

### In scope

- [x] Stage 3 audit: generic wire logic vs OpenAI-specific vs provider-specific assumptions
      recorded before extraction (report §audit).
- [x] Shared wire reuse: the OpenAI-compatible wire layer extracted only where **three** adapters
      genuinely reuse it (relay, DeepSeek, Xiaomi), each reuse proven by tests. OpenAI Official
      keeps its own Responses wire path.
- [x] `@aibridge/provider-openai` — OpenAI Official, **Responses API** default path: request
      translation (`instructions` + fenced `input`), native `text.format` strict JSON Schema gated
      on declared `jsonSchema`, semantic streaming events, usage/finish normalization, refusal as
      a signal, official error object mapping. Subscription/web-login explicitly unsupported.
- [x] `@aibridge/provider-deepseek` — thinking / reasoning-effort mapping (explicit, configurable,
      never a silent high), **reasoning-content isolation**, JSON Output as valid-JSON-only, the
      official error table (incl. 402 insufficient balance).
- [x] `@aibridge/provider-xiaomi-tokenplan` — Token Plan auth (`api-key` header; `tp-` prefix as a
      diagnostic hint only), `CN`/`SGP`/`EU` cluster presets with trusted overrides,
      `max_completion_tokens`, thinking toggle, declared-only features.
- [x] `@aibridge/provider-openai-compatible` — positioned as the **Generic OpenAI-Compatible /
      Relay** provider: `AuthScheme` enum, SSRF-safe endpoints (HTTPS, no private/metadata
      targets, integer-IPv4 bypass covered, bounded re-validated redirects), dialect knobs, no
      vendor brand lists.
- [x] Presets (4), model aliases, deterministic profile routing over `resolveRoute`, **no silent
      degrade** (config-enforced), deterministic fallback chain contract (`nextFallback`).
- [x] Capability probe: non-generative only, never at startup; declared vs verified features.
- [x] Provider conformance across all adapters + the base checklist as one table × 4 providers
      (incl. timeout, cancel, secret leak, malicious provider-error sanitization).
- [x] Config contract (`ProviderConfig` / `ModelAliasConfig` / `RouteConfig`) with strict
      validation; in-memory/fixture config only — OJPlatform config untouched.
- [x] Safe diagnostics (`ProviderDiagnostic`) + usage normalization only (no billing).
- [x] Live harness (`test:live-providers` + per-provider scripts), all OPT-IN; relay row
      `LIVE_QUALIFIED` against a real endpoint, others `LIVE_NOT_RUN` without credentials.
- [x] Portability for all 8 packages incl. declaration hygiene; `npm run verify` green.

### Out of scope for Stage 4 (explicitly)

- UI of any kind (never until the gate is lifted — [`AGENTS.md`](../AGENTS.md) §6);
- OpenAI OAuth / subscription login, ChatGPT web endpoints, cookie or session handling;
- a provider marketplace, health scoring, dynamic breakers, cost optimizers;
- automatic runtime fallback/retry (the Stage 4 chain contract is complete; its automatic
  application is Stage 5/6, deliberately not half-implemented);
- billing, quotas, dashboards (governance stages); durable host config (integration stage);
- the Anthropic protocol for Xiaomi and the Responses surface for DeepSeek/Xiaomi (documented as
  deferred protocols);
- any OJPlatform or AlgoQuest modification.

### Exit gate — `AIBRIDGE_STAGE_4 = PASS` requires

- four providers implemented (OpenAI Responses, DeepSeek thinking, Xiaomi Token Plan, relay);
- one base-contract table passes through all four: success, structured, malformed, 401/403, 404
  model, 429, 5xx, timeout, cancel, usage, finish, stream success, stream error;
- reasoning content never leaks; provider raw errors sanitized; credentials never leak;
- SSRF basics hold and a consumer can never set an endpoint;
- model ids are config, routes are deterministic, no silent degrade;
- all conformance + portability + typecheck + lint + gates + tests + build + `npm run verify`;
- OJPlatform and AlgoQuest untouched; working tree clean; report in `Docs/reports/`.

---

## Stage 5 checklist — "Reliability, Fallback & Governance"

Stage 5 is complete. See
[`reports/STAGE_5_RELIABILITY_GOVERNANCE_REPORT.md`](reports/STAGE_5_RELIABILITY_GOVERNANCE_REPORT.md).

### In scope

- [x] `ExecutionCoordinator` (`@aibridge/runtime`) — one logical request becomes provider attempts
      and one terminal result **plus** `ReliabilityProvenance` and `GovernanceSummary`
      (`AiRuntime.executeObserved`; `AiRuntime.execute` keeps its Stage 3 shape);
      `AiRuntime.getProviderHealth()` for diagnostics.
- [x] Logical request / attempt model — `LogicalRequestUsageRecord` vs `ProviderAttemptUsageRecord`
      (primary / retry / fallback / repair, with `parentAttemptId` for repair children); every
      provider paid for is accounted, dropped candidates recorded `SKIPPED` with a reason.
- [x] Fallback policy + automatic fallback — `decideFallback` applied to the chain through
      `nextFallback`; never on request/content failures; provider throttling and provider-scoped
      quota chased only when configured.
- [x] Overall deadline — one budget shared by the chain; each attempt gets
      `min(providerMs, remaining − reserve)`; a chain never costs `n × budget`.
- [x] Retry policy + unknown-outcome safety + backoff — three outcome phases derived from
      `ProviderRawError.dispatched`; max 1 same-provider retry; an unknown outcome repeated only
      under real `supportsReliableIdempotency`; deterministic backoff through `Clock`/`Sleeper`.
- [x] Circuit breaker — `CLOSED/OPEN/HALF_OPEN` keyed `providerId` + `modelAlias`; only
      provider-transient failures count.
- [x] Provider health — `RuntimeHealthRegistry`
      (`HEALTHY/DEGRADED/OPEN_CIRCUIT/DISABLED/UNKNOWN`); health ≠ capability.
- [x] Idempotency + fingerprint conflict + concurrent suppression — `IdempotencyRegistry.gate`
      (hashed fingerprint, in-flight join, `IDEMPOTENCY_CONFLICT`, 15 min / 10 000 LRU).
- [x] Rate limit — sliding window over five dimensions (`subject · callerPlugin · capability ·
      provider · global`), checked before dispatch.
- [x] Quota + reservation — `QuotaManager.reserve`/`settle`; unknown usage settles at the
      conservative reservation, never at zero.
- [x] Usage ledger + reasoning token usage — append-only attempt + logical-request records;
      `AiUsage.reasoningTokens` projects a count only (reasoning content still never crosses).
- [x] Pricing records + cost estimation + request budget — versioned pricing pinned at request
      start, unknown cost ≠ 0, `COST_BUDGET_EXHAUSTED` refuses with zero dispatch.
- [x] Output repair — one bounded repair (frozen §5.3), same provider and model, recorded as a
      child attempt and fully charged.
- [x] Config snapshot + atomic reload + rollback — `RuntimeConfigSnapshot` + `ConfigManager`;
      validated-first, atomic swap, one snapshot bound per in-flight request.
- [x] Observability + operational events + health diagnostics — safe metrics over a closed label
      set, eleven metadata-only operational events, health diagnostics.
- [x] Kill switch + cancellation interaction — switches respected mid-chain (skip and continue on
      the survivors); cancellation stops retry, fallback and repair and is terminal.
- [x] Governance ordering — idempotency gate → rate limit → quota reservation → cost budget before
      dispatch; settlement, ledger and provenance after. One fixed order, tested.
- [x] Property tests (Phase 63), fuzz (Phase 64) and chaos (Phase 65) —
      `tests/properties/reliability.test.ts`.
- [x] Security gates — governance stores mechanically scanned for secrets, prompts, learner text,
      output and reasoning content (`tests/security/governance-privacy.test.ts`); the secret,
      coupling and dependency gates unchanged.
- [x] Portability — 9 packages packed, offline-installed, typechecked (no `node` types),
      declaration-hygiene scanned and smoke-tested, incl. a packed-runtime governance smoke.
- [x] Docs — [`RELIABILITY.md`](RELIABILITY.md), [`GOVERNANCE.md`](GOVERNANCE.md),
      [`USAGE_AND_COST.md`](USAGE_AND_COST.md), [`CONFIG_RELOAD.md`](CONFIG_RELOAD.md), plus the
      Stage 5 compatibility note in
      [`INTEGRATION_CONTRACT_V1.md`](INTEGRATION_CONTRACT_V1.md).
- [x] `npm run verify` green end to end (473 tests).

### Out of scope for Stage 5 (explicitly)

- new providers (the four Stage 4 paths are unchanged);
- AlgoQuest logic or business prompts ([`AGENTS.md`](../AGENTS.md) §9);
- any UI (never until the gate is lifted — [`AGENTS.md`](../AGENTS.md) §6);
- OJPlatform production integration (Stage 9);
- payment / billing **processing** — cost is accounting, not money movement;
- auto-recharge;
- adaptive / ML / cost-driven routing — cost is governance data and must not choose providers;
- dashboards of any kind;
- OJPlatform DB migrations;
- Redis or any distributed store — the store ports have in-memory references only.

### Exit gate — `AIBRIDGE_STAGE_5 = PASS` requires

- deterministic automatic fallback over the chain, never on request or content failures;
- bounded retry (max one same-provider retry, deterministic backoff), with an unknown outcome
  repeated only under reliable idempotency;
- the overall deadline preserved across the chain — no fallback starts below the minimum viable
  budget;
- no silent capability downgrade — a fallback target must satisfy the original requirement set;
- circuit breaker and provider/model health (`providerId`+`modelAlias` keying,
  `HEALTHY`…`UNKNOWN`);
- idempotency per frozen §10 — faithful replay, concurrent duplicate suppression,
  `IDEMPOTENCY_CONFLICT`;
- rate limit, quota and quota reservations enforced before dispatch, and fallback cannot bypass a
  consumer quota;
- usage ledger with every provider attempt accounted and reasoning tokens projected as a count only;
- cost estimation from pinned pricing records, historical pricing stable, unknown cost ≠ 0;
- request budget refuses with `COST_BUDGET_EXHAUSTED` and zero dispatch;
- bounded output repair with its usage fully accounted;
- atomic config reload — an invalid config preserves the old snapshot, one in-flight request uses
  one config snapshot, rollback works;
- observability (metrics, operational events, health diagnostics) with no raw prompt, response or
  secret in metrics or the ledger;
- cancellation stops retry/fallback/repair; kill switches respected;
- property tests, fuzz and chaos green;
- strict typecheck, lint, gates, tests, build and portability green;
- Stage 1–4 suites show no regressions;
- OJPlatform and AlgoQuest untouched; working tree clean; report in [`reports/`](reports/).

---

## AlgoQuest parallel plan

Detail and contract mapping: [`INTEGRATION_CONTRACT_V1.md`](INTEGRATION_CONTRACT_V1.md) §12–15.

### Which AlgoQuest stages need no real AI Bridge

| AlgoQuest stage | Needs real AI Bridge? | Notes |
| --- | --- | --- |
| **6 — AI capability consumer** | **NO** | Build against `GenericAiPort` + the frozen mapping (§12). Back it with `ScriptedIdeaAiProvider` (already exists in AlgoQuest `host-sdk`) and a fixture-driven fake that emits `fixture-set.v1` documents. |
| **7 — Coding Quest** | **NO** | Pure quest/blueprint work. `code.debug.analyze` is a frozen *name*; a coding quest runs judge-only and degrades on AI exactly as Idea Lab does. |
| **8 — AI Debug consumer** | **NO** for the consumer half | Guard, degradation and evidence remain consumer work. A narrow `code.debug.analyze@1.0` foundation was commissioned separately as AI Bridge Stage 7, but host adapter/grant/provenance qualification is incomplete; no real consumer E2E was run. |
| **9 — Scoring** | **NO** | Scoring is explicitly not an AI capability ([`CAPABILITIES.md`](CAPABILITIES.md) §3). |
| Real-AI E2E | **YES** | AI Bridge Stage 10. Everything above must already be green. |

### Recommended AlgoQuest sequencing

1. **Now** — freeze the port boundary (`GenericAiPort` already exists). Add a `FixtureAiPort`
   that reads `Docs/fixtures/fixture-set.v1/` and asserts your own parser's `expect` + `reason`.
2. **Now** — implement the four availability branches
   (`AVAILABLE / DEGRADED / UNAVAILABLE / DISABLED`) and every row of the error→outcome→limitation
   mapping ([`INTEGRATION_CONTRACT_V1.md`](INTEGRATION_CONTRACT_V1.md) §12.5–12.6, §13.1) against
   injected `AiError`s.
3. **Now** — assert one-billable-call-per-turn using `commandId` as `idempotencyKey`.
4. **Now** — verify rubric fallback parity: every degradation row must still cap a rubric turn at
   `PROMISING` and never produce a negative claim.
5. **Later (AI Bridge Stage 8)** — pin the real `education.idea.evaluate@1.0` output schema when
   it stops being `ILLUSTRATIVE`. It is isolated behind one adapter boundary, so this is a
   one-file change.
6. **Last (AI Bridge Stage 10)** — add `AiBridgePort`. One new adapter behind an existing port.
   No rewrite.

### Explicitly not a dependency

AlgoQuest must not add `@aibridge/*` to `@algoquest/contracts`, `@algoquest/core` or
`@algoquest/host-sdk`. If an `adapter-aibridge` package ever exists on that side, it sits beside
`adapter-ojplatform` and follows the same one-way rule.

---

## Future requirements recorded now (not scheduled)

| Requirement | Where it belongs | Why it is not now |
| --- | --- | --- |
| **Admin configuration UI** (providers, models, keys, routing, quotas) | Stage 8+ product decision | UI gate closed ([`AGENTS.md`](../AGENTS.md) §6). Config is file-based meanwhile. |
| Durable idempotency + usage storage | Stage 6/7 durability slice | in-memory is bounded and acceptable for V1 ([`ARCHITECTURE.md`](ARCHITECTURE.md) §19); the ports exist since Stage 5 (`IdempotencyStorePort`, `UsageLedgerPort`). |
| Clustered circuit breaker state | later | Stage 5 ships the in-process breaker ([`ARCHITECTURE.md`](ARCHITECTURE.md) §10.5); sharing breaker state across processes is the future item. |
| **Streaming (`ai.chat.stream`)** | not a capability | [`CAPABILITIES.md`](CAPABILITIES.md) §4: streaming is a delivery concern. The delivery exists since Stage 3 (`AiStreamEvent` on `ai.text.generate`); a capability id for it would freeze a turn model nobody needs. |
| Multi-turn chat | V1.1 | [`CAPABILITIES.md`](CAPABILITIES.md) §1.2. |
| JSON Schema output dialect | later | the field table covers current needs and stays dependency-free. |
| Provider adapters as separate repositories / plugins | later | [`ARCHITECTURE.md`](ARCHITECTURE.md) §7.4. |
| Published `@aibridge/contract-fixtures` package | Stage 8, needs an ADR in both repos | JSON fixtures are enough for two consumers. |
