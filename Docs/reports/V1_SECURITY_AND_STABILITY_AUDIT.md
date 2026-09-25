# AI Bridge V1 — Security and Stability Audit Report

Stabilization audit on branch `feature/v1-stabilization-audit` (base `2fd0729`).
Not a feature stage: no new provider, capability, gateway, UI, or deployment change.
OJPlatform and AlgoQuest were read-only throughout (no commits, no modifications).

## Threats reviewed

| Threat | Control | Test coverage | Residual risk |
| --- | --- | --- | --- |
| Credential exfiltration | `secret://` handles; bound-only adapters; redacted operator channel; secret-leak gate | `tests/security/*`, stabilization regressions, `check-no-secret-leak.mjs` | None known; see R-01 for spend (not exfiltration) risk |
| SSRF (relay endpoints/redirects) | Fail-closed `checkEndpointSafety`; per-hop re-validation; ≤3 hops; cross-origin auth strip | `tests/core/endpoint-safety.test.ts`, stabilization regressions | R-03 (DNS layer out of scope) |
| Caller spoofing | Consumer `callerPluginId`/`subjectToken` rejected; identity composed from trusted context only; deny-by-default grants | `tests/security/boundaries.test.ts`, mutant test (forged id) | None known |
| Quota bypass | Prelude order fixed; fallback cannot chase own limits; replay/join pre-reservation; stream governed | `tests/runtime/*governance*`, stream-governance, chaos quota storm | R-02 (multi-process) |
| Idempotency abuse | Closed key pattern; caller+capability in identity; CONFLICT on mismatch; bounded LRU+TTL | idempotency suites, chaos same-key storm | R-07 (theoretical collision) |
| Prompt/data trust confusion | Fenced untrusted values; `untrusted:true` required; provenance enforced; provider body never metadata | boundaries tests, mutant test (trusted-claiming value) | None known |
| Provider malicious response | Bounded reads; incremental stream cap; single terminal; late deltas discarded; reasoning discarded; normalized errors | streaming suites, chaos tests, stabilization regressions | R-08 (synthetic in-stream status) |
| Reasoning leakage | `reasoning_content`/`reasoning_text`/non-message items discarded at wire; counts only | provider adapter tests | None known |
| Log injection | Redaction + truncation on operator channel; metadata-only events/metrics | governance-privacy tests, secrets tests | None known |
| Oversized payloads | 32 KiB input / 8k instructions / 512 B metadata / 64 KiB output / depth 6 / bounded SSE | input/output-safety tests, perf sanity | None known |
| Resource exhaustion | Bounded ledger (10k), idempotency LRU+TTL, qualification retention, config history cap (20), per-delta stream cap | stabilization regressions, LRU behavioral test | R-06 (uninstrumented eviction) |
| Redirect attack | Re-validation per hop; auth stripped cross-origin; private targets blocked | stabilization regressions (both wires) | None known |
| Config poisoning | Strict config validation; validated-first atomic swap; full reject; rollback; snapshot isolation | config-reload suites | None known |
| Qualification poisoning | Closed record keys; validator drops invalid; safe usage only; no secret fields | qualification suites | None known |

## Bugs found and fixed (29)

Severity: P0 immediate · P1 before production · P2 real defect, bounded blast radius.

