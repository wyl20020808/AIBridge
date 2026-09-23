# AI Bridge — Configuration Reload

> **Stage 5 implementation.** Immutable configuration snapshots, validated-first atomic reload
> and rollback in `@aibridge/runtime` (`ConfigManager`), plus the snapshot-binding rules of
> `AiRuntime` and `ExecutionCoordinator`. Configuration is file/config based; no production
> runtime change, no UI ([`AGENTS.md`](../AGENTS.md) §6–7).

Companion documents: [`PROVIDER_CONFIGURATION.md`](PROVIDER_CONFIGURATION.md) for the provider
suite half of the document, [`USAGE_AND_COST.md`](USAGE_AND_COST.md) for the pricing, quota and
budget policies it carries, [`ARCHITECTURE.md`](ARCHITECTURE.md) §17.2 for the atomic-reload
principle.

---

## 1. One immutable generation — `RuntimeConfigSnapshot` (Phase 39–40)

A snapshot is **one configuration generation**: parsed, validated, compiled — and then read-only.
Nothing mutates a snapshot; a change produces a new one.

### 1.1 What one generation contains

| Component | Source key | Notes |
| --- | --- | --- |
| provider suite | `providers` | presets, credential **handles**, endpoints, model aliases ([`PROVIDER_CONFIGURATION.md`](PROVIDER_CONFIGURATION.md) §1) |
| routes | `routes` | profile → ordered alias chain, alias-resolved into `RuntimeRoutes` |
| fallback policy | `governance.fallback` | incl. the opt-in `fallbackOnRateLimit` / `fallbackOnQuotaExceeded` flags |
| retry policy | `governance.retry` | bounded same-provider retry tuning |
| breaker tuning | `governance.breaker` | read at runtime construction — see §6 |
| rate policies | `governance.rateLimits` | the five dimensions |
| quota policies | `governance.quotas` | scopes × meters × periods, with reservations |
| budget | `governance.budget` | per-request / per-day / per-month cost caps |
| pricing | `governance.pricing` | the versioned rate cards ([`USAGE_AND_COST.md`](USAGE_AND_COST.md) §4.1) |
| idempotency | `governance.idempotency` | enabled, retention, capacity |
| repair policy | `governance.outputRepair` | `NONE` \| `ONCE` |
| unknown-usage policy | `governance.unknownUsage` | `CONSERVATIVE` \| `RELEASE` |
| kill switches | `governance.killSwitch` | global / provider / capability |

### 1.2 Snapshot identity

| Field | Value | Meaning |
| --- | --- | --- |
| `configVersion` | `cfg-N` | monotonic per manager: `cfg-1`, `cfg-2`, … (`cfg-0` is the synthetic snapshot of a runtime built without a manager) |
| `contentDigest` | `dgst-` + 16 hex | digest of the **canonical JSON** of the document (object keys sorted, so authoring order cannot change identity). **Credential-free**: a snapshot holds `credentialRef` handles only (Phase 72), never a secret value |
| `createdAtMs` | number | when the generation became active — also the instant pricing is pinned against ([`USAGE_AND_COST.md`](USAGE_AND_COST.md) §4.2) |

`configVersion` and `contentDigest` appear on every usage record and every attempt's
`routeConfigVersion`, so an operator can always say which generation produced a bill.

## 2. The reload pipeline (Phase 41)

Reload is validated-first. The steps run in order; a candidate must pass **all** of them:

| # | Step | Rejects | Runs in |
| --- | --- | --- | --- |
| 1 | parse | unknown fields, wrong types, enum violations — closed key sets everywhere | `parseRuntimeConfig` |
| 2 | validate the whole candidate | every shape rule of the suite and the governance blocks | `parseProviderSuiteConfig`, `parseGovernance` |
| 3 | cross-reference checks | duplicate ids/aliases, preset/wire contradictions, unknown route aliases, silent degrades | `semanticIssues` |
| 4 | fallback-chain compilation | cycles, duplicate targets, impossible targets, chains over 8 hops | `compileFallbackIssues` → `validateFallbackChain` |
| 5 | pricing validation | ambiguous or unpriceable rate cards | `PricingTable.validate` |
| 6 | quota validation | a reservation larger than its limit | `compileRuntimeSnapshot` |
| 7 | SSRF endpoint validation | unsafe `CUSTOM` endpoints (runs inside `parseProviderSuiteConfig`, step 2 — listed separately because it is a named, fail-closed gate) | `checkEndpointSafety` |

### 2.1 Atomic swap

**Only a full pass swaps. Any failure keeps the previous snapshot active.** Never a half-applied
route table ([`ARCHITECTURE.md`](ARCHITECTURE.md) §17.2).

