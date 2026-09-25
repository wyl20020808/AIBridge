# AI Bridge — Contract Reference (Stage 2–3)

**Status:** implemented and tested. This document describes what `@aibridge/contracts`,
`@aibridge/core`, `@aibridge/host-sdk`, `@aibridge/runtime`, `@aibridge/governance` and
`@aibridge/provider-openai-compatible` actually export, and the rules the tests enforce
mechanically.

It is a *reference*, not a second source of truth. The frozen parallel contract remains
[`INTEGRATION_CONTRACT_V1.md`](INTEGRATION_CONTRACT_V1.md); where this document and that one differ,
that one wins and this is a bug. Runtime rationale lives in [`ARCHITECTURE.md`](ARCHITECTURE.md),
[`CAPABILITIES.md`](CAPABILITIES.md) and [`SECURITY.md`](SECURITY.md).

Nothing here connects a provider, reads a key, makes a network call, or runs a UI.

---

## 1. Packages and dependency arrows

```
@aibridge/contracts   zero runtime dependencies
        ▲
        │  one-way only
@aibridge/core        depends on contracts
        ▲
        │
@aibridge/host-sdk    depends on contracts + core
        ▲
        │
@aibridge/runtime     depends on contracts + core + host-sdk   (the trusted execution layer)

@aibridge/provider-openai-compatible   depends on contracts only (implements the adapter port)
```

| Package | Owns | Must not |
| --- | --- | --- |
| `@aibridge/contracts` | versions, envelopes, errors, strict parsers, capability/descriptor types, structured schema dialect, the stream-event contract, the two prompt-channel renderers | import anything (zero runtime deps), touch DOM/Node globals/network/filesystem/`process.env` |
| `@aibridge/core` | input safety boundary, structural output safety, capability registry + directory, governance kill switches, provider/model registries | own a concrete provider, host or consumer |
| `@aibridge/host-sdk` | host port interfaces, in-memory + mutant fakes, scripted provider, host/provider conformance kits | name a host, import an SDK, make a network call |
| `@aibridge/runtime` | contract + capability validation, provider resolution, trusted secret resolution, execution, timeout, cancellation, response normalization, generic error propagation | own a provider, a host port implementation, or any provider wire shape |
| `@aibridge/provider-openai-compatible` | the reference adapter: `/chat/completions` payload, headers, base URL, authentication header, response shape, error body, SSE framing | leak a vendor type, a raw error body or a credential across the port |

All three are ESM, `module`/`moduleResolution: NodeNext`, strict TypeScript, and import each other
with explicit `.js` extensions. `scripts/check-adapter-coupling.mjs` and
`scripts/check-runtime-deps.mjs` fail the build if an arrow is violated.

**Portability:** no `@ojplatform/*` or `@algoquest/*` dependency exists in any package, and no
package reaches into either repository's source tree. `npm run check:portability` proves the
packages install and run in an isolated project with no `node` types.

---

## 2. Versions — `versions.ts`

Single source for every frozen version constant:

```ts
PLUGIN_API_VERSION            = 1
AIBRIDGE_CONTRACT_VERSION     = '1.2'
GENERIC_REQUEST_SCHEMA_VERSION = '1.2'
AIBRIDGE_RESPONSE_SCHEMA_VERSION = '1.1'
AIBRIDGE_ERROR_VERSION        = '1.2'
STRUCTURED_OUTPUT_SCHEMA_VERSION = '1.0'
STRUCTURED_OUTPUT_SCHEMA_MAJOR = 1
PROVIDER_ADAPTER_API_VERSION  = 1        // internal, not a public contract
CAPABILITY_DESCRIPTOR_VERSION = '1.1'
FIXTURE_SET_VERSION           = '1.0'
AIBRIDGE_FIELD_DIALECT        = 'aibridge.fields/v1'
```

The `1.2` values are the additive Stage 7 bump (compatibility note in
[`INTEGRATION_CONTRACT_V1.md`](INTEGRATION_CONTRACT_V1.md)); comparison stays major-compatible.

`parseMajor(version)` and `checkMajorCompatibility(actual, expected)` implement the frozen rule:
comparison is **major-compatible** (`1.0` accepts `1`, `1.0`, `1.0.3`); an unknown or higher major is
rejected (`INVALID_REQUEST` / `CONTRACT_VERSION_UNSUPPORTED`). Never best-effort parsed
([`../AGENTS.md`](../AGENTS.md) §5).

---

## 3. Validation discipline — `issue.ts`

Every parser returns a `ValidationResult<T>`:

```ts
type ValidationResult<T> =
  | { readonly ok: true;  readonly value: T }
  | { readonly ok: false; readonly failure: ValidationFailure };

type ValidationFailure = {
  readonly reason: AiErrorReason;   // exactly one, so a reject fixture can assert it
  readonly code: AiErrorCode;       // derived from the reason's canonical meta
  readonly stage: AiErrorStage;
  readonly issues: readonly ValidationIssue[];
};

type ValidationIssue = { readonly code: ValidationIssueCode; readonly path: string; readonly message: string };
```

Rules, all mechanically tested:

- **No parser throws** for bad input, and none returns a bare boolean.
- Issue `path`s are rooted (`$`, `$.field`, `$.context[3].value`) and ordered deterministically
  (keys are visited sorted).
- A failure names **one** reason, so two implementations cannot both be "right" while disagreeing
  about the rule.
- The issue-code vocabulary is closed (`VALIDATION_ISSUE_CODES`).

---

## 4. Error model — `errors.ts`

The **twelve** codes (`AI_ERROR_CODES`):

```
UNAVAILABLE  TIMEOUT  RATE_LIMITED  QUOTA_EXCEEDED
INVALID_REQUEST  INVALID_RESPONSE  SCHEMA_MISMATCH  PROVIDER_ERROR
MODEL_UNAVAILABLE  CONTENT_BLOCKED  CANCELLED  INTERNAL
```

The **twelve** stages (`AI_ERROR_STAGES`): `ENVELOPE`, `PERMISSION`, `INPUT_SAFETY`, `ROUTING`,
`PROVIDER`, `EXTRACTION`, `VALIDATION`, `POLICY`, `DEADLINE`, `GOVERNANCE`, `CANCELLATION`,
`INTERNAL`. (`INTERNAL` is a Stage 2 reconciliation of an `ARCHITECTURE.md` §6.1/§6.2 gap — see the
compatibility note.)

`REASON_META` is the authoritative `reason → { code, stage, retryable }` table. `makeAiError` fills
code, stage and retryability from it, so a reason and its classification cannot drift.
`RETRYABLE_BY_CODE` supplies the per-code default; the reason default overrides it; an explicit
`retryable` on the built error wins. `retryable` is authoritative for the caller.

**Stage 3 additive reasons** (compatibility note in
[`INTEGRATION_CONTRACT_V1.md`](INTEGRATION_CONTRACT_V1.md)): `PROVIDER_AUTH_FAILED`
(`PROVIDER_ERROR`/`PROVIDER`/false), `PROVIDER_REQUEST_REJECTED`
(`INVALID_REQUEST`/`PROVIDER`/false) and `PROVIDER_UNAVAILABLE`
(`PROVIDER_ERROR`/`PROVIDER`/true). Together with the five Stage 1 provider reasons they give
every closed `ProviderCategory` exactly one home: `REASON_BY_PROVIDER_CATEGORY` is that table and
`reasonForProviderCategory` reads it. Two adapters therefore cannot disagree about what `AUTH`
means.

**Stage 5 additive surface** (same compatibility note): three error reasons — `QUOTA_CAPABILITY`
and `QUOTA_PROVIDER` (a quota scoped to a capability / a provider) and `COST_BUDGET_EXHAUSTED` (a
cost budget — deliberately **not** `BUDGET_EXHAUSTED`, which is the **time** budget), all three
`QUOTA_EXCEEDED`/`GOVERNANCE`/`false`. Plus one warning code, `RETRY_USED` (a bounded same-provider
retry ran; additively ignorable like every warning), and `AiUsage.reasoningTokens` (a count only;
reasoning content never crosses; absent = unknown, never 0).

`FALLBACK_BY_CODE` / `fallbackEligibility` encode the frozen fallback rule: *if the failure is a
property of the request or the content, do not spend another provider's money on it.*

**`AiError.details` is deny-by-default.** `DETAIL_KEYS_BY_REASON` allows a closed key set per reason;
`parseAiError` rejects an unlisted key rather than dropping it. Values are `string | number |
boolean` only.

**The non-penetration rule** (frozen): a provider's raw message, status code, body or header never
appears in any exported type. `PROVIDER_CATEGORIES` may cross the boundary; a message never does.
`AiError.message` is sanitized bridge wording, bounded to `AI_ERROR_MESSAGE_MAX_LENGTH`.

---

## 5. Request — consumer half and trusted half

The request is split into an **untrusted consumer request** and a **trusted dispatch context**. This
is the Stage 2 formalization of [`../AGENTS.md`](../AGENTS.md) §4 and [`SECURITY.md`](SECURITY.md) §4.

### 5.1 `ConsumerAiRequest` — `request.ts`

```ts
type ConsumerAiRequest<TInput = unknown> = {
  readonly contractVersion: string;
  readonly requestId: string;          // ^[A-Za-z0-9._-]{1,64}$
  readonly idempotencyKey: string;     // ^[A-Za-z0-9._-]{1,128}$
  readonly capability: string;
  readonly capabilityVersion: string;
  readonly profile: ModelProfile;
  readonly requirements?: CapabilityRequirements;
  readonly input: TInput;
  readonly outputSchema?: OutputSchema; // generic structured only
  readonly policyId?: string;
  readonly timeoutBudget?: TimeoutBudget;
  readonly metadata?: RequestMetadata;
};
```

