# AI Bridge — Capability Model

Two layers:

```
Layer 2   Specialized Capability Packs     education.idea.evaluate
                                          education.hint.generate
                                          code.debug.analyze …
                    │  each requires exactly one generic primitive
                    ▼
Layer 1   Generic Primitives               ai.structured.generate   ← V1 core
                                          ai.text.generate
```

The layer split exists so that "general" does not mean "a complete AI platform" and
"specialized" does not mean "one customer's business logic compiled into a bridge".

> **Stage 2 status.** `CapabilityRegistry` and `AiCapabilityDirectory` are implemented in
> `@aibridge/core` as a **metadata** registry: they own a capability's schemas, policy, limits and
> `schemaOwnership`, not its execution. There is no `handler` in `CapabilityRegistration` yet —
> handlers arrive with the capability packs in Stage 8. Registration is idempotent for a
> byte-identical record and `CONFLICTING_REGISTRATION` otherwise. The two V1 generic primitives are
> registered as metadata (`GENERIC_CAPABILITY_REGISTRATIONS`); neither policy carries a business
> rule. See [`CONTRACTS.md`](CONTRACTS.md) §10–13.

---

## 1. Layer 1 — Generic primitives

### 1.1 V1 scope

Exactly **two** primitives ship in V1. Everything else is evaluated and deliberately deferred.

| Capability | V1 | What it is |
| --- | --- | --- |
| `ai.structured.generate` | **YES — the core** | Generate text that conforms to a declared shape, runtime-validated. |
| `ai.text.generate` | **YES** | Generate free text for a task. No schema. |

#### `ai.structured.generate` (V1)

| | |
| --- | --- |
| `capability` | `ai.structured.generate` |
| `capabilityVersion` | `1.0` |
| `kind` | `GENERIC` |
| `required primitive` | — *is* a primitive |
| `input` | `{ instructions, context: ContextBundle, outputSchema, profile, requirements? }` |
| `output` | runtime-validated object conforming to `outputSchema` |
| `policy` | `ai-structured-default` (structural safety only; no business rules) |
| limits | `maxInputBytes` 32 768 · `maxOutputBytes` 65 536 · `totalTimeoutMs` 20 000 |

**Why this one gets the attention.** It is what AlgoQuest's Idea Lab, code analysis, problem
generation and learning reports will all reuse. It is the only primitive where "the model said
so" is not good enough, so it is the only primitive with an extraction + validation + repair
pipeline ([`ARCHITECTURE.md`](ARCHITECTURE.md) §11).

#### `ai.text.generate` (V1)

| | |
| --- | --- |
| `capability` | `ai.text.generate` |
| `capabilityVersion` | `1.0` |
| `input` | `{ instructions, context: ContextBundle, profile, requirements?, maxOutputTokens? }` |
| `output` | `{ text, finishReason }` |
| `policy` | `ai-text-default` |
| limits | `maxInputBytes` 32 768 · `maxOutputBytes` 32 768 |

Structural safety only: size caps, secret/PII input screening, non-penetration of provider
errors. **No claim of textual correctness or safety-of-content** — that belongs to the
capability policy or the consumer's guard ([`ARCHITECTURE.md`](ARCHITECTURE.md) §11 note,
[`SECURITY.md`](SECURITY.md) §7).

### 1.2 Evaluated and deferred out of V1

| Capability | Verdict | Why not V1 |
| --- | --- | --- |
| `ai.chat.generate` | deferred V1.1 | Multi-turn state is a session concern. Single-turn covers every current consumer. Adding it now would freeze a turn/history model nobody has validated. |
| `ai.chat.stream` | deferred V1.1 | See §4. Streaming is a delivery concern, not a capability. |
| `ai.embedding.generate` | deferred | No consumer. It would add a vector-store-shaped contract for nothing. |
| `ai.vision.analyze` | deferred | Adds an input modality, a whole new input-safety surface and a `vision` profile. |
| `ai.image.generate` | **rejected for now** | Different failure modes, different safety surface, different billing. Not an AI capability any current consumer needs. |
| `ai.audio.*` | **rejected for now** | Same as image, plus realtime concerns. |

> **Do not make V1 a complete AI platform in the name of generality.** Generality here means
> "one shape that many providers and many consumers can share", not "every modality".

---

## 2. Layer 2 — Specialized capability packs

### 2.1 The relationship

