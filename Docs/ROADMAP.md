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
| 3 | **OpenAI-compatible provider** | `@aibridge/provider-openai-compatible` + provider conformance kit + **capability probe** / provider profile | 2 |
| 4 | **Structured generation** | extraction, validation, repair, no-partial-results — `ai.structured.generate` end to end against a fake and against the Stage 3 adapter | 3 |
| 5 | **Routing + config + secrets** | `AiRouter`, `ProviderConfig` / `ModelRouteConfig` / `CapabilityRouteConfig`, secret resolution, config validation + atomic reload | 4 |
| 6 | **Reliability** | timeout budgets, bounded retry, fallback chains, output repair policy, cancellation, idempotency registry, provider disable (breaker-ready) | 5 |
| 7 | **Usage + rate limits** | usage ledger, cost estimation, rate limits, quotas, observability | 6 |
| 8 | **Specialized capability packs** | `@aibridge/capabilities`: `education.idea.evaluate`, `education.hint.generate`, `learning.summary.generate`, `code.debug.analyze`, `code.explain`; `CapabilityRegistry`; discovery | 7 |
| 9 | **OJPlatform integration** | `@aibridge/adapter-ojplatform`, host manifest projection, capability broker gap closure **in the host** (separate approved change) | 8 |
| 10 | **AlgoQuest real-AI E2E** | Idea Lab against a real provider through the bridge; rubric-fallback parity under real failures | 9 |

Deliberate ordering: contracts before providers, one provider before routing, routing before
reliability, reliability before cost controls, packs before any host integration. The one
provider that exists first is the OpenAI-compatible one, because `baseUrl` + `apiKey` + `model`
reaches the widest set of vendors — but only after it is **probed**, never assumed
([`ARCHITECTURE.md`](ARCHITECTURE.md) §7.3).

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

## AlgoQuest parallel plan

Detail and contract mapping: [`INTEGRATION_CONTRACT_V1.md`](INTEGRATION_CONTRACT_V1.md) §12–15.

### Which AlgoQuest stages need no real AI Bridge

| AlgoQuest stage | Needs real AI Bridge? | Notes |
| --- | --- | --- |
| **6 — AI capability consumer** | **NO** | Build against `GenericAiPort` + the frozen mapping (§12). Back it with `ScriptedIdeaAiProvider` (already exists in AlgoQuest `host-sdk`) and a fixture-driven fake that emits `fixture-set.v1` documents. |
| **7 — Coding Quest** | **NO** | Pure quest/blueprint work. `code.debug.analyze` is a frozen *name*; a coding quest runs judge-only and degrades on AI exactly as Idea Lab does. |
| **8 — AI Debug consumer** | **NO** for the consumer half | Guard, degradation and evidence are all buildable now against an illustrative fixture. The real capability lands in AI Bridge Stage 8. |
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
| Durable idempotency + usage storage | Stage 7 | in-memory is bounded and acceptable for V1 ([`ARCHITECTURE.md`](ARCHITECTURE.md) §19). |
| Circuit breaker | Stage 6 or later | architecture is breaker-ready now ([`ARCHITECTURE.md`](ARCHITECTURE.md) §10.5); the state machine is not worth its cost yet. |
| Streaming (`ai.chat.stream`) | V1.1 | [`CAPABILITIES.md`](CAPABILITIES.md) §4. |
| Multi-turn chat | V1.1 | [`CAPABILITIES.md`](CAPABILITIES.md) §1.2. |
| JSON Schema output dialect | later | the field table covers current needs and stays dependency-free. |
| Provider adapters as separate repositories / plugins | later | [`ARCHITECTURE.md`](ARCHITECTURE.md) §7.4. |
| Published `@aibridge/contract-fixtures` package | Stage 8, needs an ADR in both repos | JSON fixtures are enough for two consumers. |
