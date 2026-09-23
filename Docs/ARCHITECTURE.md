# AI Bridge — Architecture

Stage 1. Architecture and boundaries only. No real provider, no API key, no production runtime
change, no UI.

Companion documents: [`CAPABILITIES.md`](CAPABILITIES.md) for the capability model,
[`INTEGRATION_CONTRACT_V1.md`](INTEGRATION_CONTRACT_V1.md) for the frozen consumer contract,
[`SECURITY.md`](SECURITY.md) for the security boundaries.

---

## 0. Positioning

**AI Bridge is a general-purpose AI capability provider plugin.** It converts several AI
providers into one stable, uniform, governable **AI capability** that other plugins consume
through the host capability system.

It is **not**:

- AlgoQuest-specific AI
- OJPlatform business logic
- a chatbot
- an agent framework
- a prompt collection
- a wrapper around one vendor's SDK
- a full AI platform

The dependency shape is the whole point:

```
Consumer plugin  ──(host capability)──▶  AI Bridge
                                            ├─ provider adapter A
                                            ├─ provider adapter B
                                            └─ provider adapter C
```

AlgoQuest does not import AI Bridge. AI Bridge does not import AlgoQuest. The host's future
capability registry is what connects them.

---

## 1. Responsibility split

### 1.1 `AI_BRIDGE_RESPONSIBILITIES`

| # | Responsibility | Notes |
| --- | --- | --- |
| 1 | **AI capability registry** | Register, version and expose generic primitives and specialized capability packs. See [`CAPABILITIES.md`](CAPABILITIES.md). |
| 2 | **Provider abstraction** | One `AiProviderAdapter` interface; vendor shapes never cross it (§7). |
| 3 | **Model abstraction** | Consumers ask for a **profile** or a requirement set, never a vendor model name (§8). |
| 4 | **Request envelope** | One validated ingress shape for every call (§4). |
| 5 | **Text generation** | `ai.text.generate` (§[`CAPABILITIES.md`](CAPABILITIES.md)). |
| 6 | **Structured generation** | `ai.structured.generate`, the V1 core: extraction + runtime validation (§11). |
| 7 | **Routing** | Resolve `(capability, profile, requirements, policy)` to a concrete route (§9). |
| 8 | **Timeout** | Overall request deadline, per-provider deadline, fallback deadline (§12). |
| 9 | **Retry** | Bounded retry for explicitly transient failures only (§10.3). |
| 10 | **Fallback** | Provider A → provider B under a declared policy only (§10.1). |
| 11 | **Usage** | Token counts and other usage facts, projected safely (§16). |
| 12 | **Cost metadata** | `estimatedCost` when honestly computable, explicitly marked as estimated (§16.2). |
| 13 | **Quotas** | Budget ceilings distinct from rate limits (§15.2). |
| 14 | **Policy / version metadata** | Which capability version, which policy id, which output schema produced this answer (§24). |
| 15 | **Diagnostics** | Success rate, latency, throttle rate, provider error rate, token usage (§16.4). |
| 16 | **Error normalization** | Closed AI error vocabulary; provider raw text never crosses the boundary (§6). |
| 17 | **Input safety boundary** | Size caps, metadata allow-list, credential-pattern rejection, PII redaction (§[`SECURITY.md`](SECURITY.md) §3). |
| 18 | **Structural output safety** | Schema conformance, size caps, malformed-output handling (§11.4). |
| 19 | **Secret custody** | Provider credentials held server-side, never projected outward (§18). |
| 20 | **Governance switches** | Global / provider / capability kill switches (§20). |

### 1.2 `HOST_RESPONSIBILITIES`

| # | Responsibility | Why it must be the host |
| --- | --- | --- |
| 1 | **AI capability broker** | Route a consumer's call to whichever plugin provides it. |
| 2 | **Plugin identity binding** | Mint `callerPluginId` at the plugin runtime boundary. A caller must not be able to forge it (§[`SECURITY.md`](SECURITY.md) §4). |
| 3 | **Permission decision** | Read the consumer manifest's declared capabilities and decide `allow` / `deny` before AI Bridge is entered (§[`SECURITY.md`](SECURITY.md) §5). |
| 4 | **Subject token minting** | Issue an opaque, AI-Bridge-scoped subject token for rate/quota attribution. Not an email, not a raw session token. |
| 5 | **Secret store** | Hold provider API keys; hand AI Bridge a *handle*, not a value, where possible. |
| 6 | **Usage storage (durable)** | Persist the usage ledger beyond process lifetime if the deployment requires it (§19). |
| 7 | **Configuration surface** | Where routing/provider config lives and how it is reloaded. |
| 8 | **Kill-switch authority** | Who may throw the global switch (an operator, not a plugin). |

### 1.3 `CONSUMER_PLUGIN_RESPONSIBILITIES`

| # | Responsibility | Notes |
| --- | --- | --- |
| 1 | **Business prompt / task data** | The consumer knows what it is asking about. It supplies task data in `input`. |
| 2 | **Capability selection** | Choose `education.idea.evaluate` over `ai.structured.generate` deliberately. |
| 3 | **Output consumption + final guard** | Business safety ("never hand a child the full answer") is enforced by the consumer's own guard, on top of the capability policy. |
| 4 | **Degradation behaviour** | What to do when AI is unavailable is a consumer decision, never a silent fallback (§[`INTEGRATION_CONTRACT_V1.md`](INTEGRATION_CONTRACT_V1.md) §9). |
| 5 | **Only permitted context** | Send only a `ContextBundle` the consumer is already allowed to hold. |
| 6 | **Cancellation** | Cancel in-flight work when the learner leaves (§13.2). |
| 7 | **Idempotency key supply** | One logical learning turn ⇒ one `idempotencyKey` (§14). |

### 1.4 Explicit non-responsibilities

AI Bridge does **not** own, and must grow no code for:

AlgoQuest teaching logic · user authentication · OJ problem business · the judge · learning
scoring · UI · prompt-specific business rules · the problem ORM · student mastery · arbitrary
host data lookup · any host database read.

---

## 2. Component model and dependency rules

```
@aibridge/contracts        pure types, parsers, validators, version constants (zero runtime deps)
@aibridge/core             envelopes, router, fallback, retry, structured pipeline, governance
@aibridge/host-sdk         host port interfaces + in-memory fakes + conformance kit
@aibridge/capabilities     specialized capability packs (packaged per family later)
@aibridge/provider-openai-compatible   the generic relay provider + the shared OpenAI-compatible wire layer
@aibridge/provider-openai              OpenAI Official (Responses API wire path)
@aibridge/provider-deepseek            DeepSeek Official (chat dialect + thinking semantics)
@aibridge/provider-xiaomi-tokenplan    Xiaomi MiMo Token Plan (chat dialect + Token Plan auth)
───────────────────────────────────────────────────────────────────────────────
@aibridge/adapter-<host>   OPTIONAL, separate, the only place a host is named
```

Dependency direction:

```
consumer plugin ─▶ host SDK ─▶ AI Bridge contracts
AI Bridge core  ─▶ contracts        (never the reverse)
provider-*      ─▶ contracts + core ports
adapter-<host>  ─▶ contracts         (knows one host's HTTP/IPC contract)
core            ✗ concrete providers, ✗ concrete hosts, ✗ concrete consumers
```

Rules:

- `@aibridge/contracts` has **zero runtime dependencies**. It must stay parseable in any host.
- Public contracts must not leak infrastructure types (HTTP clients, SDK response objects, DB rows).
- No cycles.
- A provider adapter is an **independent package**, not a plugin. Do not recursively plugin-ize
  providers (§22).

