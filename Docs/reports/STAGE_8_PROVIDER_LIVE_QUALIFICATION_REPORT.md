# AI BRIDGE V1 — COMMISSIONED STAGE 8

# PROVIDER LIVE QUALIFICATION + OPERATIONAL HARDENING

**Status: PASS — qualification system and all deterministic contracts complete; live provider rows
reported separately**

This report records the separately commissioned Stage 8 provider live-qualification work. It does
**not** renumber or close the historical roadmap stages: the legacy Stage 7 usage/cost durability row
and the legacy Stage 8 broader capability-pack row remain open, and the legacy Stage 9 real AlgoQuest
AI E2E has not started.

---

## STATUS

`AIBRIDGE_STAGE_8: PASS`

A portable `@aibridge/qualification` package turns "declared support in code+config" into a repeatable
per-provider/model/feature qualification, with a strict separation between declared, deterministically
tested and live-qualified support. Live provider availability is reported separately per provider and
is **not** required for the stage to pass.

## QUALIFICATION MODEL

- **States**: `DECLARED`, `DETERMINISTIC_TESTED`, `LIVE_QUALIFIED`, `LIVE_FAILED`, `LIVE_NOT_RUN`,
  `UNSUPPORTED`, `STALE` (`packages/qualification/src/status.ts`).
- **Identity**: binds providerId, providerFamily, endpoint kind + cluster, a **safe endpoint
  projection** (`{scheme,host,port?}`), modelAlias, a **safe provider-model ref**, the feature,
  adapter version, contract version and a **config digest** (`identity.ts`). No credential, no raw
  URL-with-secrets, no prompt.
- **Record**: a closed, safe shape with a builder + validator that rejects any secret-bearing key and
  restricts notes to a closed code set (`record.ts`).
- **Staleness**: pure evaluation over model / endpoint / cluster / adapter / contract / config /
  declaration / age drift (`staleness.ts`).
- **Storage**: `QualificationStorePort` + `InMemoryQualificationStore` + versioned
  `FileQualificationStore` (host-supplied I/O). Bounded retention per identity (`store.ts`,
  `file-store.ts`).
- **History**: newest-first, capped per `(providerId, modelAlias, feature)`.

## DECLARED VS VERIFIED

- **Declared**: the model's `features` in config; assurance `DECLARED`.
- **Deterministic**: proven by a fake-transport probe; assurance `DETERMINISTIC_TESTED`.
- **Live**: proven by a real run through adapter → `AiRuntime` → extraction → strict validator;
  assurance `LIVE_QUALIFIED`.
- A single feature's live success never marks the provider, other models or other features verified.
- `DECLARATION_MISMATCH` is recorded as a note; production config is never auto-modified.

## OPENAI

- **Credential: ABSENT** (the environment uses a ChatGPT subscription web login, which is **not** an
  API credential — no cookie handling, no session extraction, by policy).
- Text / Structured / JSON Schema / Streaming / Usage / Cancellation: `LIVE_NOT_RUN`.
- **Overall: `IMPLEMENTED` + `LIVE_NOT_RUN`** — an acceptable Stage 8 outcome, not a defect.

## DEEPSEEK

- **Credential: ABSENT.** Text / Structured / Reasoning / Streaming / Usage: `LIVE_NOT_RUN`.
  Cancellation: framework present, `LIVE_NOT_RUN`.
- **Overall: `IMPLEMENTED` + `LIVE_NOT_RUN`.**

## XIAOMI

- **Credential: ABSENT.** Cluster presets `CN`/`SGP`/`EU` supported; per-cluster qualification
  available but not run.
- Text / Structured / Streaming / Usage: `LIVE_NOT_RUN`. Reasoning: not declared for the Token Plan
  chat preset. Cancellation: framework present, `LIVE_NOT_RUN`.
- **Overall: `IMPLEMENTED` + `LIVE_NOT_RUN`.** One cluster's result would never imply another.

## RELAY

- **Credential: ABSENT in this session.** Historical status: one real round trip
  (`LIVE_QUALIFIED`, Stage 4). This session does not rewrite that history: a credential-less run is
  `LIVE_NOT_RUN` / `LAST_KNOWN_LIVE_QUALIFIED`, never `LIVE_FAILED`.
- Text / Structured / JSON Schema / Streaming / Usage / Cancellation: `LIVE_NOT_RUN` this session.
- **Overall: `IMPLEMENTED` + `LIVE_NOT_RUN` (this session).**

## QUALIFICATION RUNNER

- **Commands**: `npm run qualify:providers` | `qualify:openai` | `qualify:deepseek` | `qualify:xiaomi`
  | `qualify:relay` — all opt-in, never part of `verify` (Phases 28, 56).
- **Safe output** (Phase 29): provider id, model alias, feature, status, latency, usage summary, coarse
  failure class. No credential, Authorization header, prompt text, full response or reasoning content.