| Outcome | Snapshot | Event |
| --- | --- | --- |
| every step passes | the new snapshot becomes active; the old one enters history | `ai.config_reloaded` (`configVersion`, `contentDigest`) |
| any step fails | the previous snapshot stays active, unchanged | `ai.config_reload_failed` (`issueCount`, `firstPath`, `firstIssueCode`) |

A failure returns the rooted `ValidationIssue[]` in full — an operator fixes the document, not a
partially-applied state. `ConfigManager.bootstrap` applies the same pipeline to the **first**
configuration and fails without side effects.

## 3. In-flight semantics (Phase 42)

> A request binds its snapshot at **ingress** — before any await — and reads everything from that
> one object. One request, one generation.

- Routes, fallback/retry/repair policy, rate limits, quota policies, budget, pricing,
  unknown-usage policy and kill switches are read from the bound snapshot; quota and budget take
  the request's snapshot policies explicitly. A request can **never** mix route v1 with pricing v2.
- The binding happens before the first `await`, so a reload that lands while a call is being
  scheduled cannot change the generation it runs against.
- Pricing is pinned from that snapshot at request start (Phase 32); a mid-flight reload never
  reprices an in-flight attempt.
- New requests use the new snapshot. In-flight requests finish against theirs, and every attempt
  record carries that `routeConfigVersion` — the ledger shows which generation served which call.

## 4. Rollback (Phase 43)

`ConfigManager.rollback()` swaps back to the **previously active** snapshot — a re-activation of
the history object, never a re-parse. The outgoing snapshot is pushed onto the history, and
`ai.config_reloaded` is emitted with `configVersion: 'cfg-N (rollback)'` so the event stream shows
the step back.

| Property | Rule |
| --- | --- |
| history | in-memory (`history()` lists previously active snapshots, oldest first; `ConfigSnapshotStorePort` records them) |
| no previous snapshot | `rollback` fails (`MISSING_FIELD`) — it never invents a generation |
| operator surface | none. Rollback is a programmatic call; there is **no UI** |

## 5. Config shape reference

### 5.1 Document shape

```jsonc
{
  "providers": [
    {
      "providerId": "main",                          // ^[a-z][a-z0-9._-]{1,127}$
      "preset": "OPENAI_COMPATIBLE_CUSTOM",          // closed enum (PROVIDER_CONFIGURATION.md §2)
      "enabled": true,
      "credentialRef": "secret://aibridge/main",     // a HANDLE — never a value (Phase 72)
      "endpoint": { "kind": "CUSTOM", "baseUrl": "https://api.example.invalid/v1" },
      "authScheme": "BEARER",                        // closed enum
      "models": [
        {
          "alias": "MODEL_ALIAS",                    // placeholder — dotted lower-case, e.g. main.text.primary
          "providerId": "main",
          "providerModelId": "MODEL_FROM_CONFIG",    // the real id, operator-side only
          "profiles": ["balanced", "reasoning"],
          "features": ["text", "structuredJson", "usage"]
        }
      ]
    }
  ],
  "routes": [
    // profile → ordered alias chain: hop 1 is the route, the rest are the fallback chain
    { "profile": "balanced", "chain": ["MODEL_ALIAS"] }
  ],
  "governance": {
    "fallback": {
      "fallbackOnRateLimit": false,
      "fallbackOnQuotaExceeded": false,
      "allowCapabilityDegrade": false               // only false exists in Stage 5 (Phase 5)
    },
    "retry": { "maxSameProviderRetries": 1, "baseBackoffMs": 250, "maxBackoffMs": 2000 },
    "breaker": { "failureThreshold": 5, "windowMs": 30000, "cooldownMs": 15000, "halfOpenProbeLimit": 1 },
    "rateLimits": [{ "dimension": "callerPlugin", "limit": 120, "windowMs": 60000 }],
    "quotas": [
      { "scope": "subject", "meter": "TOKENS", "period": "DAY", "limit": 50000, "reservationTokens": 4096 }
    ],
    "budget": { "maxEstimatedCostPerRequest": 1, "maxEstimatedCostPerDay": 50, "maxEstimatedCostPerMonth": 1000, "currency": "USD" },
    "pricing": [
      {
        "pricingId": "price-main-1",
        "version": "1",
        "providerId": "main",
        "modelAlias": "MODEL_ALIAS",
        "validFromMs": 0,
        "currency": "USD",
        "inputTokenPrice": 0.5,
        "outputTokenPrice": 1.5,
        "cachedInputPrice": 0.1,
        "unit": "PER_1K_TOKENS",
        "source": "https://pricing.example.invalid/rate-card"
      }
    ],
    "idempotency": { "enabled": true, "retentionMs": 900000, "capacity": 10000 },
    "outputRepair": "ONCE",                          // NONE | ONCE
    "unknownUsage": "CONSERVATIVE",                  // CONSERVATIVE | RELEASE
    "killSwitch": { "global": false, "providers": [], "capabilities": [] }
  }
}
```

