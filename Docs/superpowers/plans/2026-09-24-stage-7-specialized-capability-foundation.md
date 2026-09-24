# Stage 7 Specialized Capability Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Execute inline in this worktree; do not delegate tasks to subagents.

**Goal:** Ship a host-neutral, registry-declared `code.debug.analyze@1.0` specialized capability with enforced consumer-composed instruction provenance, untrusted code/diagnostic input, bounded diagnostic output, and continuous governance/idempotency behavior.

**Architecture:** Extend the current metadata registry, runtime, and coordinator. Route specialized debug requests over `ai.structured.generate` while keeping logical capability identity specialized; run static capability-specific validation within the coordinator’s standard structured-output and repair path. Add no provider, host adapter, second registry, plugin handler system, or UI.

**Tech Stack:** TypeScript ESM workspaces, Vitest, strict TypeScript, current `aibridge.fields/v1` schema dialect, JSON fixtures, repository verification gates.

**Spec:** `Docs/superpowers/specs/2026-09-24-stage-7-specialized-capability-foundation-design.md`

## Global Constraints

- No `@aibridge/*` import of `@ojplatform/*`, `@algoquest/*`, or either repository’s source tree.
- Do not modify OJPlatform or AlgoQuest; they meet only through AIBridge-owned docs and JSON fixtures.
- Never persist, return, or log prompt/input contents, provider raw errors, secrets, or raw idempotency keys.
- Reject unsupported majors; preserve existing frozen fixture meanings; request/contract 1.2 and descriptor 1.1 are additive minor changes; field dialect remains `aibridge.fields/v1` major 1.
- Only `code.debug.analyze@1.0` is an executable specialized capability; its schemas are registry-owned and it requires `CONSUMER_COMPOSED` instructions with prompt provenance.
- `promptApplied=true` iff a valid `promptVersion` is present; request digest continues to exclude these labels.
- Code/diagnostics stay separate from trusted instructions and must be `untrusted:true`; do not silently relabel.
- Output is flat, bounded, closed, diagnostic-only, and mechanically validated; consumer final guard remains mandatory.
- No hidden tests, reference solutions, judge-private metadata, or learner history; caller-side private-input exclusion cannot be inferred by AI Bridge.
- No UI, providers, deploy/compose/installer files, production host runtime, remote push, or real AlgoQuest AI E2E.
- Final status cannot be PASS while external OJ adapter/provenance/grants block qualification; report exact gaps and production runtime effect.

## Review Focus

- Same request fingerprint with a changed prompt label must reuse the first execution’s provenance — test in Task 2.
- `context.untrusted=false`, duplicate/unknown context names, and invalid types must reject before dispatch — test in Task 3.
- Unknown output categories and context line references outside caller-provided data must reject on initial and repaired results without candidate text in errors — test in Task 4.
- Provider routing uses `ai.structured.generate` while permission, kill-switch, provenance, usage, and result retain `code.debug.analyze@1.0` — test in Task 4.
- Bracket/delimiter-bearing identity components remain injective and colon idempotency keys remain distinct — test in Task 2.

---

### Task 1: Additive request and descriptor contracts

**Files:**
- Modify: `packages/contracts/src/versions.ts`
- Modify: `packages/contracts/src/request.ts`
- Modify: `packages/contracts/src/capability.ts`
- Modify: `packages/core/src/registry.ts`
- Test: `tests/contracts/request.test.ts`
- Test: `tests/contracts/versions.test.ts`
- Test: `tests/core/registry.test.ts`
- Commit: `feat(contracts): declare specialized readiness and prompt modes`

**Interfaces:**
- Produces `CapabilityReadiness = 'STABLE' | 'EXPERIMENTAL' | 'RESERVED'` and `CapabilityInstructionMode = 'CONSUMER_COMPOSED'`.
- `CapabilityDescriptor` gains optional additive `readiness` and `instructionMode` fields; registry output defaults omitted registration metadata to `STABLE` and `CONSUMER_COMPOSED`.
- Request parsing enforces the prompt pair invariant and colon-compatible bounded idempotency keys. `consumerRequestDigest()` continues to exclude prompt labels.

- [ ] **Step 1: Write request regression tests.** Extend the existing Stage 6 provenance test in `tests/contracts/request.test.ts`:

