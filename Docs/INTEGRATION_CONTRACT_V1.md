# AIBRIDGE_INTEGRATION_CONTRACT_V1

**Status: FROZEN (v1.0)** — 2026-09-22

This document is the **parallel development contract**. It is written small and frozen early so
that a consumer team (AlgoQuest Stage 6) can build, test and ship its side **without waiting for
AI Bridge to be implemented**.

> Changing a frozen field requires: (1) a compatibility note in this document, (2) a version bump
> of the affected contract, (3) a fixture update in [`fixtures/`](fixtures/). See
> [`../AGENTS.md`](../AGENTS.md) §8.

> Nothing provider-specific is frozen here. No vendor model name, no SDK type, no request or
> response shape of any provider. Those are deliberately outside the contract.

Full rationale: [`ARCHITECTURE.md`](ARCHITECTURE.md). Capability semantics:
[`CAPABILITIES.md`](CAPABILITIES.md).

> **Compatibility note — Stage 2 implementation (additive within major 1).** Stage 2 turned this
> document into a compiling, tested surface. Four additions were needed and are recorded here per
> [`../AGENTS.md`](../AGENTS.md) §8. All four are **additive**: no frozen field changed meaning, no
> value was removed or renamed, and every `FROZEN` fixture still parses unchanged. Because no
> versioned consumer exists yet (AlgoQuest Stage 6 has not started), the contract stays `1.0`; a
> consumer built from this document must accept the two new descriptor fields below.
>
> 1. **Error stage `INTERNAL`** (§7). `ARCHITECTURE.md` §6.2 grouped reasons under an `INTERNAL`
>    label while §6.1 omitted it from the stage list. Stage 2 reconciles the gap by adding
>    `INTERNAL` to the closed stage set. Additive enum member.
> 2. **Three error reasons** (§7): `TRUSTED_FIELD_IN_CONSUMER_REQUEST` (a consumer request carrying
>    a host-bound field), `OUTPUT_SCHEMA_OVERRIDE_FORBIDDEN` (a caller authoring the output schema of
>    a capability that owns its own), and `JSON_PARSE_FAILED` (a distinct, stable reason for the
>    extraction parse step, so `EXTRACTION_FAILED` no longer has to stand in for it). Additive
>    reasons; the reason set was always closed per `ARCHITECTURE.md` §6.2.
> 3. **Two required `CapabilityDescriptor` fields** (§6): `requirements: CapabilityRequirements`
>    and `schemaOwnership: { input, output, policy }`. `schemaOwnership` is the load-bearing one: it
>    states that only a generic *structured* capability lets the caller supply `outputSchema`, and
>    that every other capability owns its input, output and policy schema. It makes
>    `OUTPUT_SCHEMA_OVERRIDE_FORBIDDEN` mechanically checkable instead of tribal knowledge.
> 4. **`aibridge.fields/v2` is proposed, not shipped.** Adding `INTEGER` and `ENUM` field types was
>    evaluated and deliberately **not** done: `aibridge.fields/v1` is frozen and a consumer already
>    parses its six types. The extension is recorded as a future `v2` so the gap is visible rather
>    than silently closed. No `v1` field type changed.
>
> Fixture impact: none. The nine fixtures already express these rules (the `secret-input` and
> `unknown-metadata` fixtures are the same rejections, now named by the reasons above).

> **Compatibility note — Stage 3 implementation (additive within major 1).** Stage 3 drove the
> contracts through a real provider via the runtime and the reference adapter. Two additions were
> needed and are recorded here per [`../AGENTS.md`](../AGENTS.md) §8. Both are **additive**: no
> frozen field changed meaning, no value was removed or renamed, and every `FROZEN` fixture still
> parses unchanged. The contract stays `1.0`, following the Stage 2 precedent (no versioned
> consumer exists yet).
>
> 1. **Three error reasons** (§7): `PROVIDER_AUTH_FAILED` (a provider rejecting its configured
>    credential), `PROVIDER_REQUEST_REJECTED` (a provider rejecting the composed request) and
>    `PROVIDER_UNAVAILABLE` (an upstream outage or transport failure). They exist so that every
>    value of the frozen `details.providerCategory` set maps to **exactly one** reason — without
>    them a 401 and a 429 would have to share a reason, and "our key is broken" would surface as a
>    consumer bug. Classification (`code`/`stage`/`retryable`):
>    `PROVIDER_AUTH_FAILED` → `PROVIDER_ERROR`/`PROVIDER`/false,
>    `PROVIDER_REQUEST_REJECTED` → `INVALID_REQUEST`/`PROVIDER`/false,
>    `PROVIDER_UNAVAILABLE` → `PROVIDER_ERROR`/`PROVIDER`/true. The reason set was always closed
>    and always minor-extensible (`ARCHITECTURE.md` §6.2).
> 2. **Streaming, as a delivery concern** — a minimal additive stream-event contract:
>    `AiStreamEvent` with the frozen sequence `STARTED → TEXT_DELTA* → (COMPLETED | FAILED)`,
>    validated by `validateAiStreamSequence`. Terminal events carry exactly the closing facts a
>    `AiResult` carries (`usage`, `finishReason`, `providerMetadata`, `latencyMs`, `warnings`) and
>    `COMPLETED.text` is the concatenation of the deltas. `ai.text.generate` may be delivered this
>    way; `ai.structured.generate` remains **non-streaming** (§5 rationale unchanged — a streamed
>    partial judgement is dangerous). `CapabilityRequirements.streaming` (§3.2) keeps its frozen V1
>    semantics **unchanged** for non-streaming delivery (`true` ⇒ `NO_ROUTE`, never a quiet
>    downgrade); incremental delivery is selected by calling the stream entry point, where the same
>    requirement is validated against the resolved route. Nothing about the request envelope, the
>    response envelope or the error model changed.
>
> Fixture impact: none — the nine fixtures parse unchanged. The stream sequence rules are covered
> by contract tests (`tests/contracts/stream.test.ts`) instead of fixtures, because a fixture
> document is a request or a response (`kind` is unchanged) and a stream is neither.

