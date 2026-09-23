# AI Bridge — Project Status

Authoritative technical documents: [`ARCHITECTURE.md`](ARCHITECTURE.md),
[`CAPABILITIES.md`](CAPABILITIES.md), [`CONTRACTS.md`](CONTRACTS.md),
[`INTEGRATION_CONTRACT_V1.md`](INTEGRATION_CONTRACT_V1.md), [`SECURITY.md`](SECURITY.md).
Per-stage acceptance reports are in [`reports/`](reports/).

| Stage | Scope | State |
| --- | --- | --- |
| 1 | Plugin architecture (boundaries, capability model, provider boundaries, security, routing, configuration, portability, versioning) | **PASS** |
| 2 | Generic AI contracts | **PASS** |
| 3 | OpenAI-compatible provider | not started |
| 4 | Structured generation | not started |
| 5 | Routing + config + secrets | not started |
| 6 | Reliability | not started |
| 7 | Usage + rate limits | not started |
| 8 | Specialized capability packs | not started |
| 9 | OJPlatform integration | not started |
| 10 | AlgoQuest real-AI E2E | not started |

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
- [`fixtures/`](fixtures/) — nine compatibility fixtures across two capability families.
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

**Not present, deliberately:** any provider implementation, any API key, any network call, any
UI, any host modification. `entry` is still `null`.

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

## Stage gates — current state

| Gate | State |
| --- | --- |
| Real provider connected | **NO** |
| API key configured | **NO** |
| UI | **NOT ALLOWED** ([`AGENTS.md`](../AGENTS.md) §6) |
| Production runtime changed | **NO** |
| Host modified | **NO** |
| `packages/` created | **YES** — `contracts`, `core`, `host-sdk` (code + tests) |

## Status update rules

1. One row per stage. State is `PASS`, `PARTIAL`, `FAIL`, or `not started`. No other words.
2. A stage changes to `PASS` only when its exit gate is fully satisfied and a report exists in
   [`reports/`](reports/).
3. "What exists today" is a list of **committed artifacts**, never intentions.
4. A regression re-opens the stage row and adds a note; it does not get silently edited away.