```ts
for (const invalid of [
  { promptApplied: true },
  { promptVersion: 'prompt.v1' },
  { promptApplied: false, promptVersion: 'prompt.v1' },
]) {
  expect(parseConsumerAiRequest({ ...validRequest(), ...invalid }).ok).toBe(false);
}
expect(parseConsumerAiRequest({ ...validRequest(), idempotencyKey: 'task-7:command-8' }).ok).toBe(true);
expect(parseConsumerAiRequest({ ...validRequest(), idempotencyKey: 'task 7:command-8' }).ok).toBe(false);
```

- [ ] **Step 2: Run `npm test -- tests/contracts/request.test.ts`; expect the new pair and colon-key assertions to fail against current parser behavior.**
- [ ] **Step 3: Write descriptor compatibility tests.** Assert registered generic descriptors expose stable/consumer-composed defaults; assert valid explicit readiness/mode survive conversion; strict descriptor parsing rejects unknown enum values.
- [ ] **Step 4: Run `npm test -- tests/core/registry.test.ts`; expect the new metadata/default assertions to fail.**
- [ ] **Step 5: Implement the contract changes.** Keep the request-id regex separate. Change overall/request version to `1.2`, descriptor version to `1.1`, and leave response/error/schema dialect versions unchanged. Enforce the pair without normalization:

```ts
const provenanceValid =
  (promptApplied === undefined && promptVersion === undefined) ||
  (promptApplied === true && promptVersion !== undefined) ||
  (promptApplied === false && promptVersion === undefined);
```

Permit only printable non-space ASCII for idempotency keys, length 1–128. Add strict descriptor key/type parsing and registry defaults; do not weaken unknown-key or major-version rejection.
- [ ] **Step 6: Run `npm test -- tests/contracts/request.test.ts tests/contracts/versions.test.ts tests/core/registry.test.ts`; expect all tests to pass.**
- [ ] **Step 7: Commit Task 1.**

### Task 2: Injective identities and replay provenance

**Files:**
- Modify: `packages/governance/src/idempotency.ts`
- Modify: `packages/governance/src/provenance.ts`
- Modify: `packages/runtime/src/coordinator.ts`
- Test: `tests/governance/idempotency-rate-quota.test.ts`
- Test: `tests/runtime/idempotency-governance.test.ts`
- Test: `tests/security/governance-privacy.test.ts`
- Commit: `fix(governance): preserve opaque provenance across idempotent replay`

**Interfaces:**
- `IdempotencyRegistry.gate(identity, fingerprint, logicalRequestId, promptProvenance?)` persists only the prompt label pair and returns the winner’s pair on REPLAY/JOIN.
- `ReliabilityProvenance` gains optional logical-request prompt labels; attempt records and metrics remain unchanged.
- Identity keys use exact bounded tuple components encoded with component lengths. No lossy substitutions or weak hash.

- [ ] **Step 1: Write injectivity tests** in `tests/governance/idempotency-rate-quota.test.ts`:

```ts
const left = { ...identity, callerPluginId: 'a|b', capability: 'c' };
const right = { ...identity, callerPluginId: 'a', capability: 'b|c' };
expect(idempotencyIdentityKey(left)).not.toBe(idempotencyIdentityKey(right));
expect(idempotencyIdentityKey({ ...identity, idempotencyKey: '[x]' }))
  .not.toBe(idempotencyIdentityKey({ ...identity, idempotencyKey: '·x·' }));
```

- [ ] **Step 2: Run `npm test -- tests/governance/idempotency-rate-quota.test.ts`; expect a collision in the current sanitizer/join implementation.**
- [ ] **Step 3: Replace `idempotencyIdentityKey()` with length-prefixed exact components.** For the four identity parts, encode each as `<UTF-16-length>:<exact-value>` and concatenate; all validated identity parts are bounded ASCII, so parsing is unambiguous and distinct tuples cannot collide.
- [ ] **Step 4: Add registry tests for label persistence.** First gate carries `{ promptApplied: true, promptVersion: 'prompt.v1' }`; REPLAY with a later label returns the stored `prompt.v1`; JOIN returns the in-flight winner’s label pair.
- [ ] **Step 5: Run `npm test -- tests/governance/idempotency-rate-quota.test.ts`; expect identity and registry provenance tests to pass.**
- [ ] **Step 6: Add runtime tests:** with identical body/idempotency key but different prompt labels, the replay and join logical provenance/usage report the original execution’s labels. Assert the conflict result omits the opaque key.
- [ ] **Step 7: Add privacy assertions:** logical provenance may contain opaque labels; events, errors, provider metadata, per-attempt usage, and metrics do not contain them or the idempotency key.
- [ ] **Step 8: Implement label propagation through the gate and `ExecutionCoordinator.finish()`.** Do not change the request digest or cache input/prompt text; remove raw `idempotencyKey` from conflict error details.
- [ ] **Step 9: Run `npm test -- tests/governance/idempotency-rate-quota.test.ts tests/runtime/idempotency-governance.test.ts tests/security/governance-privacy.test.ts`; expect all tests to pass.**
- [ ] **Step 10: Commit Task 2.**

