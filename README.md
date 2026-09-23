# AI Bridge

A **general-purpose AI capability provider plugin**.

AI Bridge turns several AI providers into one stable, governed, uniform **AI capability**
surface. Other plugins consume that surface through the host capability system. AI Bridge is
not a chatbot, not an agent framework, not a prompt collection, not a wrapper around one
vendor SDK, and not part of any single product's business logic.

```
Consumer plugin
      │  Host capability
      ▼
   AI Bridge
      ├─ provider adapter A
      ├─ provider adapter B
      └─ provider adapter C
```

## Current status — Stage 4

**Four real provider paths, one runtime, one generic result. No UI. No production change.**

| | |
| --- | --- |
| Providers implemented | **4** — OpenAI Official (Responses), DeepSeek Official, Xiaomi MiMo Token Plan, Generic OpenAI-Compatible Relay |
| Real provider connected | **TEST PATH ONLY** — opt-in live harness (relay row live-qualified) |
| API key configured | **NEVER COMMITTED** — `credentialRef` handles through the trusted secret boundary |
| Runtime code shipped | **YES** — eight dependency-free packages |
| UI | **NOT ALLOWED** |
| Production runtime changed | **NO** |

Stage 1 produced architecture. Stage 2 produced the generic contracts. Stage 3 drove them through a
real provider. Stage 4 built the **provider suite**: `@aibridge/provider-openai` (Responses API),
`@aibridge/provider-deepseek` (thinking + reasoning isolation), `@aibridge/provider-xiaomi-tokenplan`
(Token Plan auth + clusters) and the hardened `@aibridge/provider-openai-compatible` (generic
relay, SSRF-safe endpoints), plus deterministic multi-provider configuration (presets, model
aliases, profile routing, no silent degrade). Consumers still never learn which vendor served a
call. See [`Docs/PROVIDERS.md`](Docs/PROVIDERS.md),
[`Docs/PROVIDER_CONFIGURATION.md`](Docs/PROVIDER_CONFIGURATION.md),
[`Docs/PROJECT_STATUS.md`](Docs/PROJECT_STATUS.md) and
[`Docs/reports/STAGE_4_PROVIDER_SUITE_REPORT.md`](Docs/reports/STAGE_4_PROVIDER_SUITE_REPORT.md).

## Packages

| Package | Role | Runtime deps |
| --- | --- | --- |
| `@aibridge/contracts` | versions, envelopes, error model, strict parsers, capability/descriptor types, `aibridge.fields/v1`, stream events, prompt channels | **zero** |
| `@aibridge/core` | input safety, structural output safety, capability registry + directory, kill switches, provider/model registries, endpoint (SSRF) safety | `@aibridge/contracts` |
| `@aibridge/host-sdk` | host ports, in-memory + mutant fakes, scripted provider, host/provider conformance kits | `@aibridge/contracts`, `@aibridge/core` |
| `@aibridge/runtime` | pipeline, multi-provider config (presets, aliases, routes), trusted secret resolution, fallback chain contract, safe diagnostics | `@aibridge/contracts`, `@aibridge/core`, `@aibridge/host-sdk` |
| `@aibridge/provider-openai-compatible` | Generic Relay provider + the internal OpenAI-compatible wire layer | `@aibridge/contracts`, `@aibridge/core` |
| `@aibridge/provider-openai` | OpenAI Official (Responses API) | `@aibridge/contracts`, `@aibridge/core` |
| `@aibridge/provider-deepseek` | DeepSeek Official (thinking, reasoning isolation) | `@aibridge/contracts`, `@aibridge/core`, `@aibridge/provider-openai-compatible` |
| `@aibridge/provider-xiaomi-tokenplan` | Xiaomi MiMo Token Plan (auth, clusters) | `@aibridge/contracts`, `@aibridge/core`, `@aibridge/provider-openai-compatible` |

Verify locally with `npm run verify` (strict typecheck → lint → gates → tests → build →
portability). Live qualification is opt-in and never in CI:
`npm run test:live-providers` (or `test:live:openai` / `test:live:deepseek` /
`test:live:xiaomi-tokenplan` / `test:live:relay`).

## Documents

| Document | What it settles |
| --- | --- |
| [`Docs/ARCHITECTURE.md`](Docs/ARCHITECTURE.md) | Responsibility split, envelopes, errors, providers, routing, reliability, governance, versioning, host integration |
| [`Docs/CAPABILITIES.md`](Docs/CAPABILITIES.md) | Generic primitives vs specialized capability packs, registry, discovery, decision table |
| [`Docs/PROVIDERS.md`](Docs/PROVIDERS.md) | The provider suite: wire protocols, auth, structured/streaming/reasoning semantics, limitations, live status |
| [`Docs/PROVIDER_CONFIGURATION.md`](Docs/PROVIDER_CONFIGURATION.md) | Presets, model aliases, routes, secrets, SSRF rules, diagnostics |
| [`Docs/CONTRACTS.md`](Docs/CONTRACTS.md) | Contract reference: package surfaces, consumer/trusted split, schema ownership, gates |
| [`Docs/INTEGRATION_CONTRACT_V1.md`](Docs/INTEGRATION_CONTRACT_V1.md) | **Frozen parallel contract** for consumer plugins (AlgoQuest Stage 6) |
| [`Docs/SECURITY.md`](Docs/SECURITY.md) | Secret boundary, PII/secret input policy, permissions, log redaction |
| [`Docs/TESTING.md`](Docs/TESTING.md) | Test strategy, incl. mechanically asserted secret-leak tests |
| [`Docs/ROADMAP.md`](Docs/ROADMAP.md) | Stage 2–10 plan and the AlgoQuest parallel plan |
| [`Docs/PROJECT_STATUS.md`](Docs/PROJECT_STATUS.md) | Stage ledger and exit-gate evidence |
| [`Docs/fixtures/`](Docs/fixtures/) | Shared JSON contract fixtures, no cross-repo code import |

## Rules this repository lives by

- **Host neutral.** No `@ojplatform/*` and no `@algoquest/*` dependency in any core contract.
- **Secrets are server-side only.** Never in a browser bundle, a consumer plugin, a request
  envelope, or a log line. Never committed.
- **Provider raw output is never a public contract.** Provider errors are normalized before
  they cross the boundary.
- **Unknown major versions are rejected**, never best-effort parsed.

Read [`AGENTS.md`](AGENTS.md) before changing anything.