---

## 3. Naming and identity

| Thing | Value | Rule |
| --- | --- | --- |
| Plugin id | `ai.bridge` | Host-neutral. Never `ojplatform.ai`, never `algoquest.ai`. |
| Generic capability namespace | `ai.*` | Owned by AI Bridge core. |
| Specialized capability namespace | `<domain>.<subject>.<verb>` | Domain-owned, host-neutral. `education.*`, `code.*`, `problem.*`, `learning.*`. Forbidden: `algoquest.*`, `ojplatform.*`. |
| Provider instance id | operator-named, e.g. `main`, `local`, `backup` | Stable id, not a vendor brand. |
| Package scope | `@aibridge/*` | One direction of dependency only. |

The plugin id `ai.bridge` deliberately sits under the same root as the capability namespace it
owns. They are distinct identifiers: `ai.bridge` names the plugin, `ai.text.generate` names a
capability. Nothing resolves one from the other.

---

## 4. Generic request envelope — `AiRequestEnvelope`

The single ingress shape. Every call, generic or specialized, is one of these.

```ts
export const AI_BRIDGE_CONTRACT_VERSION = '1.0';

export type ModelProfile = 'fast' | 'balanced' | 'reasoning' | 'cheap' | 'high-context';

export interface AiRequestEnvelope<TInput = unknown> {
  /** Major-compatible. Unknown major ⇒ reject (INVALID_REQUEST / CONTRACT_VERSION_UNSUPPORTED). */
  readonly contractVersion: string;

  /** Unique per attempt. ULID/UUID, 1..64 chars. Echoed back verbatim. */
  readonly requestId: string;

  /** One logical turn ⇒ one billable call. 1..128 chars. Scoped (caller, capability, capabilityVersion). */
  readonly idempotencyKey: string;

  /** Bound by the host plugin runtime. MUST NOT be accepted from an untrusted channel. */
  readonly callerPluginId: string;

  /** e.g. 'ai.structured.generate' | 'education.idea.evaluate' */
  readonly capability: string;

  /** e.g. '1.0'. Major-compatible. */
  readonly capabilityVersion: string;

  /** A profile, never a model name. See §8. */
  readonly profile: ModelProfile;

  /** Optional hard requirements narrowing the route. See §8.2. */
  readonly requirements?: CapabilityRequirements;

  /** Capability-defined payload. Specialized capabilities enforce an input allow-list. */
  readonly input: TInput;

  /** Declared output shape. See §11.1. */
  readonly outputSchema: OutputSchema;

  /**
   * Selects a registered policy by id. The consumer may SELECT a policy; it may never supply
   * or override one. A policy id not registered for this capability ⇒ INVALID_REQUEST.
   */
  readonly policyId?: string;

  /** Overall budget. The bridge may tighten it, never widen it. See §12. */
  readonly timeoutBudget?: TimeoutBudget;

  /** Opaque, host-minted, AI-Bridge-scoped subject token. Never a session token. See §15. */
  readonly subjectToken?: string;

  /** Closed allow-list of exactly four keys. Unknown key ⇒ reject. See §4.2. */
  readonly metadata?: RequestMetadata;

  /** In-process only; not serializable. See §13.2. */
  readonly cancellation?: CancellationToken;
}
```

### 4.1 What must never appear in the envelope

`apiKey` · any provider secret · a raw session token · a cookie · a bearer token · an endpoint
URL · a vendor model name · a system-prompt override · a policy override · a host data handle
(a problem id is *task data* the consumer already holds and belongs in `input`, not a lookup
request).

Enforcement: a closed key list per object, unknown keys rejected with
`INVALID_REQUEST / MALFORMED_ENVELOPE`, and a mechanical test (`Docs/TESTING.md` §2.1).

### 4.2 `RequestMetadata` — strict allow-list

```ts
export type RequestMetadata = {
  readonly locale?: string;        // BCP-47, e.g. 'zh-CN'
  readonly traceId?: string;       // ^[A-Za-z0-9._-]{1,64}$
  readonly surface?: string;       // ^[a-z][a-z0-9-]{0,31}$  e.g. 'idea-lab'
  readonly correlationId?: string; // ^[A-Za-z0-9._-]{1,64}$
};
```

Exactly these four keys. Total serialized size ≤ 512 bytes. An unknown key is **rejected**
(`INVALID_REQUEST / METADATA_NOT_ALLOWED`), not silently dropped: deny-by-default is testable,
silent dropping is not.

### 4.3 `OutputSchema`

```ts
export type FieldSpec = {
  readonly name: string;           // ^[a-z][a-zA-Z0-9]*$
  readonly type: 'STRING' | 'NUMBER' | 'BOOLEAN' | 'STRING_ARRAY' | 'OBJECT' | 'OBJECT_ARRAY';
  readonly required: boolean;
  readonly description: string;    // rendered into the output-format instruction only
  readonly untrusted?: boolean;
  readonly maxLength?: number;     // hard bound in characters for STRING
};

export type OutputSchema =
  | { readonly kind: 'REF'; readonly ref: OutputSchemaRef }
  | {
      readonly kind: 'INLINE';
      readonly schemaId: string;
      readonly version: string;
      readonly dialect: 'aibridge.fields/v1';
      readonly fields: readonly FieldSpec[];
    };

export type OutputSchemaRef = { readonly schemaId: string; readonly version: string };
```

The `aibridge.fields/v1` dialect is a small field table rather than a free-form schema
document, so that "which variables may a prompt mention" has exactly one answer and candidate
validation is deterministic and dependency-free.

> This field table is **deliberately shaped like AlgoQuest's `AiFieldSpec`** (same six keys,
> same six types, same lowerCamelCase rule) so that a future adapter is a zero-translation
> mapping. That is alignment by specification, never by import.

A JSON Schema dialect is a possible later extension and is explicitly **not** in the frozen
contract.

### 4.4 `CapabilityRequirements`

```ts
export type CapabilityRequirements = {
  readonly structuredOutput?: boolean;
  readonly reasoning?: boolean;
  readonly streaming?: boolean;   // V1: always false
  readonly vision?: boolean;      // V1: always false
  readonly minContextTokens?: number;
  readonly maxOutputTokens?: number;
  readonly maxLatencyMs?: number;
};
```

Requirements narrow the route; they never name a model.

### 4.5 `TimeoutBudget` and `CancellationToken`

```ts
export type TimeoutBudget = { readonly totalMs: number; readonly providerMs?: number };
export interface CancellationToken {
  readonly cancelled: boolean;
  readonly onCancel: (cb: () => void) => () => void;
}
```

`CancellationToken` is host-neutral on purpose — no `AbortSignal`, no `AbortController`, no DOM
type in the contract. A host adapter may wrap an `AbortSignal` around it.

---

## 5. Generic response envelope — `AiResult`

```ts
export type AiResult<TOutput = unknown> = {
  readonly contractVersion: string;
  readonly requestId: string;            // echoed
  readonly capability: string;
  readonly capabilityVersion: string;

  readonly status: 'SUCCEEDED' | 'FAILED';

  /** Present only when SUCCEEDED, and only after runtime validation. */
  readonly output?: TOutput;
  /** Present only when FAILED. */
  readonly error?: AiError;

  readonly usage: AiUsage;
  readonly providerMetadata: ProviderMetadataProjection;
  readonly latencyMs: number;            // end to end, including routing and validation
  readonly finishReason: AiFinishReason;
  readonly warnings: readonly AiWarning[];
};
```

