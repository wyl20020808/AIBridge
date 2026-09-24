# AI Bridge — Supported Provider Suite

Stage 4. Four real接入 paths, one runtime, one generic result. A consumer never learns which
vendor served a call: consumers request **capability + profile + requirements + input**; the host
route configuration decides the provider and the model
([`PROVIDER_CONFIGURATION.md`](PROVIDER_CONFIGURATION.md)).

```text
Consumer → Generic AI Contract → AiRuntime → Provider Adapter → Real Provider → normalized AiResult
```

Every provider below produces the same `AiResult`, the same closed error vocabulary, the same
usage model and the same timeout/cancel semantics. Provider wire shape, auth, error bodies and
vendor event types never cross the adapter boundary
([`../AGENTS.md`](../AGENTS.md) §4, [`SECURITY.md`](SECURITY.md)).

| Provider | Package | Preset | Wire protocol | Live status |
| --- | --- | --- | --- | --- |
| **OpenAI Official** | `@aibridge/provider-openai` | `OPENAI_OFFICIAL` | Responses API | `LIVE_NOT_RUN` |
| **DeepSeek Official** | `@aibridge/provider-deepseek` | `DEEPSEEK_OFFICIAL` | OpenAI-compatible chat | `LIVE_NOT_RUN` |
| **Xiaomi MiMo Token Plan** | `@aibridge/provider-xiaomi-tokenplan` | `XIAOMI_TOKENPLAN` | OpenAI-compatible chat | `LIVE_NOT_RUN` |
| **Generic OpenAI-Compatible / Relay** | `@aibridge/provider-openai-compatible` | `OPENAI_COMPATIBLE_CUSTOM` | OpenAI-compatible chat | `LIVE_QUALIFIED` |

Status vocabulary: `IMPLEMENTED` (deterministic tests), `DECLARED` / `DETERMINISTIC_TESTED` /
`LIVE_QUALIFIED` / `LIVE_FAILED` / `LIVE_NOT_RUN` / `UNSUPPORTED` / `STALE` (see
[`PROVIDER_QUALIFICATION.md`](PROVIDER_QUALIFICATION.md)). All four are `IMPLEMENTED`. Live runs
are **opt-in** (`npm run test:live-providers` or `npm run qualify:providers`) and never touch CI.
A missing credential reports `LIVE_NOT_RUN` and is **not** a failure.

> All examples below use placeholders (`secret://…`, `MODEL_ALIAS`, `example.invalid`). No real
> key, endpoint credential or model deployment name is committed anywhere in this repository.

---

## 1. OpenAI Official — `@aibridge/provider-openai`

| | |
| --- | --- |
| **Protocol** | **Responses API** (`POST {base}/responses`) on its own wire path — deliberately not built on the Chat-Completions adapter. Semantic SSE events (`response.output_text.delta`, `response.completed` / `response.incomplete` / `response.failed`, `error`). |
| **Auth** | `Authorization: Bearer <key>`, bound through `credentialRef` → secret store → `bindCredentials`. **Official API keys only.** |
| **Structured** | Native Structured Outputs via `text.format` **strict JSON Schema**, gated on the model's declared `jsonSchema` feature; `structuredJson` alone gets JSON mode; nothing declared means prompt-only. In **every** case the AI Bridge deterministic validator is the final contract boundary — native schema is a first layer, never the last one. |
| **Streaming** | `streamText` → generic stream events; reasoning-text deltas are dropped. `response.incomplete` maps to `LENGTH`/`CONTENT_FILTER` via `incomplete_details.reason`; a refusal is a signal, not an error. |
| **Reasoning** | `reasoning.effort` is sent only for **explicitly configured** profiles. An unmapped profile sends no `reasoning` field — never a silent `high`. |
| **Configuration** | `baseUrl` (trusted, SSRF-validated), model descriptors from host config — **no model IDs are hardcoded** in the package. |
| **Known limitations** | Live row not run (see below). Reasoning **summaries** are dropped, not surfaced (chain-of-thought policy). `HOST_OAUTH_REF` is a **reserved** credential type: if OpenAI ever ships a public, third-party-consumable account authorization for subscription accounts, it can be added without touching the consumer contract. |
| **Live status** | `IMPLEMENTED` / `LIVE_NOT_RUN` |

