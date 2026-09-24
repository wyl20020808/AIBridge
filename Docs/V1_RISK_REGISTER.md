# AI Bridge V1 — Risk Register

Prioritized residual risks after the V1 stabilization audit. Every item has evidence, an owner
layer, and a trigger for reopening. Bugs found and fixed during the audit are **not** listed
here — see [`reports/V1_SECURITY_AND_STABILITY_AUDIT.md`](reports/V1_SECURITY_AND_STABILITY_AUDIT.md)
§Bug register. Deferred features are listed at the bottom, separately from risks.

Severity: **P0** immediate correctness/security · **P1** before serious production use ·
**P2** fix when usage demonstrates need · **P3** explicitly deferred / no current need.

## P0 — immediate correctness/security

**None remaining.** The one P0 found (streaming path bypassed all governance) was fixed with
regression tests (`tests/runtime/stream-governance.test.ts`). If a new P0 is discovered, feature
freeze reopens for that fix alone.

## P1 — before serious production use

### R-01 Unknown-outcome fallback defaults to double-bill
- Evidence: `packages/governance/src/fallback-policy.ts` — `crossProviderFallbackOnUnknownOutcome`
  defaults `true`; `Docs/RELIABILITY.md` §3 documents it.
- Impact: after a timeout with unknown dispatch outcome, the default path fires a second
  billable call. Likelihood: medium (any flaky network).
- Recommended action: operators who cannot tolerate double-spend should set it `false`; consider
  flipping the default in a future minor with a compatibility note.
- Trigger: first production billing dispute or flaky-network deployment.
- Owner layer: governance policy / operator config.

### R-02 Single-process atomicity only
- Evidence: idempotency `claim`, rate `tryConsume`, quota reservation are synchronous-to-first-
  await on one loop; cross-process safety is delegated to the port contract
  (`IdempotencyStorePort`, `RateLimitStorePort`, `QuotaStorePort`).
- Impact: multi-instance deployments without durable host stores can double-execute, over-admit,
  or over-reserve. Likelihood: high once horizontally scaled.
- Recommended action: any multi-instance host **must** provide durable store implementations;
  single-instance deployments are unaffected.
- Trigger: horizontal scaling.
- Owner layer: host stores.

### R-03 DNS-layer SSRF out of scope
- Evidence: `packages/core/src/endpoint-safety.ts` — private-DNS names resolving to internal IPs
  and DNS-rebinding are documented out of scope; literal-IP and known-metadata-name vectors are
  covered and tested.
- Impact: an operator pointing a relay at an attacker-influenced DNS name could have requests
  re-resolved to internal addresses. Likelihood: low (operator-controlled endpoints only; consumers
  cannot set URLs).
- Recommended action: pin relay endpoints to literal IPs or trusted DNS; revisit if relays ever
  accept non-operator-configured endpoints.
- Trigger: any non-operator-controlled endpoint input.
- Owner layer: core endpoint-safety / operator config.

## P2 — fix when usage demonstrates need

### R-04 Duplicated error classifiers may diverge again
- Evidence: `classifyHttpFailure` (chat path) vs `classifyOpenAiFailure` (Responses path) already
  diverged once (balance/402 mapping, fixed in audit); duplicated transport (`sendWithPolicy` vs
  `sendRequest`) uses different redirect-range checks.
- Impact: a future mapping fix applied to one path silently misses the other. Likelihood: medium
  over a long maintenance tail.
- Recommended action: consolidate into a shared status table with per-dialect vendor-type hooks
  when the next mapping change arrives; until then the audit's regression tests pin both.
- Trigger: next error-mapping change.
- Owner layer: provider adapters.

### R-05 Official-provider live qualification still absent
- Evidence: OpenAI/DeepSeek/Xiaomi are `LIVE_NOT_RUN` (no credentials);
  `Docs/reports/STAGE_8_PROVIDER_LIVE_QUALIFICATION_REPORT.md`.
- Impact: wire behavior is deterministically tested but never confirmed against the real vendor.
- Recommended action: run `npm run qualify:{openai,deepseek,xiaomi}` when operator credentials
  exist; never block release on it.
- Trigger: credential availability.
- Owner layer: qualification harness / operator.

### R-06 Reference stores are in-process and uninstrumented
- Evidence: `InMemory*` stores (bounded after audit) have no persistence, no metrics export, no
  overflow alerting.
- Impact: restarts lose governance counters (accepted, documented); silent eviction under extreme
  volume. Likelihood: low at expected school-instance scale.
- Recommended action: host-provided durable stores for production; add eviction counters if volume
  grows.
- Trigger: production volume evidence.
- Owner layer: governance stores / host.

### R-07 FNV-64 fingerprint collision (theoretical wrong replay)
- Evidence: `packages/governance/src/idempotency.ts` — 64-bit FNV request fingerprint.
- Impact: a collision replays the wrong result. Likelihood: negligible (2^-64 per pair).
- Recommended action: none unless a collision is ever observed; then move to a wider hash (minor,
  additive).
- Trigger: observed collision.
- Owner layer: governance idempotency.

### R-08 Relay probe is declaration-only
- Evidence: relay `probe()` returns `HEALTHY` without network I/O (declared behavior).
- Impact: health display can read healthy while the relay is down (routing is unaffected — it
  never consults health; the breaker gates dispatch on real failures).
- Recommended action: document for operators; implement a real probe only if operators rely on
  the display.
- Trigger: operator confusion incident.
- Owner layer: relay adapter.

## P3 — explicitly deferred / no current need

### R-09 Streaming is single-attempt
Policy, kept deliberately (`RELIABILITY.md` §12). Revisit only with a consumer requirement +
  design (no silent fallback today by decision, not by omission).

### R-10 Capability manifest / runtime discovery duality
Two discovery surfaces exist; they agree today. Consolidate only if they diverge.

### R-11 Portability gate coverage (undeclared-deps, `.js` grep)
The tarball-content gate (added in audit) covers the proven leak class (maps/build-info). Deeper
  static scans only if a new leak class appears.

### R-12 ConfigManager direct-rollback vs plugin rebuild path
Direct `ConfigManager.rollback()` past a provider-shape change does not rebuild providers (only
  the plugin path does). Documented; no production path calls it directly.

## Deferred features (not risks, not debt)

Standalone gateway · new providers · new specialized capabilities · chat capability ·
tool-calling · embeddings · vision · UI/admin console · prompt-management UI · adaptive cost
routing · agent framework · marketplace · deployment redesign. Each needs a real consumer
requirement and a roadmap reopening (AGENTS.md §11).

## Tech-debt classification (explicit)

- **Not debt:** Relay `LIVE_QUALIFIED` standing on the historical record while the latest
  credential-less session is `LIVE_NOT_RUN` (by-design staleness semantics); `entry: null`;
  in-memory reference stores (documented port pattern).
- **Retired by this audit (were debt, now fixed):** ungoverned streaming; inert idempotency
  tuning; dead breaker retuning; store-wiping reloads; flag-only dispose; mixed-currency sums;
  dropped-zero usage; dead budget-currency check; snapshot-date pricing; `totalTokens`-only
  settlement; partial rate consumption; stale-leader `CONFLICT`; hanging joins; conservative
  settle on zero dispatch; silent `authScheme` drops; stale contract literals; sourcemap/
  build-info in tarballs.