- **Missing credentials**: `LIVE_NOT_RUN`, never a failure; one provider's absence does not stop the
  others (Phases 9, 43).
- **Config validation** (Phase 34): invalid request ⇒ `CONFIG_INVALID` / `CONFIG_FAILURE` record, not
  a failed dispatch.
- **Single orchestrator** (Phase 27): `ProviderQualificationRunner`; provider wire stays in the
  adapter, the runner only orchestrates.

## OPERATIONAL HARDENING

- **Diagnostics** (Phase 30): `getQualificationStatus()` returns a safe per-provider/model/feature
  view (status, staleness + reasons, latency, usage, coarse failure).
- **Health separation** (Phase 31): a `LIVE_QUALIFIED` model whose provider is now 503 keeps its
  historical qualification; runtime health reports `DEGRADED`. Never merged.
- **Config drift** (Phase 6): config-digest / endpoint / cluster change ⇒ `STALE`.
- **Model drift** (Phase 36): same alias + changed provider model id ⇒ `STALE`.
- **Staleness** (Phase 6): adapter/contract/declaration changes ⇒ `STALE`; optional age bound, no
  automatic expiry in V1.
- **No startup probe** (Phases 54, 55): qualification is explicit operator action only.

## SECURITY

- **Credentials** (Phases 9, 38, 42): environment-only; never committed, logged, returned or
  persisted. No disk scan, no browser cookie, no ChatGPT session extraction.
- **Prompt**: never present in an identity, record, CLI output, log or report.
- **Raw response** (Phases 4, 39): never persisted; a poisoned provider error body is sanitized by
  construction.
- **Reasoning content** (Phase 19): never exposed to a consumer, a record, a log or an event; only
  `reasoningTokens` counts may be recorded.
- **PII** (Phase 38): no learner data in any synthetic qualification prompt.
- **Logs** (Phase 6): redaction unchanged; qualification adds no new log surface.
- **Report** (Phase 40): this document contains no credential, prompt or raw response.

## INTEGRATION FREEZE (Phase 47)

- `code.debug.analyze@1.0` schema/version: **UNCHANGED**.
- `promptApplied` / `promptVersion` semantics: **UNCHANGED**.
- Trusted instructions / untrusted context channels: **UNCHANGED**.
- Consumer-managed prompt ownership: **UNCHANGED**.
- OJ host specialized dispatch contract: **UNCHANGED**.
- AlgoQuest compatibility contract: **UNCHANGED**.

Asserted mechanically by `tests/qualification/integration-freeze.test.ts`.

## TESTS

- **Baseline**: 558 tests / 50 files, `verify` PASS (preflight).
- **Final**: 629 tests / 57 files, all passing.
- **Property** (Phase 51): `tests/properties/qualification-invariants.test.ts`.
- **Fuzz** (Phase 52): `tests/properties/qualification-fuzz.test.ts`.
- **Typecheck**: PASS (`tsc -b` + `tsc -p tsconfig.test.json --noEmit`).
- **Lint**: PASS (`eslint .`).
- **Gates**: PASS (coupling, secrets, deps — the new package is registered in all three).
- **Build**: PASS (`tsc -b`).
- **Portability**: PASS — the new package is packed, offline-installed, typechecked and smoke-tested;
  declaration-hygiene clean.
- **Verify**: PASS (`npm run verify`, end to end).

## LIVE SUMMARY

| Provider | Credential | This session |
| --- | --- | --- |
| OpenAI | ABSENT | `LIVE_NOT_RUN` |
| DeepSeek | ABSENT | `LIVE_NOT_RUN` |
| Xiaomi | ABSENT | `LIVE_NOT_RUN` |
| Relay | ABSENT | `LIVE_NOT_RUN` (historically `LIVE_QUALIFIED`) |

All four are `IMPLEMENTED`. A `LIVE_NOT_RUN` row never fails the stage (Phase 56).

## REPOS

- **OJPlatform modified: NO** (read-only; `main` at `431ca663f777cf6190eff5b70730f2d8f3bf2deb`, one
  pre-existing untracked PNG untouched).
- **AlgoQuest modified: NO** (read-only; `main` at `a8da1c8e38533ec299d1b88ccb3fc4c31994956e`, tree
  clean).

## DEPLOYMENT

- **Production runtime changed: NO.** Qualification is a separate package plus opt-in scripts; no
  `deploy/`, `compose*.yaml`, `.env.*` example or installer was touched.
- **Automatic startup probes: NONE.** Production startup never fails if a qualification endpoint is
  offline (Phases 54, 55).

## UI

**NOT IMPLEMENTED** — the UI gate remains closed (AGENTS.md §6).

## GIT

- Branch: `feature/stage8-provider-live-qualification` (no remote, by policy).
- Commits:
  - `7266bac` `feat(qualification): add provider qualification model and runner`
  - `2174ddc` `test(qualification): add live-safe provider qualification harness`
  - `6bc2a82` `docs: document provider live qualification`