---

## 0. What is frozen, and what is not

| Frozen | Not frozen, deliberately |
| --- | --- |
| capability naming | provider names, vendor model names |
| request envelope | the transport (in-process / IPC / HTTP) |
| response envelope | wire encoding (JSON assumed for fixtures only) |
| error vocabulary | provider error text and status codes |
| `ai.structured.generate` contract | prompt content of any capability |
| capability discovery shape | the host's capability registry API |
| versioning + rejection rules | the host manifest dialect |
| timeout semantics | deployment topology |
| idempotency semantics | storage engine |
| usage projection | pricing |
| availability + kill-switch semantics | admin UI |
| warning vocabulary | telemetry backend |
| structured-schema field dialect | JSON Schema support |

---

## 1. Capability naming (frozen)

### 1.1 Generic primitives

| id | version | V1 |
| --- | --- | --- |
| `ai.structured.generate` | `1.0` | **frozen, core** |
| `ai.text.generate` | `1.0` | frozen |

### 1.2 Specialized capability packs — names reserved

| id | planned version | Pack | Status |
| --- | --- | --- | --- |
| `education.idea.evaluate` | `1.0` | education | name frozen; schema is **draft**, see §5.4 |
| `education.hint.generate` | `1.0` | education | name frozen; schema draft |
| `learning.summary.generate` | `1.0` | education | name frozen; schema draft |
| `code.debug.analyze` | `1.0` | code | name frozen; schema draft |
| `code.explain` | `1.0` | code | name frozen; schema draft |
| `problem.explain` | `1.0` | problem | reserved, not scheduled |
| `problem.quest.draft` | `1.0` | problem | reserved, authoring-side, not scheduled |

### 1.3 Naming rules (frozen)

- `<domain>.<subject>.<verb>`, lower dot-case.
- **Forbidden:** any product name — `algoquest.*`, `ojplatform.*`, `aibridge.*` — as a capability
  id. A product's voice lives in `policyId`, not in the capability id.
- A capability id, once published, is never reused for different semantics.

---

## 2. Version constants (frozen)

```ts
export const AIBRIDGE_CONTRACT_VERSION        = '1.0';  // envelopes + error vocabulary
export const AIBRIDGE_REQUEST_SCHEMA_VERSION  = '1.0';  // AiRequestEnvelope
export const AIBRIDGE_RESPONSE_SCHEMA_VERSION = '1.0';  // AiResult
export const AIBRIDGE_ERROR_VERSION           = '1.0';  // AiErrorCode
export const AIBRIDGE_FIELD_DIALECT           = 'aibridge.fields/v1';
export const AIBRIDGE_PLUGIN_API_VERSION      = 1;
```

### 2.1 Compatibility rule (frozen)

- Comparison is **major-compatible**: `1.0` accepts `1`, `1.0`, `1.0.3`.
- **An unknown or higher major is rejected.** Never best-effort parsed.
  `INVALID_REQUEST` / `reason: CONTRACT_VERSION_UNSUPPORTED`.
- A **minor** addition is additive and ignorable *only* where this document says "may be
  ignored". Everywhere else, unknown fields are rejected.

A consumer must reject a response whose `contractVersion` major it does not support, exactly as
AI Bridge rejects such a request. Symmetric strictness is what makes "it parsed" mean "it is
right".

---

## 3. Request envelope (frozen)

```ts
export type ModelProfile = 'fast' | 'balanced' | 'reasoning' | 'cheap' | 'high-context';

export interface AiRequestEnvelope<TInput = unknown> {
  readonly contractVersion: string;      // '1.0'
  readonly requestId: string;            // ^[A-Za-z0-9._-]{1,64}$, unique per attempt
  readonly idempotencyKey: string;       // ^[A-Za-z0-9._-]{1,128}$
  readonly callerPluginId: string;       // host-bound. MUST NOT be self-declared. §8
  readonly capability: string;
  readonly capabilityVersion: string;    // '1.0'
  readonly profile: ModelProfile;
  readonly requirements?: CapabilityRequirements;
  readonly input: TInput;
  readonly outputSchema: OutputSchema;
  readonly policyId?: string;
  readonly timeoutBudget?: TimeoutBudget;
  readonly subjectToken?: string;
  readonly metadata?: RequestMetadata;
}
```

Field rules:

| Field | Rule |
| --- | --- |
| `contractVersion` | required. Major mismatch ⇒ reject. |
| `requestId` | required. Unique per **attempt**. Echoed verbatim. |
| `idempotencyKey` | required. Stable across retries of the same logical turn. Scoped to `(callerPluginId, capability, capabilityVersion)`. |
| `callerPluginId` | required. Host-bound (§8). Missing/unverified ⇒ `PERMISSION / CALLER_NOT_PERMITTED`. |
| `capability` | required. Unknown ⇒ `ENVELOPE / CAPABILITY_UNKNOWN`. |
| `capabilityVersion` | required. Unsupported major ⇒ `ENVELOPE / CAPABILITY_VERSION_UNSUPPORTED`. |
| `profile` | required. A profile, **never** a model name. |
| `requirements` | optional. Narrows the route; never names a model. |
| `input` | required. Capability-defined. Subject to that capability's `inputAllowList` (deny by default). |
| `outputSchema` | required. `REF` (preferred) or `INLINE`. |
| `policyId` | optional. **Selects** a registered policy. Supplying policy *content* is always an error. |
| `timeoutBudget` | optional. `{ totalMs, providerMs? }`. The bridge clamps **down**, never up. |
| `subjectToken` | optional in the type; required whenever a subject dimension is configured. Opaque, host-minted. Not a session token, not an email, not a user id. |
| `metadata` | optional. Exactly `locale`, `traceId`, `surface`, `correlationId`. Unknown key ⇒ **reject**. ≤ 512 bytes serialized. |

**Unknown top-level fields are rejected** (`INVALID_REQUEST` / `MALFORMED_ENVELOPE`).

### 3.1 Forbidden in the envelope (frozen)

`apiKey` · any provider secret · a raw session token · a cookie · a bearer token · `baseUrl` /
`endpoint` · a vendor model name · a system-prompt override · any policy content · a host data
lookup handle.

### 3.2 Supporting types (frozen)

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

export type OutputSchema =
  | { readonly kind: 'REF'; readonly ref: { schemaId: string; version: string } }
  | {
      readonly kind: 'INLINE';
      readonly schemaId: string;
      readonly version: string;
      readonly dialect: 'aibridge.fields/v1';
      readonly fields: readonly FieldSpec[];
    };

export type FieldSpec = {
  readonly name: string;         // ^[a-z][a-zA-Z0-9]*$
  readonly type: 'STRING' | 'NUMBER' | 'BOOLEAN' | 'STRING_ARRAY' | 'OBJECT' | 'OBJECT_ARRAY';
  readonly required: boolean;
  readonly description: string;
  readonly untrusted?: boolean;
  readonly maxLength?: number;
};

export type TimeoutBudget = { readonly totalMs: number; readonly providerMs?: number };

export type RequestMetadata = {
  readonly locale?: string;
  readonly traceId?: string;
  readonly surface?: string;
  readonly correlationId?: string;
};
```

> The `FieldSpec` shape is **deliberately identical** to AlgoQuest's `AiFieldSpec` (same six keys,
> same six types, same `^[a-z][a-zA-Z0-9]*$` name rule). That makes the future adapter a
> zero-translation mapping. Aligned by specification, never by import.

---

## 4. Response envelope (frozen)

```ts
export type AiResult<TOutput = unknown> = {
  readonly contractVersion: string;
  readonly requestId: string;                 // echoed
  readonly capability: string;
  readonly capabilityVersion: string;
  readonly status: 'SUCCEEDED' | 'FAILED';
  readonly output?: TOutput;                  // only when SUCCEEDED; runtime-validated
  readonly error?: AiError;                   // only when FAILED
  readonly usage: AiUsage;
  readonly providerMetadata: ProviderMetadataProjection;
  readonly latencyMs: number;
  readonly finishReason: 'STOP' | 'LENGTH' | 'CONTENT_FILTER' | 'UNKNOWN';
  readonly warnings: readonly AiWarning[];
};
```

`status` is binary. A "partial success" is `SUCCEEDED` plus `warnings`, so a consumer writes
exactly one success branch.

### 4.1 `AiUsage` (frozen)

```ts
export type AiUsage = {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly cachedTokens?: number;
  readonly estimatedCost?: {
    readonly value: number;
    readonly currency: string;
    readonly basis: 'PROVIDER_REPORTED' | 'PRICE_TABLE' | 'ESTIMATED';
  };
};
```

- **Every field is optional.** Some providers report nothing.
- `estimatedCost` is **optional and stays optional**. Absent means *unknown*, not *zero*.
- Usage is cost/capacity evidence only. **A consumer must not use usage to judge a learner.**

### 4.2 `ProviderMetadataProjection` (frozen — and it is a *projection*)

```ts
export type ProviderMetadataProjection = {
  readonly providerId: string;    // operator-named instance id: 'main' | 'local' | 'backup'
  readonly providerFamily: 'openai-compatible' | 'anthropic' | 'google' | 'local' | 'mock';
  readonly modelClass: 'REASONING' | 'FAST' | 'LOCAL' | 'UNKNOWN';
  readonly routeDepth: number;    // 0 = first choice; > 0 = fallback served it
  readonly attemptCount: number;
  readonly repaired: boolean;
};
```

Closed key set. **Never present**: `modelId`, `endpoint`, `baseUrl`, `apiKeyId`,
`organizationId`, `projectId`, `region`, `requestHeaders`, `responseHeaders`, `rawRequest`,
`rawResponse`, `rawError`, `sessionId`, `subjectToken`.

Do **not** branch on `providerId`. It identifies a deployment instance and will change.
`modelClass` is the only quality signal a consumer may rely on.

### 4.3 `AiWarning` (frozen)

```ts
export type AiWarningCode =
  | 'IDEMPOTENT_REPLAY' | 'OUTPUT_REPAIRED' | 'FALLBACK_USED' | 'DEGRADED_ROUTE'
  | 'USAGE_ESTIMATED'  | 'INPUT_REDACTED'   | 'INPUT_TRUNCATED' | 'POLICY_NARROWED';