`status` is binary on purpose. A "half-success" is represented as `SUCCEEDED` plus `warnings`,
so a consumer has exactly one branch to write.

### 5.1 `AiUsage`

```ts
export type AiUsage = {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly cachedTokens?: number;
  readonly estimatedCost?: EstimatedCost;
};

export type EstimatedCost = {
  readonly value: number;
  readonly currency: string;                                  // ISO 4217
  readonly basis: 'PROVIDER_REPORTED' | 'PRICE_TABLE' | 'ESTIMATED';
};
```

**`estimatedCost` is optional and must stay optional.** Not every provider reports usage, and
none reports cost in a comparable way. Absent means *unknown*, not *zero*. `basis` is mandatory
when a cost is present, so a consumer can never mistake a price-table guess for a provider
invoice. All usage fields are optional because some providers report nothing.

Usage is **cost and capacity evidence only**. Nothing in it may influence a learning judgement.

### 5.2 `ProviderMetadataProjection` — the safe projection

```ts
export type ProviderMetadataProjection = {
  readonly providerId: string;         // operator-named instance id: 'main', 'local', 'backup'
  readonly providerFamily: 'openai-compatible' | 'anthropic' | 'google' | 'local' | 'mock';
  readonly modelClass: 'REASONING' | 'FAST' | 'LOCAL' | 'UNKNOWN';
  readonly routeDepth: number;         // 0 = first choice; > 0 = a fallback served it
  readonly attemptCount: number;
  readonly repaired: boolean;          // an output repair attempt was needed
};
```

Closed key set; unknown keys rejected. **Excluded by design**, and their absence is asserted by
a test: `modelId`, `endpoint`, `baseUrl`, `apiKeyId`, `organizationId`, `projectId`, `region`,
`requestHeaders`, `responseHeaders`, `rawRequest`, `rawResponse`, `rawError`, `finishText`,
`sessionId`, `subjectToken`.

`modelClass` is a *class*, deliberately not a vendor model name. Reporting the model id would
teach every consumer to branch on `gpt-*` and would leak deployment topology. Operators see the
real model in the usage record (§16.3); consumers see the class.

### 5.3 `AiFinishReason`

`'STOP' | 'LENGTH' | 'CONTENT_FILTER' | 'UNKNOWN'`. Closed. `LENGTH` and `CONTENT_FILTER` are
signals for the consumer's own guard; neither is an error by itself.

### 5.4 `AiWarning`

```ts
export type AiWarning = {
  readonly code:
    | 'IDEMPOTENT_REPLAY'    // this result was replayed from a prior identical turn
    | 'OUTPUT_REPAIRED'      // the raw payload needed one bounded repair before it validated
    | 'FALLBACK_USED'        // a non-first-choice route served the request
    | 'DEGRADED_ROUTE'       // the route was narrowed (e.g. requested profile unavailable)
    | 'USAGE_ESTIMATED'      // usage figures are computed, not provider-reported
    | 'INPUT_REDACTED'       // PII-like material was redacted from the input
    | 'INPUT_TRUNCATED'      // input hit a declared size bound and was truncated
    | 'POLICY_NARROWED';     // a registered policy narrowed the caller's request
  readonly detail?: string;
};
```

Closed code set. Warnings are additive: a consumer that ignores them still behaves safely.

---

## 6. Error model — `AiError`

AI Bridge speaks **one** stable error vocabulary. It is a closed set of twelve.

```ts
export type AiErrorCode =
  | 'UNAVAILABLE'        // nothing could serve the request right now
  | 'TIMEOUT'            // the overall deadline elapsed
  | 'RATE_LIMITED'       // throttled; retry later
  | 'QUOTA_EXCEEDED'     // a budget ceiling was reached
  | 'INVALID_REQUEST'    // the caller's envelope/input/schema is wrong
  | 'INVALID_RESPONSE'   // a provider returned unparseable content
  | 'SCHEMA_MISMATCH'    // a provider answered, but not in the declared shape
  | 'PROVIDER_ERROR'     // an upstream failure that is not ours and not the caller's
  | 'MODEL_UNAVAILABLE'  // the routed model is not currently usable
  | 'CONTENT_BLOCKED'    // a policy or safety filter refused the content
  | 'CANCELLED'          // cancelled by caller or host
  | 'INTERNAL';          // our bug. sanitized.

export type AiError = {
  readonly code: AiErrorCode;
  /** Sanitized operator-safe wording. Never provider prose, never a stack trace, never a URL. */
  readonly message: string;
  /** Authoritative for the caller. Overrides the per-code default when the bridge knows better. */
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly stage: AiErrorStage;
  readonly reason?: AiErrorReason;
  readonly details?: Readonly<Record<string, string | number | boolean>>;
};
```

### 6.1 `AiErrorStage`

`'ENVELOPE' | 'PERMISSION' | 'INPUT_SAFETY' | 'ROUTING' | 'PROVIDER' | 'EXTRACTION' |
'VALIDATION' | 'POLICY' | 'DEADLINE' | 'GOVERNANCE' | 'CANCELLATION'`

Knowing the stage is what turns "it failed" into a diagnosis without exposing a provider message.

### 6.2 `AiErrorReason` — closed sub-reasons

```
ENVELOPE      CONTRACT_VERSION_UNSUPPORTED · MALFORMED_ENVELOPE · CAPABILITY_UNKNOWN
              CAPABILITY_VERSION_UNSUPPORTED · OUTPUT_SCHEMA_UNSUPPORTED · METADATA_NOT_ALLOWED
              IDEMPOTENCY_CONFLICT
PERMISSION    CALLER_NOT_PERMITTED · SUBJECT_MISSING
INPUT_SAFETY  INPUT_TOO_LARGE · SECRET_LIKE_INPUT
GOVERNANCE    KILL_SWITCH_GLOBAL · KILL_SWITCH_PROVIDER · KILL_SWITCH_CAPABILITY
              RATE_LIMIT_SUBJECT · RATE_LIMIT_CALLER · RATE_LIMIT_CAPABILITY · RATE_LIMIT_PROVIDER
              QUOTA_SUBJECT · QUOTA_CALLER · QUOTA_GLOBAL
ROUTING       NO_ROUTE · MODEL_UNAVAILABLE · ROUTE_EXHAUSTED
DEADLINE      BUDGET_EXHAUSTED
PROVIDER      PROVIDER_OVERLOADED · PROVIDER_THROTTLED · PROVIDER_TIMEOUT · PROVIDER_BAD_RESPONSE
              PROVIDER_CONTENT_FILTER
EXTRACTION    EXTRACTION_FAILED · OUTPUT_TOO_LARGE
VALIDATION    SCHEMA_VALIDATION_FAILED · OUTPUT_REPAIR_EXHAUSTED
POLICY        POLICY_VIOLATION
CANCELLATION  CANCELLED_BY_CALLER · CANCELLED_BY_HOST
INTERNAL      INTERNAL_ERROR
```

`details` keys are closed per reason. Adding a reason or a detail key is a **minor** contract
change; adding a code is a **major** one.

### 6.3 Retryability defaults

