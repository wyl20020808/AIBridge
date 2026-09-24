# AI Bridge V1 — Technical Overview

Authoritative current-system document. Implementation-grounded at the V1 stabilization audit
(`feature/v1-stabilization-audit`); historical stage reports in [`reports/`](reports/) remain
historical evidence and are not rewritten here.

Companion documents: [`V1_RISK_REGISTER.md`](V1_RISK_REGISTER.md) (prioritized residual risks),
[`reports/V1_SECURITY_AND_STABILITY_AUDIT.md`](reports/V1_SECURITY_AND_STABILITY_AUDIT.md)
(threat review, bug register, tests added).

## 1. Product purpose

AI Bridge turns several AI providers into one stable, governed, uniform **AI capability** surface.
Other (consumer) plugins consume that surface through the host capability system. Consumers never
learn which vendor served a call, never see vendor prose, and never hold credentials.

## 2. What AI Bridge is / is not

**Is:** a capability broker (generic text + structured primitives, one specialized capability),
a provider suite (4 adapters), and a governance layer (idempotency, rate/quota/budget, breaker,
retry/fallback, usage/cost, config reload, qualification metadata).

**Is not:** a chatbot, an agent framework, a prompt collection, a wrapper around one vendor SDK,
an embedding/vision/tool-calling platform, a standalone gateway, a UI/admin console, or any
single product's business logic (no teaching logic, no learner identity, no judging, no scores).

## 3. Package architecture

12 packages (`packages/*`), all ESM, strict TypeScript, `files: ["dist"]`:

| Package | Role | Runtime deps |
| --- | --- | --- |
| `@aibridge/contracts` | Versions, envelopes, error vocabulary, strict parsers, capability/descriptor types, `aibridge.fields/v1`, stream events, prompt channels | **zero** |
| `@aibridge/core` | Input safety, structural output safety, capability registry + directory, kill switches, provider/model registries, endpoint (SSRF) safety | contracts |
| `@aibridge/host-sdk` | Host ports, in-memory + mutant fakes, scripted provider, host/provider conformance kits (dev/host-bootstrap only, never a production credential path) | contracts, core |
| `@aibridge/governance` | Fallback/retry policy, breaker + health, idempotency, rate limit, quota, usage ledger + cost, budget, observability. All stateful pieces behind ports with in-memory reference impls | contracts, host-sdk (Clock type only) |
| `@aibridge/runtime` | `AiRuntime` pipeline, multi-provider config (presets, aliases, routes), trusted secret resolution, `ExecutionCoordinator`, `ConfigManager` + snapshots, suite materialization, fallback-chain contract, safe diagnostics | contracts, core, governance, host-sdk |
| `@aibridge/qualification` | Status ladder, secret-free identity, closed records, pure staleness/drift, bounded stores, unified runner, safe diagnostics. Depends only on contracts. Never routes, never runs at startup | contracts |
| `@aibridge/provider-openai-compatible` | Generic Relay adapter + the internal shared OpenAI-compatible wire layer | contracts, core |
| `@aibridge/provider-openai` | OpenAI Official — **Responses API** wire path (independent of the chat dialect) | contracts, core |
| `@aibridge/provider-deepseek` | DeepSeek Official — explicit thinking mapping, reasoning isolation, JSON Output = valid JSON only | contracts, core, provider-openai-compatible |
| `@aibridge/provider-xiaomi-tokenplan` | Xiaomi MiMo Token Plan — `api-key` auth, `CN`/`SGP`/`EU` clusters, `max_completion_tokens` | contracts, core, provider-openai-compatible |
| `@aibridge/host` | OJPlatform host entry: manifest + `ServerPlugin` (`create`/`reload`/`dispose`/diagnostics) | contracts, core, governance, host-sdk, runtime |
| `@aibridge/suite-all` | The single concrete-adapter seam: preset → `AdapterFactorySpec` → adapter. No other package constructs a concrete adapter | runtime (types), provider packages |

Dependency direction (enforced by `check-adapter-coupling.mjs`, `check-runtime-deps.mjs`):
`contracts` ← `core`/`qualification` ← `governance`/`host-sdk` ← `runtime` ← `host`;
providers ← `suite-all`. No cycles. No `@ojplatform/*` / `@algoquest/*` imports anywhere.
Runtime never imports a concrete adapter; host never touches a provider package.
`qualification` is metadata-only and never a production startup dependency.

## 4. Request lifecycle

