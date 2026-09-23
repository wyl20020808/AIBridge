# AI Bridge — Test Strategy

The list below is not a wish list. Every item names a failure it catches, and every item is a
**release gate** for the stage that introduces the code it covers.

---

## 1. Test layers

| Layer | What it proves | Introduced |
| --- | --- | --- |
| **1. Contract tests** | `@aibridge/contracts` accepts what the contract says is valid and rejects what it says is invalid, with the exact `reason` | Stage 2 |
| **2. Security tests** | secrets, raw errors and learner text never leak across any boundary | Stage 2 (skeleton) → Stage 3 (live) |
| **3. Provider conformance** | every adapter behaves identically at the AI Bridge boundary | Stage 3 |
| **4. Routing / fallback** | route resolution, chain order, bounded retry, budget arithmetic | Stage 5 |
| **5. Structured output** | extraction, validation, repair, no-partial-results | Stage 4 |
| **6. Rate limit / quota** | all five dimensions, both mechanisms | Stage 5 |
| **7. Idempotency** | one learning turn ⇒ one billed call | Stage 5 |
| **8. Usage** | records are complete, and contain no content | Stage 5 |
| **9. Capability packs** | each pack's policy holds, incl. business safety | Stage 8 |
| **10. Portability** | no forbidden dependency anywhere | Stage 2 |
| **11. Compatibility fixtures** | [`fixtures/`](fixtures/) agree with a consumer's own parser | Stage 2, and continuously |

### 1.1 Provider conformance kit

A reusable suite in `@aibridge/host-sdk` that every `AiProviderAdapter` must pass unchanged.
An adapter that needs an exemption has a design problem. **Stage 3 implements it** and runs the
same cases against two adapters through two different injection seams — the scripted queue and the
fake HTTP transport (`ConformanceTarget.enqueue(behavior)`), so "every adapter behaves identically
at the AI Bridge boundary" is a checked property (`tests/host-sdk/provider-conformance.test.ts`).

Cases, minimum (✓ = in the kit; ↗ = enforced where the layer lives):

| Case | Asserts | Where |
| --- | --- | --- |
| text happy path | `text` non-empty, `finishReason` in the closed set | ✓ `text.happy-path` |
| structured happy path | payload extracted and validated | ✓ `structured.happy-path` + `tests/runtime/pipeline.test.ts` |
| structured malformed | `INVALID_RESPONSE`, never a partial object | ↗ `tests/runtime/errors.test.ts` + `pipeline.test.ts` |
| structured off-schema | `SCHEMA_MISMATCH` with issue paths | ↗ `tests/runtime/pipeline.test.ts` |
| deadline exceeded | `TIMEOUT` within `budget ± tolerance` | ↗ `tests/runtime/timeout-cancellation.test.ts` |
| cancellation | `CANCELLED` is terminal even if the provider later answers | ↗ `tests/runtime/timeout-cancellation.test.ts` |
| error mapping | a synthetic vendor error yields exactly the mapped `code` + `providerCategory` | ✓ `error.mapped-category` + ↗ `tests/runtime/errors.test.ts` |
| usage absent | `usage: {}` + `USAGE_ESTIMATED` where the bridge estimates | ✓ `usage.shape` |
| size caps | oversized output ⇒ `OUTPUT_TOO_LARGE` | ↗ `tests/runtime/pipeline.test.ts` |
| stream round trip | deltas then exactly one `FINISH` with usage + closed finish reason | ✓ `stream.round-trip` + `tests/runtime/streaming.test.ts` |
| stream error terminal | a mid-stream failure closes with exactly one `ERROR` | ✓ `stream.error-terminal` + `tests/runtime/streaming.test.ts` |
| **no vendor type escapes** | every exported signature is free of vendor types | ↗ declaration-hygiene scan in `scripts/check-portability.mjs` + strict typecheck |
| **no secret escapes** | with a synthetic key configured, the key appears in no output | ✓ `secret.no-escape` + `tests/security/runtime-secrets.test.ts` |

