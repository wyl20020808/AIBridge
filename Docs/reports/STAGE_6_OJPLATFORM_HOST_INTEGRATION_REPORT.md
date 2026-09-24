# AI BRIDGE V1 — STAGE 6

# OJPLATFORM HOST INTEGRATION + SITE-WIDE AI CAPABILITY BROKER

**`AIBRIDGE_STAGE_6 = PASS`**

AI Bridge is now a **site-wide capability provider** inside OJPlatform, behind a generic broker
that is deliberately not AI-shaped. Two repositories, committed separately; they meet only at
npm-packed artifacts and at the frozen contract. The seam carries everything a host must own —
trusted caller identity for both PLUGIN and SITE CORE callers, deny-by-default permissions,
per-caller rate/quota, usage attribution, kill switches, opaque subject tokens — and nothing it
must not: no UI, no public raw-prompt proxy, no credential in the browser, no prompt/output in
the ledger, no AlgoQuest change, no business AI feature. AI is optional: a deployment with no AI
configuration and no installed artifacts boots normally with every AI capability honestly
`UNAVAILABLE`. Along the way the packed-artifact qualification caught three real bugs (a forked
kill-switch registry, collapsed kill-switch reasons, dropped adapter wire options) and two
vocabulary gaps deferred since Stages 4 and 5 were closed
(`PROVIDER_BALANCE_EXHAUSTED`; prompt provenance labels).

## HOST PORTS

- Entry: `@aibridge/host` `createAiBridgeServerPlugin({config, adapterFactories, resolveEndpoint,
  secrets, stores, clock})` → `AiBridgeServerPlugin` (`execute`/`stream`/`listCapabilities`/
  `status`/`reload`/`diagnostics`/`configSnapshot`/`dispose`). Documented in
  [`HOST_INTEGRATION.md`](../HOST_INTEGRATION.md).
- Consumption is **npm-packed artifacts only** — 11 packages (`contracts`, `core`, `host-sdk`,
  `governance`, `runtime`, four providers, `host`, `suite-all`). No cross-repo source import, no
  absolute path in any committed config.
- `scripts/qualify-packed-host.mjs` (new): packs the closure, installs the tarballs into a clean
  prefix (the exact operator path), boots the packed plugin and drives a real `execute` against a
  loopback OpenAI-compatible fake. Asserts: SUCCEEDED with usage and the resolved bearer
  credential, idempotent replay with **no second dispatch**, kill-switch gating through an atomic
  reload, disposal. **PASS** — the artifacts an operator installs actually boot and serve.

## CAPABILITY BROKER

- `@ojplatform/capability-broker` (new, OJPlatform): the generic seam. Providers register
  capability ids with versions; SITE CORE modules and plugins consume under host-bound identity.
- **Identity.** Clients are minted only by the broker (`forPlugin` from the manifest,
  `forSite` from server-side registration). Composed keys `plugin.<id>` / `site.<id>` are
  collision-free; there is no callerId parameter anywhere on the client surface, so spoofing
  another plugin or impersonating site core is impossible **by construction**.
- **Permissions.** Deny-by-default. Plugin grants = manifest `consumesCapabilities`
  (`cap@major` matching); site grants = server registration. Denial is `PERMISSION_DENIED`
  before any provider dispatch (asserted: zero provider calls).
- **Availability.** `AVAILABLE / DEGRADED / UNAVAILABLE / DISABLED`, host kill switch layered
  over provider status. **Timeout budgets clamp down only.**
- Default site caller identities registered (`problem`, `submission`, `content`, `admin`) as
  governance fixtures. No business route consumes AI in Stage 6 — per-caller rate/quota policies
  are demonstrably separable (`site.problem` vs `plugin.algoquest.learning-quests` scope keys in
  `config/aibridge.example.json`); usage attribution is per composed caller key.

## MANIFEST DIALECT

- Canonical: flat `providesCapabilities` / `consumesCapabilities` (refs `id` / `id@major` /
  `id@major.x`), `apiVersion` canonical with `pluginApiVersion` accepted legacy alias,
  `contributes` optional for server-capability plugins, `entry: null` legal when no slots are
  declared. AI Bridge's root `plugin.manifest.json` migrated to canonical; a test keeps JSON ↔
  code projection in lockstep.
- **OnlineCodeEditor non-regression**: its manifest and browser registration parse unchanged
  (frozen-shape regression tests) and `tests/plugin-foundation.test.tsx` stays green.

## AI MODULE