A specialized capability is **not** a second transport and **not** a business function. It is a
*contract + policy + prompt strategy* layered over exactly one generic primitive.

```
Specialized capability =
      versioned input schema
    + versioned output schema
    + policy                    (incl. business safety rules)
    + prompt strategy           (owned here, versioned here)
    + required generic primitive
```

Example:

```
education.idea.evaluate  @1.0
    requires: ai.structured.generate
    inputSchema:   education.idea.evaluate.input@1.0
    outputSchema:  education.idea.evaluate.output@1.0
    policy:        education-idea-evaluate-v1
    promptStrategy: education-idea-evaluate/v1
```

The primitive does the transport, extraction and structural validation. The pack does the
*meaning*: what counts as progress, what must never be revealed, which rubric vocabulary the
answer uses.

### 2.2 Naming rule — domain-namespaced, never product-namespaced

**Forbidden:** `algoquest.idea.evaluate`, `ojplatform.code.explain`.
**Required:** `education.idea.evaluate`, `code.explain`.

Rationale: the day a second teaching product wants "evaluate a learner's idea against a rubric",
it should call the same capability. A capability named after one product cannot be reused
without a lie baked into its identifier.

A product-specific *policy* is fine and expected:
`education.idea.evaluate` may have policies `algoquest-tutor-v1` and `other-school-v1` side by
side, selected by `policyId`. The **capability** is shared; the **policy** is where a product's
voice and safety rules live.

### 2.3 Consumer selection rules

A consumer chooses deliberately:

| Need | Call |
| --- | --- |
| arbitrary text, no shape | `ai.text.generate` |
| my own private shape, my own rules | `ai.structured.generate` |
| a **shared**, reusable, policy-governed judgement | a specialized capability |

And a consumer may **not** reimplement a specialized capability on top of
`ai.structured.generate` to dodge the capability's policy. Where a policy exists, it applies.
See [`INTEGRATION_CONTRACT_V1.md`](INTEGRATION_CONTRACT_V1.md) §9 for the fallback rule.

---

## 3. Decision table — generic vs specialized

| Question | Answer |
| --- | --- |
| "Generate any summary of this text." | **`ai.text.generate`** — arbitrary output, no shared shape, no policy claim. |
| "Give me JSON with these three fields for my own internal bookkeeping." | **`ai.structured.generate`** — private shape, structural safety only. |
| "Assess a student's algorithm idea against an education rubric and ask one next question." | **`education.idea.evaluate`** — shared, reusable, policy-governed judgement. |
| "Analyse compile errors and return a strict debug schema." | **`code.debug.analyze`** — shared shape + a policy about never handing over the full fix. |
| "Explain this code to a learner." | **`code.explain`** — shared + policy ("explain, don't solve"). |
| "Draft a quest for a problem." | **`problem.quest.draft`** — future, authoring-facing. |
| "Write a paragraph of encouragement." | **`ai.text.generate`** — the consumer owns its own voice. |
| "Score this learner." | **neither** — not an AI capability at all. Scoring is consumer/host business. |
| "Look up this learner's history so the AI can personalise." | **neither** — AI Bridge never reads host data ([`SECURITY.md`](SECURITY.md) §3.3). |

### 3.1 The three-question test

Ask, in order:

1. **Is the output shape shared across more than one product?** No ⇒ generic.
2. **Does answering correctly require a policy about what must not be revealed?** No ⇒ generic.
3. **Would a second teaching product want the identical judgement vocabulary?** Yes ⇒
   specialized, and name it by domain.

If question 2 is yes and question 3 is no, the policy belongs to the **consumer's guard**, not to
AI Bridge.

---

## 4. Streaming — evaluated, out of V1

**Decision: `ai.structured.generate` is non-streaming in V1. Text/chat streaming is V1.1.**

Rationale: AlgoQuest's Idea evaluation needs a *complete structured result* — a classification, a
confidence, a concept list, exactly one next question. A token stream of a partial judgement is
not merely less useful, it is dangerous: a learner could read "your idea is off track" before the
sentence that qualifies it arrives.

Streaming also multiplies the contract: partial JSON, incremental validation, backpressure,
cancellation mid-token. Nothing in V1 needs it.

---

## 5. `CapabilityRegistry`

### 5.1 Registration record

