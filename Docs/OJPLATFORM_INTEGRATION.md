# OJPlatform Integration (Stage 6)

The concrete record of the Stage 6 binding: AI Bridge becomes a **site-wide capability provider**
inside OJPlatform behind a generic broker. Two repositories, committed separately; they meet only
at the npm-packed artifacts and at the frozen contract — never at source.

| Repo | Work | Branch / location |
| --- | --- | --- |
| `OJPlatformPlugins/AIBridge` | host plugin entry, suite-all factory table, packed-artifact qualification, 402 reason | `main` |
| `OJPlatform` | capability broker, manifest dialect, AI module, usage-ledger migration, gates | worktree `D:\OJPlatform-worktrees\ai-capability-broker-v1`, branch `codex/ai-capability-broker-v1` |

AlgoQuest is untouched (read-only). No business AI feature ships in Stage 6 — this stage builds
the capability seam and its governance, nothing that judges, scores or teaches.

## 1. The site-wide capability broker

`@ojplatform/capability-broker` is deliberately **not AI-shaped**: providers register capability
ids with versions; callers execute them under host-bound identity. AI Bridge is the first
provider, not the only possible one.

- **Trusted caller identity.** Clients are minted only by the broker (`forPlugin`, `forSite`)
  from host registration data. The composed key is `plugin.<manifest-id>` /
  `site.<module-id>` — collision-free by construction. A caller can only act as the identity the
  broker bound at mint time; there is no callerId parameter anywhere on the client surface.
- **Permissions.** Deny-by-default. Plugin grants are the manifest's `consumesCapabilities`
  (`cap@major` matching); site grants come from server-side registration. A denied call is
  `PERMISSION_DENIED` before any provider dispatch.
- **Availability.** `AVAILABLE / DEGRADED / UNAVAILABLE / DISABLED` with the host kill switch
  (`global / providers / capabilities`) applied on top of every provider's own status.
- **Timeout clamping.** A host limit narrows a caller's budget, never widens it.
- **Subjects.** Opaque host-minted tokens — `ojs1_` (user) and `oja1_` (anonymous) namespaces,
  HMAC-SHA256 under `OJPLATFORM_AI_SUBJECT_HMAC_KEY`. Missing key → process-local tokens
  (unstable, honestly marked), site still boots.

## 2. Manifest dialect (canonical, backward compatible)

`apiVersion` is canonical; `pluginApiVersion` is accepted as a legacy alias. Flat
`providesCapabilities` / `consumesCapabilities` (references: `id`, `id@major`, `id@major.x`).
Server-capability plugins may omit `contributes`; `entry: null` is legal when no slots are
declared. The existing OnlineCodeEditor manifest and browser registration parse **unchanged** —
asserted by `tests/manifest-dialect.test.ts`.

## 3. The AI module (`apps/api/src/modules/ai`)

One narrow meeting point between the two systems:

| File | Role |
| --- | --- |
| `loader.ts` | Composed dynamic import of `@aibridge/host` + `@aibridge/suite-all`. Absent and broken artifacts are reported distinctly — both leave the site fully booted. |
| `config.ts` | `OJPLATFORM_AI_CONFIG_FILE` / `OJPLATFORM_AI_CONFIG_JSON` document source + `fs.watch` atomic reload (an invalid candidate keeps the active snapshot) + the `OJPLATFORM_AI_DISABLED` host kill switch. |
| `provider.ts` | The only broker ↔ bridge adapter: trusted context composition (broker key as `callerPluginId`, grants, opaque subject), envelope construction (frozen contract version, host-minted request id), `AbortSignal` → `CancellationToken`, verbatim result projection. |
| `redis-stores.ts` | Lua-atomic governance stores under the versioned `oj:aibridge:v1:*` namespace: exact sliding-window rate limit, reserve/settle/release quota, encrypted idempotency replay cache (AES-256-GCM, hard TTL). |
| `usage-ledger.ts` | Postgres adapter for `ai_capability_usage_requests` / `_attempts` (migration `0037`), append-only, per-caller attribution aggregates. The schema has no column capable of holding content. |
| `site-ai.ts` | `SiteAiClient` — the facade site core modules consume. |
| `routes.ts` | `GET /api/ai/capabilities`, operator-gated diagnostics. **No execution endpoint, no raw-prompt proxy.** |

Boot postures, each leaving the site fully booted: `DISABLED_BY_ENV` → `NO_CONFIG` →
`CONFIG_UNREADABLE` → `ARTIFACTS_ABSENT` → `ARTIFACTS_INVALID` → `CONFIG_REJECTED` → `ACTIVE`.

## 4. Operator runbook

```sh
# 1. Build and qualify the artifacts (AI Bridge repo)
npm run build && node scripts/qualify-packed-host.mjs

# 2. Pack and install into the API (OJPlatform repo; never committed to package.json)
cd packages/host && npm pack --pack-destination <dir>   # ... all 11 packages
cd apps/api && npm install --no-save <dir>/*.tgz

# 3. Configure (server-side only)
cp config/aibridge.example.json config/aibridge.json    # edit: providers, routes, governance
export OJPLATFORM_AI_CONFIG_FILE=config/aibridge.json
export OJPLATFORM_AI_SUBJECT_HMAC_KEY=<long random>     # subject tokens + replay-cache encryption

# 4. Boot and verify
curl -H "Cookie: oj_session=<operator session>" http://127.0.0.1:3000/api/ai/capabilities

# Emergency stop (gates the whole broker)
export OJPLATFORM_AI_DISABLED=1
```

Provider credentials flow as `secret://env/<NAME>` handles resolved against the process
environment. No real value appears in any committed file, log line, error message or
`providerMetadata` projection.

## 5. Governance stores and the usage ledger

- Redis: `oj:aibridge:v1:{idem,rate,quota}:*` — versioned, isolated from every other `oj:*`
  consumer. Replay-cache payloads are AES-256-GCM encrypted and hard-TTL'd (15 minutes, the
  AI Bridge §14.3 retention): Redis snapshots never hold plaintext results. Quota reservations
  survive a restart (durable accounting).
- Postgres: `0037_ai_capability_usage` (one logical-request row and one provider-attempt row
  per call) plus `0038` (a `provenance` label object on request rows — `{promptApplied,
  promptVersion}`, opaque identifiers). Cost and capacity evidence only: prompts, learner text,
  AI outputs and credentials cannot be stored because no column holds them (asserted
  mechanically).

## 6. Security properties (mechanically enforced)

- No static `@aibridge/*` dependency anywhere in OJPlatform source — architecture gate scan.
- No mutating `/api/ai/*` route — architecture gate scan. The browser never holds an AI
  Bridge/provider/API key/base URL — `tests/ai-browser-secret-scan.test.ts` over everything the
  browser ships.
- Caller spoofing is impossible by construction (clients exist only because the broker minted
  them); consumer requests carrying trusted fields are rejected by the bridge.
- Provider raw errors never reach a consumer or a learner: the closed error vocabulary is the
  only surface.

## 7. Non-regression and honest scope

- OnlineCodeEditor: manifest parsing and browser registration unchanged (frozen-shape tests).
- OJPlatform test baseline gate: zero new failures; the 47 known failures are the recorded
  historical debt, untouched.
- `tests/foundation.test.ts` (`pluginSdkVersion`) remains the recorded baseline failure — not
  touched by this stage.
- Deployment: no change to production runtime, no `deploy/`/`compose` change, no installer
  change (AGENTS.md §7 — deployment-impact check: explicitly out of scope).
