# AI BRIDGE V1 — STAGE 3

**`AIBRIDGE_STAGE_3 = PASS`**

Stage 3 = **provider runtime & reference adapter**. The Stage 2 generic contracts were driven
through a **real AI provider** for the first time, with every provider-specific fact isolated
inside one adapter and one trusted runtime boundary:

```text
Consumer → Generic AI Contract → AIBridge Runtime → Provider Adapter → Real Provider → normalized Generic Result
```

No UI, no production runtime change, no host modification, no committed key. Ordinary CI never
touches a real provider.

---

## 1. Runtime architecture

New package `@aibridge/runtime` (depends on `@aibridge/contracts`, `@aibridge/core`,
`@aibridge/host-sdk`). `AiRuntime` is the single execution path; `execute`/`stream` **never throw**.

| Step | Owner | Failure shape |
| --- | --- | --- |
| 1. contract validation | `parseConsumerAiRequest` (the security boundary) + `TrustedDispatchContext` + `composeAiRequest` | `INVALID_REQUEST` with the closed Stage 2 reasons |
| 2. capability validation | registry lookup (`CAPABILITY_UNKNOWN` vs `CAPABILITY_VERSION_UNSUPPORTED`), permission defence in depth (`CALLER_NOT_PERMITTED`), governance kill switches, policy selection, schema ownership, `inputAllowList`, payload parsers | all **pre-dispatch** |
| 3. provider resolution | `resolveRoute` — profile route chain, kill-switch filter, per-**model** feature/requirement checks | `NO_ROUTE`, `MODEL_UNAVAILABLE`, `KILL_SWITCH_*` |
| 4. trusted secret resolution | `credentialRef` → host `SecretStorePort` → `bindCredentials` at registration | registration-time `ValidationResult` |
| 5. execution + timeout + cancellation | one attempt, the frozen three-deadline arithmetic, `raceAttempt` (settles exactly once) | `BUDGET_EXHAUSTED` / `PROVIDER_TIMEOUT` / `CANCELLED` |
| 6. response normalization | text → `{ text, finishReason }`; structured → Stage 2 extraction + `guardStructuredOutput` (no partial results) | `INVALID_RESPONSE` / `SCHEMA_MISMATCH` |
| 7. generic error propagation | `normalizeProviderError` / `normalizeThrown` over `REASON_META` | the closed twelve-code vocabulary |

Consumer-visible surface is the generic contract only; no provider SDK type, HTTP shape or vendor
error reaches a consumer (AGENTS.md §4).

## 2. Provider adapter interface

`AiProviderAdapter` (in `@aibridge/contracts`, `PROVIDER_ADAPTER_API_VERSION = 1`, internal):

```text
generateText(ProviderRequest)            → ProviderTextResult | throw ProviderCallError
generateStructured(ProviderRequest)      → ProviderStructuredResult | throw ProviderCallError
streamText?(ProviderRequest)             → AsyncIterable<ProviderStreamEvent>   (additive)
bindCredentials?(TrustedCredentials)     → void                                  (additive)
probe? / shutdown?
```

Stage 3 additive, all internal (recorded as a compatibility note): `streamText?`, `bindCredentials?`,
`ProviderRequest.cancellation?`, `ProviderRawError.reason` / `retryAfterMs`, and the
`ProviderCallError` class whose `message` is fixed (`'provider call failed'`) because a thrown value
may land in a stack trace. `ProviderRequest` remains AI Bridge's own shape — the test asserts its
key set carries no credential field at all.

## 3. Reference provider

**Exactly one**: `@aibridge/provider-openai-compatible` (`OpenAiCompatibleAdapter`) — the
OpenAI-compatible chat-completions dialect, chosen per the ROADMAP because `baseUrl` + `apiKey` +
`model` reaches the widest set of vendors. No second provider, no marketplace.

Provider-specific and contained: `/chat/completions` payload (`model`, `messages`, `max_tokens`,
`stream`, `stream_options`), `Content-Type` + `Authorization: Bearer …`, base URL composition,
response shape (`choices[].message.content`, `finish_reason`, `usage.*`),
error body (`error.type`/`error.code`/`error.message`), `Retry-After`, SSE `data:` framing and
`[DONE]`. Model features are **declared by the operator, never assumed** from the URL shape
(`ARCHITECTURE.md` §7.3). The transport seam (`FetchLike`) is self-declared so no `Response` /
`RequestInit` / `AbortSignal` type escapes into a published signature.