```ts
export type CapabilityRegistration = {
  readonly id: string;                  // 'education.idea.evaluate'
  readonly version: string;             // '1.0' — major-compatible
  readonly kind: 'GENERIC' | 'SPECIALIZED';

  readonly inputSchema: OutputSchema;   // same REF/INLINE shape as the response schema
  readonly outputSchema: OutputSchema;

  /** Exactly one generic primitive for V1. */
  readonly requiredPrimitive: 'ai.text.generate' | 'ai.structured.generate';

  readonly policy: CapabilityPolicy;    // id + version + rules. See §5.2.
  readonly handler: CapabilityHandler;  // pure: (input, ctx) => output | AiError

  readonly profiles: readonly ModelProfile[];
  readonly limits: CapabilityLimits;
  readonly allowGenericFallback: boolean;   // §6.3
  readonly retention: 'NONE' | 'METADATA_ONLY' | 'CONTENT';

  /** Who authors each schema. Only a generic structured capability lets the caller supply output. */
  readonly schemaOwnership: SchemaOwnership;
};

export type SchemaOwnership = {
  readonly input: 'REGISTRY' | 'CALLER';
  readonly output: 'REGISTRY' | 'CALLER';
  readonly policy: 'REGISTRY';
};
```

### 5.2 `CapabilityPolicy`

```ts
export type CapabilityPolicy = {
  readonly id: string;               // 'education-idea-evaluate-v1'
  readonly version: string;
  readonly inputAllowList: readonly string[];  // deny-by-default input keys
  readonly outputRules: readonly string[];     // named, machine-checkable rules
  readonly forbiddenOutput: readonly string[]; // e.g. 'FULL_SOLUTION'
  readonly maxOutputBytes: number;
};
```

`forbiddenOutput` is where business safety lives at the capability layer: "never give a child the
complete answer" is a rule of `education.idea.evaluate`, **not** of `ai.structured.generate`.
The generic layer must not grow business rules; that is how a generic bridge becomes a
product-specific mess.

### 5.3 `CapabilityHandler`

```ts
export type CapabilityHandler = (
  input: unknown,
  ctx: CapabilityContext,     // prompt strategy access, policy, deadline, cancellation
) => Promise<HandlerOutcome>;

export type HandlerOutcome =
  | { readonly ok: true; readonly output: unknown }
  | { readonly ok: false; readonly error: AiError };
```

A handler calls **only** its `requiredPrimitive`. Calling another specialized capability is
forbidden (no capability chains), which keeps latency, budget and failure semantics
comprehensible.

### 5.4 `CapabilityLimits`

```ts
export type CapabilityLimits = {
  readonly maxInputBytes: number;
  readonly maxOutputBytes: number;
  readonly totalTimeoutMs: number;
  readonly maxCallsPerTurn: number;   // 1 for every V1 capability
};
```

`maxCallsPerTurn: 1` is a governance control as much as a cost one: a capability that quietly
makes four model calls is un-auditable.

---

## 6. Capability discovery

### 6.1 API

```ts
export interface AiCapabilityDirectory {
  listCapabilities(): Promise<readonly CapabilityDescriptor[]>;
  getCapability(id: string, version?: string): Promise<CapabilityDescriptor | null>;
  getStatus(): Promise<AiBridgeStatus>;
}
```

Hosts with a capability registry expose these through it. Hosts without one expose them as a
plain service on the same transport as the calls — see
[`INTEGRATION_CONTRACT_V1.md`](INTEGRATION_CONTRACT_V1.md) §6.

### 6.2 `CapabilityDescriptor` — what a consumer may learn

```ts
export type CapabilityDescriptor = {
  readonly id: string;
  readonly version: string;
  readonly kind: 'GENERIC' | 'SPECIALIZED';
  readonly status: CapabilityAvailability;    // 'AVAILABLE'|'DEGRADED'|'UNAVAILABLE'|'DISABLED'
  readonly requiredPrimitive: string;
  readonly profiles: readonly ModelProfile[];
  readonly requirements: CapabilityRequirements;
  readonly inputSchema: OutputSchema;
  readonly outputSchema: OutputSchema;
  readonly policyId: string;
  readonly policyVersion: string;
  readonly allowGenericFallback: boolean;
  readonly limits: CapabilityLimits;
  readonly schemaOwnership: SchemaOwnership;
};
```

**Deliberately absent from the descriptor:** provider ids, model names, prices, endpoints, keys.
A consumer that learns the topology starts depending on it.

### 6.3 `AiBridgeStatus`

