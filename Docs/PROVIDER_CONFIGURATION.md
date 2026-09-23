# AI Bridge — Provider Configuration

Stage 4. The operator's provider-suite **config contract**: presets, providers, model aliases and
profile routes. Configuration is file/fixture-based; durable host configuration is an
integration-stage concern and OJPlatform's config system is untouched
([`PROJECT_STATUS.md`](PROJECT_STATUS.md)).

Everything on this page is **trusted operator input**. Nothing here is consumer-visible except
through the safe projection in [`PROVIDERS.md`](PROVIDERS.md). Examples use placeholders only —
`secret://…`, dotted aliases, `example.invalid` — and never a real credential.

---

## 1. Shape

```jsonc
{
  "providers": [
    {
      "providerId": "main",                       // ^[a-z][a-z0-9._-]{1,127}$
      "preset": "DEEPSEEK_OFFICIAL",              // closed enum, §2
      "enabled": true,
      "credentialRef": "secret://aibridge/main",  // a HANDLE — never a value
      "endpoint": { "kind": "PRESET" },           // or { "kind": "CUSTOM", "baseUrl": "https://…" }
      "authScheme": "BEARER",                     // optional, closed enum, §3
      "wireProtocol": "OPENAI_CHAT_COMPLETIONS",  // optional; must match the preset
      "allowPrivateNetworkForDevelopment": false, // optional; development only
      "models": [
        {
          "alias": "deepseek.reasoning.primary",  // routing name — never a vendor model id
          "providerId": "main",
          "providerModelId": "MODEL_FROM_CONFIG", // the real id (operator-side only)
          "profiles": ["reasoning", "balanced"],
          "features": ["text", "structuredJson", "reasoning", "streaming", "usage"],
          "verifiedFeatures": ["text"],           // optional: qualification evidence
          "contextLimit": 65536,                  // optional, positive integer
          "outputLimit": 8192,                    // optional, positive integer
          "pricing": { "currency": "USD", "asOf": "2026-09-23" }  // optional and dated
        }
      ]
    }
  ],
  "routes": [
    // profile → ordered alias chain: hop 1 is the route, the rest are the fallback chain
    { "profile": "reasoning", "chain": ["deepseek.reasoning.primary", "openai.reasoning.primary"] },
    { "profile": "fast",      "chain": ["relay.fast.primary"] }
  ]
}
```

`parseProviderSuiteConfig` is strict: closed key sets everywhere, unknown fields rejected, rooted
validation issues, and every semantic rule of §5 checked before a value comes back.

## 2. Presets

A preset decides **adapter family + wire defaults + safe auth defaults**. It never decides
consumer business policy.

| Preset | Adapter | Wire protocol | Default auth | Endpoint |
| --- | --- | --- | --- | --- |
| `OPENAI_OFFICIAL` | `@aibridge/provider-openai` | `OPENAI_RESPONSES` | `BEARER` | custom/trusted (official default `https://api.openai.com/v1`) |
| `DEEPSEEK_OFFICIAL` | `@aibridge/provider-deepseek` | `OPENAI_CHAT_COMPLETIONS` | `BEARER` | preset (official default `https://api.deepseek.com`) |
| `XIAOMI_TOKENPLAN` | `@aibridge/provider-xiaomi-tokenplan` | `OPENAI_CHAT_COMPLETIONS` | `API_KEY_HEADER` | preset clusters `CN` / `SGP` / `EU` |
| `OPENAI_COMPATIBLE_CUSTOM` | `@aibridge/provider-openai-compatible` | `OPENAI_CHAT_COMPLETIONS` | `BEARER` | `CUSTOM` baseUrl required |

A `wireProtocol` that contradicts its preset is a **config error**, not a call-time surprise.
Clusters exist only for `XIAOMI_TOKENPLAN`.

## 3. Authentication

Closed enum only — **never an arbitrary header map**:

| `authScheme` | Header sent |
| --- | --- |
| `BEARER` | `Authorization: Bearer <secret>` |
| `API_KEY_HEADER` | `api-key: <secret>` (the documented MiMo header) |

`credentialRef` must match `^secret://…$`. A raw credential in config is **rejected outright** by
the same pattern — a handle is the only accepted shape. Resolution happens at provider
registration, through the host secret port, into the adapter's private field
([`SECURITY.md`](SECURITY.md) §2).

## 4. Endpoints and SSRF

- `PRESET` — resolve from the provider package's endpoint table (e.g. the Xiaomi clusters).
- `CUSTOM` — a trusted base URL, validated fail-closed: `https` required, no embedded credentials,
  no loopback / private / link-local / cloud-metadata targets (integer IPv4 encodings included),
  and every redirect target is re-validated with a bounded redirect count.
- `allowPrivateNetworkForDevelopment: true` relaxes scheme + private-network rules for local
  development. It defaults to **false** and is never a production setting.
- A consumer request can carry **no** URL, host or endpoint: those are rejected fields at the
  contract boundary (`FORBIDDEN_CONSUMER_FIELDS`).

## 5. Validation rules (strict, deny-by-default)

| Rule | Failure |
| --- | --- |
| duplicate `providerId` | rejected |
| duplicate model `alias` | rejected |
| unknown preset / profile / feature / cluster | rejected |
| unknown config field | rejected (closed key sets) |
| missing or non-`secret://` `credentialRef` (incl. a raw key) | rejected |
| unsafe `CUSTOM` endpoint | rejected (named SSRF rejection) |
| negative / non-integer `contextLimit` / `outputLimit` | rejected |
| `wireProtocol` contradicting the preset | rejected |
| `verifiedFeatures` naming a never-declared feature | rejected (verification is not promotion) |
| route alias that does not exist | rejected |
| **a route chain naming a model not declared for that profile** | rejected — **no silent degrade** |
| duplicate route for one profile, duplicate hop in one chain | rejected |

## 6. Model aliases and profile routing

Routes name **aliases**, never vendor model ids. `buildRuntimeRoutes` resolves
`alias → (providerId, providerModelId)` once, from this config; the real id appears only in the
materialized route table and in operator-side diagnostics.

Routing is deterministic (Stage 4): profile → configured chain → first hop whose model is declared
for the profile and satisfies the request's requirements. There is **no** cost optimiser, no
adaptive balancing, no AI-driven provider choice. A `reasoning` request whose configured model is
gone fails — it never quietly lands on a `fast` model. Hop 2+ of a chain is a **deterministic
fallback contract** (`nextFallback`): eligible only for transient, provider-shaped failures
(`UNAVAILABLE`, `TIMEOUT`, `MODEL_UNAVAILABLE`, retryable `PROVIDER_ERROR`), opt-in for
`RATE_LIMITED`/`QUOTA_EXCEEDED`, and never for request/content/permission/secret failures. The
runtime's automatic application of that contract is Stage 5.

## 7. Declared vs verified features

`features` is the operator's **declaration** (never inferred from a model name);
`verifiedFeatures` records what an opt-in probe / live qualification actually proved. Routing runs
on declarations; `ProviderDiagnostic` reports both as a per-feature `DECLARED` / `VERIFIED`
status. One probe verifies only what it exercised — never every capability of every model.

## 8. Safe diagnostics

`materializeProviderSuite(…).diagnostics()` is the operator channel: provider id, preset, family,
enabled, auth scheme, wire protocol, resolved endpoint, the credential **handle** (and whether one
is bound), model aliases with declared/verified features, and the last **non-generative** probe
status. It can never contain: an API key, credential content, an `Authorization` header, or a raw
provider error body — the projection type has no such field.

## 9. Cost metadata

`pricing` is optional and dated (`currency` + `asOf`). Absent cost stays **unknown** — no cost is
ever fabricated from token counts. Usage in Stage 4 is normalization only; billing, quotas and
dashboards are Stage 5 governance.
