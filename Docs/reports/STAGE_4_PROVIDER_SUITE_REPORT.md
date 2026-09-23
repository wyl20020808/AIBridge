# AI BRIDGE V1 — STAGE 4
# PROVIDER SUITE & MULTI-PROVIDER QUALIFICATION

**`AIBRIDGE_STAGE_4 = PASS`**

Four real接入 paths over one runtime and one generic result. A consumer never learns which vendor
served a call: consumers request capability + profile + requirements + input; trusted host route
configuration decides the provider and the model. Deterministic base-contract coverage (one table
× four providers), provider-specific suites, strict config validation, SSRF-hardened relay, and an
opt-in live harness with one row live-qualified against a real endpoint.

## PROVIDERS

| Provider | Package | Status |
| --- | --- | --- |
| OpenAI: | `@aibridge/provider-openai` (Responses API) | `IMPLEMENTED` / `LIVE_NOT_RUN` |
| DeepSeek: | `@aibridge/provider-deepseek` (chat + thinking) | `IMPLEMENTED` / `LIVE_NOT_RUN` |
| Xiaomi Token Plan: | `@aibridge/provider-xiaomi-tokenplan` (chat + Token Plan auth) | `IMPLEMENTED` / `LIVE_NOT_RUN` |
| Generic Relay: | `@aibridge/provider-openai-compatible` (chat + dialect knobs) | `IMPLEMENTED` / `LIVE_QUALIFIED` |

**Audit (Phase 1) of the Stage 3 adapter, before extraction:**
- `GENERIC_WIRE_LOGIC` — SSE `data:` framing, abort/deadline send scope, `Retry-After` parsing,
  vendor-JSON parsing, raw-message truncation/credential-stripping, the self-declared transport
  seam. Extracted into the internal wire layer (reused by three adapters, each reuse tested).
- `OPENAI_SPECIFIC_ASSUMPTION` — `/chat/completions` path, `choices[0].message.content`,
  `finish_reason` spellings, `usage.prompt_tokens/…` field names, `[DONE]`, `stream_options`,
  `max_tokens`, the `error:{type,code,message}` body. Stays as the **chat dialect**.
- `PROVIDER_SPECIFIC_ASSUMPTION` — Bearer-only auth (→ `AuthScheme` enum), `max_tokens` vs
  `max_completion_tokens` (MiMo), `response_format` policy (json_object vs json_schema vs none),
  thinking/reasoning fields, error-status semantics (402 balance, `insufficient_quota`), endpoint
  safety policy. Now dialect/config, per provider.

## OPENAI

- Protocol: **Responses API** (`POST {base}/responses`) on its own wire path — deliberately not
  built on the Chat-Completions adapter (Phase 3). Semantic SSE events; `instructions` (trusted) +
  `input` (fenced data).
- Structured: native `text.format` **strict JSON Schema**, gated on the model's declared
  `jsonSchema`; `structuredJson` ⇒ JSON mode; undeclared ⇒ prompt-only. AIBridge deterministic
  validation is the final boundary in every case (native schema is layer one only).
- Streaming: `response.output_text.delta` → deltas; `response.completed/incomplete/failed`/`error`
  → terminal; reasoning-text deltas dropped; `incomplete_details.reason` → `LENGTH`/
  `CONTENT_FILTER`; refusal is a signal, not an error.
- Errors: official error object mapped (`model_not_found`, `insufficient_quota`, `rate_limit`,
  …); vendor prose operator-only. `reasoning.effort` only for explicitly configured profiles —
  never a silent high.
- Models: from trusted host config; nothing hardcoded. `probe()` = non-generative `GET /models`.
- Live: `IMPLEMENTED` / **`LIVE_NOT_RUN`** — the current OpenAI usage is a ChatGPT **subscription
  with web login**, which is not an API credential. Per the approved rule this row is not required;
  no cookie/session/internal-token handling exists in the package. `HOST_OAUTH_REF` is reserved
  for a future official account-authorization flow (RESERVED ONLY, not implemented).

## DEEPSEEK

- Protocol: OpenAI-compatible chat (`https://api.deepseek.com/chat/completions`), dedicated
  adapter despite the compatible wire (Phase 7). Deferred: DeepSeek's Responses surface.
- Thinking: `thinking:{type: enabled|disabled}` + `reasoning_effort: low|high|max` mapped
  **explicitly** from profile config (default: `reasoning`/`high-context` → enabled at the
  documented default effort; everything else → `disabled`). Unmapped profiles are never upgraded
  to high. Mapping is configurable and tested (Phase 8).
- Structured: `response_format: json_object` = **valid JSON, never labeled jsonSchema**
  (Phase 10). Missing content ⇒ malformed; empty content ⇒ flows to the strict validator, which
  decides success.