| ID | Severity | Root cause | Fix | Regression test |
| --- | --- | --- | --- | --- |
| BUG-001 | P0 | `AiRuntime.stream()` bypassed all governance (no idempotency/quota/rate/budget/breaker/ledger) despite docstring claiming coverage | `ExecutionCoordinator.stream()`: full governed single-attempt path; `runtime.stream()` delegates | `tests/runtime/stream-governance.test.ts` (8) |
| BUG-002 | P1 | SSRF validator missed FQDN trailing dot (`localhost.` ≠ `localhost`) | Normalize one trailing dot before name checks (`core`, qualification identity) | `tests/security/stabilization-regressions.test.ts` |
| BUG-003 | P1 | Auth headers forwarded to cross-origin redirect targets (both wires) | Strip auth on cross-origin hop; fail closed on unparseable | same file (both wires + same-origin control) |
| BUG-004 | P1 | OpenAI classifier mapped `insufficient_*` → `AUTH_FAILED`, no 402 branch (exhausted balance read as broken credential) | Map to `PROVIDER_BALANCE_EXHAUSTED` + 402 branch, mirroring chat classifier | same file + updated `tests/provider-openai/adapter.test.ts:327` |
| BUG-005 | P2 | Relay/DeepSeek/Xiaomi adapters could emit TEXT_DELTA after FINISH within one flush | Discard post-terminal payloads in the flush loop | same file (with control) |
| BUG-006 | P2 | `InMemoryUsageLedger` unbounded arrays | Per-list capacity (10k), oldest-first eviction | `tests/governance/stabilization-regressions.test.ts` |
| BUG-007 | P2 | `ContextValue.maxLength` parsed but never enforced | Enforce in `parseContextValue` (`OUT_OF_RANGE`) | `tests/contracts/context-maxlength.test.ts` (2) |
| BUG-008 | P2 | `PROVIDER_THROTTLED` classified by accident (no map entry) | Explicit `PROVIDER_TRANSIENT` entry | covered by policy suites |
| BUG-009 | P2 | `unknownOutcome = dispatched !== true` treated pre-dispatch failures as unknown | `dispatched === undefined` | covered by retry/fallback suites |
| BUG-010 | P2 | Configured idempotency `retentionMs`/`capacity` inert (hardcoded) | Threaded at construction + live `reconfigure()` | governance regressions |
| BUG-011 | P2 | Stale store `IN_FLIGHT` + absent leader promise → misleading `CONFLICT` | Take over as fresh leader (`PROCEED`) | governance regressions |
| BUG-012 | P2 | Idempotency `JOIN` ignored joiner deadline/cancellation (could hang) | Race vs deadline/cancel like `raceAttempt` | stream-governance (hung-leader case) |
| BUG-013 | P2 | Cancel-after-reserve settled full conservative quota instead of releasing | Release when `dispatched===0` | stream-governance (pre-cancelled case) |
| BUG-014 | P2 | Refused rate-limit call left partial hits in earlier dimensions | Two-phase check-then-consume (`RateLimitStorePort.check`, additive) | governance regressions |
| BUG-015 | P2 | `TOKENS` settlement keyed only on `totalTokens` (over-charged split reporters) | `totalTokens ?? input+output` | covered by quota suites |
| BUG-016 | P2 | `mergeCosts` summed across currencies into a meaningless amount | Mixed currency → `UNKNOWN`, no amount | governance regressions |
| BUG-017 | P2 | Budget currency check dead (amount-only comparison) | Currency-aware check; mismatch drops estimate (spent-only) | governance regressions |
| BUG-018 | P2 | Price pinned at snapshot creation, not request start | Pin at request `startedAtMs` | covered by cost suites |
| BUG-019 | P2 | `summarize()` dropped real zero-token reports into unknown | Reuse `aggregateUsage()` for totals | governance regressions |
| BUG-020 | P2 | Breaker retuning via reload never took effect (config pinned at construction) | `reconfigure()` + `syncGovernanceTuning()` on reload | governance regressions |
| BUG-021 | P2 | Shape-changing reload with default stores wiped quota/rate/idempotency state | Reuse live registries across rebuilds | config-reload suites |
| BUG-022 | P2 | `dispose()` was a flag; provider `shutdown?.()` never invoked | Real `AiRuntime.dispose()` (idempotent, error-swallowing, fail-closed) | stream-governance (dispose case) |
| BUG-023 | P2 | `authScheme` overrides on official presets silently dropped | Forwarded (DeepSeek/Xiaomi); non-BEARER on OpenAI rejected | `tests/suite-all/adapter-config-forwarding.test.ts` (5) |
| BUG-024 | P2 | `ConfigManager.rollback()` never popped (history grew, repeat rollback stuck) + unbounded history | Pop on rollback + `CONFIG_HISTORY_LIMIT=20` | config-reload suites |
| BUG-025 | P2 | Live script classified auth-shaped failures as `PROVIDER_FAILURE` | Route through `classifyQualificationFailure` | script-level (imports shipped classifier) |
| BUG-026 | P2 | `configDigest` omitted `authScheme`/`wireProtocol` (auth-only drift invisible) | Added to digest inputs + script entries | source + script |
| BUG-027 | P2 | Version drift: `CONTRACTS.md` table, manifest `contractVersions`, hardcoded `'1.1'` literals, script stamped `'1.1'` vs `CONTRACT=1.2` | All derived from `contracts` constants; docs corrected | versions suites |
| BUG-028 | P2 | Packed tarballs contained `.js.map`/`.d.ts.map`/`dist/.tsbuildinfo` (local-path leaks) — caught by the new tarball-content gate | `sourceMap`/`declarationMap` off at root; `tsbuildinfo` moved to gitignored `tmp/` | `check-portability.mjs` `checkTarballContents()` |
| BUG-029 | P2 | Missing `PROVIDER_BALANCE_EXHAUSTED` operator message (fell back to generic) | Added Stage-6 wording | errors suites |

