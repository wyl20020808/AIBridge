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

## Current status — Stage 3

**Provider runtime and one reference adapter proven against a real provider. No UI. No production
change.**

| | |
| --- | --- |
| Real provider connected | **TEST PATH ONLY** — one opt-in live smoke, recorded in the report |
| API key configured | **NEVER COMMITTED** — resolved through the trusted secret boundary at runtime |
| Runtime code shipped | **YES** — five dependency-free packages |
| UI | **NOT ALLOWED** |
| Production runtime changed | **NO** |

Stage 1 produced architecture. Stage 2 produced the generic contracts. Stage 3 drove them through a
real AI provider: `@aibridge/runtime` (validation, provider resolution, trusted secret resolution,
execution, timeout, cancellation, normalization, generic errors) and
`@aibridge/provider-openai-compatible` (the one reference adapter), plus the streaming contract,
deterministic fake-provider tests, secret-leakage regression tests, ESLint, and one recorded real
round trip. See [`Docs/CONTRACTS.md`](Docs/CONTRACTS.md) for the exported surface,
[`Docs/PROJECT_STATUS.md`](Docs/PROJECT_STATUS.md) for the stage gates and
[`Docs/reports/STAGE_3_PROVIDER_RUNTIME_REPORT.md`](Docs/reports/STAGE_3_PROVIDER_RUNTIME_REPORT.md)
for the acceptance report.

## Packages

| Package | Role | Runtime deps |
| --- | --- | --- |
| `@aibridge/contracts` | versions, envelopes, error model, strict parsers, capability/descriptor types, `aibridge.fields/v1`, stream events, prompt channels | **zero** |
| `@aibridge/core` | input safety, structural output safety, capability registry + directory, kill switches, provider/model registries | `@aibridge/contracts` |
| `@aibridge/host-sdk` | host ports, in-memory + mutant fakes, scripted provider, host/provider conformance kits | `@aibridge/contracts`, `@aibridge/core` |
| `@aibridge/runtime` | contract + capability validation, provider resolution, trusted secret resolution, execution, timeout, cancellation, normalization, generic errors | `@aibridge/contracts`, `@aibridge/core`, `@aibridge/host-sdk` |
| `@aibridge/provider-openai-compatible` | the reference provider adapter — all provider wire shape stays inside | `@aibridge/contracts` |

Verify locally with `npm run verify` (strict typecheck → lint → gates → tests → build →
portability). Run one real provider round trip, when credentials exist, with
`npm run test:live-provider`.

## Documents

| Document | What it settles |
| --- | --- |
| [`Docs/ARCHITECTURE.md`](Docs/ARCHITECTURE.md) | Responsibility split, envelopes, errors, providers, routing, reliability, governance, versioning, host integration |
| [`Docs/CAPABILITIES.md`](Docs/CAPABILITIES.md) | Generic primitives vs specialized capability packs, registry, discovery, decision table |
| [`Docs/CONTRACTS.md`](Docs/CONTRACTS.md) | Stage 2 contract reference: package surfaces, consumer/trusted split, schema ownership, gates |
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