- Reasoning isolation: `reasoning_content` (and `delta.reasoning_content`) is chain-of-thought and
  is **discarded** — final answer only, never persisted, never forwarded (Phase 9). Reasoning
  *token counts* are not projected (frozen `AiUsage` has no such field — Stage 5 carry-over).
- Errors: official table mapped — 400/401/**402 insufficient balance**/422/429/500/503, plus
  model-not-found (Phase 11). All rows tested.
- Live: `IMPLEMENTED` / **`LIVE_NOT_RUN`** (no official DeepSeek credential in this environment).

## XIAOMI TOKEN PLAN

- Protocol: OpenAI-compatible chat. **Implemented: chat completions. Deferred: the documented
  Anthropic protocol and the Responses surface** (Phase 16 — one protocol covers current needs;
  not one implementation per protocol).
- Auth: documented `api-key: <key>` header by default (`BEARER` selectable). `credentialRef` →
  secret store → private field. The `tp-` prefix is a **safe-diagnostic hint only**
  (`credentialShape`), never a hard API contract (Phase 13). No real `tp-`/`ttp-` value exists
  anywhere in the repository.
- Cluster: `CN` / `SGP` / `EU` presets resolve the official Token Plan endpoints; trusted config
  may override. Consumers can never choose a base URL (Phase 14). Token Plan ≠ pay-as-you-go
  MiMo (`sk-…`) — separable for a future PAYG adapter (Phase 12).
- Structured: `json_object` by default; `json_schema` only when declared; AIBridge validation
  decides success.
- Models: declared per model (`text/structuredJson/jsonSchema/reasoning/streaming/vision/…`
  never inferred from names — Phase 15); `verifiedFeatures` records qualification evidence;
  `max_completion_tokens` semantics; `thinking:{type}` mapping; `repetition_truncation` finish maps
  to `UNKNOWN`, never guessed.
- Live: `IMPLEMENTED` / **`LIVE_NOT_RUN`** (no `tp-` credential; web sessions are never used).

## RELAY

- Protocol: OpenAI-compatible chat, positioned as the **Generic OpenAI-Compatible / Relay**
  provider (中转站 / self-hosted gateways / third-party compatible endpoints). **No vendor brand
  list in code** (Phase 17).
- Endpoint: trusted operator config or preset; SSRF-validated fail-closed — HTTPS required, no
  embedded credentials, no loopback/private/link-local/metadata targets (integer IPv4 encodings
  normalized and covered), `localhost`/`.local`/metadata hostnames blocked, **redirects bounded
  (3) with every target re-validated**, `allowPrivateNetworkForDevelopment` default false
  (Phase 19–20). A consumer request can carry no URL/host/endpoint — rejected at the contract
  boundary and asserted.
- Auth: closed enum `BEARER` | `API_KEY_HEADER` (documented `api-key` header). No arbitrary
  header map (Phase 18).
- Capabilities: declared per model; `structuredOutput` mode (`JSON_OBJECT` / `JSON_SCHEMA` /
  `PROMPT_ONLY`) and `maxTokensField` are configuration, never guessed from "OpenAI-compatible".
- Live: `IMPLEMENTED` / **`LIVE_QUALIFIED`** — one real round trip (text + structured + stream)
  against a real endpoint: `status SUCCEEDED`, usage `38/59/97` tokens (run 1) and `38/29/67`
  (run 2), `finish STOP`, ~9.2 s, **credential absent from every output surface**.

## SHARED RUNTIME

- AiRuntime: unchanged Stage 3 pipeline, extended with deterministic multi-provider
  configuration. All four providers → same `AiResult`, same error model, same usage model, same
  timeout/cancel semantics (asserted by the matrix).
- Wire reuse: extracted only where ≥ 2 providers genuinely reuse it (here: 3 — relay, DeepSeek,
  Xiaomi) with tests per reuse; OpenAI Official keeps its own wire path. One shared package was
  **not** created — the layer lives in `@aibridge/provider-openai-compatible` as a documented
  *internal reusable layer* with no runtime dependency (Phase 2, 51).
- Provider registry: `materializeProviderSuite` — factories keyed by preset (the runtime never
  imports a provider package), credential binding at registration, routes built from aliases.
- Model aliases: `openai.reasoning.primary`-style names in routes; `alias → (providerId,
  providerModelId)` resolved once from trusted config; real ids never in route tables (Phase 22).
- Profile routing: deterministic `profile + capability + requirements → alias` over the existing
  `resolveRoute`; no cost optimiser, no adaptive balancing (Phase 23). **No silent degrade**: a
  chain may only name models declared for that profile — enforced at config validation and at
  resolution (Phase 24). Fallback: the deterministic `nextFallback` chain contract with the frozen
  eligibility rule (Phase 25) — automatic application is Stage 5/6, deliberately not
  half-implemented.