- Base: `3fbe8cd` (canonical `main`).
- Working tree clean at stage end.
- Merged into canonical `main` with `--no-ff` as `0a7f091` (see the addendum below).

## NEXT

- **Ready for a future AlgoQuest Real-AI Sync: framework YES; live-qualified provider NO** — no
  provider was live-qualified in this session. The qualification framework is complete and will accept
  the first real provider whose credential is supplied.
- **Recommended provider for the first Real-AI Sync**: only from an actually `LIVE_QUALIFIED` provider.
  Historically the Generic OpenAI-Compatible Relay is the only one that has ever completed a real
  round trip; it becomes the recommended candidate once a credential is supplied and
  `npm run qualify:relay` reports `LIVE_QUALIFIED`.
- **Known carry-overs**: OpenAI subscription login is not an API credential (Phase 41); DeepSeek has
  no official key here; Xiaomi Token Plan has no `tp-` credential here; the Relay credential is
  absent in this session.
- Stop policy (Phase 60) respected: no frozen contract change, no OJPlatform/AlgoQuest modification,
  no destructive operation, no unfixed secret issue.

---

# ADDENDUM — CANONICAL MERGE + CURRENT REAL RELAY QUALIFICATION

This addendum supersedes the "live-qualified provider NO" statement in the `NEXT` section above for the
current canonical revision. It records the canonical merge of Stage 8 and the first real provider
qualification run through the Stage 8 runner.

## Canonical merge

- Base (`main` before): `3fbe8cd7ed55fdc5b7a2fba11edc24b0bf6b7506`.
- Feature head: `6bc2a82` (`feature/stage8-provider-live-qualification`).
- Merge commit (`--no-ff`, no conflicts): `0a7f091`.
- Canonical `npm run verify`: **PASS** (typecheck, lint, gates, 629 tests / 57 files, build,
  portability — 12 packages packed, offline-installed, typechecked, smoke-tested).
- Working tree clean; no remote.

## Current real Relay qualification

- Provider family: **Generic OpenAI-Compatible Relay** (`openai-compatible`), preset
  `OPENAI_COMPATIBLE_CUSTOM`, adapter `OpenAiCompatibleAdapter`, auth `BEARER`.
- Model alias: `live.primary`; safe model ref: `deepseek-v4.#987198450affc76e`.
- Safe endpoint projection: `https` / `hgapi.dieqiyun.top` (no path, query or credential recorded).
- Feature declaration: `text, structuredJson, streaming, usage`. `reasoning` deliberately **not**
  declared (a relay's DeepSeek may not expose official reasoning semantics).
- Command: `npm run qualify:relay` (credentials injected process-only; never written to disk).

| Feature | Status | Latency | Safe usage | Finish |
| --- | --- | --- | --- | --- |
| text | **LIVE_QUALIFIED** | 2305 ms | in 13 / out 2 / total 15 | STOP |
| structuredJson | **LIVE_QUALIFIED** | 2140 ms | in 67 / out 6 / total 73 | STOP |
| streaming | **LIVE_QUALIFIED** | 1108 ms | (not reported on terminal) | STOP |
| usage | **LIVE_QUALIFIED** | 1273 ms | in 13 / out 2 / total 15 | STOP |

- Config digest: `cfg#79f7be7b5679c455`; adapter version `1.0.0`; contract version `1.1`.
- **JSON_SCHEMA / REASONING / CANCELLATION**: not declared for this relay model and therefore not
  probed. Their deterministic adapter tests remain authoritative.
- **Transient note**: a first run returned `LIVE_FAILED` / `ADAPTER_BUG` on `usage` only; a repeated
  run qualified it. The raw endpoint and repeated isolated calls returned well-formed bodies, so this
  was a transient upstream `PROVIDER_BAD_RESPONSE` (the shipped classifier is conservative and flags
  any unparseable response as `ADAPTER_BUG`). No adapter defect was found; no code was changed.
- **DECLARATION_MISMATCH**: none — every declared feature qualified.

## Security

- Credential: **PRESENT** (process-only), absent from source, config, docs, logs, git, the
  qualification record and the environment. Repo-wide scan for the key: **no match**.
- Prompt persisted: **NO**. Raw response persisted: **NO**. Reasoning content persisted: **NO**.

## Integration freeze

`code.debug.analyze@1.0`, `promptApplied` / `promptVersion`, the trusted/untrusted channels and the
OJ host contract are **UNCHANGED**. OJPlatform and AlgoQuest were **not modified**.

## Current status

- Relay: `IMPLEMENTED`; current TEXT / STRUCTURED_JSON / STREAMING / USAGE = `LIVE_QUALIFIED`.
- A `LIVE_QUALIFIED` provider is now available for a future AlgoQuest Real-AI Sync; the recommended
  provider is the **Generic OpenAI-Compatible Relay**.