| Code | Default `retryable` | Rationale |
| --- | --- | --- |
| `UNAVAILABLE` | true | transient by definition |
| `TIMEOUT` | true | may succeed on a later attempt |
| `RATE_LIMITED` | true | time-shaped; `retryAfterMs` given |
| `QUOTA_EXCEEDED` | **false** | not fixed by retrying now; `retryAfterMs` is the quota reset |
| `INVALID_REQUEST` | false | retrying loops forever and hides a caller bug |
| `INVALID_RESPONSE` | true | upstream garbage is usually transient |
| `SCHEMA_MISMATCH` | false | the same call tends to produce the same non-conformance |
| `PROVIDER_ERROR` | true iff `category` is `OVERLOADED` | |
| `MODEL_UNAVAILABLE` | false | fixed by **re-routing**, not by retrying the same route |
| `CONTENT_BLOCKED` | false | retrying an identical blocked input is abusive |
| `CANCELLED` | false | |
| `INTERNAL` | false | |

### 6.4 The non-penetration rule

> A provider's raw message, raw status code, response body or header value is **never** part of
> the public contract and must never reach a consumer plugin or a learner.

What may cross the boundary is only: `code`, `message` (bridge-authored), `retryable`,
`retryAfterMs`, `stage`, `reason`, `details` (closed keys). A *mapped* upstream category may
travel in `details.providerCategory` with the closed value set
`'RATE_LIMIT' | 'AUTH' | 'OVERLOADED' | 'BAD_REQUEST' | 'CONTENT_FILTER' | 'UPSTREAM' | 'UNKNOWN'`.
That is a category, not a message.

Raw provider text goes, if anywhere, to the operator-only redacted log
(§[`SECURITY.md`](SECURITY.md) §6), truncated and stripped of credentials.

Reason: an OpenAI 429 paragraph is not a contract. It changes whenever a vendor rewords it, and
every consumer that parses it becomes fragile at once.

---

## 7. Provider abstraction — `AiProviderAdapter`

Defined now, implemented in Stage 3. No vendor type may appear in this interface.

```ts
export interface AiProviderAdapter {
  /** Stable, operator-named instance id: 'main' | 'local' | 'backup'. Not a brand. */
  readonly id: string;
  readonly family: ProviderFamily;
  readonly adapterApiVersion: number;      // PROVIDER_ADAPTER_API_VERSION = 1

  /** Static feature/capability declaration. Verified by a probe (§7.2). */
  readonly descriptor: ProviderDescriptor;

  generateText(request: ProviderRequest): Promise<ProviderTextResult>;
  generateStructured(request: ProviderRequest): Promise<ProviderStructuredResult>;

  /** Optional. A port that cannot probe says so rather than pretending. */
  probe?(signal: CancellationToken): Promise<ProviderHealth>;
  shutdown?(): Promise<void>;
}
```

Rules:

- `ProviderRequest` is **AI Bridge's own** request shape (prompt messages, bound fields, output
  format instruction, model ref, deadline). Not a vendor "chat completions" object.
- `ProviderTextResult` / `ProviderStructuredResult` carry AI Bridge's own types plus a
  `rawError` slot that core reads **only** to build §6's mapped `details.providerCategory`, then
  discards.
- A vendor SDK's response object, exception type or error string must not appear in any exported
  signature. Enforced by a lint rule and a test (`Docs/TESTING.md` §2.4).

### 7.1 Provider descriptor and feature matrix

```ts
export type ProviderFeature =
  | 'text' | 'structuredJson' | 'jsonSchema' | 'streaming' | 'reasoning'
  | 'usage' | 'vision' | 'tools' | 'caching';

export type ProviderDescriptor = {
  readonly id: string;
  readonly family: ProviderFamily;
  readonly features: readonly ProviderFeature[];
  readonly models: readonly ModelDescriptor[];
  readonly maxConcurrency: number;
  readonly supportsIdempotency: boolean;   // almost always false — see §14
};
```

### 7.2 Model descriptor and capability matrix

Feature support is a property of the **model**, not of the provider. Two models behind one
provider frequently differ.

```ts
export type ModelDescriptor = {
  readonly providerId: string;
  readonly modelRef: string;           // operator-side only; NEVER crosses to a consumer
  readonly displayName: string;        // operator-side only
  readonly features: readonly ProviderFeature[];
  readonly maxContextTokens: number;
  readonly maxOutputTokens: number;
  readonly profiles: readonly ModelProfile[];   // which profiles this model can serve
  readonly pricing?: {
    readonly inputPerMTok?: number;
    readonly outputPerMTok?: number;
    readonly currency: string;
    readonly asOf: string;             // ISO date; pricing goes stale
  };
};
```

Pricing is optional and dated, because a stale price presented as truth is worse than no price.

### 7.3 "OpenAI-compatible" is not one thing

An OpenAI-compatible endpoint can be reached with only `baseUrl` + `apiKey` + `model`, which is
why it is the first adapter. But compatible *wire format* does not mean compatible *semantics*.
Structured output, reasoning-token reporting, usage accounting and streaming differ in the wild.

Therefore: every adapter ships a **provider profile** (`supportsStructuredJson`,
`emitsUsageTokens`, `reportsFinishReasonFaithfully`, …) that is **probed at configuration time**
and recorded, never assumed from the URL shape. See [`ROADMAP.md`](ROADMAP.md) Stage 3.

### 7.4 Provider plugin model — decision

**Decision: provider adapters are independent packages inside this repository
(`@aibridge/provider-openai-compatible`), not plugins.**

Rejected alternatives:
- *Provider as a plugin* — recursive plugin loading to reach an outbound HTTP call is a large
  security and lifecycle surface for no V1 benefit. Revisit only if third parties must ship
  providers without a release of AI Bridge.
- *One package per provider, separate repositories* — right later, premature now.

This keeps the boundary sharp (a provider is replaceable and testable in isolation) without
over-abstracting.

---

## 8. Model / profile abstraction

> A consumer must never request `gpt-x`, `claude-x` or `deepseek-x`. It requests a **profile**,
> or a requirement set. AI Bridge configuration decides which real provider and model satisfy it.

### 8.1 `ModelProfile`

| Profile | Meaning | Typical use |
| --- | --- | --- |
| `fast` | lowest latency, modest depth | hint text, short explanations |
| `balanced` | default; good latency/quality | general structured output |
| `reasoning` | maximum deliberation, slowest, dearest | `education.idea.evaluate`, debug hypotheses |
| `cheap` | cost-first | bulk summaries, drafts |
| `high-context` | large input window | whole-file explanations, long reports |
| `vision` | *(reserved, not V1)* | |

Profiles are **semantic classes**, not tiers of one vendor. `reasoning` on one deployment may be
one vendor's top model and another deployment's local model. A profile with no configured route
is `MODEL_UNAVAILABLE` / `NO_ROUTE`, not a silent downgrade — a silent downgrade to `cheap` when
`reasoning` was asked for would quietly change the quality of a child's feedback.

### 8.2 Profile vs requirements

`profile` is the coarse, human-shaped request. `requirements` is the hard constraint list
(§4.4). A route is acceptable only if it satisfies **both**.

---

## 9. Routing — `AiRouter`

### 9.1 V1 scope

**V1 is explicit configured routing plus a fallback chain.** No automatic optimisation, no
online learning, no cost/quality optimizer. Rejected: adaptive routing — it makes answers
non-reproducible, which is unacceptable when a child's feedback is at stake.

### 9.2 Inputs and output

```
in : capability · capabilityVersion · profile · requirements · policy · availability · budget
out: Route = { providerId, modelRef, profile, routeDepth, deadline }
```

Resolution order (deterministic):

1. **Kill switch** — global / provider / capability (§20). A disabled target is not routable.
2. **Capability route** — `CapabilityRouteConfig[capability[@major]]` gives a policy id, an
   optional profile override and a fallback chain reference.
