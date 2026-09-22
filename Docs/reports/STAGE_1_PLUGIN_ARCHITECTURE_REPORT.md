# AI BRIDGE V1 — STAGE 1

**`AIBRIDGE_STAGE_1 = PASS`**

Stage 1 = **plugin architecture**. Architecture and contracts only. No real provider, no API
key, no production runtime change, no UI, no host modification.

---

## PRODUCT

**Purpose:** a general-purpose AI capability provider plugin. It converts several AI providers
into one stable, uniform, governable **AI capability** that other plugins consume through the
host capability system.

**Non-goals:** AlgoQuest-specific AI · OJPlatform business logic · a chatbot · an agent
framework · a prompt collection · a vendor SDK wrapper · a complete AI platform · teaching logic
· user identity · OJ problem business · judging · learning scoring · UI · prompt-specific
business rules · the problem ORM · student mastery · arbitrary host data lookup.

---

## ARCHITECTURE

**Core:** `@aibridge/contracts` (zero runtime deps) → `@aibridge/core` (envelopes, router,
fallback, structured pipeline, governance) → `@aibridge/host-sdk` (ports + fakes + conformance
kit) → `@aibridge/capabilities` (specialized packs) → `@aibridge/provider-openai-compatible`.
Provider adapters are **independent packages, not plugins** — no recursive plugin-ization.

**Host:** AI capability broker · non-forgeable plugin identity · permission decision · opaque
subject token · secret store · usage storage · config surface + reload · kill-switch authority.

**Consumer:** business task data · deliberate capability selection · output consumption and its
own final guard · declared degradation behaviour · only permitted context · cancellation ·
idempotency key supply.

---

## GENERIC CAPABILITIES

**Text:** `ai.text.generate@1.0` — free text, structural safety only, no claim of content safety.

**Structured:** `ai.structured.generate@1.0` — **the V1 core**. Two channels (trusted
instructions / untrusted data bindings), extraction → optional bounded repair → runtime
validation → policy checks. Types are never coerced; unknown fields rejected; **no partial
results**.

**Future (evaluated, deliberately out of V1):** `ai.chat.generate`, `ai.chat.stream` (V1.1),
`ai.embedding.generate`, `ai.vision.analyze`. **Rejected for now:** `ai.image.generate`,
`ai.audio.*`.

---

## SPECIALIZED CAPABILITIES

Model: `versioned input schema + versioned output schema + policy + prompt strategy + required
generic primitive`. Names are domain-namespaced, never product-namespaced.

**Education:** `education.idea.evaluate@1.0` (priority) · `education.hint.generate@1.0` ·
`learning.summary.generate@1.0`.
**Code:** `code.debug.analyze@1.0` · `code.explain@1.0`. Never receives hidden testcases,
reference answers or judge secrets.
**Problem:** `problem.explain` · `problem.quest.draft` (reserved; explicitly not a Stage 1 goal).
**Learning:** `learning.*` reserved; nothing registered in V1.

Forbidden: `algoquest.*`, `ojplatform.*`. A product's voice lives in `policyId`.

---

## REQUEST / RESPONSE

**Request envelope:** `contractVersion` · `requestId` · `idempotencyKey` · `callerPluginId`
(host-bound) · `capability` · `capabilityVersion` · `profile` · `requirements?` · `input` ·
`outputSchema` · `policyId?` · `timeoutBudget?` · `subjectToken?` · `metadata?` (exactly four
allow-listed keys, unknown ⇒ reject).

**Never in the envelope:** API key · provider secret · raw session token · cookie · bearer token
· endpoint · vendor model name · prompt override · policy override · host data handle.

**Response envelope:** `contractVersion` · `requestId` · `capability` · `capabilityVersion` ·
`status: SUCCEEDED | FAILED` · `output?` (runtime-validated) · `error?` · `usage` ·
`providerMetadata` (closed safe projection) · `latencyMs` · `finishReason` · `warnings[]`
(closed code set). `estimatedCost` is optional and stays optional — absent means *unknown*, not
zero.