```

Additive and ignorable. A consumer that ignores every warning still behaves safely.

---

## 5. `ai.structured.generate` (frozen)

### 5.1 Input

```ts
export type StructuredGenerateInput = {
  readonly instructions: string;          // the task. ≤ 8 000 chars.
  readonly context: readonly ContextValue[];
};

export type ContextValue = {
  readonly name: string;                  // ^[a-z][a-zA-Z0-9]*$
  readonly label: string;
  readonly type: 'STRING' | 'NUMBER' | 'BOOLEAN' | 'STRING_ARRAY' | 'OBJECT' | 'OBJECT_ARRAY';
  readonly untrusted: boolean;            // true for anything a learner typed
  readonly value: string;                 // already serialized as text by the caller
  readonly maxLength?: number;
};
```

Two channels ([`ARCHITECTURE.md`](ARCHITECTURE.md) §11.2): `instructions` is trusted and
authored; `context[]` is data. **A value with `untrusted: true` is rendered as data and can never
become an instruction.** A caller that inlines learner text into `instructions` has voided this
guarantee and owns the consequences.

### 5.2 Output

`output` is a JSON object conforming to `outputSchema`.

Validation semantics (frozen):

1. Extraction order: fenced JSON block → outermost balanced `{…}`/`[…]` → `EXTRACTION_FAILED`.
2. JSON parse failure ⇒ `INVALID_RESPONSE`.
3. **Unknown fields rejected. Missing required fields rejected. Types are never coerced** —
   `"3"` is not a `NUMBER`.
4. `maxLength` enforced per field; `maxOutputBytes` enforced overall.
5. **No partial results.** A payload that does not fully conform is a failure, not a
   best-effort object.

### 5.3 Repair (frozen)

One bounded repair attempt: re-ask the **same** provider/model with the validation issues as
feedback. Controlled by config (`'NONE' | 'ONCE'`, default `'ONCE'`), charged to the same
`idempotencyKey`, reported as `warnings: [{ code: 'OUTPUT_REPAIRED' }]`. Exhaustion ⇒
`VALIDATION / OUTPUT_REPAIR_EXHAUSTED`.

Repair is not retry and not fallback.

### 5.4 Specialized capability schemas — draft, not frozen

`education.idea.evaluate`, `education.hint.generate`, `learning.summary.generate`,
`code.debug.analyze`, `code.explain` have **frozen names** and **draft schemas**. Their shape is
settled when the first pack is implemented (Stage 8), with a compatibility note here.

The `education.idea.evaluate` request/response pair is provided now as an **illustrative**
fixture ([`fixtures/`](fixtures/) `binding: "ILLUSTRATIVE"`) so a consumer can build its
envelope plumbing and its degradation paths immediately. A consumer must treat the specialized
schema as **provisional** and keep it behind one adapter boundary so a schema change is a
one-file change.

### 5.5 `ai.text.generate` (frozen)

Input: `{ instructions, context[] }` plus `requirements?` and `maxOutputTokens?` from the
envelope. Output: `{ text: string; finishReason: AiFinishReason }`. Structural safety only.

---

## 6. Capability discovery (frozen)

```ts
export interface AiCapabilityDirectory {
  listCapabilities(): Promise<readonly CapabilityDescriptor[]>;
  getCapability(id: string, version?: string): Promise<CapabilityDescriptor | null>;
  getStatus(): Promise<AiBridgeStatus>;
}

export type CapabilityAvailability = 'AVAILABLE' | 'DEGRADED' | 'UNAVAILABLE' | 'DISABLED';

export type CapabilityDescriptor = {
  readonly id: string;
  readonly version: string;
  readonly kind: 'GENERIC' | 'SPECIALIZED';
  readonly status: CapabilityAvailability;
  readonly requiredPrimitive: string;
  readonly profiles: readonly ModelProfile[];
  readonly requirements: CapabilityRequirements;      // additive, Stage 2 — see the compatibility note
  readonly inputSchema: OutputSchema;
  readonly outputSchema: OutputSchema;
  readonly policyId: string;
  readonly policyVersion: string;
  readonly allowGenericFallback: boolean;
  readonly limits: { maxInputBytes: number; maxOutputBytes: number; totalTimeoutMs: number; maxCallsPerTurn: number };
  readonly schemaOwnership: SchemaOwnership;           // additive, Stage 2 — see the compatibility note
};

export type SchemaOwnership = {
  readonly input: 'REGISTRY' | 'CALLER';
  readonly output: 'REGISTRY' | 'CALLER';
  readonly policy: 'REGISTRY';
};