## CAPABILITIES

- Declared: `ModelDescriptor.features` / config `features` — the operator's declaration, never
  inferred from a model name.
- Verified: `verifiedFeatures` + `featureStatus` (`DECLARED`/`VERIFIED` per feature) +
  `recordQualification`. One probe never validates every model capability (Phase 27).
- Probe: `probe()` is **non-generative** (`GET /models` connectivity + credential check) and never
  runs at startup; generative qualification is the opt-in live harness only (Phase 26). Probing is
  manual/administrative and may cost money — nothing automatic exists.

## SECURITY

- Credentials: `credentialRef` (`secret://…`) → host secret port → `bindCredentials` private
  field → outbound auth header only. Raw credentials in config are rejected by pattern. No key in
  source/JSON/fixtures/docs/tracked env/transcripts (Phase 34, 48).
- Provider errors: vendor bodies read only inside adapters; public output carries mapped
  category + generic reason. **Malicious error bodies** (credential echo + learner-like PII + stack
  trace) are sanitized on every consumer-reachable surface — tested × 4 (Phase 49).
- Raw responses: transient, adapter-internal; never in `providerMetadata` (Phase 50) — the closed
  projection test still holds.
- Reasoning content: dropped at the wire layer, non-streamed and streamed; never output,
  persisted or forwarded (Phase 9, 56).
- Relay endpoint: SSRF fail-closed + bounded re-validated redirects + consumer-cannot-override
  (Phase 19–20, 32).
- SSRF basics: integer-IPv4 bypass, IPv6 loopback/ULA/link-local, IPv4-mapped IPv6, metadata
  targets — all rejected and tested (`tests/core/endpoint-safety.test.ts`).

## CONFIGURATION

- Provider: `ProviderConfig` — providerId, preset, enabled, `credentialRef`, endpoint
  (PRESET/cluster or CUSTOM), `authScheme`, `wireProtocol`, dev flag, models. Strict closed-key
  parsing + Phase 42 semantic rules (duplicates, unknowns, unsafe endpoints, missing/raw
  credentials, invalid combinations, negative limits) — all rejected, all tested.
- Models: `ModelAliasConfig` — alias, providerId, providerModelId, profiles, features,
  verifiedFeatures, limits, dated pricing (absent cost stays unknown — Phase 47).
- Routes: `profile → ordered alias chain`; every hop must be declared for the profile (no silent
  degrade); deterministic.
- Secrets: handles only. Resolution at registration through the trusted secret port.
- Source: **config contract + in-memory/fixture only** — OJPlatform's config system untouched
  (Phase 43). Usage = normalization only; billing/quotas/dashboards are governance stages
  (Phase 46).

## ALGOQUEST COMPATIBILITY

Read-only audit of `D:\OJPlatformPlugins\AlgoQuest` (Phase 55). Stage 6.1 recorded three
`AIBRIDGE_COMPATIBILITY_GAP` entries (`Docs/AI_TASKS.md` §10). Stage 4 status:

1. **Two-channel instruction/data** — "the bridge has no messages/systemPrompt array; an adapter
   flattens instructions into `input.instructions` and carries bindings as `input.context`."
   **Confirmed transport-safe across all four providers** (Phase 56): the trusted instruction
   channel and the untrusted data channel stay distinct to the final wire step (`instructions`/
   system vs fenced data) and are never flattened early. The flattening AlgoQuest describes is
   exactly the frozen mapping and it works on Responses, chat-dialect and relay paths alike.
2. **Prompt provenance (`promptApplied`/`promptVersion`)** — still absent as dedicated fields.
   Per Phase 57 the bridge accepts **opaque pass-through identifiers** (the frozen metadata
   allow-list: `traceId`/`correlationId`/`surface`) and never generates a business prompt version
   itself. A dedicated provenance field would be a frozen-contract additive change — deferred.
   **Remaining gap, recorded.**
3. **`idempotencyKey` charset / registry-referenced schemas / specialized-capability prompts** —
   the charset is frozen (consumers map `commandId` accordingly); caller-authored **INLINE field
   tables** are supported on the generic structured path (and Stage 4 adds native-schema
   translation from them); specialized `education.*` capabilities accepting composed prompts are
   Stage 8. **Remaining gaps, recorded.**

Trust channels and prompt ownership: unchanged — the bridge transports a consumer-composed prompt
and never manages it.

## TESTS

- Baseline (Stage 3 final): 214 tests. **Final: 353 tests**, all deterministic, no network.
- Provider conformance: the shared kit passes unchanged on **5** adapters (scripted + 4 real)
  through per-dialect injection seams; the Phase 28 base table runs × 4 providers through one
  `AiRuntime`.