**Errors:** twelve closed codes — `UNAVAILABLE TIMEOUT RATE_LIMITED QUOTA_EXCEEDED INVALID_REQUEST
INVALID_RESPONSE SCHEMA_MISMATCH PROVIDER_ERROR MODEL_UNAVAILABLE CONTENT_BLOCKED CANCELLED
INTERNAL` — plus `stage`, a closed `reason` set (38) and `retryable`. **Provider raw prose never
crosses the boundary**; only a mapped `providerCategory` may.

---

## MODEL

**Profiles:** `fast` · `balanced` · `reasoning` · `cheap` · `high-context` (+ `vision` reserved).
A profile is a semantic class, never a model name. **No silent downgrade** — an unroutable
profile is `MODEL_UNAVAILABLE`, not a quieter one.

**Requirements:** `structuredOutput`, `reasoning`, `streaming` (V1: false), `vision` (V1: false),
`minContextTokens`, `maxOutputTokens`, `maxLatencyMs`. Narrow a route; never name a model.

**Routing:** explicit configured route + fallback chain. Deterministic seven-step resolution:
kill switch → capability route → model route → requirement filter → availability filter →
budget filter → first survivor. No adaptive routing: answers must be reproducible.

---

## PROVIDERS

**Adapter:** `AiProviderAdapter { id, family, adapterApiVersion, descriptor, generateText,
generateStructured, probe?, shutdown? }`. No vendor type in any exported signature.

**Features (per model, not per provider):** `text · structuredJson · jsonSchema · streaming ·
reasoning · usage · vision · tools · caching`, plus `maxContextTokens`, `maxOutputTokens`,
optional dated pricing. "OpenAI-compatible" is a wire format, not a semantic guarantee — every
adapter ships a **probed** provider profile.

**Fallback:** allowed for timeout, temporary unavailability, `MODEL_UNAVAILABLE`, and (only if
configured) rate limit / quota. **Never** for `INVALID_REQUEST`, `SCHEMA_MISMATCH`,
`CONTENT_BLOCKED`. Rule: *if the failure is a property of the request or the content, do not
spend another provider's money on it.*

Bounded retry (transient only), a separate one-shot **output repair** on the same provider, and a
breaker-ready provider runtime state — a full circuit breaker is deferred but possible without a
contract change.

---

## STRUCTURED OUTPUT

**Schema:** `aibridge.fields/v1` field table (or a `REF`). Six types, `required`, `maxLength`,
`untrusted`. Deliberately shaped like AlgoQuest's `AiFieldSpec` — aligned by specification, never
by import.

**Validation:** extraction (fenced JSON → outermost balanced span → `EXTRACTION_FAILED`) → JSON
parse → strict field validation, **no type coercion**, size caps → policy checks → at most one
bounded repair attempt on the same provider.

**Failure:** `SCHEMA_MISMATCH` / `INVALID_RESPONSE` with issue paths. **Never a partial result.**
A model saying "this is JSON" is a hint, not evidence.

---

## SECURITY

**Secrets:** server-side only. Preferred source is a host secret store via `apiKeyRef`, then env
indirection, then an encrypted config file. Never in a browser bundle, a consumer plugin, a
request/response envelope, a log, a fixture or git.

**PII:** credential-shaped input is **rejected** (`SECRET_LIKE_INPUT`) — forwarding a secret is
irreversible. PII-shaped input is **redacted** with `INPUT_REDACTED` — punishing a learner for
pasting a phone number is worse.

**Logs:** prompts and responses are not logged by default (`METADATA_ONLY`). Redaction runs at
the **sink**, not at call sites.

**Permissions:** consumer manifest declares capabilities; the **host** decides allow/deny; AI
Bridge enforces again. `callerPluginId` is host-bound and unforgeable; a self-declared identity
is rejected.

**Context:** AI Bridge never reads host data — not the user DB, not the problem DB, not the judge
DB. Consumers send only a `ContextBundle` they already hold. Specialized capabilities declare a
deny-by-default `inputAllowList`.

Business safety ("never give a child the complete answer") belongs to the capability policy
**and** the consumer's final guard. `declaresSolution` is screened, never trusted.

---

## GOVERNANCE