### Task 3: Registry-owned debug contract and validators

**Files:**
- Modify: `packages/core/src/descriptors.ts`
- Modify: `packages/runtime/src/index.ts`
- Create: `packages/runtime/src/code-debug.ts`
- Test: `tests/core/registry.test.ts`
- Test: `tests/runtime/pipeline.test.ts`
- Commit: `feat(capabilities): register bounded code debug contract`

**Interfaces:**
- `parseCodeDebugInput(value: unknown, path?: string): ValidationResult<StructuredGenerateInput>` requires exactly one `sourceCode` string context, allows one optional `diagnostics` string context, and rejects all unknown/duplicate names, non-string values, and `untrusted:false`.
- `validateCodeDebugOutput(value: unknown, input: StructuredGenerateInput, path?: string): ValidationResult<unknown>` allows only flat registry-owned fields and validates category, limitation, and context-line references.
- `CODE_DEBUG_CAPABILITY_REGISTRATION` declares `code.debug.analyze@1.0`, `SPECIALIZED`, `STABLE`, `CONSUMER_COMPOSED`, `ai.structured.generate`, registry-owned schemas, max one call, and no generic fallback.

- [ ] **Step 1: Write parser tests** for a valid structured input plus rejected false-trust, duplicate, unknown-name, wrong-type, missing-source, and over-limit cases. Add output tests for valid/unknown category, mismatched parallel arrays, absent diagnostics reference, and out-of-range lines.
- [ ] **Step 2: Run the focused tests; expect import/behavior failures because the capability registration and parsers do not exist.**
- [ ] **Step 3: Add the registry-owned descriptor.** Define flat field-v1 output arrays `issueCategories`, `diagnosticContextRefs`, `limitations`; no free-form output field, nested object, confidence value, or caller-owned schema.
- [ ] **Step 4: Implement strict input parsing** by first calling the generic structured parser, then validating context cardinality/name/type/trust. Do not relabel false trust or merge context into instructions.
- [ ] **Step 5: Implement the static output validator.** Allowed categories are `SYNTAX|TYPE|BUILD|RUNTIME|LOGIC|OTHER`; limitations are `INSUFFICIENT_CONTEXT|AMBIGUOUS_EVIDENCE|NO_RELEVANT_LOCATION`. Each category has one `<context>:<line>[-<line>]` reference; names are `sourceCode`/`diagnostics`, lines are ordered positive integers within the referenced input’s line count. Return closed error issue codes/paths only.
- [ ] **Step 6: Run `npm test -- tests/core/registry.test.ts tests/runtime/pipeline.test.ts`; expect registration and validator tests to pass.**
- [ ] **Step 7: Commit Task 3.**

### Task 4: Specialized routing and coordinator validation

**Files:**
- Modify: `packages/runtime/src/runtime.ts`
- Modify: `packages/runtime/src/coordinator.ts`
- Modify: `tests/runtime/pipeline.test.ts`
- Modify: `tests/runtime/retry-repair.test.ts`
- Modify: `tests/runtime/idempotency-governance.test.ts`
- Commit: `feat(runtime): execute bounded code debug capability`

**Interfaces:**
- `ExecutionPlan` carries logical capability identity and registered `requiredPrimitive` separately.
- Permissions, kill switches, logical results, usage, and reliability use `code.debug.analyze@1.0`; route resolution and provider dispatch use `ai.structured.generate`.
- Both initial structured output and the existing bounded repair output pass through generic schema validation plus `validateCodeDebugOutput()`.