Modelled on AlgoQuest's `host-sdk` Conformance Kit idea (mutant-killing suites), adapted here
for adapters rather than host providers.

**Stage 4.** The kit runs unchanged against **five** adapters (the scripted reference plus OpenAI
Official, DeepSeek Official, Xiaomi Token Plan and the generic relay) through their own injection
seams (`tests/provider-suite/conformance.test.ts`). On top of it, the Phase 28 base checklist is
one table executed through one `AiRuntime` **per provider** (`tests/runtime/provider-matrix.test.ts`):
text success · structured success · malformed response · 401/403 · 404 model · 429 · 5xx ·
timeout · cancel · usage · finish reason · stream success · stream error · credential-leak and
malicious-provider-error sanitization. Provider-specific suites live beside it.

### 1.2 Stage 5 reliability suites (Phase 63–65 and the governance/runtime suites)

Each row names the failure it catches:

| Suite | Failure it catches |
| --- | --- |
| `tests/properties/reliability.test.ts` — property (Phase 63) | a generated case where one fingerprint runs two execution chains, a different fingerprint returns the old result, a fallback widens the deadline or degrades capability, a consumer quota is routable-around, a failed reload replaces the snapshot, an unknown cost becomes zero, or the ledger holds prompt/raw response text |
| `tests/properties/reliability.test.ts` — fuzz (Phase 64) | a random failure/graph/breaker/quota/rate/repair sequence that loops, reuses an attempt id, overspends quota, disagrees with the ledger, or produces more than one terminal result |
| `tests/properties/reliability.test.ts` — chaos (Phase 65) | timeouts, malformed payloads, late answers and 429/503 storms that make the runtime throw, hang, or double-terminate |
| `tests/governance/policy.test.ts` | a fallback or retry decision that chases a request/content failure or the caller's own limits, repeats an unknown outcome without reliable idempotency, exceeds one same-provider retry, backs off non-deterministically, or accepts a cyclic/impossible fallback chain |
| `tests/governance/breaker-health.test.ts` | a caller-side failure moving the breaker, dispatch through an open breaker, or one 429 becoming a permanent health verdict |
| `tests/governance/idempotency-rate-quota.test.ts` | one turn billed twice, a same-key different-body replay, a non-atomic claim or rate window that overshoots, or an unknown usage settled at zero |
| `tests/governance/cost-ledger.test.ts` | a historical price rewritten by a later rate card, an unpriced model priced as zero, a missing attempt record, or a reasoning token treated as anything but a count |
| `tests/runtime/fallback-execution.test.ts` | a chain that silently degrades capability, chases `CONTENT_BLOCKED`, routes around a consumer quota, dispatches past a kill switch or open breaker, or outruns the shared deadline |
| `tests/runtime/retry-repair.test.ts` | an unbounded retry storm, an unknown outcome repeated without reliable idempotency, a repair that runs twice, hides its call or fires on a content failure, or a misreported `OUTPUT_REPAIR_EXHAUSTED` |
| `tests/runtime/idempotency-governance.test.ts` | a non-faithful replay, unjoined concurrent duplicates, a replay that consumes quota or rate budget, or retry/fallback/repair continuing after cancellation |
| `tests/runtime/config-reload.test.ts` | an unknown config field slipping through, a raw credential or unsafe endpoint in a snapshot, a duplicate/impossible fallback target accepted, a half-applied reload, or an in-flight request mixing two config generations |
| `tests/runtime/observability.test.ts` | a metric label or event payload carrying a subject, request id or content, a missing refusal/breaker/retry signal, or an open operational-event vocabulary |
| `tests/security/governance-privacy.test.ts` | a secret, prompt, learner text, raw response or reasoning content in any governance store or config snapshot, or an unknown cost laundered into zero |

`npm run test:live:reliability` is **opt-in** and never part of `verify`: it runs a real fallback
smoke only when two providers have credentials and reports `SKIP` otherwise — a `SKIP` never fails
the stage.

---

## 2. Security tests — mechanically asserted

These must fail the build. "Reviewed by a human" is not a security control.

### 2.1 Secret leak