**Subscription note.** The current OpenAI usage is a ChatGPT / OpenAI **subscription** with web
login. That is not an API credential and is deliberately unsupported: this repository contains no
cookie handling, no session extraction, no internal-token plumbing and no unofficial endpoint
usage. Without `AIBRIDGE_LIVE_OPENAI_API_KEY`, `npm run test:live:openai` reports `LIVE_NOT_RUN`,
which is an acceptable Stage 4 outcome.

## 2. DeepSeek Official — `@aibridge/provider-deepseek`

| | |
| --- | --- |
| **Protocol** | OpenAI-compatible chat (`POST {base}/chat/completions`), official base `https://api.deepseek.com`. Encapsulated in a **dedicated adapter** despite the compatible wire — DeepSeek's semantics are its own. |
| **Auth** | `Authorization: Bearer <key>` via `credentialRef`. |
| **Thinking** | `thinking: { type: 'enabled' \| 'disabled' }` + `reasoning_effort: 'low' \| 'high' \| 'max'` (documented default effort `high`; `medium`/`xhigh` are server-mapped to `high`). The profile → thinking mapping is **explicit, configurable and tested**: the default enables thinking only for `reasoning`/`high-context`; every other profile sends `disabled` — an unmapped profile is **never** silently upgraded (DeepSeek thinks by default server-side, so silence would think). |
| **Structured** | `response_format: { type: 'json_object' }` — **valid JSON, not schema adherence**. The adapter never declares `jsonSchema` for DeepSeek chat; the AI Bridge extractor + strict validator decide success. Empty content (a documented JSON Output case) flows to the validator and becomes an extraction failure, never a silent success. |
| **Reasoning isolation** | Chain-of-thought arrives as `reasoning_content` beside `content` (non-streamed and `delta.reasoning_content` in streams). It is **discarded**: never output, never persisted, never sent to a consumer. |
| **Errors** | Official table mapped: 400 invalid format → `INVALID_REQUEST`; 401 auth → `PROVIDER_AUTH_FAILED`; **402 insufficient balance** → `PROVIDER_AUTH_FAILED` (an operator repairs the deployment; not retryable); 422 invalid parameters → `INVALID_REQUEST`; 429 rate limit → `RATE_LIMITED` + `retryAfterMs`; 500 server error → `PROVIDER_ERROR` (retryable); 503 overloaded → `PROVIDER_ERROR`/`OVERLOADED`. |
| **Known limitations** | Reasoning **token** counts (`completion_tokens_details.reasoning_tokens`) are not projected — the frozen `AiUsage` carries no such field (recorded as a Stage 5 usage-governance item). DeepSeek's own Responses API surface is **deferred** (V1 = chat). |
| **Live status** | `IMPLEMENTED` / `LIVE_NOT_RUN` (no official DeepSeek key in this environment) |

## 3. Xiaomi MiMo Token Plan — `@aibridge/provider-xiaomi-tokenplan`

| | |
| --- | --- |
| **Protocol** | OpenAI-compatible chat. **Implemented protocol: chat completions. Deferred protocols: the documented Anthropic compatibility protocol and the Responses surface** — V1 takes the most stable path that covers current needs, not one implementation per protocol. |
| **Auth** | The documented `api-key: <key>` header by default (`BEARER` is also documented and selectable). Token Plan keys look like `tp-…`; the prefix is a **diagnostic hint only** (`credentialShape`), never a hard API contract and never an authorization rule. |
| **Clusters** | `CN` / `SGP` / `EU` presets resolve the official Token Plan endpoints (`token-plan-cn` / `token-plan-sgp` / `token-plan-ams.xiaomimimo.com/v1`); trusted config may override (the docs state the Base URL is whatever the Token Plan page displays). A consumer can **never** choose a base URL. Token Plan is the subscription product — not the pay-as-you-go MiMo API (`sk-…`, different endpoint); the architecture keeps them separable for a future PAYG adapter. |
| **Structured** | `response_format: { type: 'json_object' }` (the documented base contract) or `json_schema` **only when the operator declares it**; `text`/prompt-only otherwise. AIBridge validation decides success regardless. |
| **Streaming** | `streamText` → generic stream events; `delta.reasoning_content` dropped. MiMo's `repetition_truncation` finish reason maps to `UNKNOWN` (never guessed into the closed set). |
| **Reasoning** | `thinking: { type: 'enabled' \| 'disabled' }` with the same explicit per-profile mapping rule as DeepSeek (no `reasoning_effort` — not documented for this API). |
| **Models / limits** | Model IDs come from trusted host config (documented families include the V2.5/V2.6 chat models; ASR/TTS are out of scope). `max_completion_tokens` is the documented output-cap field (range `[1, 131072]`). Features are **declared per model**, never inferred from a model name; anything uncertain is left unverified until an opt-in probe. |
| **Known limitations** | `json_schema` shape follows the platform's Structured Output guide and is verified only by opt-in live qualification. Web-search tools and multimodal inputs are out of Stage 4 scope. |
| **Live status** | `IMPLEMENTED` / `LIVE_NOT_RUN` (no `tp-` credential in this environment; web sessions are never used) |

