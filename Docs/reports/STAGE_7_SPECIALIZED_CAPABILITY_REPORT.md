# AI BRIDGE V1 — COMMISSIONED STAGE 7

# SPECIALIZED CAPABILITY FOUNDATION

**Status: PARTIAL — AIBridge implementation complete; external qualification pending**

This report records the separately commissioned Stage 7 foundation for
`code.debug.analyze@1.0`. It does **not** renumber or close the historical roadmap stages. The
legacy Stage 7 usage/cost durability work and Stage 8 broader capability-pack work remain open;
the legacy Stage 9 real AlgoQuest AI E2E has not started.

## SCOPE AND RESULT

AI Bridge now registers one stable, consumer-composed specialized capability with registry-owned
input/output schemas and bounded structural behavior. It runs through the existing runtime and
coordinator; no new provider, host adapter, dynamic handler system, capability-pack package, or UI
was added.

- Input requires exactly one untrusted `sourceCode` STRING context and optionally one untrusted
  `diagnostics` STRING context. Consumer-authored instructions remain a separate channel.
- Output is closed to `issueCategories`, paired `diagnosticContextRefs` bounded to supplied context
  lines, and `limitations`. It carries no free-form explanation, patch, solution, score, or teaching
  response.
- `promptApplied: true` and an opaque `promptVersion` are required for this capability. Prompt
  labels remain logical-request provenance and are preserved across idempotent replay/join without
  becoming request identity.
- The provider route and call use `ai.structured.generate`; permissions, kill switches, results,
  reliability, and usage retain logical identity `code.debug.analyze@1.0`.
- Static output validation is applied after generic schema validation on both the initial and
  bounded repair response.

The consumer remains responsible for composing instructions, selecting and excluding private data,
choosing debugging/teaching strategy, and interpreting the bounded result under its own final guard.
AI Bridge does not fetch hidden tests, reference answers, private judge metadata, or other learner
data.

## CONTRACT AND COMPATIBILITY

The additive request/envelope contract is `1.2`; the capability descriptor is `1.1`. Response
schema `1.1`, error vocabulary `1.2`, and `aibridge.fields/v1` remain unchanged. The request
provenance pair and bounded printable-ASCII idempotency keys (including colon-delimited keys) are
documented in [`../INTEGRATION_CONTRACT_V1.md`](../INTEGRATION_CONTRACT_V1.md). Existing FROZEN
fixture meanings were not changed. Six new AIBridge-owned illustrative fixtures and their local
parser/validator tests cover successful and invalid debug requests/results, provenance, trust,
context references, and compatibility mapping.

## SECURITY AND OWNERSHIP

- Caller code and diagnostics remain untrusted data; `untrusted: false` is rejected rather than
  relabelled.
- Registry schemas and static validators reject unknown output fields/values, mismatched finding
  arrays, invalid references, and references outside caller-supplied context.
- Public errors expose closed validation reasons/paths, not rejected candidate content. No prompt,
  input, provider raw error, credential, or idempotency key is added to logs, metrics, provider
  metadata, or consumer-facing errors.
- Input data is caller-selected. The bridge cannot determine whether caller-labelled material is
  public; consumers must exclude all private judge and learner data before dispatch.

## VERIFICATION

The completed repository verification passed:

| Check | Result |
| --- | --- |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS |
| Coupling gate | PASS — no `@ojplatform/*`, `@algoquest/*`, or cross-repository source imports |
| Secret-leak gate | PASS — 234 files scanned; the existing synthetic secret-input fixture is allow-listed |
| Runtime dependency gate | PASS — contracts have zero runtime dependencies; dependency arrows remain one-way |
| `npm test` | PASS — 50 test files, 558 tests |
| `npm run build` | PASS |
| Portability gate | PASS — all 11 packages packed, offline-installed, typechecked and smoke-tested; 13 packed-runtime assertions |
| `npm run check:fixtures` | PASS — 1 file, 22 tests |
| Focused specialized runtime suites | PASS — 4 files, 67 tests |
| Host capability discovery regression | PASS — 1 file, 19 tests; asserts the two generic capabilities and the built-in specialized descriptor |

No live provider calls or real consumer AI E2E were run. The latter was expressly excluded from
this scope.

## QUALIFICATION GAPS AND NEXT WORK

The implementation is **not host-qualified**. The read-only compatibility audit found that the
current OJPlatform adapter grants generic capability IDs and does not provide the mandatory
specialized prompt-provenance pair. A separate, explicitly approved host change must add the
logical capability grant/dispatch mapping and provenance transport, then qualify the adapter and
host behavior against these AIBridge-owned fixtures. That host work is outside this repository and
was not performed. No AlgoQuest consumer was wired to this capability and no real AlgoQuest AI E2E
was run.

Accordingly this commissioned scope is **PARTIAL**, not PASS. The historical Stage 7 usage/cost
durability, broader Stage 8 packs, and legacy Stage 9 real-AI E2E remain distinct work items.

## LIVE, DEPLOYMENT, AND GIT

- **Live providers:** no live provider calls were made.
- **Production runtime/deployment impact: NONE.** The AIBridge library runtime gains an additive
  opt-in capability, but no production host is connected to it. No production runtime host,
  deployment, `deploy/`, compose file, deployment-consumed environment example, or Windows installer
  was modified. OJPlatform and AlgoQuest were not modified.
- **UI:** none.
- **Git:** implementation commits on `feature/stage7-specialized-capabilities` are `92bbb16`
  (approved design/plan), `13521bc` (contracts), `47238db` (idempotency provenance), `8d969d0`
  (capability descriptor/validators), and `c63b459` (runtime dispatch and validation). The
  implementation range is based on `3e7dec5`; changes were kept local and were not pushed.
- **Worktree:** clean at Task 5 closeout.

## EXIT ASSESSMENT

| Requirement | Result |
| --- | --- |
| Host-neutral bounded `code.debug.analyze@1.0` foundation | PASS |
| Prompt provenance, untrusted input, registry schema, logical identity, and bounded output enforcement | PASS |
| Idempotency, repair, governance, and compatibility regression coverage | PASS |
| Full AIBridge verification | PASS |
| OJPlatform adapter/grant/provenance qualification | **NOT DONE — separate approved host work required** |
| Real consumer AI E2E | **NOT RUN — out of scope** |
| Commissioned Stage 7 overall | **PARTIAL** |