`apps/api/src/modules/ai` (OJPlatform) — the only meeting point (`provider.ts` is the single
broker ↔ bridge adapter):

- **Loader**: composed dynamic import of `@aibridge/host` + `@aibridge/suite-all`. Absent and
  broken artifacts are reported distinctly (`ARTIFACTS_ABSENT` / `ARTIFACTS_INVALID`); both
  leave the site fully booted. Architecture gate scans real sources: no static `@aibridge/*`
  import anywhere.
- **Config**: `OJPLATFORM_AI_CONFIG_FILE` / `OJPLATFORM_AI_CONFIG_JSON` (inline), flat
  `{providers, routes, governance}` document. Boot postures, each fail-closed and each leaving
  the site booted: `DISABLED_BY_ENV → NO_CONFIG → CONFIG_UNREADABLE → ARTIFACTS_ABSENT →
  ARTIFACTS_INVALID → CONFIG_REJECTED → ACTIVE`. `fs.watch` reload is atomic — a syntactically
  invalid file never reaches the bridge, a rejected candidate keeps the active snapshot.
- **Provider bridge**: trusted context composed from broker-bound identity (broker key as
  `callerPluginId`, grants, opaque subject); envelope with frozen contract version and
  host-minted request id; `AbortSignal` → `CancellationToken`; results pass through verbatim
  (already the closed vocabulary — provider prose never crosses).
- **SiteAiClient**: the facade for site core (identity from registration, caller-chosen
  idempotency keys — one logical turn is one billable call and the client refuses to pretend
  otherwise).
- **Routes**: `GET /api/ai/capabilities` operator diagnostics only (worker-control gate:
  authenticated + operator). **No execution endpoint, no raw-prompt proxy** — architecture gate
  rejects any mutating `/api/ai/*` route.

## GOVERNANCE STORES

- Redis under the versioned **`oj:aibridge:v1:*`** namespace, Lua-atomic: exact sliding-window
  rate limit, reserve/settle/release quota (durable across restarts — asserted with a fresh
  store instance), and the idempotency replay cache with AES-256-GCM payloads and a hard TTL
  (15 min, AI Bridge §14.3). Redis snapshots never hold plaintext results; an undecryptable
  entry fails closed as absent (never a wrong replay).
- Fail-closed posture: a store that cannot reach Redis throws and the call fails at the
  governance stage — never "unlimited". Host stores are wired only when durably backed; dev
  boots fall back to the bridge's in-memory references, honestly marked.

## USAGE LEDGER

- Postgres `0037_ai_capability_usage` (+`0038` provenance labels): one logical-request row and
  one provider-attempt row per call; append-only (`ON CONFLICT DO NOTHING`), per-caller
  attribution aggregates for operator diagnostics.
- **The shape makes content storage impossible** — no column for a prompt, learner text, an
  output, a response or a credential, asserted mechanically over `information_schema`. The
  `provenance` object (0038) holds the caller's opaque prompt labels (`promptApplied`,
  `promptVersion`) — identifiers only.

## SUBJECTS & IDENTITY

- Opaque host-minted subject tokens: `ojs1_` (user) / `oja1_` (anonymous) HMAC-SHA256 namespaces
  under `OJPLATFORM_AI_SUBJECT_HMAC_KEY`. No email, no user id, no session token (asserted: not
  weakly reversible). Missing key → process-local tokens, honestly marked `PROCESS_LOCAL`, site
  still boots.

## BROWSER BOUNDARY

- The browser never holds AI Bridge, a provider credential, a provider base URL or the HMAC
  key. Enforced three ways: architecture gate (no static `@aibridge/*` anywhere; no mutating
  `/api/ai/*` route), `tests/ai-browser-secret-scan.test.ts` over everything the browser ships
  (handles, key names, vendor endpoints), and the OJ secret-leak conventions.

## KILL SWITCH

- Three fail-closed layers: host env (`OJPLATFORM_AI_DISABLED` gates the whole broker),
  config `governance.killSwitch` (replaced, never accumulated, on every atomic reload), live
  registry (mid-flight). Global / providers / capabilities.
- **Two bugs fixed here** (caught by the packed qualification): the plugin's constructor forked
  the kill-switch registry (reloads applied to a registry nothing executed against; `status()`
  disagreed with execution) and the coordinator collapsed every kill into
  `KILL_SWITCH_PROVIDER` (a global kill surfaced as a provider problem). Now one shared registry
  and the exact verdict reason (`KILL_SWITCH_GLOBAL` / `KILL_SWITCH_CAPABILITY` /
  `KILL_SWITCH_PROVIDER`) survives to the consumer. Nine regression tests.