**Rate limit** (*how fast*): four dimensions — subject, caller plugin, capability, global
provider — sliding window, strictest wins.
**Quota** (*how much*): the same four dimensions in tokens/day and optional currency/month.
Distinct on purpose: `RATE_LIMITED` says slow down, `QUOTA_EXCEEDED` says stop.
**Subject:** an opaque host-minted token — never an email, never a session token.
**Usage:** one record per dispatch with provider, model, tokens, latency, status, cost.
**Cost:** `estimatedCost` with a mandatory `basis`; never presented as an invoice.
**Kill switch:** global · per-provider · per-capability. `DISABLED` ≠ `UNAVAILABLE`, and
`getStatus()` reports it **before** a call — "the school turned AI off" and "AI is broken" need
different words to a child.

---

## VERSIONING

Plugin API `1` · AI Bridge contract `1.0` · generic request schema `1.0` · structured output
schema (per `schemaId@version`) · specialized capability version (per capability) · provider
adapter API `1` (internal).

Major-compatible only. **Unknown major ⇒ reject. Never best-effort parse.**

---

## HOST INTEGRATION

**Required host capabilities:** AI capability broker · plugin identity binding · permission
decision · subject token · secret store · usage storage · config surface + reload · kill-switch
authority.

**Current gaps (8, recorded not patched):**

1. No capability registry / broker — `packages/plugin-sdk` only has the `problem.solve.editor` UI
   slot.
2. No plugin identity binding — `activate(context: { sdkVersion })` only.
3. No permission model in `PluginManifest`.
4. No opaque subject token.
5. No secret store (deployment env only).
6. Manifest dialect divergence (`apiVersion` vs `pluginApiVersion`, both reject unknown fields).
7. No durable plugin storage API.
8. No cancellation propagation across the host.

Mitigation for all eight: the frozen contract is **transport-agnostic**, so consumers build now
and bind later; AI Bridge rejects what cannot be verified rather than trusting it.

---

## ALGOQUEST INTEGRATION

**Consumer mapping:** the existing `GenericAiPort` is the bridge's natural face. `bindings` →
`context[]` is a zero-translation mapping (identical shape); `latencyClass` → `profile`;
`modelClass` ↔ `REASONING/FAST/LOCAL/UNKNOWN`; `costEstimate` → `estimatedCost`. Full table:
[`../INTEGRATION_CONTRACT_V1.md`](../INTEGRATION_CONTRACT_V1.md) §12.

**Unavailable:** capability `UNAVAILABLE`/`DISABLED` ⇒ `AI_UNAVAILABLE` ⇒ authored rubric /
authored fallback, assessor `RUBRIC`, `degraded: true`, band ceiling `PROMISING`. No silent
fallback to `ai.structured.generate`: that is the consumer's adapter / host policy decision
(`allowGenericFallback`).

**Failure mapping:** `TIMEOUT`→`AI_TIMEOUT` · `RATE_LIMITED`/`QUOTA_EXCEEDED`→`AI_RATE_LIMITED` ·
`INVALID_RESPONSE`/`SCHEMA_MISMATCH`/`INTERNAL`→`AI_FAILED` or `OUTPUT_INVALID` ·
`CONTENT_BLOCKED`→`AI_REJECTED` (never rendered to a child as a refusal) · `CANCELLED`→`AI_CANCELLED`.

AI Bridge never writes a learner's classification into a quest, and `COMPLETE` is never the
model's free choice.

---

## PARALLEL CONTRACT

**Frozen fields:** capability naming · request envelope · response envelope · error vocabulary ·
`ai.structured.generate` contract · capability discovery · versioning + rejection rules · timeout
semantics · idempotency semantics · usage projection · availability + kill-switch semantics ·
warning vocabulary · structured-schema field dialect.

**Shared fixture strategy:** **JSON fixture specs**, versioned as `fixture-set.v1`, loaded and
validated by each side's own parser. Cross-repo source import is rejected — it would void host
neutrality in both directions. A published `@aibridge/contract-fixtures` package is deferred to
Stage 8 and needs an ADR in both repositories.