Placeholders only — `secret://…`, `MODEL_ALIAS`, `example.invalid`. A real credential in a config
document is not a config error to be fixed later; it is a leak to be prevented
([`SECURITY.md`](SECURITY.md) §2).

### 5.2 Parse-time validation rules

| Rule | Failure |
| --- | --- |
| unknown config field anywhere (suite, provider, model, endpoint, route, governance block) | rejected — `UNKNOWN_FIELD`; closed key sets, deny-by-default |
| `allowCapabilityDegrade: true` | rejected in Stage 5 — only `false` is implemented (Phase 5); accepting `true` would silently promise a downgrade path that does not exist |
| `credentialRef` that is not a `secret://…` handle (incl. any raw credential) | rejected — `PATTERN_MISMATCH`. **Handles only, never values** (Phase 72) |
| unsafe `CUSTOM` endpoint (non-`https`, embedded credentials, loopback / private / link-local / cloud-metadata targets, integer IPv4 encodings included) | rejected at validation — named SSRF rejection ([`PROVIDER_CONFIGURATION.md`](PROVIDER_CONFIGURATION.md) §4) |
| unknown preset / profile / feature / cluster; `wireProtocol` contradicting the preset | rejected |
| `outputRepair` / `unknownUsage` outside their closed enums | rejected |
| non-integer / negative `contextLimit` / `outputLimit`, `verifiedFeatures` naming a never-declared feature | rejected |

### 5.3 Compile-time validation rules

| Rule | Failure |
| --- | --- |
| duplicate `providerId` or model `alias` | rejected — `DUPLICATE_FIELD` |
| duplicate route for one profile | rejected |
| duplicate hop in one chain (a revisit of one target is a cycle) | rejected — `validateFallbackChain` |
| impossible target: an alias that does not resolve, or a model not declared for that profile | rejected — **no silent degrade** |
| a chain longer than 8 hops | rejected — `OUT_OF_RANGE`; a fallback chain is finite |
| overlapping pricing for one `(provider, model, version)` target | rejected — a price pin must be deterministic |
| a pricing record with no model target, no input **or** output price, a bad currency, or `validUntilMs ≤ validFromMs` | rejected |
| a quota `reservationTokens` / `reservationCost` larger than its `limit` | rejected — a reservation larger than the limit can never be granted |
| non-positive rate-limit `limit` / `windowMs` | rejected |

## 6. Known limitations — Trade-off, stated honestly

- **Breaker tuning is read at runtime construction.** `AiRuntime` builds its
  `CircuitBreakerRegistry` from the snapshot active when the runtime is constructed (a
  caller-supplied registry overrides it). A reload that changes `governance.breaker` compiles and
  swaps cleanly, but the live breaker keeps its old thresholds — changing breaker tuning live
  requires a restart. Rate limits, quotas, budget, pricing, fallback/retry/repair and kill
  switches all follow the request's snapshot (§3); the breaker is the one component whose tuning
  is construction-time. Rationale: mid-flight threshold changes would make a breaker's verdict
  history-dependent just when it is deciding whether to trust a provider.
- **Adapter materialization for a changed provider set is bootstrap work.** A snapshot compiles
  routes from config alone, but dispatch needs a bound `AiProviderAdapter`; `registerProvider` is
  dynamic and async (it resolves a `credentialRef` through the host secret port). A reload that
  adds a provider's routes before that adapter is registered leaves those hops unviable
  (`NOT_REGISTERED`, recorded as skipped) rather than half-working. Rationale: a route-table swap
  must never race credential resolution.

## 7. Out of scope (explicitly)

- file watching / automatic reload from disk — reload is an explicit `ConfigManager.reload`
  call with a candidate document;
- remote config services and config distribution;
- admin UI of any kind (NOT ALLOWED — [`AGENTS.md`](../AGENTS.md) §6);
- OJPlatform deploy/config integration and env-var injection ([`AGENTS.md`](../AGENTS.md) §7):
  `deploy/`, `compose*.yaml` and `.env.*` examples are untouched by this stage;
- durable snapshot storage — host-owned later; the reference store is in-memory
  ([`ARCHITECTURE.md`](ARCHITECTURE.md) §19);
- changing the frozen consumer contract: a snapshot is operator-side data and is projected
  outward only through [`USAGE_AND_COST.md`](USAGE_AND_COST.md) §8's surfaces.