Generic request (`execute`):

```
Consumer plugin
  │ consumer request (no callerPluginId/subjectToken — rejected if present)
  ▼
Host boundary — binds callerPluginId, TrustedDispatchContext (identity, grants, promptApplied)
  ▼
AiRuntime.#prepare — parse, capability validation, route resolution, deadline computation
  ▼
ExecutionCoordinator.execute — governance prelude (idempotency gate → budget check →
  quota reserve → rate consume) → candidate loop (kill verdict → breaker verdict →
  per-attempt reserve → raceAttempt vs deadline/cancel → classify → retry/fallback policy) →
  repair (max once) → settlement (quota settle/release, budget spend, ledger, metrics, events) →
  gate completion → terminal AiResult
```

Specialized (`code.debug.analyze@1.0`): same pipeline, but `isExecutableCapability` pins
`kind=SPECIALIZED`, `requiredPrimitive=ai.structured.generate`, `output=REGISTRY`,
`instructionMode=CONSUMER_COMPOSED`; caller `outputSchema` is rejected
(`OUTPUT_SCHEMA_OVERRIDE_FORBIDDEN`); registry schema is imposed; `allowGenericFallback=false`.

Streaming (`stream`): `STARTED` is yielded after `#prepare`; provider delivery runs inside
`ExecutionCoordinator.stream()` under the **same** governance as `execute` (idempotency gate with
REPLAY-as-stream, budget/quota/rate prelude, single-target kill+breaker pick, bounded
single-attempt dispatch, per-delta byte cap, full settlement). Single terminal
(`COMPLETED`|`FAILED`); late deltas discarded; cancel races close `CANCELLED`. Replay of a
settled stream re-delivers the stored terminal text as deltas (no re-dispatch).

Failure/fallback accounting:

```
Primary attempt → failure class → retry? (same provider ≤1) : fallback? (chain ≤8, policy-gated)
  → every attempt reserves/settle quota, appends ledger, records breaker/health, merges cost
  → stable terminal selected by selectTerminalError (kill/deadline preserved over provider noise)
```

`execute`/`stream` never throw: all failures are terminal `AiResult`/`FAILED` events.

## 5. Trust model

Two channels, never mixed:

- **Trusted** (host-bound only): `callerPluginId`, subject identity, grants, `promptApplied` /
  `promptVersion`, resolved secrets. Consumer-supplied values in these positions are rejected
  (`TRUSTED_FIELD_IN_CONSUMER_REQUEST`); untrusted values declaring trust are rejected by closed
  keys and the `untrusted:true` requirement.
- **Untrusted** (consumer/provider data): prompt context values, provider response bodies,
  diagnostics. Provider bodies never become `providerMetadata` (projection is built from route
  target + operator config only); reasoning content is discarded at the wire; repair feedback is
  paths+codes only.

## 6. Capability model

Two generic primitives (`ai.text.generate`, `ai.structured.generate`) + one specialized
capability (`code.debug.analyze@1.0`). Capabilities are registry entries with ownership
(`REGISTRY` vs `CONSUMER`), instruction mode, output schema ownership, fallback policy, and
readiness. Logical capability identity is preserved end to end (metrics, ledger, idempotency
identity, and governance all key on the logical id, never the dispatch primitive).

## 7. Provider model

Adapters implement `AiProviderAdapter` (`ADAPTER_API=1`): `generateText`,
`generateStructured`, optional `streamText`, `probe`, `bindCredentials`, optional `shutdown`.
Provider-specific facts (base URLs, cluster tables, token fields, auth defaults, structured
modes, thinking defaults) live inside each adapter. The relay package additionally hosts the
shared OpenAI-compatible wire helpers consumed by DeepSeek/Xiaomi; OpenAI Official deliberately
uses its own Responses-API wire path. Vendor framing never crosses: finish reasons, usage, and
errors are normalized to the closed vocabulary at the wire.

## 8. Routing

Profile → ordered candidate list (`enumerateRouteCandidates`), no silent degrade
(`allowCapabilityDegrade` rejected; capability mismatch fails the candidate, never downgrades).
`validateFallbackChain` bounds the chain (≤8). Declared vs verified features are separate:
config `verifiedFeatures` is an operator assertion surfaced in diagnostics; qualification
staleness never routes.

## 9. Retry / fallback

Error-semantics matrix (implementation = [`RELIABILITY.md`](RELIABILITY.md) §13):