3. **Model route** — `ModelRouteConfig[profile]` gives the ordered route chain.
4. **Requirement filter** — drop routes that fail `requirements` (features, context, output cap).
5. **Availability filter** — drop routes whose provider is unhealthy or rate-limited (`retryAfterMs`
   in the future).
6. **Budget filter** — drop routes that cannot complete inside the remaining overall budget
   (§12.3).
7. First remaining route wins; the rest are the fallback chain.

If nothing survives: `FAILED` with `ROUTING / NO_ROUTE`.

---

## 10. Reliability — retry, fallback, repair, circuit breaking

Three distinct mechanisms. Conflating them is how a system ends up issuing thirty billed calls
for one learning turn.

### 10.1 Fallback — provider A → provider B

**Allowed only for these outcomes**, and only when the policy says so:

| Condition | Fallback eligible |
| --- | --- |
| provider timeout | yes |
| temporary unavailability (`UNAVAILABLE`, `PROVIDER_ERROR` w/ `OVERLOADED`) | yes |
| `MODEL_UNAVAILABLE` | yes (it is a routing problem) |
| rate limited | **only if explicitly configured** (`fallbackOnRateLimit: true`) |
| quota exceeded | only if `fallbackOnQuotaExceeded: true`; off by default — a quota is a budget, and hopping providers to dodge your own budget is a bug, not resilience |
| `INVALID_REQUEST` | **no** |
| `INVALID_RESPONSE` / `SCHEMA_MISMATCH` | **no** (see §10.4) |
| `CONTENT_BLOCKED` | **no** — retrying a blocked input elsewhere is content-policy shopping |
| `CANCELLED` | **no** |

`fallbackOnRateLimit` and `fallbackOnQuotaExceeded` default to **false** and must be set per
capability route.

### 10.2 Not-fallback rules in one line

> If the failure is a property of the **request** or of the **content**, do not spend another
> provider's money on it. If it is a property of the **provider**, consider a different one.

### 10.3 Retry — same provider

Bounded: `maxAttempts` per route, default **2** (1 retry), exponential backoff with jitter,
base 250 ms, capped at 2 s, and always capped by the overall budget.

Retryable: `UNAVAILABLE`, `TIMEOUT`, `INVALID_RESPONSE`, `PROVIDER_ERROR`(`OVERLOADED`).
Never retried: `INVALID_REQUEST`, `SCHEMA_MISMATCH`, `CONTENT_BLOCKED`, `MODEL_UNAVAILABLE`,
`QUOTA_EXCEEDED`, `CANCELLED`.

Retrying `RATE_LIMITED` in-process is **discouraged**: return `retryAfterMs` and let the caller
decide. An in-process retry loop against a throttle is how a throttled caller becomes an
abusive one.

### 10.4 Output repair — a third mechanism

When a structured payload fails validation, AI Bridge may make **one** bounded *repair* attempt:
re-ask the **same** provider/model with the validation issues appended as feedback. It is:

- not a retry (the request changed),
- not a fallback (the provider did not),
- policy-controlled (`outputRepair: 'NONE' | 'ONCE'`, default `'ONCE'`),
- charged to the same overall budget and the same `idempotencyKey`,
- reported as `warnings: [{ code: 'OUTPUT_REPAIRED' }]`,
- and exhausted by `VALIDATION / OUTPUT_REPAIR_EXHAUSTED`.

Repair is the only sanctioned response to `SCHEMA_MISMATCH`, because the failure mode is
"the model nearly complied" and one clarifying re-ask is materially different from blind retry.

### 10.5 Circuit breaking

**V1: not implemented as a circuit breaker.** The full state machine (closed/half-open, failure
rate windows, probe traffic) is deferred to Stage 6 — the implementation cost is real and V1's
reliability budget is better spent on timeouts and fallback.

**But the architecture must allow it now**, which is why:

- `ProviderHealth` exists on the adapter (§7) and `AiRouter` filters on availability (§9.2 step 5);
- `ProviderRuntimeState` (`ENABLED | DEGRADED | DISABLED`) is mutable at runtime;
- an operator (or a future breaker) can flip `main` to `DEGRADED` without a redeploy;
- every route decision records `routeDepth` and `attemptCount`, so a breaker can be built on
  telemetry without changing the contract.

---

## 11. Structured generation — the V1 core

`ai.structured.generate` is what code analysis, problem generation, learning reports and
AlgoQuest's Idea Lab will all reuse. It gets the most design attention.

### 11.1 Input

`ai.structured.generate` takes `StructuredGenerateInput` in `AiRequestEnvelope.input`, with
`outputSchema`, `profile`, `requirements` and `policyId` on the envelope itself
([`INTEGRATION_CONTRACT_V1.md`](INTEGRATION_CONTRACT_V1.md) §5.1):

| Field | Where | Meaning |
| --- | --- | --- |
| `instructions` | `input` | the task. Generic bridge prompt + capability policy. Not a business prompt free-for-all. |
| `context` | `input` | a `ContextBundle` of labelled values, each marked `untrusted` or not |
| `outputSchema` | envelope | `REF` or `INLINE` (§4.3) |
| `profile` / `requirements` | envelope | §8 |
| `policyId` | envelope | selects a registered policy, or the capability's default |

### 11.2 Two channels, and why

- **Instruction channel** — system messages, the capability's immutable policy layer, the output
  format instruction. Trusted, authored, versioned.
- **Data channel** — the `ContextBundle`: runtime values, each labelled and flagged `untrusted`.
  A learner's free text lives here and can **never** become an instruction.

A value with `untrusted: true` is rendered as data (quoted, delimited, length-bounded) and is
never concatenated into an instruction string. This is what makes a prompt-injection attempt
*structurally* unable to rewrite policy, rather than merely discouraged from trying.

### 11.3 Pipeline

```
AiRequestEnvelope
  │  validate envelope (closed keys, versions, metadata allow-list)
  │  permission + subject check            ─▶ INVALID_REQUEST / PERMISSION
  │  input safety (size, secrets, PII)     ─▶ INPUT_SAFETY
  ▼
AiRouter.resolve()                          ─▶ ROUTING / NO_ROUTE
  │  deadline = min(request budget, capability cap, server cap)
  ▼
AiProviderAdapter.generateStructured()
  │  (retry / fallback per §10.1–10.3)
  ▼
raw provider response
  │  extract structured payload   (never "the model said it is JSON, so it is")
  ▼
payload candidate
  │  bounded repair attempt       (§10.4)  ─▶ OUTPUT_REPAIRED warning
  ▼
runtime schema validation         ─▶ SCHEMA_MISMATCH
  │  size caps                     ─▶ OUTPUT_TOO_LARGE
  │  policy checks (capability)    ─▶ POLICY_VIOLATION
  ▼
AiResult { status: 'SUCCEEDED', output, usage, providerMetadata, warnings }
```

### 11.4 Extraction and validation — do not trust the model

The claim "this is JSON" is a **hint**, not evidence. Ordered extraction, first match wins:

1. a fenced ` ```json … ``` ` block;
2. the outermost balanced `{ … }` or `[ … ]` span;
3. otherwise `EXTRACTION_FAILED`.

Then, on the candidate:

- parse as JSON — a parse failure is `INVALID_RESPONSE`;
- apply the field table: unknown fields **rejected**, missing required fields rejected, types
  coerced **never** (a `NUMBER` that arrives as `"3"` is a failure, not a value), `maxLength`
  enforced;