```ts
export type AiBridgeStatus = {
  readonly contractVersion: string;
  readonly global: CapabilityAvailability;
  readonly killSwitch: { global: boolean; providers: readonly string[]; capabilities: readonly string[] };
  readonly capabilities: readonly { id: string; version: string; status: CapabilityAvailability }[];
};
```

`getStatus()` is how a consumer distinguishes **"the school turned AI off"** from
**"AI is broken"**. Those demand different words to a child, so the difference must be visible
before the call is made.

---

## 7. Capability packs

All designed here. **None implemented in this stage.**

### 7.1 Education pack

| Capability | Requires | Input (shape) | Output (shape) | Policy owns |
| --- | --- | --- | --- | --- |
| `education.idea.evaluate@1.0` | `ai.structured.generate` | learner's idea text (untrusted), own-words explanation (untrusted), problem excerpt, declared concepts, hint level | classification · confidence · conceptIds · issues[] · exactly one nextQuestion · hintLevel · declaresSolution | never reveal the full solution; at most one question per turn; misconception vocabulary is a closed set |
| `education.hint.generate@1.0` | `ai.structured.generate` | learner's current text (untrusted), hint level 1..3, previous hints | text · hintLevel · declaresSolution | hints are graded; a hint that declares a solution is withheld |
| `learning.summary.generate@1.0` | `ai.structured.generate` | node outcomes, declared concepts, effort signals (durations only) | strengths · gaps · nextSteps · narrative · declaresSolution | descriptive, never a score or grade; no ranking against other learners |

`education.idea.evaluate` is the priority capability of the whole V1 programme.

**Domain-neutral vocabulary rule.** The classification set is education-domain vocabulary
(`OFF_TRACK | PARTIAL | PROMISING | CORRECT | COMPLETE` is a *candidate* set under discussion,
not frozen here) — never AlgoQuest's internal quest vocabulary, never a score or a percentage.

**`COMPLETE` must not be the model's free choice.** Where a capability requires a conjunction of
facts to claim "complete", the *consumer's deterministic guard* decides it; the model only
proposes. AI Bridge's policy records `declaresSolution` as a self-report and **screens it, never
trusts it**.

### 7.2 Code pack

| Capability | Requires | Input | Output | Policy owns |
| --- | --- | --- | --- | --- |
| `code.debug.analyze@1.0` | `ai.structured.generate` | learner's source (untrusted), language, public verdict, public failing-sample ordinals, public compile diagnostics | hypotheses[] · nextQuestion · declaresSolution | never hand over the corrected program; hypotheses are ranked questions, not patches |
| `code.explain@1.0` | `ai.structured.generate` | source (untrusted), language, level | explanation sections · declaresSolution | explain, do not solve |

**Context rule for the code pack:** input must **not** contain hidden testcases, judge secret
data, reference answers, or checker internals. The capability's `inputAllowList` makes this
mechanical, and [`SECURITY.md`](SECURITY.md) §3.3 forbids AI Bridge from fetching them.

### 7.3 Problem pack (future)

| Capability | Status | Note |
| --- | --- | --- |
| `problem.explain@1.0` | future | Explain a published problem statement to a learner. |
| `problem.quest.draft@1.0` | future — **explicitly not a Stage 1 goal** | Authoring-side content production for quest authors. A different audience (authors, not learners) and a different safety profile; it must not be confused with the learner-facing packs. |

### 7.4 Learning pack

`learning.summary.generate` sits in the education pack (§7.1) because its consumers, its safety
rules and its vocabulary are education-shaped. A separate `learning.*` namespace is reserved for
future cross-domain learning analytics; nothing is registered there in V1.

---

## 8. Versioning of capabilities

- `capabilityVersion` is per capability, `MAJOR.MINOR`, major-compatible.
- `inputSchema` and `outputSchema` carry their own `schemaId` + `version`.
- `policyId` + `policyVersion` are recorded on every call but are **not** contract versions.

Adding an optional output field is a **minor**. Renaming a field, removing one, or changing a
field's type is a **major**, and the old major keeps serving until it is explicitly retired.

A specialized capability may be served at two majors simultaneously during a migration window.
Consumers pin the major they were built against.

---

## 9. Future capability lifecycle

`register` is not a public V1 API. Capabilities ship **compiled in** (`@aibridge/capabilities`),
because a runtime-registration surface is a remote-code-execution surface until there is a real
plugin authority behind it. Revisit when the host has one.