## CONTRACT CHANGES

Additive, per [`../../AGENTS.md`](../../AGENTS.md) §8 — compatibility note in
[`INTEGRATION_CONTRACT_V1.md`](../INTEGRATION_CONTRACT_V1.md), version bumps, fixtures:

1. `PROVIDER_BALANCE_EXHAUSTED` (`PROVIDER_ERROR`/`PROVIDER`/false) — 402 /
   `insufficient_quota` / `insufficient_balance` no longer misreport an empty wallet as
   `PROVIDER_AUTH_FAILED`. The one deliberate non-retryable fallback chase (rule
   `PROVIDER_BALANCE`): one wallet's emptiness is not the next provider's. Closes the Stage 5
   vocabulary gap. `AIBRIDGE_ERROR_VERSION` 1.1 → 1.2.
2. `promptApplied?` / `promptVersion?` optional request fields — opaque prompt provenance
   pass-through, riding into the logical-request usage record. Closes the Stage 4/5 gap.
   Request schema version 1.0 → 1.1.
- Fixtures: two new **ILLUSTRATIVE** (`ai.text.generate.response.balance-exhausted.json`,
  `ai.text.generate.request.prompt-provenance.json`); every `FROZEN` fixture parses unchanged.

## PROVIDERS

- No provider added. The shared wire classification (OpenAI-compatible, DeepSeek, Xiaomi) now
  names the balance reason; the suite-all factory table forwards `authScheme` and
  `allowPrivateNetworkForDevelopment` (third fixed bug — an operator's custom-gateway auth
  scheme had been ignored).
- LIVE status unchanged and honest: Relay LIVE_QUALIFIED; OpenAI / DeepSeek / Xiaomi
  IMPLEMENTED / LIVE_NOT_RUN. No web-login session scraping (OpenAI web login is not an API
  credential).

## TESTS

- AI Bridge: `npm run verify` green — typecheck, lint, gates, **509 tests**, build,
  portability (11 packages). New: kill-switch lifecycle (5), kill-switch reason fidelity (4),
  balance-exhausted classification/fallback (3 sets), prompt-provenance parsing, fixture set.
- OJPlatform: baseline gate **PASS — 1092 passed, 47 known failures (historical debt), 0 new
  failures**. New: broker identity/permissions/isolation, manifest dialect + OnlineCodeEditor
  regression, AI module boot postures, provider bridge + cancellation, env secret store, routes
  gating + no-mutating-route, real-Redis store atomicity/durability/encryption, real-Postgres
  ledger + attribution + schema-property, browser secret scan.
- Packed-artifact qualification: **PASS** (offline, operator install path).

## LIVE

- No live provider calls were made in this stage (no real credentials present). The packed
  qualification drives the full adapter path against a loopback OpenAI-compatible fake — wire
  shape, credential flow, usage accounting, replay and kill switch are proven; vendor live
  qualification stays an operator run.

## DEPLOYMENT

- **Deployment-impact check (AGENTS.md §7): no production runtime change.** No `deploy/` /
  `compose` / `.env.*`-consumed-by-deployment change, no Windows installer change. The only
  `.env.example` change adds clearly-marked **optional** AI placeholders (no real values); a
  fresh deployment with nothing set boots exactly as before. Database migrations `0037`/`0038`
  are additive tables/columns applied by the existing migration runner.

## UI

- **None** (AGENTS.md §6 gate intact). Provider, model, key, routing and quota configuration is
  file/config based (`config/aibridge.example.json` + env); the only surface is an
  operator-gated read-only diagnostics route.

## GIT

- AI Bridge (`OJPlatformPlugins/AIBridge`, `main`): `886905b` (host entry + suite-all +
  canonical manifest), `6f32746` (packed qualification + three fixes + 402 reason),
  `27b06ec` (prompt provenance labels), final docs commit containing this report. Clean tree,
  no remote.
- OJPlatform (`D:\OJPlatform-worktrees\ai-capability-broker-v1`, branch
  `codex/ai-capability-broker-v1`, base main `738f061`): `a0d46b5` (capability broker +
  manifest dialect), `522667d` (AI module + stores + migration 0037 + gates + config example),
  `a15923c` (provenance labels + migration 0038 + browser scan). Clean tree. **No remote
  created, nothing pushed** (origin is the pre-existing OJPlatform remote, untouched).
- AlgoQuest: read-only throughout, byte-identical.

## NEXT

