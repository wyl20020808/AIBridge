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

## Current status — Stage 1

**Architecture only.**

| | |
| --- | --- |
| Real provider connected | **NO** |
| API key configured | **NO** |
| Runtime code shipped | **NO** |
| UI | **NOT ALLOWED in this stage** |
| Production runtime changed | **NO** |

Stage 1 produced architecture, contracts and boundaries only. See
[`Docs/PROJECT_STATUS.md`](Docs/PROJECT_STATUS.md) for the stage gate and
[`Docs/ROADMAP.md`](Docs/ROADMAP.md) for what Stage 2 will build.

## Documents

| Document | What it settles |
| --- | --- |
| [`Docs/ARCHITECTURE.md`](Docs/ARCHITECTURE.md) | Responsibility split, envelopes, errors, providers, routing, reliability, governance, versioning, host integration |
| [`Docs/CAPABILITIES.md`](Docs/CAPABILITIES.md) | Generic primitives vs specialized capability packs, registry, discovery, decision table |
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