`parseConsumerAiRequest` is the **security boundary**. Before reading any field it rejects:

- `TRUSTED_ONLY_FIELDS` (`callerPluginId`, `subjectToken`, `grantedPermissions`, `permissions`,
  `hostRequestId`, `principal`, `verifiedCaller`) with
  `INVALID_REQUEST` / `TRUSTED_FIELD_IN_CONSUMER_REQUEST` — including when good fields are also
  present;
- `FORBIDDEN_CONSUMER_FIELDS` (`apiKey`, `baseUrl`, `model`, `providerId`, `systemPrompt`, `policy`,
  `messages`, …) with `MALFORMED_ENVELOPE`;
- any unknown key with `MALFORMED_ENVELOPE`.

Reason precedence is deterministic (`REASON_PRECEDENCE`): a more specific diagnosis wins over the
generic envelope one.

### 5.2 `TrustedDispatchContext` — `context.ts`

Injected by the host/broker in a channel the caller cannot write:

```ts
type TrustedDispatchContext = {
  readonly callerPluginId: string;
  readonly subjectToken?: string;      // opaque; never an email, user id or session token
  readonly grantedPermissions: readonly string[];
  readonly hostRequestId?: string;
  readonly traceId?: string;
};
```

`composeAiRequest(consumerRequest, trustedContext)` is the **only** place `callerPluginId` and
`subjectToken` enter the pipeline. `isOpaqueSubjectToken` refuses identity-shaped tokens (an email,
a JWT). `subjectTokenHash` gives the usage ledger a stable handle and never the token.
`isCapabilityGranted` matches `capability` or `capability@major`, deny by default.

### 5.3 `AiRequestEnvelope` — `envelope.ts`

The frozen wire envelope carries both halves in one document (`callerPluginId` + `subjectToken`
plus the consumer fields). `parseAiRequestEnvelope` validates that shape for a **trusted channel**
and for fixture conformance; it never grants a consumer the right to author those fields. The
security boundary stays `parseConsumerAiRequest`.

### 5.4 Metadata — `metadata.ts`

Closed allow-list of exactly four keys: `locale`, `traceId`, `surface`, `correlationId`. An unknown
key is `METADATA_NOT_ALLOWED`; the serialized form is capped at 512 bytes.

### 5.5 The generic capability payloads — `input.ts`

The frozen input shapes of the two V1 primitives (INTEGRATION_CONTRACT_V1.md §5.1, §5.5), parsed
with the same closed-key discipline: `ContextValue` (`name`, `label`, `type`, `untrusted`, `value`,
optional `maxLength`), `StructuredGenerateInput` and `TextGenerateInput` (which may carry
`maxOutputTokens`). The instruction channel is bounded (`INSTRUCTIONS_MAX_LENGTH = 8 000`); bundle
names are unique and lowerCamelCase. Stage 3 added these parsers so the runtime can reject an
unknown input key before it reaches a provider — the shapes themselves did not change.

### 5.6 The two prompt channels — `prompt.ts`

`renderOutputFormatInstruction` and `renderContextBlock` are the **one** implementation of the
instruction/data split (ARCHITECTURE.md §11.2), shared by the runtime (which renders the
output-format instruction) and every adapter (which renders the data channel). An `untrusted` value
is fenced as delimited data — `<<<aibridge-data … <<<aibridge-data` — and never concatenated into
an instruction string, so prompt injection is *structurally* unable to rewrite policy.

---

## 6. Schema ownership

A capability's **input schema**, **output schema** and **policy** each have an owner
(`SchemaOwnership`). The rule is deliberately unequal:

| Capability | `input` | `output` | `policy` |
| --- | --- | --- | --- |
| `ai.structured.generate` | `REGISTRY` | **`CALLER`** | `REGISTRY` |
| `ai.text.generate` | `REGISTRY` | `REGISTRY` | `REGISTRY` |
| every specialized capability | `REGISTRY` | `REGISTRY` | `REGISTRY` |

A specialized capability owns its output schema. A caller supplying `outputSchema` for one is
`INVALID_REQUEST` / `OUTPUT_SCHEMA_OVERRIDE_FORBIDDEN` (`allowsCallerOutputSchema` in
`@aibridge/core`). A caller may always **select** a registered policy via `policyId`; it may never
supply policy content.

---

## 7. Structured schema dialect — `schema.ts`

`aibridge.fields/v1` is a **field table**, not free-form JSON Schema. Six field types:

```
STRING  NUMBER  BOOLEAN  STRING_ARRAY  OBJECT  OBJECT_ARRAY
```

`FieldSpec`: `name` (`^[a-z][a-zA-Z0-9]*$`), `type`, `required`, `description`, optional
`untrusted`, optional `maxLength`. `OutputSchema` is `REF` (`{ schemaId, version }`) or `INLINE`
(`{ schemaId, version, dialect, fields }`). An unknown `dialect` or unsupported schema major is
`OUTPUT_SCHEMA_UNSUPPORTED` — never best-effort parsed.

The shape is deliberately identical to AlgoQuest's `AiFieldSpec`: **aligned by specification, never
by import.**

### 7.1 Extraction, validation and repair — `structured/`

- **Extraction** (`extraction.ts`): fenced ```` ```json ```` block → outermost balanced `{…}`/`[…]`
  → plain JSON → `EXTRACTION_FAILED`. A fenced block that does not parse is `JSON_PARSE_FAILED`, not
  a silent retry of the next strategy. Pure extraction never calls a model.
- **Validation** (`validate.ts`): unknown fields rejected, required fields strict, **types never
  coerced** (`"3"` is not a `NUMBER`), only finite numbers pass, `maxLength` per string, size- and
  depth-bounded, control/binary data rejected. **No partial result** — a non-conforming payload is a
  failure, not a best-effort object.
- **Repair** (`repair.ts`): a third mechanism, distinct from retry and fallback. Bounded to one
  attempt (`OUTPUT_REPAIR_POLICIES = ['NONE','ONCE']`), the same provider and model, the same
  `idempotencyKey`, reported as `OUTPUT_REPAIRED`; exhaustion is
  `VALIDATION / OUTPUT_REPAIR_EXHAUSTED`. Stage 2 defines the contract only and never calls a
  provider.

---

## 8. Response — `response.ts`

```ts
type AiResult<TOutput = unknown> = {
  readonly contractVersion: string;
  readonly requestId: string;
  readonly capability: string;
  readonly capabilityVersion: string;
  readonly status: 'SUCCEEDED' | 'FAILED';
  readonly output?: TOutput;                    // only when SUCCEEDED
  readonly error?: AiError;                     // only when FAILED
  readonly usage: AiUsage;
  readonly providerMetadata: ProviderMetadataProjection;
  readonly latencyMs: number;
  readonly finishReason: AiFinishReason;
  readonly warnings: readonly AiWarning[];
};
```

`parseAiResult` enforces the invariants: `SUCCEEDED` **must** carry `output` and **must not** carry
`error`; `FAILED` **must** carry `error` and **must not** carry `output`. A "partial success" is
`SUCCEEDED` plus `warnings`, so a consumer writes exactly one success branch.

- **`usage`** — every field optional; `estimatedCost` optional and stays optional (absent means
  *unknown*, not *zero*); a present cost carries a mandatory `basis`.
- **`providerMetadata`** — a closed safe projection (`providerId`, `providerFamily`, `modelClass`,
  `routeDepth`, `attemptCount`, `repaired`). `EXCLUDED_PROVIDER_METADATA_KEYS` lists what must never
  appear (`modelRef`, `endpoint`, `rawResponse`, `subjectToken`, …); a test asserts their absence.
- **`finishReason`** — closed: `STOP | LENGTH | CONTENT_FILTER | UNKNOWN`.
- **`warnings`** — the frozen eight codes (`AI_WARNING_CODES`), additive and ignorable.

### 8.1 Streaming — `stream.ts` (Stage 3, additive)

Streaming is a **delivery concern, not a capability** ([`CAPABILITIES.md`](CAPABILITIES.md) §4), so
the stream contract is a delivery variant of `AiResult`, not a second architecture. The frozen
sequence, enforced by `validateAiStreamSequence` and tested:

```text
STARTED  →  TEXT_DELTA*  →  (COMPLETED | FAILED)
```

- `STARTED` echoes identity exactly once and always first;
- `TEXT_DELTA` carries a non-empty increment, only before the terminal;
- exactly one terminal event, always last — `COMPLETED` carries `text` (the concatenation of the
  deltas) plus the same closing facts `AiResult` carries (`usage`, `finishReason`,
  `providerMetadata`, `latencyMs`, `warnings`); `FAILED` carries a normalized `AiError` plus the
  same closing facts;
- a stream that ends without a terminal is invalid — the runtime always terminates one, including
  on error, timeout and cancellation.

`parseAiStreamEvent` / `parseAiStreamEvents` apply the closed-key discipline to each event and the
sequence rules to the whole document. Provider-side, `ProviderStreamEvent` (`TEXT_DELTA` | `FINISH`
| `ERROR`) is the adapter's mapped output — never a vendor SSE frame.

---

## 9. Profiles and requirements — `profile.ts`, `requirements.ts`

Five V1 profiles: `fast`, `balanced`, `reasoning`, `cheap`, `high-context`. `vision` is **reserved
and out of scope for V1** — not permanently rejected, but not a member of `MODEL_PROFILES`. A
reserved profile is rejected with that explanation so an integrator is not left guessing.

`CapabilityRequirements` (`structuredOutput`, `reasoning`, `streaming`, `vision`,
`minContextTokens`, `maxOutputTokens`, `maxLatencyMs`) **narrows a route**; it never names a model
or provider. `streaming`/`vision` are never satisfiable in V1, so `true` yields `NO_ROUTE` rather
than a quiet downgrade (`v1UnsupportedRequirements`).

---

## 10. Capabilities — `capability.ts`

Naming: `<domain>.<subject>.<verb>`, lower dot-case; product prefixes (`algoquest.`, `ojplatform.`,
`aibridge.`) are forbidden as capability ids. A product's voice lives in `policyId`.

`CapabilityDescriptor` exposes: `id`, `version`, `kind` (`GENERIC | SPECIALIZED`), `status`,
`requiredPrimitive`, `profiles`, `requirements`, `inputSchema`, `outputSchema`, `policyId`,
`policyVersion`, `allowGenericFallback`, `limits`, `schemaOwnership`.

**Deliberately absent:** provider ids, model names, prices, endpoints. A consumer that learns the
topology starts depending on it.

`CapabilityAvailability` is `AVAILABLE | DEGRADED | UNAVAILABLE | DISABLED`. `DISABLED` ≠
`UNAVAILABLE`: "the school turned AI off" and "AI is broken" require different words to a child.

---

## 11. Providers — `provider.ts`

Descriptions and the adapter port. The **reference implementation** is
`@aibridge/provider-openai-compatible` (§16); no vendor SDK type appears anywhere.
`AiProviderAdapter` (`generateText`, `generateStructured`, optional `streamText`, optional
`bindCredentials`, optional `probe`/`shutdown`) is the port every adapter implements.
`ProviderRequest` is AI Bridge's own shape, not a vendor "chat completions" object; `modelRef` is
operator-side and never crosses back to a consumer. `ProviderRawError.rawMessage` is operator-only;
the runtime reads only `category` (plus the optional mapped `reason`) and normalizes through
`REASON_META`.

**Stage 3 additive port surface** (internal — `PROVIDER_ADAPTER_API_VERSION` is not a public
contract): `streamText?` (the provider-side stream), `bindCredentials?` (the one trusted door a
credential value may enter through), `ProviderRequest.cancellation?` (so an adapter can abort
outbound work) and `ProviderRawError.reason` / `retryAfterMs` (mapped facts, never prose).
`ProviderCallError` is how an adapter reports a mapped failure; its `message` is fixed and
sanitized because a thrown value may land in a stack trace.

Feature support is a property of the **model**, not the provider (`ModelDescriptor.features`).

---

## 12. Governance — `killswitch.ts`, `core/killswitch.ts`

Three switches: `global`, `providers.<id>`, `capabilities.<id>[@<major>]`. Resolution precedence is
`global → capability → provider`: the broadest operator intent names the error.

The three reasons are `KILL_SWITCH_GLOBAL | KILL_SWITCH_PROVIDER | KILL_SWITCH_CAPABILITY`, all
mapped to `MODEL_UNAVAILABLE` / `GOVERNANCE`. `KILL_SWITCH_PROVIDER` is reported
only when **no** candidate provider survives; otherwise the call proceeds on the survivors — a
provider switch is a routing restriction, not a capability outage.

A kill switch is **governance, never failure**: `AiCapabilityDirectory.getStatus()` reports it
before a call is made.

---

## 13. `@aibridge/core`

| Export | Role |
| --- | --- |
| `screenAiInput` | size cap → secret rejection (`SECRET_LIKE_INPUT`) → PII redaction (`INPUT_REDACTED`). Size first: a limit enforced after billing is not a limit. `SECRET_PATTERNS`, `PII_PATTERNS`, `findSecrets`, `findPii`, `firstSecretPath`. |
| `guardStructuredOutput` / `isStructurallySafe` | wraps the validator so a caller gets an `AiError`, and so a partially valid payload can never be mistaken for a usable one. |
| `CapabilityRegistry` | metadata registry (register/get/list). Byte-identical re-registration is idempotent; a different record for the same `id@major` is `CONFLICTING_REGISTRATION`. No `handler` — registration is not execution. |
| `authorizeCapabilityCall` / `TurnCallCounter` | `maxCallsPerTurn` enforcement. Breach is `POLICY / POLICY_VIOLATION` with `details.rule = 'maxCallsPerTurn'`. |
| `KillSwitchRegistry`, `killSwitchError`, `verdictError` | mutable governance holder around the pure resolver. |
| `ProviderRegistry`, `ModelRegistry` | operator-side descriptions, same conflict discipline. |
| `AiCapabilityDirectory` | `listCapabilities` / `getCapability` / `getStatus`, with governance applied. |
| `GENERIC_CAPABILITY_REGISTRATIONS`, `GENERIC_STRUCTURED_POLICY`, `GENERIC_TEXT_POLICY`, `CALLER_OWNED_OUTPUT_SCHEMA`, `allowsCallerOutputSchema` | the two V1 primitives as metadata. Both policies are **structural only** — no business rule. |
| `canonicalize`, `utf8ByteLength`, `jsonByteLength`, `isRecord`, `walkStrings`, `mapStrings` | dependency-free helpers. |

---

## 14. `@aibridge/host-sdk`

### 14.1 Ports — `ports.ts`

Split by whether the host can answer synchronously from bound state or must be asked:

- **sync:** `PluginIdentityPort`, `PermissionPort`, `SubjectTokenPort`, `KillSwitchAuthorityPort`, `Clock`
- **async:** `SecretStorePort`, `UsageStorePort`, `ConfigPort`

`PluginIdentityPort.currentCallerPluginId()` returning `null` is honest and must lead to
`CALLER_NOT_PERMITTED`; returning a caller-supplied value would launder a forged identity.
`UsageRecord` deliberately has **no** prompt/output/learner-text field.

### 14.2 Fakes — `fakes.ts`

`makeInMemoryHost()` plus deterministic implementations, and **mutant** hosts each wrong in exactly
one way (`MutantEmptyIdentity`, `MutantPermissivePermissions`, `MutantNonOpaqueSubjectTokens`,
`MutantLeakySecretStore`, `MutantDroppingUsageStore`, `MutantInvalidKillSwitchAuthority`,
`MutantBrokenClock`). `InMemorySecretStore` excludes its values from `JSON.stringify` and
`toString()`. A conformance suite that has never failed is decoration; the mutants exist so the kit
can be shown to *fail* on a bad host.

### 14.3 Scripted provider — `scripted-provider.ts`

`ScriptedProviderAdapter` with `textStep` / `structuredStep` / `rejectStep` / `hangStep` /
`streamStep` / `streamRejectStep`, so tests drive the pipeline deterministically without a
network — non-streaming and streaming alike. `bindCredentials` records the **handle** and drops the
value: this adapter physically cannot leak a secret it was given.

### 14.4 Conformance kits

`runHostConformance(host)` returns a `ConformanceReport` and **never throws**: identity,
deny-by-default permissions, opaque-or-null subject token, secret redaction (with an optional
synthetic secret), usage round-trip, usage-no-content, kill-switch validity, finite clock,
loadable config. `runProviderConformance(subject)` runs the adapter cases against a
`ConformanceTarget` — an adapter plus an `enqueue(behavior)` seam — so the same neutral behaviours
are injected through the scripted queue (`scriptedConformanceTarget`) or through a real adapter's
fake transport. Nine cases: the Stage 2 five plus `error.mapped-category`, `stream.round-trip`,
`stream.error-terminal` and `secret.no-escape` ([`TESTING.md`](TESTING.md) §1.1).

---

## 15. `@aibridge/runtime` (Stage 3)

The trusted execution layer — the one path every call takes:

```text
Consumer → Generic AI Contract → AiRuntime → Provider Adapter → Real Provider → normalized Generic Result
```

`AiRuntime` owns, in order: **contract validation** (`parseConsumerAiRequest` is the security
boundary; `composeAiRequest` joins the host-bound `TrustedDispatchContext`), **capability
validation** (registry lookup, `CAPABILITY_UNKNOWN` vs `CAPABILITY_VERSION_UNSUPPORTED`,
permission defence in depth, governance, policy selection, schema ownership, `inputAllowList`,
payload parsing), **provider resolution** (`resolveRoute`: profile route chain + per-model feature
and requirement checks — everything a provider cannot serve fails **locally**, before dispatch),
**trusted secret resolution** (`credentialRef` → the host's `SecretStorePort` → the adapter's
`bindCredentials`, at registration only), **execution** with the frozen three-deadline arithmetic
and terminal idempotent cancellation, **response normalization** (`AiResult` with the closed
projection) and **generic error propagation** (`normalizeProviderError` / `normalizeThrown` —
provider prose never crosses).

`stream()` is the same pipeline with incremental delivery (`AiStreamEvent`), offered for
`ai.text.generate` only. Other exports: `normalizeProviderError`, `normalizeThrown`,
`validationFailureToAiError`, `providerTimeoutError`, `budgetExhaustedError`,
`cancelledByCallerError`/`cancelledByHostError`, `classifyModel`, `resolveRoute`,
`unmetRequirements`, and the operator-only channel (`OperatorLogSink`, `RecordingOperatorLog`,
`redactOperatorDetail` — credential-stripped, PII-stripped, truncated at the sink).

`execute`/`stream` **never throw**: a `FAILED` result (or a `FAILED` stream terminal) is the only
failure channel.

**Stage 5 additions.** `ExecutionCoordinator` (§19's policy layer composed) turns one logical
request into its provider attempts (primary / retry / fallback / repair) and returns the terminal
result plus `ReliabilityProvenance` and `GovernanceSummary` — surfaced as
`AiRuntime.executeObserved`, while `AiRuntime.execute` keeps its Stage 3 signature and returns the
result alone; `AiRuntime.getProviderHealth()` reports health diagnostics. `config-manager.ts` adds
`RuntimeConfigSnapshot` + `ConfigManager` (validated-first atomic `reload`, `rollback`, one snapshot
bound per in-flight request), `output.ts` shares output shaping + bounded repair, `routes.ts` adds
`enumerateRouteCandidates`, and `fallback.ts` adds `validateFallbackChain` (cycle / duplicate-target
/ impossible-target rejection) beside `nextFallback` — which gained a small conformance fix: a
**configured** `RATE_LIMITED`/`QUOTA_EXCEEDED` chase is no longer vetoed by the retryable check,
since the frozen §7.2 table allows a configured chase.

## 16. `@aibridge/provider-openai-compatible` (Stage 3)

The **one** reference adapter — enough to prove the architecture, not a provider marketplace.

- `OpenAiCompatibleAdapter` implements `AiProviderAdapter` over `/chat/completions` (non-streaming
  JSON and SSE streaming). Everything vendor-shaped — payload, headers, base URL, `Authorization`,
  response shape, error body, `finish_reason` spellings, token field names, `[DONE]` framing —
  lives in this package (`adapter.ts`, `http.ts`).
- The transport seam (`FetchLike` and friends) is **self-declared**: no `Response`, `RequestInit`,
  `AbortSignal` or vendor type appears in the published `.d.ts`, enforced by the declaration-hygiene
  scan in `scripts/check-portability.mjs`.
- `classifyHttpFailure` maps a vendor error body to a closed `category` + generic `reason` (vendor
  *type* first, status second) with `rawMessage` kept operator-only;
  `mapFinishReason`/`mapUsage` map the response, never fabricating an absent fact.
- Credential custody: `bindCredentials` stores the value in a private field excluded from
  `JSON.stringify`/`toString()`; it appears only in the outbound `Authorization` header.

## 17. Fixtures — `Docs/fixtures/fixture-set.v1/`

Ten JSON documents, versioned `FIXTURE_SET_VERSION`. Six `FROZEN`, four `ILLUSTRATIVE`.
`tests/fixtures/fixtures.test.ts` runs each through the repo's own parser and asserts the declared
`expect` and `reason`:

- request fixtures parse with `parseAiRequestEnvelope`; on accept, core `screenAiInput` runs too, so
  the `secret-input` fixture is caught at the input-safety layer (`SECRET_LIKE_INPUT`);
- response fixtures parse with `parseAiResult`;
- exactly one fixture contains a credential-shaped value, and it is the allow-listed synthetic
  `…secret-input.json`.

A `reject` fixture asserts *which* `reason` is produced. A change to a `FROZEN` fixture is a
contract change and follows [`../AGENTS.md`](../AGENTS.md) §8.

---

## 18. Gates and verification

| Command | Enforces |
| --- | --- |
| `npm run typecheck` | strict build (`tsc -b`) + test typecheck (`tsconfig.test.json`) |
| `npm run lint` | ESLint (Stage 3 — the Stage 2 deferral is paid): residual bugs, never style churn |
| `npm run check:coupling` | no `@ojplatform/*`, `@algoquest/*` or cross-repo source import |
| `npm run check:secrets` | no credential pattern in any committed file (one named fixture allow-listed) |
| `npm run check:deps` | contracts has zero runtime deps; the package arrows are one-way |
| `npm run test` | the full suite, including fixtures, security boundaries and property invariants |
| `npm run check:portability` | build → `npm pack` → offline install into an isolated project → typecheck (no `node` types) → declaration-hygiene scan → runtime smoke (incl. one full runtime + adapter round trip) |
| `npm run verify` | all of the above, in order |
| `npm run test:live-provider` | **opt-in only** — one real round trip against a real provider, `SKIP` without credentials. Never part of `verify` and never in PR CI. |

CI (`.github/workflows/verify.yml`) runs `npm ci` then `npm run verify` on Linux and Windows against
the pinned Node version.

---

## 19. `@aibridge/governance` (Stage 5)

The host-neutral reliability and governance primitives the runtime composes. It depends only on
`@aibridge/contracts` (the frozen vocabulary) and `@aibridge/host-sdk` (the `Clock` port): no
provider, no host, no consumer. Every stateful piece is a port with an in-memory reference
implementation — deliberately **no OJPlatform DB adapter**.

| Export | Role |
| --- | --- |
| `fallback-policy.ts` — `decideFallback`, `resolveFallbackPolicy`, `fallbackOptionsOf`, `classifyFailure`, `breakerImpact` | reason-aware fallback policy over the closed code/reason/stage vocabulary (`FALLBACK_STOP_RULES`): a request/content failure never chases, provider throttling and provider-scoped quota chase only when configured, and the caller's own rate/quota/budget limits are never dodged. |
| `retry-policy.ts` — `decideRetry`, `classifyRetryPhase`, `backoffDelayMs`, `MAX_SAME_PROVIDER_RETRIES` | bounded retry in three outcome phases (`BEFORE_DISPATCH` / `KNOWN_NOT_ACCEPTED` / `UNKNOWN_OUTCOME_AFTER_DISPATCH`, derived from `ProviderRawError.dispatched`); hard cap **1** same-provider retry; deterministic backoff (a projected `Retry-After` wins) through the `Sleeper`/`Clock` seams. |
| `breaker.ts` — `CircuitBreaker`, `CircuitBreakerRegistry`, `resolveBreakerConfig` | `CLOSED → OPEN → HALF_OPEN` keyed `providerId` + `modelAlias`; only provider-transient failure counts, so one bad model never disables a provider's others. |
| `health.ts` — `RuntimeHealthRegistry`, `HEALTH_STATES` | `HEALTHY / DEGRADED / OPEN_CIRCUIT / DISABLED / UNKNOWN` composed from observed calls, the breaker and the operator switch. Health is not capability. |
| `idempotency.ts` — `IdempotencyRegistry`, `InMemoryIdempotencyStore`, `hashRequestFingerprint`, `idempotencyIdentityKey` | the frozen §10 semantics: replay with `IDEMPOTENT_REPLAY`, in-flight join, `IDEMPOTENCY_CONFLICT` on a different fingerprint (hashed before storage — a raw digest embeds the input); retention 15 min, capacity 10 000, LRU. |
| `rate-limit.ts` — `RateLimiter`, `InMemoryRateLimitStore`, `rateLimitReason` | sliding window over five dimensions (`subject · callerPlugin · capability · provider · global`), atomic `tryConsume`; `RATE_LIMITED` + `retryAfterMs` before dispatch — a refusal makes zero provider calls. |
| `quota.ts` — `QuotaManager`, `InMemoryQuotaStore`, `quotaReason`, `reservationAmount` | scopes × meters (`REQUESTS · TOKENS · ESTIMATED_COST`) × periods (`DAY · MONTH`); **reservations** before dispatch, settlement after; unknown usage settles at the conservative reservation, never zero. |
| `cost.ts` — `PricingTable`, `estimateCost`, `aggregateUsage`, `UNKNOWN_COST` | versioned pricing records validated strictly and **pinned at request start**; known usage × pinned price, provider-reported cost wins; unknown cost is unknown, never 0. |
| `budget.ts` — `BudgetTracker`, `checkRequestBudget` | per-request/day/month cost budget in the same `ESTIMATED_COST` buckets; refusal is `COST_BUDGET_EXHAUSTED` with zero dispatch (never `BUDGET_EXHAUSTED` — that one is the time budget). |
| `usage-ledger.ts` — `UsageLedgerPort`, `InMemoryUsageLedger` | append-only, two record shapes: `LogicalRequestUsageRecord` and `ProviderAttemptUsageRecord`. No prompt, no response, no credential, no reasoning content. |
| `observability.ts` — `MetricsSink`, `OperationalEventSink`, `InMemoryMetrics`, `RecordingOperationalEvents` | safe metrics over a closed low-cardinality label set and eleven metadata-only operational events. No request ids, no subjects, no content. |
| `provenance.ts` — `ReliabilityProvenance`, `ProviderAttemptProvenance`, `GovernanceSummary`, `summarize`, `mergeCosts` | the per-attempt audit trail (operator-side) beside the result: what was tried, skipped and charged, and the governance totals for one logical request. |
| `terminal.ts` — `selectTerminalError` | deterministic terminal error selection when every candidate failed — one stable error, not the loudest. |
| `subject.ts` — `hashSubjectToken`, `safeSubjectRef` | subject hashing: a subject token appears in no store, only its hash. |

State seams: `IdempotencyStorePort`, `RateLimitStorePort`, `QuotaStorePort`, `UsageLedgerPort` (and
`ConfigSnapshotStorePort`, which lives beside `ConfigManager` in `@aibridge/runtime`) — each with an
in-memory reference implementation. A durable, host-backed implementation is integration-stage work.