export type AiBridgeStatus = {
  readonly contractVersion: string;
  readonly global: CapabilityAvailability;
  readonly killSwitch: { global: boolean; providers: readonly string[]; capabilities: readonly string[] };
  readonly capabilities: readonly { id: string; version: string; status: CapabilityAvailability }[];
};
```

**Not in the descriptor:** provider ids, model names, prices, endpoints. Consumers must not be
able to develop a topology dependency.

### 6.1 Availability semantics (frozen)

| Value | Meaning | Consumer expectation |
| --- | --- | --- |
| `AVAILABLE` | full route, requested profile reachable | normal |
| `DEGRADED` | serving, but narrowed (e.g. `reasoning` profile unreachable) | may still call; expect `DEGRADED_ROUTE` |
| `UNAVAILABLE` | no route right now | do not call; use your declared fallback |
| `DISABLED` | switched off deliberately | do not call; **say something different to the learner** than for a failure |

`DISABLED` ≠ `UNAVAILABLE`. "The school turned AI off" and "AI is broken" require different
words to a child, so the contract must distinguish them before the call.

---

## 7. Error model (frozen)

```ts
export type AiErrorCode =
  | 'UNAVAILABLE' | 'TIMEOUT' | 'RATE_LIMITED' | 'QUOTA_EXCEEDED'
  | 'INVALID_REQUEST' | 'INVALID_RESPONSE' | 'SCHEMA_MISMATCH' | 'PROVIDER_ERROR'
  | 'MODEL_UNAVAILABLE' | 'CONTENT_BLOCKED' | 'CANCELLED' | 'INTERNAL';