## 4. Generic OpenAI-Compatible / Relay — `@aibridge/provider-openai-compatible`

| | |
| --- | --- |
| **Protocol** | OpenAI-compatible chat. Serves 中转站, self-hosted compatible gateways and third-party OpenAI-compatible endpoints. **No vendor brand list exists in code** — behaviour is declared by configuration, never guessed from a URL. |
| **Endpoint** | `baseUrl` from **trusted operator configuration only**, SSRF-validated: HTTPS required, embedded credentials forbidden, loopback/private/link-local/metadata targets rejected (including integer IPv4 encodings), bounded redirects with **re-validation of every target**. `allowPrivateNetworkForDevelopment` (default `false`) is the recorded development-only escape hatch. A consumer request can never carry a URL, host or endpoint — the contract rejects them. |
| **Auth** | Closed enum: `BEARER` or `API_KEY_HEADER` (the documented `api-key` header). **No arbitrary header map.** |
| **Capabilities** | Declared per model (`text`, `structuredJson`, `jsonSchema`, `reasoning`, `streaming`, `usage`, …). What a relay supports is what is **declared or probed** — `OpenAI-compatible` never implies the full OpenAI feature set. |
| **Structured** | Operator-declared mode: `JSON_OBJECT`, `JSON_SCHEMA` (native, first layer) or `PROMPT_ONLY`. The AIBridge validator is the final boundary in all three modes. |
| **Known limitations** | Relay dialects vary; unsupported knobs (`thinking`, `max_completion_tokens`) are off unless declared via the dialect configuration. Health scoring and circuit breaking are Stage 6. |
| **Live status** | `IMPLEMENTED` / `LIVE_QUALIFIED` — one real round trip (text + structured + stream) against a real relay endpoint, credential absent from every output surface |

---

## Shared guarantees (all four)

- **Trust channels**: trusted `instructions` and untrusted `input.context` stay distinct to the
  final wire step (`instructions`/system vs fenced data) — never flattened early
  ([`ARCHITECTURE.md`](ARCHITECTURE.md) §11.2).
- **Error normalization**: the closed generic vocabulary only; provider error bodies are read
  inside the adapter and leave as a mapped category + generic reason. A **malicious provider error
  body** (echoing the credential, learner-like PII, a stack trace) is sanitized everywhere it
  could reach a consumer — proven for all four providers.
- **Secrets**: bound via `credentialRef` → secret store → `bindCredentials`; placed only in the
  outbound auth header; absent from requests, responses, errors, stream events, logs, snapshots
  and packed output.
- **Timeout & cancellation**: the frozen three-deadline arithmetic; cancellation is terminal and
  aborts the outbound call.
- **Probing**: `probe()` is **non-generative** (`GET /models` connectivity + credential check) and
  is never run at startup. Generative qualification is the opt-in live harness only. Repeatable
  **live qualification** (per-feature, secret-free records, staleness) lives in
  `@aibridge/qualification`; see [`PROVIDER_QUALIFICATION.md`](PROVIDER_QUALIFICATION.md).

## Deterministic coverage

One base-contract table runs unchanged through all four providers (`tests/runtime/provider-matrix.test.ts`):
text success · structured success · malformed response · 401/403 · 404 model · 429 · 5xx ·
timeout · cancel · usage · finish reason · stream success · stream error · credential-leak +
malicious-error sanitization. Each provider then has its own suite
(`tests/provider-openai/`, `tests/provider-deepseek/`, `tests/provider-xiaomi-tokenplan/`,
`tests/provider-openai-compatible/`) and passes the shared provider conformance kit unchanged.