- reject a payload over `maxOutputBytes` with `OUTPUT_TOO_LARGE` — a schema that validates a
  50 MB blob is not a safety control.

Failure is a first-class outcome: `SCHEMA_MISMATCH` with `details` listing issue codes and
`path`s. There is **no** "return what we managed to read". A partially correct structured answer
about a child is worse than no answer.

---

## 12. Timeouts — three deadlines

| Deadline | Meaning |
| --- | --- |
| **Request deadline** | overall budget for the whole call: routing + every provider attempt + extraction + validation + repair. Computed once at ingress as `deadlineAt`. |
| **Provider deadline** | per-attempt cap: `min(timeoutBudget.providerMs ?? DEFAULT_PROVIDER_MS, remaining − VALIDATION_RESERVE_MS)`. |
| **Fallback deadline** | not a separate number — a fallback attempt inherits the **remaining** budget and must leave `VALIDATION_RESERVE_MS` free. |

### 12.1 The chain must not multiply the wait

> The whole fallback chain may **not** give every provider a full timeout. A user waits one
> budget, not `n × budget`.

Defaults: `DEFAULT_TOTAL_MS = 20 000`, `DEFAULT_PROVIDER_MS = 15 000`,
`VALIDATION_RESERVE_MS = 1 000`, `MIN_VIABLE_PROVIDER_MS = 1 500`.

If `remaining < MIN_VIABLE_PROVIDER_MS` when an attempt would start, stop and return
`TIMEOUT` / `BUDGET_EXHAUSTED`. Rationale: a 300 ms provider attempt cannot finish a useful
call and only burns money and patience.

### 12.2 Clamping

The bridge clamps a caller's `timeoutBudget` down to the capability cap and the server cap. It
**never** widens it. A caller cannot buy a 10-minute call.

### 12.3 Budget as a routing filter

A route whose expected latency exceeds the remaining budget is dropped at step 6 of §9.2 rather
than started and abandoned.

---

## 13. Cancellation

### 13.1 Host-neutral token

`CancellationToken` (§4.5) — no `AbortSignal`, no `AbortController`, no DOM type in the
contract. A host adapter may bridge one in.

### 13.2 Semantics

- Cancelled before a provider attempt starts ⇒ `CANCELLED` / `CANCELLED_BY_CALLER`, **no charge**.
- Cancelled in flight ⇒ the bridge aborts the outbound request where the adapter supports it and
  returns `CANCELLED`. Usage is whatever the provider reports, marked `warnings: []` — the call
  may still be billed by the provider and the usage record must say so.
- Cancellation is **idempotent** and **terminal**: once `CANCELLED` is returned the result is
  final, even if the provider answers later.

Use case that drives this: the learner navigates away from the Idea Lab or closes the quest while
an evaluation is in flight. That request must stop costing money and must never write a late
answer into a session that has moved on.

---

## 14. Idempotency

### 14.1 The problem

A network retry at the transport layer must not produce **two billed AI calls for one learning
turn**.

### 14.2 Semantics (frozen)

- `idempotencyKey` is scoped to `(callerPluginId, capability, capabilityVersion)`.
- The first call with a key executes. Any later call with the same key **replays the stored
  result** and adds `warnings: [{ code: 'IDEMPOTENT_REPLAY' }]`.
- A concurrent duplicate **coalesces** onto the in-flight call and receives the same result,
  also marked `IDEMPOTENT_REPLAY`.
- The same key with a **different** request digest ⇒ `INVALID_REQUEST` / `IDEMPOTENCY_CONFLICT`.
  Silent replay of a *different* request would be worse than failing.

### 14.3 Trade-off, stated honestly

Providers almost never support idempotency (`supportsIdempotency: false` by default, §7.1), so
**AI Bridge owns the registry**, not the provider.

V1 keeps an **in-process** registry: TTL 15 minutes, capacity 10 000 entries, LRU eviction,
`Map` keyed by the scoped key.

Consequences accepted:
- a process restart loses the registry ⇒ at worst **one** duplicate billed call for one turn,
  bounded and acceptable;
- eviction under memory pressure has the same bound;
- durable storage is deferred to Stage 7 (`Docs/ROADMAP.md`) and is an *operator* choice
  (host storage vs embedded), never a consumer's concern.

Rejected: asking the consumer to dedupe — a consumer cannot dedupe a call it already sent.

---

## 15. Rate limit and quota — two different things

### 15.1 Rate limit — *how fast*

A sliding window over a time unit. `20 req/min`.

Dimensions (all four enforced independently; the strictest wins):

| Dimension | Keyed by |
| --- | --- |
| subject | `subjectToken` |
| caller plugin | `callerPluginId` |
| capability | `capability@major` |
| global provider | `providerId` |

Configured per dimension as `{ limit, windowMs, burst? }`. Exceeding it yields
`RATE_LIMITED` + `retryAfterMs` + a `reason` naming the dimension.

### 15.2 Quota — *how much*

A budget over a longer period. `200 000 tokens/day`, or a currency budget per calendar day/month.

Same four dimensions, measured in **tokens** and optionally currency. Exceeding it yields
`QUOTA_EXCEEDED` + `retryAfterMs` (the reset instant). Quota is checked **before** dispatch and
reconciled **after** (actual usage may exceed a pre-flight estimate).

Why the distinction matters: a rate-limited caller is going too fast and should slow down; a
quota-exhausted caller is out of budget and should stop or ask a human. Merging them into one
`429` hides a spending problem inside a throttling one.

### 15.3 The subject token

AI Bridge may have no idea who the real user is — and must not acquire one.

The host mints an **opaque subject token**: AI-Bridge-scoped, non-forgeable, un-resolvable to
identity by AI Bridge, and **not** an email, a user id or a raw session token. It exists to make
"one learner cannot exhaust the school's budget" true, and nothing else.

---

## 16. Usage, cost and observability

### 16.1 Usage record (operator-side)

| Field | |
| --- | --- |
| `requestId`, `idempotencyKey` | |
| `callerPluginId`, `capability`, `capabilityVersion` | |
| `providerId`, `modelRef` | real model — operator-only |
| `subjectTokenHash` | hashed, never the token |
| `inputTokens`, `outputTokens`, `cachedTokens`, `estimatedCost` | |
| `latencyMs`, `routeDepth`, `attemptCount`, `repaired` | |
| `status`, `errorCode`, `errorStage`, `errorReason` | |
| `timestamp` | |

### 16.2 Cost honesty

`estimatedCost` appears only when a price basis exists (§5.1). When usage itself is estimated,
`warnings: [{ code: 'USAGE_ESTIMATED' }]` is set. An absent cost is **unknown**, never zero, and
never rendered as "free".

### 16.3 Privacy default

> **Do not record full prompts or full responses.** By default, record neither.

Sizes (byte counts), token counts, timings, statuses and error codes are recorded. Content is
not. A per-capability `retention: 'NONE' | 'METADATA_ONLY' | 'CONTENT'` exists in the config
model with default `METADATA_ONLY`; `CONTENT` requires an explicit operator decision and a
documented retention window.

### 16.4 Diagnostics

AI Bridge must be able to answer, without reading any learner text:

- success rate (per capability, per provider, per caller)
- latency distribution (p50 / p95 / p99)
- rate-limit hit rate and quota consumption
- provider error rate by mapped category
- token usage and estimated spend

Student free text is never a diagnostic input.

---

## 17. Configuration model

Three layers. No real key appears in any example anywhere in this repository.