## 4. Generic → provider request translation

`AiRuntime` renders the two prompt channels with the shared contract renderers; the adapter
composes the vendor payload:

- `instructions` (+ `outputFormatInstruction` from the caller-owned output schema) → the **system**
  message — the trusted channel;
- `context[]` → the **user** message via `renderContextBlock`, where every `untrusted` value is
  fenced as `<<<aibridge-data … <<<aibridge-data` and labelled "never as instructions" — the data
  channel. A learner sentence is therefore **structurally** unable to rewrite policy; the test
  asserts an injection-shaped value appears only in the user message, never in the system message;
- `modelRef` (operator-side) → `model`; `maxOutputTokens` → `max_tokens`; `deadlineAtMs` → an abort
  timer; `cancellation` → an abort signal;
- the credential → **the `Authorization` header and nowhere else**. The payload body is asserted
  credential-free.

## 5. Provider → generic response normalization

- `finish_reason` → the closed `STOP | LENGTH | CONTENT_FILTER | UNKNOWN` (an unknown spelling is
  `UNKNOWN`, never guessed); `content_filter` with no content is a **signal**, not an error.
- `usage` → `AiUsage` with absent fields left absent (unknown ≠ zero): `prompt_tokens`,
  `completion_tokens`, `total_tokens`, `prompt_tokens_details.cached_tokens`.