| Test | Fails when |
| --- | --- |
| `check-no-secret-leak.mjs` scans every committed file | any file matches a credential pattern (sk-, ghp_, AKIA, xox, PEM block, JWT triplet, `apiKey: "<non-placeholder>"`) |
| fixture scan | any fixture in [`fixtures/`](fixtures/) contains a credential-shaped value (the one in `…secret-input.json` is a **synthetic, obviously fake** marker and is allow-listed by name) |
| response projection test | with a synthetic key configured, the key string appears in **no** of: `AiResult`, `AiError.message`, `AiError.details`, `providerMetadata`, `warnings[].detail` |
| log capture test | with a synthetic key configured, the key appears in **no** captured log line at any level |
| browser-bundle test | the built client bundle contains no provider credential and no `apiKeyRef` resolution |
| consumer-request test | a consumer-visible request/response round trip never contains a credential |
| runtime secret regression (Stage 3) | with a synthetic key bound through the trusted secret port, the key appears in **no** of: `AiResult`, `AiError`, stream events, `ProviderRequest`, snapshots, operator-log entries (including a provider error body that echoes the key back), `JSON.stringify(runtime)`, `JSON.stringify(adapter)` |
| **negative gate test** (Stage 3) | a planted credential-shaped file does **not** make `check-no-secret-leak.mjs` fail — the test plants one, asserts exit ≠ 0 and the named pattern, and removes it (`tests/security/runtime-secrets.test.ts`) |
| leaky-adapter mutant (Stage 3) | a mutant adapter that serializes its credential is **not** detected by the same assertions — proven by making the mutant leak and watching the assertion catch it |

**A synthetic key is always used.** A test that uses a real key is itself a finding.

### 2.2 Raw prompt / response logging

| Test | Fails when |
| --- | --- |
| log capture on a request containing a sentinel learner sentence | the sentinel appears in any log line at `METADATA_ONLY` retention |
| log capture on a provider error with sentinel prose | the sentinel appears in any **consumer-facing** log or in any `AiError.message` |
| operator channel test | a raw provider error may appear only in the operator channel, only truncated, only credential-stripped |

### 2.3 Provider raw error non-penetration

| Test | Fails when |
| --- | --- |
| for every synthetic vendor error text `V` | `V` is a substring of `AiError.message`, `AiError.details` or `warnings[].detail` |
| status code test | a vendor numeric status never appears in a public field |

### 2.4 Vendor type containment

| Test | Fails when |
| --- | --- |
| type-level lint over `@aibridge/core` and `@aibridge/contracts` exports | an exported signature references a vendor SDK type, a DOM `AbortSignal`, or a host type |

### 2.5 `callerPluginId` unforgeable

| Test | Fails when |
| --- | --- |
| transport-level test | a request whose `callerPluginId` is supplied by the caller body is accepted |
| registry test | caller A can invoke a capability only caller B declared |
| absent-identity test | a call with no host-bound identity is not rejected |

### 2.6 Quota not bypassable

| Test | Fails when |
| --- | --- |
| caller with quota exhausted | any call is dispatched |
| `fallbackOnQuotaExceeded: false` (default) | a fallback provider is attempted after `QUOTA_EXCEEDED` |
| key-swap test | a second `idempotencyKey` for the same logical turn does not produce a second dispatch when the consumer is honest (§10) |
| restart test | documented as a known, bounded gap (§[`ARCHITECTURE.md`](ARCHITECTURE.md) §19) — asserted to be *bounded*, not absent |

### 2.7 Output safety

| Test | Fails when |
| --- | --- |
| unknown-field output | accepted |
| type-coerced output (`"3"` as `NUMBER`) | accepted |
| oversized output | accepted |
| partial output returned after a failed validation | anything but a `FAILED` envelope |
| `declaresSolution: true` | reaches a consumer unflagged |
| `forbiddenOutput` rule | a capability policy rule is silently skipped |

---

## 3. Functional test areas

### 3.1 Contract tests