```yaml
# providers — server-side, loaded from an operator-owned file or the host secret store
providers:
  main:
    family: openai-compatible
    baseUrl: "${AIBRIDGE_MAIN_BASE_URL}"        # env indirection; never literal
    apiKeyRef: "secret://aibridge/main/api-key" # a REFERENCE, resolved server-side
    timeoutMs: 15000
    maxConcurrency: 8
    features: ["text", "structuredJson", "usage"]   # probed, not assumed — §7.3
  local:
    family: local
    baseUrl: "${AIBRIDGE_LOCAL_BASE_URL}"
    apiKeyRef: null

models:
  - providerId: main
    modelRef: "${AIBRIDGE_MAIN_REASONING_MODEL}"
    profiles: ["reasoning", "high-context"]
    features: ["text", "structuredJson", "jsonSchema", "reasoning", "usage"]
    maxContextTokens: 128000
    maxOutputTokens: 8000
    pricing: { inputPerMTok: null, outputPerMTok: null, currency: USD, asOf: "2026-01-01" }

routes:
  model:                                  # profile → route chain
    reasoning:   [{ providerId: main,   modelRef: "${AIBRIDGE_MAIN_REASONING_MODEL}" },
                  { providerId: local,  modelRef: "${AIBRIDGE_LOCAL_MODEL}" }]
    balanced:    [{ providerId: main,   modelRef: "${AIBRIDGE_MAIN_FAST_MODEL}" }]
    fast:        [{ providerId: local,  modelRef: "${AIBRIDGE_LOCAL_MODEL}" }]
    cheap:       [{ providerId: local,  modelRef: "${AIBRIDGE_LOCAL_MODEL}" }]
    high-context:[{ providerId: main,   modelRef: "${AIBRIDGE_MAIN_REASONING_MODEL}" }]
  capability:                             # capability → policy + overrides
    "ai.structured.generate@1":
      policyId: "ai-structured-default"
      profileOverride: "balanced"
      fallbackOnRateLimit: false
      fallbackOnQuotaExceeded: false
      outputRepair: "ONCE"
    "education.idea.evaluate@1":
      policyId: "education-idea-evaluate-v1"
      profileOverride: "reasoning"
      allowGenericFallback: false

governance:
  rateLimits:
    subject:    { limit: 20,  windowMs: 60000 }
    caller:     { limit: 120, windowMs: 60000 }
    capability: { limit: 200, windowMs: 60000 }
    provider:   { limit: 600, windowMs: 60000 }
  quotas:
    subject:    { tokensPerDay: 50000 }
    caller:     { tokensPerDay: 200000 }
    global:     { tokensPerDay: 2000000, currencyPerMonth: 500 }
  killSwitch:
    global: false
    providers: {}
    capabilities: {}

limits:
  maxInputBytes: 32768
  maxOutputBytes: 65536
  maxTotalTimeoutMs: 30000
  metadataMaxBytes: 512
```

### 17.1 Config object types

```ts
ProviderConfig        // id, family, baseUrl, apiKeyRef, timeoutMs, maxConcurrency, features
ModelRouteConfig      // profile → ordered Route[]   (providerId, modelRef)
CapabilityRouteConfig // capability@major → policyId, profileOverride, fallback flags, outputRepair
```

Semantics: `route.reasoning: …` means "the `reasoning` **profile** resolves to this route chain".
Nothing in the config is consumer-visible except through §5.2's safe projection.

### 17.2 Reload

Config reload is **atomic and validated-first**: a file that fails validation is rejected in
full and the previous config stays live. Never a half-applied route table.

---

## 18. Secret management

**Every provider credential is server-side only.** Full treatment in
[`SECURITY.md`](SECURITY.md) §2. Summary:

| Source | V1 verdict |
| --- | --- |
| **Host secret store** | preferred; AI Bridge receives a *handle* (`apiKeyRef`) |
| **Environment variables** | acceptable for a single-instance deployment; indirection in config |
| **Encrypted config file** | acceptable where no secret store exists; key supplied out of band |
| Browser bundle / consumer plugin / AlgoQuest / request envelope / logs | **never** |

Not implemented in Stage 1 — designed only.

---

## 19. Storage

AI Bridge needs very little persistence, and **none of it is student data**.

| Data | Where | Durability | Why |
| --- | --- | --- | --- |
| Provider / model / route config | operator file or host config service | durable, operator-owned | it is deployment state |
| Secrets | host secret store / env / encrypted file | durable, never in AI Bridge's own DB | §18 |
| Usage ledger | host usage storage if required | durable (host) or append-only file | billing history survives restarts |
| Idempotency registry | memory | **volatile**, 15 min TTL | §14.3 — bounded loss is accepted |
| Rate-limit / quota counters | memory | volatile | a restart resetting a window is acceptable and honest |
| Provider health / runtime state | memory | volatile | re-probed at boot |

**AI Bridge must not own a student business database.** If a feature starts needing learner
history, that is a consumer's data and a host's storage.

Trade-off recorded: losing in-memory counters on restart means a caller could exceed a daily
quota after a redeploy. Accepted for V1; a durable counter is a Stage 7 operator option.

---

## 20. Kill switch

Three switches, all required:

| Switch | Effect |
| --- | --- |
| `global` | every capability returns `FAILED` / `GOVERNANCE` / `KILL_SWITCH_GLOBAL` |
| `providers.<id>` | that provider is not routable; other providers keep serving |
| `capabilities.<id>@<major>` | that capability returns `GOVERNANCE` / `KILL_SWITCH_CAPABILITY` |

Use case that drives this: **a school forbids AI.** The operator throws the global switch. AI
Bridge reports every capability `DISABLED`. AlgoQuest sees `education.idea.evaluate` unavailable
and runs its authored rubric fallback — a real, degraded learning turn, not an error page.

Mechanical requirement: `discoverCapabilities()` reports `status: 'DISABLED'`, so a consumer can
detect this *before* asking. A kill switch must never look like a random failure.

---

## 21. Portability

AI Bridge must be **host-neutral**. It should be attachable to OJPlatform, to another learning
platform, or to a standalone server.

Rules:

- No `@ojplatform/*` or `@algoquest/*` in any core contract, and no imports from those
  repositories' source trees.
- Host knowledge lives in a separate `@aibridge/adapter-<host>` package with a one-way
  dependency arrow.
- The transport is unspecified: the contract is a **call shape**, not an HTTP API. It may be
  in-process, IPC, or HTTP.
- Where the host offers more than the contract needs, the adapter narrows. Where the host offers
  less, the adapter declares `supported: false` — it does not fake it.

Enforcement target (Stage 2): a coupling check that fails on a forbidden import, modelled on
AlgoQuest's `scripts/check-adapter-coupling.mjs`.

---

## 22. Package structure

Recommended layout. **Not created in Stage 1** — creating empty packages to make a directory
look tidy is how a repository acquires five unbuildable stubs.

```
AIBridge/
  plugin.manifest.json
  Docs/
  packages/
    contracts/                     @aibridge/contracts
    core/                          @aibridge/core
    host-sdk/                      @aibridge/host-sdk     (ports + fakes + conformance kit)
    capabilities/                  @aibridge/capabilities (specialized packs; split later if needed)
    provider-openai-compatible/    @aibridge/provider-openai-compatible
    adapter-ojplatform/            @aibridge/adapter-ojplatform   (Stage 9, host-specific)
  tests/
  scripts/                         check-adapter-coupling.mjs, check-no-secret-leak.mjs
```

Each package is created only when it has a real implementation and a test to carry.

---

## 23. Manifest and plugin identity

**Stable plugin id: `ai.bridge`.**