- Retry: same provider at most once, only for transient provider classes with
  `retryable=true`, never for `RATE_LIMITED`, never past the shared deadline, never on unknown
  outcome without `supportsReliableIdempotency`.
- Fallback: `decideFallback` over `nextFallback`; never chases own quota/budget limits
  (`OWN_LIMIT_NOT_DODGED`); `PROVIDER_BALANCE_EXHAUSTED` has one deliberate chase exception;
  cross-provider fallback on unknown outcome is gated by `crossProviderFallbackOnUnknownOutcome`
  (default true — accepted, documented double-bill risk).
- Repair: structured-output repair max once (`ONCE`), fully accounted (quota, ledger, cost,
  `REPAIR` record), same schema, same deadline/budget.

## 10. Circuit breaker

Per `providerId`+`modelAlias`: `CLOSED`/`OPEN`/`HALF_OPEN` with cooldown + probe limit.
Only `{PROVIDER_UNAVAILABLE, PROVIDER_OVERLOADED, PROVIDER_TIMEOUT}` move the breaker;
caller-caused errors never poison it. Kill switch outranks the breaker. Tuning propagates on
config reload (`reconfigure`, state preserved).

## 11. Idempotency

Identity = caller + capability + consumer key + request digest (length-prefix tuple encoding,
64-bit FNV fingerprint, stored hashed). `IN_FLIGHT` join (raced vs joiner deadline/cancel),
success replay, final-failure replay, 15-min TTL + 10k LRU, `CONFLICT` on same-key/different-
request, per-request retention tuning with live `reconfigure`. Stale store records (dead leader)
are taken over as fresh leaders rather than misreported. Cross-process duplicates are an
accepted single-process-reference limit.

## 12. Rate / quota

Rate: 5 dimensions (subject, caller, capability, provider, global), FakeClock-safe,
two-phase check-then-consume (refused calls consume nothing). Quota: reservation lattice
(request-scope once + budget buckets + per-attempt provider scope), settle-or-release
(zero-dispatch calls release, never settle), never negative, unknown usage settles
conservative by default (`TOKENS` settles on `totalTokens ?? input+output`).

## 13. Usage / cost

Usage counts are provider-reported by design (`usageKnown`, never zero-filled).
`InMemoryUsageLedger` is bounded (10k per list, oldest-first eviction). Cost: per-attempt
pinned pricing with `pricingId/version` provenance; provider-reported wins; unknown → absent
(never zero); cached/reasoning splits; mixed-currency merges yield `UNKNOWN` with no amount;
repair/fallback totals merged with `partial` flags. Historical records stay stable across
pricing changes (price pinned at request start).

## 14. Config reload

Validated-first atomic swap; full reject on invalid; rollback walks back generations
(bounded history, 20). One immutable `RuntimeConfigSnapshot` per logical request — in-flight
calls keep the old object; reload never mixes versions within a request. Reload reuses live
governance registries (no quota/rate/idempotency reset) and pushes breaker/idempotency tuning.

## 15. Host integration

`@aibridge/host` exposes manifest (`ai.bridge`, `entry: null`) + `ServerPlugin`
(`create`/`reload`/`dispose`/`status`/`diagnostics`). Single shared `KillSwitchRegistry`
(no fork); kill reasons preserved per flavour. `dispose()` is real: adapters'
`shutdown?.()` run, in-flight semantics documented, double-dispose safe. Host-provided stores
survive reload; default stores are reused across rebuilds. Deployment contract unchanged
(`entry: null`, no env vars, no services, no DB).

## 16. Specialized capabilities

`code.debug.analyze@1.0` only: consumer-composed instructions required (`promptApplied` +
`promptVersion`), provenance enforced, exactly-one `sourceCode` (`STRING`, `untrusted:true`,
closed context names), registry-owned output schema, logical identity preserved, repair
re-validates the specialized schema. Contract frozen (§23).

## 17. Provider qualification

Portable `@aibridge/qualification`: ladder `DECLARED` → `DETERMINISTIC_TESTED` →
`LIVE_QUALIFIED` (`LIVE_FAILED` / `LIVE_NOT_RUN` / `UNSUPPORTED` / `STALE`); secret-free
identity (safe endpoint projection + config digest incl. auth/wire); closed records; pure
staleness/drift evaluation; bounded stores; unified runner; safe diagnostics. Metadata only:
never routes, never runs at startup. Missing credential → `LIVE_NOT_RUN`, never failure.

## 18. Security model