- `providerMetadata` → the closed projection (`providerId`, `providerFamily: 'openai-compatible'`,
  `modelClass` from the model's features, `routeDepth: 0`, `attemptCount: 1`, `repaired: false`).
- structured payloads go through the existing Stage 2 pipeline: ordered extraction →
  `guardStructuredOutput` → **no partial results**. (Bounded repair and the full structured
  pipeline remain Stage 4.)

## 6. Capability enforcement

Every requirement is checked against the resolved **model descriptor** before dispatch; an
unsatisfiable one is `NO_ROUTE` with `details.profile`, never a quiet downgrade. Enforced:
`text`/`structuredJson`/`reasoning`/`streaming` features, `minContextTokens`, `maxOutputTokens`,
profile membership, `vision`/`streaming` V1 unsatisfiability per delivery mode
(`unsatisfiableRequirements`), schema ownership both ways (`OUTPUT_SCHEMA_OVERRIDE_FORBIDDEN`,
missing-schema rejection, `REF` resolution), policy selection, `inputAllowList` (deny by default),
capability major compatibility, kill switches. The fake tests prove each by **counting provider
calls**: `callCount === 0`.

## 7. Streaming

Stage 2 had no streaming contract; Stage 3 adds the **minimal additive** one (compatibility note):

```text
STARTED → TEXT_DELTA* → (COMPLETED | FAILED)      exactly one terminal, always last
```

`COMPLETED.text` is the concatenation of the deltas and carries the same closing facts `AiResult`
carries (`usage`, `finishReason`, `providerMetadata`, `latencyMs`, `warnings`); `FAILED` carries a
normalized `AiError`. `validateAiStreamSequence` machine-checks order/finish/usage/error semantics.
Provider side: `ProviderStreamEvent` (`TEXT_DELTA | FINISH | ERROR`) — never a vendor SSE frame.

Deterministic and tested: stream success (order + usage + finish), HTTP failure before the stream,
mid-stream vendor error (one `ERROR` terminal, deltas kept honest), stream ending without a finish
event (`PROVIDER_BAD_RESPONSE`), cancellation mid-stream (one `FAILED` terminal, later deltas
discarded), structured-capability stream refused **locally**, non-streaming route refused locally.
Streaming is offered for `ai.text.generate` only — a token stream of a partial judgement is
dangerous (`CAPABILITIES.md` §4); structured generation stays complete-or-nothing.

## 8. Error mapping

Provider/network failures map to the **existing** Stage 2 model (`REASON_META` is authoritative).
The full table, each row tested (vendor prose sentinel asserted absent from every public field):

| Case | category | reason | code | stage | retryable |
| --- | --- | --- | --- | --- | --- |
| invalid request (consumer) | — | `MALFORMED_ENVELOPE` / `INPUT_TOO_LARGE` / … | `INVALID_REQUEST` | ENVELOPE/INPUT_SAFETY | false |
| permission | — | `CALLER_NOT_PERMITTED` | `INVALID_REQUEST` | PERMISSION | false |
| auth failure (401/403) | `AUTH` | `PROVIDER_AUTH_FAILED` *(additive)* | `PROVIDER_ERROR` | PROVIDER | false |
| provider-rejected request (400/422) | `BAD_REQUEST` | `PROVIDER_REQUEST_REJECTED` *(additive)* | `INVALID_REQUEST` | PROVIDER | false |
| model not found (404/400 `*model*`) | `BAD_REQUEST` | `MODEL_UNAVAILABLE` | `MODEL_UNAVAILABLE` | ROUTING | false |
| rate limit (429) | `RATE_LIMIT` | `PROVIDER_THROTTLED` | `RATE_LIMITED` | PROVIDER | true + `retryAfterMs` |
| provider unavailable (5xx/transport) | `UPSTREAM` | `PROVIDER_UNAVAILABLE` *(additive)* | `PROVIDER_ERROR` | PROVIDER | true |
| overloaded (503 / `overloaded_error`) | `OVERLOADED` | `PROVIDER_OVERLOADED` | `PROVIDER_ERROR` | PROVIDER | true |
| timeout (408/504/deadline) | `UPSTREAM` | `PROVIDER_TIMEOUT` | `TIMEOUT` | PROVIDER | true |
| cancelled | — | `CANCELLED_BY_CALLER` / `CANCELLED_BY_HOST` | `CANCELLED` | CANCELLATION | false |
| malformed provider response | `UPSTREAM` | `PROVIDER_BAD_RESPONSE` | `INVALID_RESPONSE` | PROVIDER | true |
| content filter | `CONTENT_FILTER` | `PROVIDER_CONTENT_FILTER` | `CONTENT_BLOCKED` | PROVIDER | false |
| internal (unmapped throw) | — | `INTERNAL_ERROR` | `INTERNAL` | INTERNAL | false |

Non-penetration: the raw error body is read **only** inside the adapter, reduced to category +
reason (+ operator-only `rawMessage`), and `normalizeThrown` discards a thrown message outright.

## 9. Timeout

The frozen arithmetic is reused unchanged: `clampTimeoutBudget` clamps **down** (a 10-minute call
cannot be bought — asserted), `providerDeadlineAt` reserves `VALIDATION_RESERVE_MS` and refuses a
non-viable attempt (`BUDGET_EXHAUSTED`, no dispatch), one attempt overrunning its per-attempt
deadline is `PROVIDER_TIMEOUT` and the outbound call is **abandoned** (abort asserted on the fake
transport). The two failure modes are distinguishable on purpose.

## 10. Cancellation

`CancellationToken` (host-neutral) via `ExecuteOptions`, propagated to the adapter as
`ProviderRequest.cancellation` (abort). Semantics tested: cancelled **before** dispatch ⇒
`CANCELLED`/`CANCELLED_BY_CALLER`, no charge, **zero** provider calls; cancelled in flight ⇒
terminal and idempotent, the late provider answer is discarded; mid-stream ⇒ one `FAILED` terminal
and no further deltas; the outbound call is aborted.

## 11. Secret handling

The API key exists **only** in the trusted runtime boundary. Flow: operator config names
`credentialRef: "secret://…"` (a handle, never a literal) → `AiRuntime.registerProvider` resolves it
through the host `SecretStorePort` → hands it to `bindCredentials` over the single trusted channel
(`TrustedCredentials`) → the adapter stores it in a private field excluded from
`JSON.stringify`/`toString()` and places it only in the outbound `Authorization` header. The
runtime keeps the resolved value only to strip it from operator detail, never in serializable state.

Regression tests prove the key appears in **none** of: generic request (`ProviderRequest` — the key
set has no credential field at all), generic response (`AiResult`), error serialization
(`AiError`), stream events, snapshots (`JSON.stringify(runtime)`, `JSON.stringify(adapter)`,
`String(adapter)`), fixtures, operator log entries — including the worst case where the **provider
error body echoes the key back** (stripped at the log sink along with PII and truncated). The
scripted adapter drops the value on binding entirely. A registration that would resolve a credential
for an adapter that cannot bind one is refused. `screenAiInput` and the Stage 2 gates do not
regress; package output is covered by `check-no-secret-leak.mjs` + the packed-declaration scan.

## 12. Negative security test

Deliberately breaking the boundary makes verification fail — demonstrated twice:

1. **Secret gate (manual + automated).** A credential-shaped file planted in the tree:
   `check-no-secret-leak.mjs` → `1 finding(s) … matches OPENAI_STYLE_KEY`, exit **1** (so
   `npm run gates` → `npm run verify` fail). Cleanup → `OK (131 files scanned)`, exit 0. The same
   sequence runs as a test (`tests/security/runtime-secrets.test.ts`), planting the file, asserting
   exit ≠ 0 and the named pattern, and removing it in `finally`.
2. **Runtime leak mutant.** A deliberately broken adapter (`LeakyAdapter`) that serializes its
   credential is caught by the very assertions the good adapter passes — proving the regression
   suite detects the mutation rather than merely passing on correct code.

## 13. Fake-provider tests

Ordinary CI is network-free and deterministic. `tests/helpers/openai-fake.ts` scripts the HTTP
transport (statuses, vendor error bodies, SSE frames, hanging calls with abort support);
`ScriptedProviderAdapter` scripts the port (incl. `streamStep`s). Coverage — success; malformed
response (non-JSON body, missing content); 401/403; 404/400 model; 429 + `Retry-After`; 5xx (500,
503); timeout; cancellation; stream success; stream error (mid-stream + pre-stream); capability
rejection (unknown capability, unsupported major, ungranted caller, forged context, schema
ownership both ways, `inputAllowList`, secret input, unknown policy, kill switch, unsatisfiable
requirements, unstreamable route). The provider conformance kit runs 9 cases against **two**
adapters through two injection seams.

## 14. Live-provider test

`npm run test:live-provider` — opt-in, outside `verify`, never in PR CI. Without credentials it
reports `SKIP` and exits 0. With credentials it performs exactly one real round trip and asserts the
credential appears in no output surface.

**Executed manually against a real provider for the exit gate:**

```text
endpoint : https://hgapi.dieqiyun.top/v1        (OpenAI-compatible)
model    : deepseek-v4-flash-0731               (operator-side model ref)
credential source: environment only (never printed, never committed)
result   : status SUCCEEDED, output.text = "pong", finishReason STOP
usage    : inputTokens 87, outputTokens 38, totalTokens 125
projection: providerId "live", providerFamily "openai-compatible", modelClass "FAST",
            routeDepth 0, attemptCount 1, repaired false
latency  : 2631 ms
secret   : asserted absent from the result, the runtime and the adapter — PASS
verdict  : test:live-provider PASS
```

## 15. ESLint

The Stage 2 deferral is paid: `eslint@9.39.1` + `typescript-eslint@8.46.2` (pinned),
`eslint.config.mjs` (flat), `npm run lint` inside `npm run verify`. Deliberately small — the
compiler owns types, the coupling gate owns host neutrality, the secret gate owns credential
shapes; ESLint catches the residual class (dead code, accidental globals, unsafe patterns) and
**no** style reformatting was done.

## 16. Contract changes

Additive only, no breaking change (AGENTS.md §8):

| Change | Kind | Where |
| --- | --- | --- |
| three error reasons `PROVIDER_AUTH_FAILED`, `PROVIDER_REQUEST_REJECTED`, `PROVIDER_UNAVAILABLE` (+ `REASON_BY_PROVIDER_CATEGORY`) | additive enum members | `errors.ts` |
| `AiStreamEvent` sequence + parsers + `validateAiStreamSequence` | new additive surface | `stream.ts` |
| `ContextValue` / `StructuredGenerateInput` / `TextGenerateInput` parsers | implementing frozen §5.1/§5.5 shapes — no shape change | `input.ts` |
| prompt-channel renderers | new additive surface | `prompt.ts` |
| `ProviderRequest.cancellation?`, `streamText?`, `bindCredentials?`, `ProviderRawError.reason`/`retryAfterMs`, `ProviderCallError` | internal port (not a public contract) | `provider.ts` |
| `unsatisfiableRequirements(requirements, delivery)` | additive; `v1UnsupportedRequirements` behavior **unchanged** | `requirements.ts` |

No version bump (Stage 2 precedent — no versioned consumer exists yet). The nine fixtures are
untouched and all parse unchanged.

## 17. Compatibility notes

Two notes recorded in [`INTEGRATION_CONTRACT_V1.md`](../INTEGRATION_CONTRACT_V1.md): the three
error reasons (with their exact `code`/`stage`/`retryable` classification), and streaming as a
delivery concern (the frozen sequence; `ai.text.generate` streamable, structured generation not;
`CapabilityRequirements.streaming` keeps its frozen V1 semantics for non-streaming delivery —
`true` ⇒ `NO_ROUTE`, never a quiet downgrade). Fixture impact: **none**; stream sequence rules are
covered by contract tests because a fixture document is a request or a response and a stream is
neither.

## 18. Portability

`npm run check:portability` now packs **all five** packages → installs them `--offline` into an
isolated project (no workspace, no aliases, no `src/`, no registry) → typechecks the consumer with
`types: []` (no `node` types) → runs a **declaration-hygiene scan** (no `AbortSignal`, `RequestInit`,
`Response`, `Headers`, `ReadableStream`, `NodeJS.*`, `node:*` in any published `.d.ts`) → runs an
11-assertion smoke including one full runtime + reference adapter round trip over fake HTTP with a
credential bound through the secret port. No package depends on monorepo files.

## 19. CI

Unchanged and green: `.github/workflows/verify.yml` runs `npm ci` + `npm run verify` on
`ubuntu-latest` and `windows-latest` against Node `22.20.0`. `verify` now includes `lint`. The live
provider smoke is deliberately **not** in CI.

## 20. `npm run verify`

Green end to end: typecheck (build + tests) → lint → gates (coupling, secret-leak, runtime-deps) →
214 tests → build → portability (5 packages, declaration hygiene, smoke).

## 21. Production runtime impact

**None** (AGENTS.md §7 deployment-impact check): `deploy/`, `compose*.yaml`, `.env.*` examples and
any installer are untouched; `plugin.manifest.json` is unchanged with `"entry": null`; no provider
is wired into any production user flow. The real provider is reachable only through the explicit
opt-in test path.

## 22. UI impact

**None.** The UI gate is closed and untouched (AGENTS.md §6). No admin console, no settings panel,
no React/Vue/CSS, no pages.

## 23. Docs

Updated: [`CONTRACTS.md`](../CONTRACTS.md) (package arrows, stream/input/prompt sections, port
additions, runtime + adapter sections, gates), [`INTEGRATION_CONTRACT_V1.md`](../INTEGRATION_CONTRACT_V1.md)
(Stage 3 compatibility note), [`CAPABILITIES.md`](../CAPABILITIES.md) (streaming status),
[`SECURITY.md`](../SECURITY.md) (trusted secret boundary in code, operator channel),
[`TESTING.md`](../TESTING.md) (conformance cases and where they live; secret regression + negative
gate tests), [`ROADMAP.md`](../ROADMAP.md) (Stage 3 checklist, paid deferral, workbench row),
[`PROJECT_STATUS.md`](../PROJECT_STATUS.md) (Stage 3 gate table, gates state),
[`README.md`](../../README.md) (status, packages, commands), and this report.

## 24. Git commits

Logical commits on `main`, no remote, no push, AlgoQuest/OJPlatform untouched:

1. `feat(contracts): add the stream contract, capability payload parsers and provider-port extensions`
2. `feat(host-sdk): add streaming scripts, trusted credential handling and the adapter-neutral conformance kit`
3. `feat(runtime): add the trusted execution layer with generic error propagation`
4. `feat(provider-openai-compatible): add the reference OpenAI-compatible adapter`
5. `test(security): add secret-leakage regressions and the negative gate test`
6. `chore: add ESLint, the declaration-hygiene gate and the opt-in live provider smoke`
7. `docs: record Stage 3 contracts, compatibility notes and the acceptance report`

## 25. Working tree

`git status` clean at the end of Stage 3.

---

## Exit gate

| Requirement | Result |
| --- | --- |
| Generic contract validation | **PASS** |
| Capability validation | **PASS** |
| Trusted secret boundary | **PASS** |
| Reference adapter | **PASS** |
| Request translation | **PASS** |
| Response normalization | **PASS** |
| Generic error mapping | **PASS** |
| Streaming | **PASS** |
| Timeout | **PASS** |
| Cancellation | **PASS** |
| Secret leakage regression | **PASS** |
| Fake provider tests | **PASS** |
| Package portability | **PASS** |
| Linux CI compatibility | **PASS** |
| Windows CI compatibility | **PASS** |
| ESLint | **PASS** |
| `npm run verify` | **PASS** |
| Live provider smoke | **PASS** (manual, real provider — §14) |
| No UI changes | **PASS** |