Zero invented bugs: two pre-existing tests pinning buggy behavior were updated with root-cause
notes (`provider-openai/adapter.test.ts:327`; `security/runtime-secrets.test.ts` stream half —
the old expectation depended on the P0 re-dispatch; the governed REPLAY path is correct).

No breaking contract change: all fixes internal or additive minor-compatible
(optional `RateLimitStorePort.check`, `IdempotencyRegistry` options, `AiRuntime.dispose`/
`governanceServices`). No `BREAKING_CONTRACT_BLOCKER` encountered.

## Tests added (56)

- `tests/security/stabilization-regressions.test.ts` (11): SSRF trailing dot, redirect auth strip,
  OpenAI balance mapping, late-delta discard.
- `tests/governance/stabilization-regressions.test.ts` (15): currency, zero-usage, budget, rate
  two-phase, idempotency tuning/takeover, breaker reconfigure, ledger bound.
- `tests/runtime/stream-governance.test.ts` (8): quota/rate charge, replay, ledger, kill,
  cancel-release, hung-leader deadline, dispose.
- `tests/contracts/context-maxlength.test.ts` (2): bound accepted / `OUT_OF_RANGE`.
- `tests/suite-all/adapter-config-forwarding.test.ts` (5): full field-forwarding pin.
- `tests/runtime/stabilization-mutants.test.ts` (8, Phase 44): kill, quota, forgery, trust
  confusion, fallback accounting, caller isolation, error normalization, stale-contract
  staleness — each kills a named guard-deletion mutant.
- `tests/runtime/stabilization-chaos.test.ts` (7, Phases 45–48): stream chaos, cancel race,
  same-key concurrency storm, quota storm, seeded version fuzz, LRU bound, parse perf sanity.
- Pre-existing `tests/properties/reliability.test.ts` already covers seeded property/fuzz/chaos/
  concurrency baselines; no duplication was added.

Final gate: `npm run verify` PASS — typecheck, lint, gates, **685 tests**, build, portability
(incl. new tarball-content gate); `git diff --check` clean; working tree clean.

## Areas not proven (honest limits)

- Official-provider wire behavior against real vendors (no credentials; deterministic fakes only).
- Multi-process deployment (single-process reference proven; durable stores are host-provided).
- Real-world volume (boundedness proven behaviorally; production telemetry still to be observed).
- DNS-layer attacks (out of scope by decision, R-03).

## Recommended production monitoring

Quota refused-rate and conservative-settle rate; breaker open/close transitions; idempotency
`CONFLICT` rate (client bug signal); `UNKNOWN_COST` occurrence; ledger/registry eviction
pressure; kill-switch engagements; qualification staleness transitions after config changes;
relay endpoint latency (no probe covers it, R-08).