Credentials: `credentialRef` (`secret://` handle) → host `SecretStorePort` → bound adapter;
never in requests, logs, errors, events, metrics, ledger, fixtures, or packed output
(mechanically asserted). Endpoints: fail-closed SSRF validation (loopback/RFC1918/link-local/
metadata/CGNAT/userinfo rejected; trailing-dot normalized; every redirect target re-validated,
≤3 hops, auth stripped on cross-origin hop). Transport seams injected (`FetchLike`); no
`process.env`/DOM in packages. See [`SECURITY.md`](SECURITY.md) and the audit report.

## 19. Observability

Closed metric label set (ids/counts/codes only); events metadata-only; no raw provider text,
no prompt/response content, no secrets in metrics/events/ledger. Operator-only redacted
diagnostic channel (literal bound secrets + `SECRET_PATTERNS` + PII stripped, truncated).

## 20. Portability

Every production package: packs (`files: ["dist"]`), offline-installs, typechecks against
packed `.d.ts` without `node` types, passes declaration-hygiene scan, tarball-content gate
(`dist/` only, no tests/maps/build-info), and smoke-tests — via `npm run check:portability`.
No `sourcemap`/`tsbuildinfo` in packed output (local-path leaks eliminated at the root
`tsconfig.base.json`). No absolute paths, workspace-only imports, undeclared deps, or test
files in tarballs.

## 21. Current provider status

| Provider | Wire | Deterministic | Live |
| --- | --- | --- | --- |
| OpenAI Official (Responses) | `POST {base}/responses`, Bearer, `max_output_tokens`, strict JSON Schema gated | PASS (incl. error table, streaming, reasoning isolation) | `LIVE_NOT_RUN` (no credential) |
| DeepSeek Official | `POST {base}/chat/completions`, Bearer, `max_tokens`, JSON Output = valid JSON only | PASS | `LIVE_NOT_RUN` |
| Xiaomi MiMo Token Plan | `POST {base}/chat/completions`, `api-key`, `CN`/`SGP`/`EU`, `max_completion_tokens` | PASS | `LIVE_NOT_RUN` |
| Generic Relay | `POST {base}/chat/completions`, configurable auth, tri-mode structured | PASS | Historically `LIVE_QUALIFIED` (Stage 4: text/structured/streaming/usage); latest credential-less session `LIVE_NOT_RUN`, historical record stands |

## 22. Current known limitations

- Live qualification exists only for the Relay row; official providers await operator credentials.
- Streaming is single-attempt (no stream fallback) — policy, not a gap.
- Reference stores are in-process (cross-process atomicity delegated to the port contract).
- Relay `probe()` returns `HEALTHY` without network (declared behavior).
- Xiaomi streams omit `stream_options` (usage may be absent on streams).
- In-stream error frames carry synthetic status (vendor type still mapped).
- Localhost/private-DNS names and DNS-rebinding are documented out of scope for SSRF checks.

## 23. Integration contract freeze

Frozen: `code.debug.analyze@1.0`; `promptApplied`/`promptVersion` semantics; consumer-managed
prompt ownership; trusted/untrusted separation; OJPlatform specialized dispatch contract;
capability identity semantics; generic request/response major versions
(`CONTRACT=1.2`, `REQUEST=1.2`, `RESPONSE=1.1`, `ERROR=1.2`); idempotency semantics.
Changes require a compatibility note + version bump + fixture update
([`INTEGRATION_CONTRACT_V1.md`](INTEGRATION_CONTRACT_V1.md), AGENTS.md §8). This audit made no
breaking change (additive port options only: optional `RateLimitStorePort.check`,
`IdempotencyRegistry` retention option, `AiRuntime.dispose/governanceServices`).

## 24. Operational lifecycle

Configure (file/config, placeholders only) → construct → start → health (`getProviderHealth`)
→ qualification (opt-in `npm run qualify:*`, never startup) → reload (atomic, rollback) →
kill switch (global/capability/provider, live-merged) → diagnostics (safe, secret-free) →
shutdown (`dispose`, real adapter shutdown). No UI at any step (gate closed).

## 25. Future-extension rules

Feature development is **FROZEN** after V1 stabilization. Reopen only for: a real consumer
requirement, a production defect, a security issue, performance/reliability evidence, or an
integration-contract requirement — each as a separately approved change. Never add a provider,
capability, gateway, tool-calling, embedding, vision, UI, or deployment change speculatively
(AGENTS.md §11).