- [ ] **Step 1: Write runtime tests** for debug discovery/execution with prompt pair, a structured mock provider result, provider primitive identity, and specialized logical result/provenance identity. Add no-dispatch rejection cases for missing prompt labels and caller `outputSchema`.
- [ ] **Step 2: Run `npm test -- tests/runtime/pipeline.test.ts`; expect the specialized request not to execute under the current generic-only allowlist.**
- [ ] **Step 3: Extend `AiRuntime.#prepare()`.** Require registered `STABLE` readiness, `CONSUMER_COMPOSED`, matching built-in debug ID/version, prompt pair, registry output schema, and strict code-debug input; reject streaming and any caller schema override. Keep existing identity/permission/screening/limits checks.
- [ ] **Step 4: Route with the declared primitive** while retaining the logical capability in trusted authorization and `ExecutionPlan`. Do not bypass `ExecutionCoordinator`.
- [ ] **Step 5: Update `ExecutionCoordinator.#dispatch()` and output shaping.** Select structured provider generation by `requiredPrimitive`; run debug output validation after generic schema shaping on original and repair responses. Keep provider errors and rejected candidate text out of public errors/logs.
- [ ] **Step 6: Add a repair regression:** invalid category/reference triggers the existing single bounded repair; a second invalid result fails safely, while a valid repaired result succeeds.
- [ ] **Step 7: Run `npm test -- tests/runtime/pipeline.test.ts tests/runtime/retry-repair.test.ts tests/runtime/idempotency-governance.test.ts`; expect all tests to pass.**
- [ ] **Step 8: Commit Task 4.**

### Task 5: Fixtures, contract docs, and closeout report

**Files:**
- Add: AIBridge-owned debug request/result, provenance-invalid, trust-invalid, output-reference-invalid, and compatibility JSON fixtures under `Docs/fixtures/fixture-set.v1/`
- Modify: `tests/fixtures/fixtures.test.ts`
- Modify: `Docs/INTEGRATION_CONTRACT_V1.md`
- Modify: `Docs/CAPABILITIES.md`
- Modify: `Docs/PROJECT_STATUS.md`
- Modify: `Docs/ROADMAP.md`
- Add: `Docs/reports/STAGE_7_SPECIALIZED_CAPABILITY_REPORT.md`
- Commit: `docs(stage-7): record specialized capability foundation and qualification`

**Interfaces:**
- Fixtures are data only and never alter existing FROZEN fixture meanings.
- Keep legacy roadmap numbering/history. Label the user-commissioned specialized Stage 7 separately from legacy Stage 7 usage/cost work.
- Report exact read-only OJPlatform/AlgoQuest gaps and explicitly state production deployment/runtime-host effect is none.

- [ ] **Step 1: Add fixture-runner tests** that require the new valid and invalid case names and exercise request provenance, trust labels, and output references.
- [ ] **Step 2: Run `npm run check:fixtures`; expect failure because the new case files are absent.**
- [ ] **Step 3: Add JSON fixture data** using only synthetic code/diagnostic text and closed output values, then update the fixture runner’s explicit expected-file list. Run `npm run check:fixtures`; expect the conformance assertions to pass.
- [ ] **Step 4: Add the frozen-contract compatibility note** for request/contract 1.2 and descriptor 1.1, prompt pair semantics, readiness/instruction mode, colon idempotency support, and unchanged response/error/field dialect. Preserve all existing fixture payload meanings.
- [ ] **Step 5: Correct `Docs/CAPABILITIES.md`** so AIBridge owns structural contract/safety/execution only; consumers own prompt strategy/business rules/final interpretation. Keep idea/hint draft and learning summary reserved.
- [ ] **Step 6: Reconcile project/roadmap status** without renumbering legacy Stage 7–10; record this user-commissioned Stage 7 as PARTIAL because current OJPlatform grants and adapter provenance mapping are absent and real host qualification is out of scope.
- [ ] **Step 7: Add `Docs/reports/STAGE_7_SPECIALIZED_CAPABILITY_REPORT.md`** with summary, implementation, security/conformance evidence, read-only compatibility gaps, verification outputs, exact base/head, clean-tree result, and production runtime/deployment effect.
- [ ] **Step 8: Run `npm run verify`; expect typecheck, lint, coupling/secret/dependency gates, all tests, build, and offline package portability to pass.**
- [ ] **Step 9: Review `git diff --check`, `git diff --stat`, `git status --short`, and confirm no frozen fixture, host, deploy, installer, provider, or UI paths changed.**
- [ ] **Step 10: Commit Task 5.**