**Safe for AlgoQuest Stage 6: YES.** Everything Stage 6 needs is frozen. The only provisional
surface is the specialized output schema (`ILLUSTRATIVE` fixtures), which is deliberately
isolated behind one adapter boundary. AlgoQuest Stages 6, 7, 8 and 9 all proceed **without** a
real AI Bridge.

---

## PORTABILITY

**OJPlatform coupling:** none. **AlgoQuest coupling:** none. No `@ojplatform/*` or `@algoquest/*`
in any core contract; host knowledge lives in a separate `@aibridge/adapter-<host>` with a
one-way dependency arrow. The contract is a call shape, not an HTTP API.

---

## WORKBENCH

**Stage 1: PASS**

**Stage 2 — Generic AI Contracts, checklist:**
`@aibridge/contracts` (zero runtime deps: versions, envelopes, errors, strict parsers with sorted
rooted issues, capability types) · `@aibridge/core` skeleton (`CapabilityRegistry`,
`AiCapabilityDirectory`, input safety boundary, kill switches, provider/model registry types) ·
`@aibridge/host-sdk` (host ports + fakes + conformance kit skeleton) ·
`check-adapter-coupling.mjs` · `check-no-secret-leak.mjs` · fixture runner · contract tests.
Out of scope for Stage 2: any real provider, key, network call, routing, retry, quotas, capability
packs, UI, host modification. Full checklist: [`../ROADMAP.md`](../ROADMAP.md).

---

## DEPLOYMENT

**Production runtime changed: NO.** No `deploy/`, `compose*.yaml`, `.env.*` example or Windows
installer was touched. `plugin.manifest.json` declares `"deploymentImpact": "NONE"`.

---

## UI

**Implementation: NOT ALLOWED.** Future admin configuration UI (providers, models, keys, routing,
quotas) is recorded in [`../ROADMAP.md`](../ROADMAP.md) and not scheduled. Configuration is
file-based meanwhile.

---

## GIT

**Path:** `D:\OJPlatformPlugins\AIBridge` — independent Git repository. No remote created.

**Branch:** `main`

**Commits:**
- `chore: initialize AI Bridge plugin workspace`
- `docs: define generic AI capability architecture`
- `docs: define AI Bridge integration contract`
- `docs: define AI Bridge security, testing and roadmap`

**Status:** clean working tree. No provider implementation, no API key, no runtime code.

---

## Reference audit (read-only)

| Source | Used for |
| --- | --- |
| `D:\OJPlatform\packages\plugin-sdk\src\index.ts` | `PLUGIN_API_VERSION = 1`, `PluginManifest`, `PluginRegistry`, `PluginHost`, `SUPPORTED_PLUGIN_SLOTS = ['problem.solve.editor']`, `parsePluginManifest` unknown-field rejection |
| `D:\OJPlatform\Docs\adr\0004-plugin-sdk-dependency-direction.md`, `Docs\architecture\DEPENDENCY_RULES.md` | dependency-direction precedent |
| `D:\OJPlatform\plugins\OnlineCodeEditor\plugin.manifest.json` | the `apiVersion` manifest dialect |
| `D:\OJPlatformPlugins\AlgoQuest\packages\contracts\src\ai-task\generic-ai-port.ts` | `GenericAiPort`, `GenericAiRequest/Response`, `StructuredOutputSchema`, `AiFieldSpec`, `GenericAiChannel` |
| `…\ai-task\call.ts`, `…\ai-task\ids.ts` | `AiTaskOutcome`, `AiCallRecord`, `AI_TASK_IDS` |
| `…\ai\provider.ts`, `…\ai\idea-evaluation.ts`, `…\capabilities.ts`, `…\host-error.ts`, `…\versions.ts` | `AiProvider`, `IdeaEvaluation`, `HostCapabilities`, `HostErrorCode`, version policy |
| `D:\OJPlatformPlugins\AlgoQuest\Docs\{CONTRACTS,IDEA_LAB,ADAPTER_OJPLATFORM,PROJECT_STATUS}.md` | Stage 5 degradation semantics, rubric fallback ceiling, adapter coupling rules |
| `D:\OJPlatformPlugins\AlgoQuest\plugin.manifest.json` | the `pluginApiVersion` manifest dialect and `capabilities.requires/optional` shape |

Neither repository was modified.