- envelope: closed key sets, version rejection (`1.0` vs `2.0` vs `1`), metadata allow-list,
  forbidden-field rejection, size caps.
- `FieldSpec`: name pattern, six types, `maxLength`, `required`.
- error model: twelve codes only; reason/stage/detals closure; retryability defaults table.
- fixtures: every file in [`fixtures/`](fixtures/) yields its declared `expect` **and** `reason`.

### 3.2 Routing and fallback

- profile → route chain resolution; requirement filtering; availability filtering.
- fallback only on the allowed set ([`ARCHITECTURE.md`](ARCHITECTURE.md) §10.1).
- **never** fallback on `INVALID_REQUEST`, `SCHEMA_MISMATCH`, `CONTENT_BLOCKED`.
- fallback respects the **remaining** budget; a fallback is never started with less than
  `MIN_VIABLE_PROVIDER_MS` left.
- `FALLBACK_USED` and `DEGRADED_ROUTE` warnings are emitted exactly when they should be.

### 3.3 Timeout

- `n` fallbacks do not cost `n × totalMs`; assert the wall clock is within `totalMs + tolerance`.
- caller budgets are clamped **down**, never up.
- `VALIDATION_RESERVE_MS` is actually reserved.

### 3.4 Structured output

- extraction order: fenced JSON → balanced span → `EXTRACTION_FAILED`.
- JSON with prose around it extracts; JSON with two objects extracts the **outermost** and is
  documented.
- no partial results, ever.
- repair runs at most once, on the same provider, and reports `OUTPUT_REPAIRED`.

### 3.5 Retry

- retry only on the retryable set; attempt counts bounded.
- `RATE_LIMITED` is **not** retried in process.
- retry never crosses the overall deadline.

### 3.6 Idempotency

- replay returns the identical result plus `IDEMPOTENT_REPLAY`.
- concurrent duplicates coalesce to one dispatch (assert with a counting fake).
- same key + different body ⇒ `IDEMPOTENCY_CONFLICT`.

### 3.7 Rate limit and quota

- all five dimensions enforced independently; strictest wins.
- `retryAfterMs` is populated and sane.
- `QUOTA_EXCEEDED` is distinguishable from `RATE_LIMITED` in `reason` and in the outcome.

### 3.8 Usage

- every dispatch produces exactly one usage record.
- no content in a usage record ([`SECURITY.md`](SECURITY.md) §6.1).
- `estimatedCost` absent ⇒ no zero is fabricated.

### 3.9 Capability packs

- `inputAllowList` rejects a key outside it.
- `forbiddenOutput` rules fire.
- `education.*` policy holds: exactly one question per turn, closed misconception vocabulary,
  `declaresSolution` screened.
- `code.*` policy holds: no hidden testcase or reference answer in `input`; the pack never
  returns a corrected program.
- `maxCallsPerTurn: 1` is enforced per invocation.

### 3.10 Portability

- `check-adapter-coupling.mjs`: no `@ojplatform/*`, no `@algoquest/*`, no cross-repo source
  import, in any `@aibridge/*` package.
- the contracts package builds and parses with **zero** runtime dependencies.
- a smoke run of `@aibridge/contracts` in a bare environment (no host, no DOM) passes.

### 3.11 Kill switch and availability

- global / provider / capability switches each produce `GOVERNANCE` + the matching `reason`.
- `getStatus()` reports `DISABLED` **before** a call is attempted.
- `DISABLED` and `UNAVAILABLE` remain distinguishable end to end.

### 3.12 Cancellation

- cancel before dispatch ⇒ no provider call, no usage record beyond the attempt.
- cancel in flight ⇒ `CANCELLED`, terminal, late provider answers discarded.
- cancellation is idempotent.

---

## 4. Non-goals of the test system

Stated so nobody assumes coverage:

- **model output quality** — evaluation datasets and prompt quality metrics are a capability-pack
  concern (Stage 8+), not a bridge correctness concern.
- **vendor behaviour** — a conformance kit tests the adapter's contract, not whether a vendor's
  model is good.
- **load testing** — recorded as a Stage 7 need; not a release gate before it.
