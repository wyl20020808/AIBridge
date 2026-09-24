# Stage 7 Specialized Capability Foundation and Consumer-Managed Prompt Compatibility

**Status:** Approved design; implementation in progress.

## Purpose

Establish a host-neutral foundation for specialized capabilities and make consumer-composed instructions/provenance enforceable without moving business prompts, teaching behavior, host data access, or final interpretation into AI Bridge. The only executable specialized V1 candidate is `code.debug.analyze@1.0`, dispatched through the existing runtime and execution coordinator.

This is the user-commissioned “Stage 7” scope. The existing roadmap uses Stage 7 for legacy usage/cost durability and Stage 8 for capability packs. Preserve that historical sequence; record this commissioned scope explicitly instead of silently renumbering the older roadmap or claiming its legacy Stage 7 work is complete.

## Constraints and ownership

- Do not edit `D:\OJPlatform` or `D:\OJPlatformPlugins\AlgoQuest`, import either repository, add a provider, add UI, change deployment/installer files, or run real AlgoQuest AI E2E.
- Extend the existing metadata `CapabilityRegistry`, `AiRuntime`, and `ExecutionCoordinator`. Do not create another registry, a dynamic handler/plugin mechanism, or a capability-pack package.
- AI Bridge owns capability IDs/versions, closed schemas, structural policies, allow-lists, trust enforcement, execution/reliability/governance, and bounded provenance transport. The consumer owns composed business instructions, prompt artifacts, teaching/debug strategy, host-data selection, and the final learner-facing guard/interpretation.
- Never fetch hidden tests, reference solutions, judge-private metadata, or learner history. Callers must exclude private values; the bridge cannot infer whether caller-labeled input is public.
- Do not record or return prompt/input contents, provider raw errors, secrets, or opaque idempotency keys. Do not put high-cardinality provenance values into metrics.
- No production deployment/runtime-host changes. Package runtime behavior changes only when a consumer opts into the new specialized capability.

## Contract and descriptor design

1. Add optional, closed descriptor fields `readiness: STABLE | EXPERIMENTAL | RESERVED` and `instructionMode: CONSUMER_COMPOSED`. Preserve runtime `status` as deployment availability; do not conflate it with maturity.
2. Generic registrations default to `STABLE` and `CONSUMER_COMPOSED` so discovery remains compatible. The debug registration explicitly declares `STABLE` and `CONSUMER_COMPOSED`; only the code-debug ID/version is executable among specialized registrations. Reserved/experimental registrations are never made executable by their descriptor alone.
3. Enforce the global provenance pair invariant without normalization: `promptApplied=true` requires a valid `promptVersion`; a present `promptVersion` requires `promptApplied=true`; `promptApplied=false` cannot carry a version. The opaque version uses the existing bounded ASCII pattern and has no business meaning to the bridge.
4. Require `promptApplied=true` and `promptVersion` on `code.debug.analyze@1.0`. Keep prompt labels out of `consumerRequestDigest`: the prompt-composed instructions are already request input, and Stage 6 defines labels as not request identity.
5. Permit bounded printable ASCII idempotency keys, including colon-delimited consumer keys, while rejecting whitespace, control characters, and values over 128 characters. Encode identity tuples injectively with length-prefixed exact components; do not sanitize or weak-hash identity components.
6. Bump request/envelope and overall contract minor versions from 1.1 to 1.2, descriptor version from 1.0 to 1.1. Leave response/error versions and `aibridge.fields/v1` major unchanged. Add a frozen-contract compatibility note and AIBridge-owned fixtures; existing frozen fixture meaning and outcomes remain unchanged.

## Specialized input and trust boundary

The logical request carries the same two structural channels as the generic structured primitive:

```ts
type CodeDebugInput = {
  instructions: string; // consumer-composed, trusted instruction channel
  context: readonly ContextValue[]; // code/diagnostics are data, not instructions
};
```

Require exactly one `sourceCode` string context, permit at most one optional `diagnostics` string context, and reject all other names/types. Require each context entry to have `untrusted: true`; reject `false` rather than relabeling. Continue normal size/secret/PII screening and bounded character limits. Do not flatten context data into `instructions`.

The debug descriptor owns both schemas. A consumer-supplied `outputSchema` is rejected. The runtime validates the logical capability and permission first, but resolves provider routes and dispatch against its declared primitive, `ai.structured.generate`; logical identity remains `code.debug.analyze@1.0` in permissions, reliability, usage, responses, kill switches, and logs that identify the capability.