export type AiError = {
  readonly code: AiErrorCode;
  readonly message: string;          // sanitized bridge wording. NEVER provider prose.
  readonly retryable: boolean;       // authoritative for the caller
  readonly retryAfterMs?: number;
  readonly stage: 'ENVELOPE' | 'PERMISSION' | 'INPUT_SAFETY' | 'ROUTING' | 'PROVIDER'
               | 'EXTRACTION' | 'VALIDATION' | 'POLICY' | 'DEADLINE' | 'GOVERNANCE' | 'CANCELLATION'
               | 'INTERNAL';   // INTERNAL is additive, Stage 2 — see the compatibility note
  readonly reason?: AiErrorReason;   // closed set — ARCHITECTURE.md §6.2, plus the Stage 2 and Stage 3 additions
  readonly details?: Readonly<Record<string, string | number | boolean>>;
};
```

### 7.1 The non-penetration rule (frozen)

> A provider's raw message, status code, response body or header value is **never** part of this
> contract and must never reach a consumer.

A caller must not parse `message` for meaning. Only `code`, `stage`, `reason`, `retryable` and
`retryAfterMs` are semantic. `message` is for humans and logs.

### 7.2 Retry/fallback classification (frozen)

| Code | retryable default | safe to fall back to another provider |
| --- | --- | --- |
| `UNAVAILABLE` | true | yes |
| `TIMEOUT` | true | yes |
| `RATE_LIMITED` | true | only if configured |
| `QUOTA_EXCEEDED` | false | only if configured (off by default) |
| `INVALID_REQUEST` | false | **no** |
| `INVALID_RESPONSE` | true | **no** |
| `SCHEMA_MISMATCH` | false | **no** |
| `PROVIDER_ERROR` | true iff `OVERLOADED` | yes when retryable |
| `MODEL_UNAVAILABLE` | false | **yes** — it is a routing problem |
| `CONTENT_BLOCKED` | false | **no** |
| `CANCELLED` | false | no |
| `INTERNAL` | false | no |

**Never fall back on `CONTENT_BLOCKED`.** Trying the same blocked content on another provider is
content-policy shopping, not resilience.

---

## 8. Identity and permission (frozen requirements)

1. `callerPluginId` is bound by the **host plugin runtime**, in a channel the caller cannot
   write.
2. AI Bridge **rejects** an unverified `callerPluginId`. There is no self-declared fallback.
3. A consumer declares the capabilities it uses in its manifest
   (`capabilities.requires` / `capabilities.optional`). Undeclared ⇒ denied.
4. `subjectToken` is opaque and host-minted. It is **not** an email, a user id, or a raw session
   token. AI Bridge cannot resolve it to a person and must not try.

A consumer must be correct when the host provides none of these yet: today the enforcement is
coarser (§11), and the consumer's own degradation logic must not assume per-learner governance
is in force.

---

## 9. Timeout semantics (frozen)

| Deadline | Definition |
| --- | --- |
| **request deadline** | `deadlineAt` computed once at ingress from `timeoutBudget.totalMs`, clamped to capability and server caps. Covers routing + all provider attempts + extraction + validation + repair. |
| **provider deadline** | `min(timeoutBudget.providerMs ?? 15 000, remaining − 1 000)` |
| **fallback deadline** | not a separate value — a fallback inherits the **remaining** budget |

Defaults: total 20 000 ms · provider 15 000 ms · validation reserve 1 000 ms · minimum viable
attempt 1 500 ms.

**A caller waits one budget, not `n × budget`.** The bridge never widens a caller's budget.

When the budget is exhausted the result is `TIMEOUT` / `BUDGET_EXHAUSTED`, `retryable: true`.

---

## 10. Idempotency semantics (frozen)

1. `idempotencyKey` is scoped to `(callerPluginId, capability, capabilityVersion)`.
2. A repeat returns the stored result with `warnings: [{ code: 'IDEMPOTENT_REPLAY' }]`.
3. A concurrent duplicate **coalesces** onto the in-flight call and receives the same result.
4. The same key with a **different** request body ⇒ `INVALID_REQUEST` / `IDEMPOTENCY_CONFLICT`.
5. **One logical learning turn ⇒ one `idempotencyKey`.** A consumer must mint it from its own
   turn identity (e.g. a `commandId`) and must **not** regenerate it per transport retry.

Consumer obligation: never send two different `idempotencyKey`s for the same learning turn. That
is the one thing that would defeat the mechanism.

---

## 11. Usage projection (frozen)

A consumer may read: `usage.*` (as cost evidence), `providerMetadata.modelClass`,
`providerMetadata.routeDepth`, `warnings`, `latencyMs`, `finishReason`.

A consumer must **not**: branch on `providerId`; derive any learner judgement from `usage`;
assume `estimatedCost` exists; assume `inputTokens` is exact (`USAGE_ESTIMATED`).

---

## 12. Mapping to AlgoQuest's `GenericAiPort`

AlgoQuest already declares a `GenericAiPort`
(`@algoquest/contracts` → `ai-task/generic-ai-port.ts`) whose comment says whatever sits behind
it — "a host gateway, **a bridge**, a scripted fake" — is interchangeable. AI Bridge is that
bridge. This section makes the mapping explicit so the adapter is mechanical.

> This is a **mapping**, not a dependency. Neither repository imports the other.

### 12.1 Request mapping

| `GenericAiRequest` | `AiRequestEnvelope` | Note |
| --- | --- | --- |
| `requestId` | `requestId` | direct |
| `idempotencyKey` | `idempotencyKey` | direct. AlgoQuest maps it from its `commandId`. |
| `capabilityHint` | `capability` + `capabilityVersion` | `capabilityHint` is a hint and may be ignored by a transport; `capability` is a contract field. When the hint names `education.idea.evaluate`, the adapter **selects that capability** if it is registered, else `ai.structured.generate` per §13. |
| `messages` (SYSTEM/USER) | `instructions` + `context[]` | AlgoQuest's SYSTEM messages map to `instructions`; its USER message content maps to `context[]` entries flagged `untrusted` |
| `bindings` (`name,label,type,untrusted,value`) | `context[]` (`name,label,type,untrusted,value`) | **identical shape** — zero translation |
| `outputSchema {schemaId,version,fields}` | `outputSchema` = `{ kind:'INLINE', dialect:'aibridge.fields/v1', … }` | identical `fields` table |
| `latencyClass` | `profile` | mapping in §12.3 |
| `timeoutMs` | `timeoutBudget.totalMs` | direct |
| `maxOutputBytes` | `requirements.maxOutputTokens` + `limits.maxOutputBytes` | byte cap is a capability/bridge limit; token cap is a requirement |
| — | `callerPluginId`, `subjectToken`, `metadata`, `policyId`, `contractVersion` | supplied by the adapter / host |

### 12.2 Response mapping

| `GenericAiResponse` | `AiResult` | Note |
| --- | --- | --- |
| `requestId` | `requestId` | |
| `providerId` | `providerMetadata.providerId` | |
| `modelClass: AiModelClass` | `providerMetadata.modelClass` | §12.3 |
| `text` | `output.text` for `ai.text.generate`; otherwise the bridge keeps `text` internal | a structured answer does not need its raw prose |
| `structured: unknown` | `output` | **but** the bridge has already runtime-validated it. AlgoQuest must still run its own `parseX` — defence in depth, and it is already written. |
| `finishReason` | `finishReason` | `STOP\|LENGTH\|CONTENT_FILTER\|UNKNOWN` — identical |
| `usage` (`inputTokens,outputTokens,latencyMs,costEstimate`) | `usage` (`inputTokens,outputTokens,totalTokens,cachedTokens,estimatedCost`) | `costEstimate: number` ⇒ `estimatedCost: { value, currency: 'USD', basis: 'ESTIMATED' }`. `latencyMs` moves to `AiResult.latencyMs`. |

### 12.3 Profile / modelClass mapping

| AlgoQuest `latencyClass` | AI Bridge `profile` | reported `modelClass` |
| --- | --- | --- |
| `FAST` | `fast` | `FAST` |
| `STANDARD` | `balanced` | `FAST` or `REASONING`, whatever actually served it |
| `DELIBERATE` | `reasoning` | `REASONING` |
| — | `cheap` | `FAST` |
| — | `high-context` | `REASONING` |

| AI Bridge `modelClass` | AlgoQuest `AiModelClass` |
| --- | --- |
| `REASONING` | `'strong-reasoning'` |
| `FAST` | `'fast'` |
| `LOCAL` | `'local'` |
| `UNKNOWN` | `'unknown'` |

`modelClass` reports what **actually served the request**, not what was asked for. A `DELIBERATE`
request answered by a degraded route reports `FAST` and carries `DEGRADED_ROUTE` — so AlgoQuest
can see it got a weaker answer than it wanted.

### 12.4 `GenericAiPortCapabilities` mapping

| `GenericAiPortCapabilities` | `AiBridgeStatus` + `CapabilityDescriptor` |
| --- | --- |
| `contractVersion` | `AIBRIDGE_CONTRACT_VERSION` |
| `providerId` | `providerMetadata.providerId` of the first configured route |
| `structuredOutput` / `textOutput` | both `true` in V1 |
| `cancellation` | `true` |
| `idempotency` | `true` (§10) |
| `maxOutputBytes` | `limits.maxOutputBytes` |
| `modelClasses` | derived from the reachable `profiles` |
| `channel` | `'COMPOSED_PROMPT'` — AI Bridge consumes `messages`/`instructions`. A future in-bridge specialized pack may report `'TYPED_CAPABILITY'`. |

### 12.5 Error mapping → `HostErrorCode`

The adapter maps and sets `HostError.retryable` from `AiError.retryable` — **the bridge is
authoritative for retryability**, which is why §7.2 exists.

| `AiErrorCode` | `HostErrorCode` | Note |
| --- | --- | --- |
| `UNAVAILABLE` | `UNAVAILABLE` | |
| `TIMEOUT` | `TIMEOUT` | |
| `RATE_LIMITED` | `RATE_LIMITED` | |
| `QUOTA_EXCEEDED` | `RATE_LIMITED` | **deliberate.** `FORBIDDEN` would read as "this learner may not use AI", which is false. Quota is time-shaped, so `RATE_LIMITED` + `retryAfterMs` is honest. |
| `INVALID_REQUEST` | `INVALID_INPUT` | |
| `INVALID_RESPONSE` | `INTERNAL` | bridge preserves `retryable: true` |
| `SCHEMA_MISMATCH` | `INTERNAL` | bridge preserves `retryable: false` |
| `PROVIDER_ERROR` | `UNAVAILABLE` | |
| `MODEL_UNAVAILABLE` | `UNSUPPORTED_CAPABILITY` | |
| `CONTENT_BLOCKED` | `FORBIDDEN` | see §13.3 — never surfaced to a learner as a refusal |
| `CANCELLED` | `CANCELLED` | safe: `isJudgeVerdict('CANCELLED')` is false |
| `INTERNAL` | `INTERNAL` | |

### 12.6 `AiTaskOutcome` mapping

| Situation | `AiErrorCode` | `AiTaskOutcome` |
| --- | --- | --- |
| validated answer | — | `ANSWERED` |
| capability missing / `DISABLED` | `MODEL_UNAVAILABLE`, `GOVERNANCE/*` | `AI_UNAVAILABLE` |
| provider/transport failure | `PROVIDER_ERROR`, `INVALID_RESPONSE`, `INTERNAL` | `AI_FAILED` |
| overall budget elapsed | `TIMEOUT` | `AI_TIMEOUT` |
| throttled | `RATE_LIMITED` | `AI_RATE_LIMITED` |
| quota exhausted | `QUOTA_EXCEEDED` | `AI_RATE_LIMITED` *(no `AI_QUOTA` value exists; documented so nobody "fixes" it by inventing one)* |
| cancelled | `CANCELLED` | `AI_CANCELLED` |
| failed schema validation | `SCHEMA_MISMATCH`, `OUTPUT_TOO_LARGE` | `OUTPUT_INVALID` |
| unknown capability | `INVALID_REQUEST` | `TASK_UNKNOWN` |

---

## 13. Failure semantics with AlgoQuest (frozen rules)

### 13.1 Degradation mapping

| AI Bridge condition | AlgoQuest condition | Learner-visible behaviour |
| --- | --- | --- |
| capability `UNAVAILABLE` / `DISABLED` / no `ai.*` at all | `AI_UNAVAILABLE` | authored rubric / authored fallback. Assessor recorded as `RUBRIC`, `degraded: true`, band ceiling `PROMISING`. |
| `TIMEOUT` | `AI_FAILED` (degraded) | authored fallback |
| `RATE_LIMITED` | `AI_FAILED` (degraded) | authored fallback; **retry is a consumer decision**, not a hidden retry |
| `QUOTA_EXCEEDED` | `AI_FAILED` (degraded) | authored fallback |
| `INVALID_RESPONSE` / `SCHEMA_MISMATCH` | `AI_FAILED` (degraded) | authored fallback + `guard` |
| `CONTENT_BLOCKED` | `AI_REJECTED` | authored fallback. Never rendered as a refusal to the learner. |
| `CANCELLED` | session `STOPPED` / `DEGRADED` | nothing written late into a session that moved on |
| `INVALID_REQUEST` | **caller bug** | log and fail loudly in dev; degrade in production |

### 13.2 Rules (frozen)

1. **AI Bridge never writes a learner's classification into a quest.** It returns an answer. The
   consumer's runtime decides what that means for evidence, band and completion.
2. **`COMPLETE` is never the model's free choice.** A capability may propose it; the consumer's
   deterministic guard decides it.
3. **No silent fallback.** Whether `education.idea.evaluate` may fall back to
   `ai.structured.generate` is decided by the **consumer's adapter / host policy**
   (`allowGenericFallback`), never by AI Bridge and never implicitly.
4. **`declaresSolution` is a self-report.** Screen it, never trust it.
5. **A degraded turn is a real turn.** Falling back to a rubric is not an error page.

### 13.3 `CONTENT_BLOCKED` must not read as punishment

A child whose text trips a safety filter must not be told "the AI refused you". The consumer
maps it to its own neutral, encouraging degradation message. The word "blocked" reaches an
operator log, never a learner.

---

## 14. Shared compatibility fixture (frozen strategy)

### 14.1 Decision

> **Shared JSON fixture specs.** Versioned data files, loaded and validated by each side's
> **own** parser. **No cross-repo source import, ever.**

| Option | Verdict |
| --- | --- |
| **JSON fixture spec** (chosen) | Zero code coupling. Each side proves its own parser against the same bytes. Language- and repo-agnostic. Diffable in review. |
| cross-repo source import | **rejected** — it would make AlgoQuest depend on `@aibridge/*` and void host neutrality in both directions. |
| published contract package (`@aibridge/contract-fixtures`) | **deferred to Stage 8**, needs an ADR in *both* repositories. Convenient, but it is a code coupling and must be a deliberate one. |
| generated artifact | **deferred** — only worth it once there are three or more consumers. |

### 14.2 Fixture set

`Docs/fixtures/fixture-set.v1/` — `fixtureSetVersion: "1.0"`.

Each fixture is one JSON document:

```json
{
  "fixtureSetVersion": "1.0",
  "binding": "FROZEN | ILLUSTRATIVE",
  "kind": "request | response",
  "expect": "accept | reject",
  "capability": "…",
  "capabilityVersion": "…",
  "case": "short-machine-readable-case-name",
  "document": { }
}
```

`binding: "FROZEN"` fixtures must pass against any conforming implementation, in either
repository, forever within major 1. `binding: "ILLUSTRATIVE"` fixtures are for scaffolding a
consumer's plumbing and may change with a compatibility note.

Both sides run the same fixtures through their own validators and assert the same `expect`.
That is the entire compatibility guarantee — and it is enough to develop against.

Files in `fixture-set.v1/`:

| File | Binding | Expect |
| --- | --- | --- |
| `ai.structured.generate.request.ok.json` | FROZEN | accept |
| `ai.structured.generate.request.unknown-metadata.json` | FROZEN | reject |
| `ai.structured.generate.request.secret-input.json` | FROZEN | reject |
| `ai.structured.generate.response.ok.json` | FROZEN | accept |
| `ai.structured.generate.response.schema-mismatch.json` | FROZEN | accept *(a valid FAILED envelope)* |
| `ai.text.generate.response.ok.json` | FROZEN | accept |
| `education.idea.evaluate.request.ok.json` | ILLUSTRATIVE | accept |
| `education.idea.evaluate.response.ok.json` | ILLUSTRATIVE | accept |
| `education.idea.evaluate.response.unavailable.json` | ILLUSTRATIVE | accept |

A `reject` fixture asserts *which* `reason` is produced, so two implementations cannot both be
"right" while disagreeing about the rule.

---

## 15. AlgoQuest Stage 6 parallel plan

**Which work needs no real AI Bridge?** Almost all of it.

| AlgoQuest work | Needs real AI Bridge? | How to proceed now |
| --- | --- | --- |
| **Stage 6 — AI capability consumer** | **NO** | Implement `GenericAiPort` against the mapping in §12. Back it with `ScriptedIdeaAiProvider` / a fixture-driven fake that returns `fixture-set.v1` documents. Run §14's fixtures against your own parser. |
| Capability discovery + degradation states | **NO** | `AiBridgeStatus` and `CapabilityAvailability` are frozen (§6). Write the `AVAILABLE/DEGRADED/UNAVAILABLE/DISABLED` branches now; feed them from a fake. |
| Failure semantics (§13.1) | **NO** | The whole error→`AiTaskOutcome`→`ATTEMPT_LIMITATION_CODE` table is frozen (§12.5, §12.6, §13.1). Test every row with an injected `AiError`. |
| Idempotent turn handling (§10) | **NO** | Mint keys from `commandId`, assert one billable call per turn against a counting fake. |
| Cancellation on quest close (§13) | **NO** | `CancellationToken` semantics are frozen. |
| Rubric fallback parity | **NO** | Already built in Stage 5. Verify the `AI_UNAVAILABLE` / `AI_FAILED` ceiling (`PROMISING`) still holds under every §13.1 row. |
| **Stage 7 — Coding Quest** | **NO** | Pure quest/blueprint work. `code.debug.analyze` is a *name* today; a coding quest can run judge-only and degrade on AI exactly like Idea Lab does. |
| **Stage 8 — AI Debug consumer** | **NO** for the consumer half | Build the consumer and its guard against `code.debug.analyze`'s frozen *name* and an illustrative fixture. The real capability lands in AI Bridge Stage 8. |
| **Stage 9 — Scoring** | **NO** | Scoring is explicitly *not* an AI capability ([`CAPABILITIES.md`](CAPABILITIES.md) §3). Deterministic work. |
| Real-AI end-to-end | **YES** | AI Bridge Stage 10. Everything else must be already green. |

### 15.1 Consumer development pattern

```
AlgoQuest core ─▶ GenericAiPort (your port, your types)
                       │
        ┌──────────────┼──────────────────┐
        ▼              ▼                  ▼
  ScriptedFake   FixtureFake        AiBridgePort (Stage 10)
  (Stage 5,       (reads fixture-set.v1,  (maps §12, talks to
   exists)        asserts your parser)     AI Bridge over the host)
```

Three implementations behind one port, so the real bridge lands as **one new adapter**, not a
rewrite.

### 15.2 Safe for AlgoQuest Stage 6 to start against this contract?

**YES.**

Everything Stage 6 needs is frozen: capability naming (§1), versions (§2), request envelope (§3),
response envelope (§4), `ai.structured.generate` (§5), discovery (§6), errors (§7), identity
(§8), timeouts (§9), idempotency (§10), usage projection (§11), and the mapping to
`GenericAiPort` (§12). The only provisional surface is the **specialized** output schema
(§5.4), which is isolated behind one adapter boundary by design.

---

## 16. Portability

- AI Bridge core has **no** `@ojplatform/*` and **no** `@algoquest/*` dependency.
- AlgoQuest has **no** `@aibridge/*` dependency. This document and [`fixtures/`](fixtures/) are
  the only shared surface.
- Host-specific knowledge lives in `@aibridge/adapter-<host>` on the AI Bridge side and in
  AlgoQuest's existing host adapter on its side. Each arrow points one way.
- The contract is a **call shape**, not an HTTP API. In-process, IPC and HTTP are all valid
  transports.

**OJPlatform coupling: none. AlgoQuest coupling: none.**