Ready for Host Integration: **DONE** — the OJPlatform host integration is the deliverable of
this stage. Ready for the next stage: **YES**, with the deliberate stop: **AlgoQuest real-AI
integration is explicitly NOT started**.

Known carry-overs (honest, unchanged where deliberately open):

- **Streaming is single-attempt** — governance applies but retry/fallback/repair do not after
  the first delta; fallback-before-first-delta remains future work (Stage 5 carry-over).
- **Breaker tuning is construction-time** — a reload updates policies but not
  `failureThreshold/windowMs/cooldownMs` (Stage 5 carry-over).
- **Durable encrypted idempotency beyond the 15-minute replay window** — V1 is transient by
  design (AI Bridge §14.3); the encrypted Redis cache extends durability but the "durable,
  encrypted store as a host option" remains a later host choice.
- **Pricing-table maintenance** (`governance.pricing`) per deployment's real price lists; cost
  stays `ESTIMATED` where a price list is absent (never a silent 0 claim — `unknownUsage:
  CONSERVATIVE` default).
- **Adaptive / cost-driven routing** — deliberately not attempted (Phase 35).
- **Live rows for OpenAI / DeepSeek / Xiaomi** — pending real credentials (operator run).
- **OJ packed-artifact E2E inside the OJ test suite** — the loader's absence path and the
  bridge seam are tested with deterministic fakes inside OJ; the artifacts themselves are
  qualified end-to-end by `scripts/qualify-packed-host.mjs` (AIBridge). One-command OJ-side
  packed smoke remains a convenience to add, not a capability gap.

## Stage 5 carry-over audit — closed out this stage

| Carry-over | Status |
| --- | --- |
| 402 / `insufficient_quota` misreported as `PROVIDER_AUTH_FAILED` (vocabulary gap) | **DONE** — `PROVIDER_BALANCE_EXHAUSTED` with its own fallback rule, compat note, fixture |
| Prompt provenance fields (`promptApplied`/`promptVersion`) | **DONE** — additive optional request fields + ledger labels (0038) |
| Durable idempotency/usage/quota/rate stores as host adapters | **DONE** — OJPlatform Redis (encrypted, Lua-atomic) + Postgres adapters |

## Exit gate

| Requirement | Result |
| --- | --- |
| Generic capability broker (not an AI special case) | **PASS** |
| PLUGIN and SITE CORE callers | **PASS** |
| Host-bound identity, spoof-proof by construction | **PASS** |
| Deny-by-default permissions from manifest / server registration | **PASS** |
| Per-caller rate limit and quota, separable policies | **PASS** |
| Usage attribution per caller and subject | **PASS** |
| Browser never holds AI Bridge / provider / key / base URL | **PASS** |
| No public raw-prompt proxy endpoint | **PASS** |
| No UI | **PASS** |
| AlgoQuest unchanged (read-only) | **PASS** |
| No business AI features | **PASS** |
| Two repos, committed separately, no remote push | **PASS** |
| AIBridge consumed as npm-packed artifacts only | **PASS** |
| No cross-repo source import (gate) | **PASS** |
| No absolute paths / real values in committed config | **PASS** |
| AI optional: missing config does not break boot | **PASS** |
| Broken/missing artifacts do not break boot | **PASS** |
| Invalid config keeps the active snapshot (atomic reload) | **PASS** |
| Kill switch global / provider / capability | **PASS** |
| Kill-switch reasons exact to the consumer | **PASS** |
| Fail-closed cost/safety stores | **PASS** |
| Redis namespace `oj:aibridge:v1:*` | **PASS** |
| Replay cache encrypted, hard TTL, atomic claim | **PASS** |
| Durable usage ledger stores no prompts / outputs / secrets | **PASS** |
| Ledger fully accounts every provider attempt | **PASS** |
| Manifest dialect canonical + `pluginApiVersion` alias | **PASS** |
| OnlineCodeEditor non-regression | **PASS** |
| Subject tokens opaque and namespace-separated | **PASS** |
| Packed-artifact host qualification | **PASS** |
| 402 `PROVIDER_BALANCE_EXHAUSTED` (additive, documented) | **PASS** |
| Prompt provenance (additive, documented) | **PASS** |
| AI Bridge verify (typecheck/lint/gates/509 tests/build/portability) | **PASS** |
| OJPlatform baseline gate, zero new failures (1092 passed) | **PASS** |
| Browser secret scan | **PASS** |
| Deployment runtime unchanged | **PASS** |
| Working trees clean (both repos) | **PASS** |