## Output contract and validation

Use only flat `aibridge.fields/v1` arrays/scalars; the current dialect has no enums or integer field type and shallowly validates objects. Avoid arbitrary prose, nested output objects, code blocks, or confidence scores.

The registry-owned output schema contains:

- required `issueCategories: STRING_ARRAY`, whose values are mechanically restricted to `SYNTAX`, `TYPE`, `BUILD`, `RUNTIME`, `LOGIC`, or `OTHER`;
- required `diagnosticContextRefs: STRING_ARRAY`, one reference per issue category, in the form `<contextName>:<startLine>` or `<contextName>:<startLine>-<endLine>`; context name is exactly `sourceCode` or `diagnostics`, line numbers are 1-based, ranges ordered, and references must fit within the supplied context;
- required `limitations: STRING_ARRAY`, restricted to `INSUFFICIENT_CONTEXT`, `AMBIGUOUS_EVIDENCE`, or `NO_RELEVANT_LOCATION`.

The two per-finding arrays must have equal lengths. Empty arrays are valid. A static, capability-specific validator runs after generic structured schema validation on both initial and repaired provider output. It returns only closed issue codes/paths and never includes candidate text. The output carries no solution, arbitrary explanation, teaching progression, learner score/mastery, final learner-facing response, hidden-test/reference-solution data, chain-of-thought, or scratchpad. Consumers decide what findings mean and apply their own deterministic final guard.

## Runtime and provenance flow

- Parse/validate the specialized input before routing; authorize capability permission and registration as today; reject non-STABLE readiness and unsupported specialized IDs.
- Route and call the provider using the registered primitive (`ai.structured.generate`) and the registry-owned schema while preserving logical capability identity in the result and governance path.
- Reuse coordinator retry/fallback/repair/cancellation/quota/usage behavior. Custom output validation participates in the normal structured shaping/repair path.
- Keep `promptApplied`/`promptVersion` on the logical reliability/usage record, not per-attempt metrics, provider metadata, events, or logs. Attempts continue to link through logical request ID.
- Because prompt labels are deliberately excluded from the request digest, store only the winning execution’s opaque prompt label pair in each idempotency record. Return that original pair for REPLAY/JOIN so the logical usage/reliability record identifies the execution actually reused. Cache no input or prompt content.
- Conflict errors omit the raw idempotency key.

## Compatibility and exit qualification

- Add AIBridge-owned fixtures for valid specialized requests/results, provenance-pair failures, trust-channel rejection, registry-owned schema/unknown output rejection, and compatibility mapping. Do not modify the AlgoQuest fixture set or share source code.
- Existing AlgoQuest `debug.analyze` remains consumer-managed and reserved. Its SYSTEM/USER prompt and binding values can be structurally mapped to `instructions` and typed context, but no real AlgoQuest task becomes executable in this stage.
- Current OJPlatform integration omits prompt provenance and grants only generic capability IDs. Therefore no claim of real OJPlatform specialized dispatch or OJ/AlgoQuest AI E2E. Record the minimal separate host adapter/provenance/grant work needed, without changing the host.
- Stage report status is `PARTIAL` if AIBridge checks pass but the external OJ host adapter/grants or prohibited real consumer E2E prevent the user’s hard-exit gate. Do not mark this requested Stage 7 PASS on AIBridge-local tests alone.

## Verification criteria

- Contract parser/descriptor tests reject malformed provenance pairs, controls/whitespace/unbounded idempotency, unknown readiness/mode values, and unsupported majors; accept colon keys and valid additive descriptors.
- Idempotency tests prove tuple identity is injective for delimiter/bracket-containing components, replay/join reuse the original opaque labels, and conflict results do not return keys.
- Runtime tests prove specialized input trust/name/type rules, prompt/schema ownership requirements, primitive routing with logical capability identity, bounded output/custom validation on initial and repair paths, and safe errors/provenance across fallback/retry/replay/cancel/usage.
- Security tests mechanically assert no prompt/input/secret/candidate prose or raw provider errors leak to error details, logs/events/provider metadata/metrics.
- Frozen fixture tests and all existing suites continue to pass. `npm run verify` must pass, including coupling/secrets/dependency gates, build, and offline portability. AIBridge worktree ends clean with a `Docs/reports/` closeout report.
- No changes to deployment files, provider packages, host repositories, or UI; production runtime/deployment effect is none.