- Security: SSRF suite, relay redirect/override suites, reasoning-isolation suites, malicious
  provider-error rows × 4, secret-leak regressions, negative gate test (all Stage 3 protections
  intact).
- Typecheck: strict, PASS. Lint: PASS. Build: PASS. Gates (coupling/secret/deps): PASS.
- Portability: 8 packages packed → offline install → repo-external typecheck (no `node` types) →
  declaration-hygiene scan → runtime smoke incl. a multi-provider suite round trip: PASS.
- Verify: `npm run verify` PASS end to end.

## LIVE QUALIFICATION

| Row | Status |
| --- | --- |
| OpenAI: | `IMPLEMENTED` / `LIVE_NOT_RUN` (subscription web login is not an API credential — allowed) |
| DeepSeek: | `IMPLEMENTED` / `LIVE_NOT_RUN` (no official credential) |
| Xiaomi: | `IMPLEMENTED` / `LIVE_NOT_RUN` (no `tp-` credential) |
| Relay: | `IMPLEMENTED` / **`LIVE_QUALIFIED`** (real endpoint; text + structured + stream; no leak) |

Harness: `npm run test:live-providers` / `test:live:{openai,deepseek,xiaomi-tokenplan,relay}` —
OPT-IN, environment-only credentials and models, tiny synthetic prompts (Phase 40), declaration-
driven smoke selection (structured/stream/reasoning run only where declared — Phase 39), and
`LIVE_NOT_RUN` is never a failure (Phase 34).

## DEPLOYMENT

Production runtime changed: **NO**. No `D:\OJPlatform` change, no `deploy/`, `compose`, `.env.*`
example or installer touched, `plugin.manifest.json` unchanged (`"entry": null`). No provider is
wired into any production user flow.

## UI

**NOT ALLOWED** — no provider settings, key input, model selector or dashboard.

## GIT

- HEAD: see `git log` (Stage 4 slice commits below).
- Commits: `refactor(provider): extract reusable compatible wire primitives` ·
  `feat(provider): add OpenAI official Responses adapter` ·
  `feat(provider): add DeepSeek official adapter` ·
  `feat(provider): add Xiaomi Token Plan adapter` ·
  `feat(runtime): add deterministic multi-provider configuration` ·
  `test(provider): add provider suite conformance and security coverage` ·
  `chore: wire the provider suite into gates, portability and the live harness` ·
  `docs: document the supported provider suite`.
- Status: clean working tree, no remote, OJPlatform and AlgoQuest untouched.

## NEXT

Recommended Stage 5: **Provider Reliability + Usage / Quota / Cost Governance** — bounded retry
and automatic fallback *applying* the Stage 4 `nextFallback` contract, idempotency registry, usage
ledger + cost estimation (dated pricing metadata already in config), rate limits and quotas,
observability, config atomic reload.

Known carry-overs:

- automatic fallback/retry application (contract complete, application deferred by design);
- bounded output **repair** (moved to the reliability track — see the roadmap renumbering note);
- reasoning **token counts** in usage (needs an additive `AiUsage` field — governance stage);
- prompt provenance fields (`promptApplied`/`promptVersion`) — frozen-contract additive change,
  deferred with the AlgoQuest gap recorded;
- Xiaomi Anthropic protocol + Xiaomi/DeepSeek Responses surfaces (documented deferred protocols);
- `HOST_OAUTH_REF` account-authorized credential type (RESERVED ONLY, awaiting a public official
  authorization flow);
- live rows for OpenAI / DeepSeek / Xiaomi pending real credentials.

---

## Stage 3 audit appendix — wire classification

See the `## PROVIDERS` audit block above (GENERIC_WIRE_LOGIC / OPENAI_SPECIFIC_ASSUMPTION /
PROVIDER_SPECIFIC_ASSUMPTION), produced before any extraction, per Phase 1.

## Exit gate

| Requirement | Result |
| --- | --- |
| OpenAI Official adapter implemented | **PASS** |
| OpenAI Responses path / structured / streaming | **PASS** |
| DeepSeek adapter implemented | **PASS** |
| DeepSeek thinking mapping / structured handling | **PASS** |
| Reasoning content not leaked | **PASS** |
| Xiaomi Token Plan adapter implemented | **PASS** |
| Xiaomi auth / cluster config / structured path | **PASS** |
| Generic Relay provider / trusted custom endpoint | **PASS** |
| SSRF basic protection / consumer cannot override URL | **PASS** |
| Model IDs config-only / deterministic routes / no silent downgrade | **PASS** |
| Provider raw errors sanitized / credentials never leak | **PASS** |
| All provider conformance / portability | **PASS** |
| Strict typecheck / lint / gates / tests / build / `npm run verify` | **PASS** |
| OJPlatform untouched / AlgoQuest untouched | **PASS** |
| Working tree clean | **PASS** |