Evaluated and rejected: `aibridge.provider-hub` — "provider-hub" describes an internal packaging
decision (provider adapters may later move out) and would be wrong the day they do. `ojplatform.ai`
and `algoquest.ai` are rejected outright as host-prefixed.

`plugin.manifest.json` (Stage 1) declares identity, contract versions, the two generic primitives
it provides, `"entry": null`, `"permissions": []` and `"deploymentImpact": "NONE"`.

### 23.1 Host gap — two manifest dialects

The two reference repositories do not agree, and this is a real integration gap:

| | OJPlatform `plugin-sdk` | AlgoQuest manifest |
| --- | --- | --- |
| API version key | `apiVersion: string \| number` | `pluginApiVersion: 1` |
| Capability declaration | none (`contributes.slots`) | `capabilities.requires` / `capabilities.optional` |
| Permission declaration | none | `permissions: []` |
| Parser | **rejects unknown fields** | strict, rejects unknown fields |

OJPlatform's `parsePluginManifest` accepts exactly
`id, name, version, apiVersion, entry, contributes.slots` and returns `null` otherwise. A manifest
carrying `capabilities` or `pluginApiVersion` is **rejected by that parser**.

Consequence for Stage 9: a host adapter must either (a) carry a host-specific manifest projection,
or (b) the host must grow a capability-aware manifest version. Recorded as
**Host Capability Gap #1** (§25.2). AI Bridge does not modify the host in this stage.

---

## 24. Versioning

Six versioned things, deliberately separate so that one moving does not invalidate another.

| Version | V1 value | Covers | Unknown major |
| --- | --- | --- | --- |
| Plugin API version | `1` | plugin ↔ host loading | reject registration |
| **AI Bridge contract version** | `1.0` | request envelope, response envelope, error vocabulary | **reject** `INVALID_REQUEST` / `CONTRACT_VERSION_UNSUPPORTED` |
| Generic request schema version | `1.0` | `AiRequestEnvelope` field set | reject |
| Structured output schema version | per schema (`schemaId` + `version`) | one capability's output shape | reject `OUTPUT_SCHEMA_UNSUPPORTED` |
| Specialized capability version | per capability (`education.idea.evaluate@1.0`) | one capability's input/output/policy | reject `CAPABILITY_VERSION_UNSUPPORTED` |
| Provider adapter API version | `1` | AI Bridge ↔ provider adapter (**internal**, not frozen publicly) | reject adapter registration |

Rules:

- **Major-compatible only.** `1.0` accepts `1`, `1.0`, `1.0.3`. `2.0` is rejected against `1.0`.
- **Unknown major ⇒ reject. Never best-effort parse.** A plausible-looking wrong answer is the
  single worst outcome this system can produce.
- Policy ids and prompt versions are recorded on every call, but they are **not** contract
  versions: changing a policy must not break a consumer.

The frozen values live in `@aibridge/contracts` as constants, and in
[`INTEGRATION_CONTRACT_V1.md`](INTEGRATION_CONTRACT_V1.md) §2.

---

## 25. Host integration boundary

### 25.1 What the host must provide

| Host capability | Shape | Required for |
| --- | --- | --- |
| **AI capability broker** | resolve `capability@version` → provider plugin call | everything |
| **Plugin identity** | non-forgeable `callerPluginId` bound at the plugin runtime boundary | permission, attribution |
| **Permission decision** | read the consumer manifest's declared capabilities → `allow` / `deny` | §[`SECURITY.md`](SECURITY.md) §5 |
| **Subject token** | opaque, AI-Bridge-scoped, un-resolvable to identity | rate limit + quota |
| **Secret store** | `apiKeyRef` → credential, server-side | §18 |
| **Usage storage** | append-only usage ledger (optional) | §16.1 |
| **Config surface + reload** | where `ProviderConfig` lives and how it is refreshed | §17.2 |
| **Kill-switch authority** | an operator role able to throw the switches | §20 |

### 25.2 Host Capability Gaps (as of this audit)

Recorded, **not** patched into any host in this stage.

| # | Gap | Evidence | Impact | Mitigation |
| --- | --- | --- | --- | --- |
| 1 | **No capability registry / broker.** `packages/plugin-sdk` has `PluginRegistry`/`PluginHost` but only a UI **slot** (`problem.solve.editor`) and no service/capability dispatch. | `D:\OJPlatform\packages\plugin-sdk\src\index.ts` | A consumer cannot call `education.idea.evaluate` through the host today. | The frozen contract in [`INTEGRATION_CONTRACT_V1.md`](INTEGRATION_CONTRACT_V1.md) is transport-agnostic, so AlgoQuest can build against it now and bind later. |
| 2 | **No plugin identity binding.** `callerPluginId` has no minting mechanism; nothing stops a caller claiming another id. | `plugin-sdk`: `activate(context: { sdkVersion })` only | Attribution and permission are unenforceable. | AI Bridge **rejects** a call without a host-bound `callerPluginId` (`PERMISSION / SUBJECT_MISSING`… `CALLER_NOT_PERMITTED`). Never trust a self-declared id. |
| 3 | **No permission model.** `PluginManifest` has no `capabilities` or `permissions` field. | `plugin-sdk/src/index.ts` `PluginManifest` | No `allow`/`deny` at the host. | AI Bridge enforces its own registry-level authorization as defence in depth, and records the requirement. |
| 4 | **No subject token.** No opaque, non-identity subject handle exists. | audit | Per-learner rate/quota is impossible. | Fall back to `callerPluginId`-level governance only; document the coarser guarantee. |
| 5 | **No secret store.** No host secret API; only deployment env files. | `D:\OJPlatform\.env.example`, `Docs/security/PHASE_2B_ENVIRONMENT_SECRET_POLICY.md` | Keys would have to live in env vars. | Env indirection in `ProviderConfig` (§17); `apiKeyRef` reserved for a future host store. |
| 6 | **Manifest dialect divergence.** `apiVersion` vs `pluginApiVersion`; unknown-field rejection on both sides. | §23.1 | One manifest cannot register with both. | Host-specific manifest projection in `@aibridge/adapter-<host>`. |
| 7 | **No durable plugin storage API.** `storage.records` is an AlgoQuest-side expectation, not an OJPlatform offering. | AlgoQuest `capabilities.ts` vs OJPlatform `plugin-sdk` | Usage ledger durability. | Append-only file in V1; host storage when offered. |
| 8 | **No cancellation propagation.** No host-wide cancel/abort for plugin work. | audit | Learner navigation cannot cancel in-flight AI. | `CancellationToken` is in the contract; the adapter wires it when the host grows one. |

### 25.3 Extension points that exist today

- `problem.solve.editor` — the only supported UI slot (`SUPPORTED_PLUGIN_SLOTS`).
- `PluginContribution { slot, render }` — render-only. No data service, no RPC, no events.

This is sufficient for a UI plugin and **not** sufficient for a capability provider. That is the
headline gap.

---

## 26. Gates that stay closed

| Gate | State |
| --- | --- |
| **UI** | NOT ALLOWED in any current stage. Admin configuration UI is a recorded future requirement ([`ROADMAP.md`](ROADMAP.md) Stage 8 note), not a task. |
| **Deployment impact** | `NO` for Stage 1. `deploy/`, `compose*.yaml`, `.env.*` examples and Windows installers are untouched and out of scope for AI Bridge stages. |
| **Real provider** | Not connected. No API key anywhere in this repository. |
| **Host modification** | Out of scope. Gaps are recorded in §25.2, never patched. |
