# AI Bridge — Provider Live Qualification

Stage 8. "The config declares a model supports streaming" is a claim. "This provider + model +
endpoint has been qualified through a repeatable live run" is evidence. This document is the model
that keeps the two apart.

Package: `@aibridge/qualification` (depends only on `@aibridge/contracts`; no host knowledge, no
sockets, no startup probes).

---

## 1. The assurance ladder

A model's support is never one boolean. Each `(provider, model, endpoint, feature)` sits somewhere
on a ladder, and a stronger rung is only reached by actually running the corresponding class of test.

| Status | Meaning | How it is reached |
| --- | --- | --- |
| `DECLARED` | The operator/config says the model supports the feature. | Configuration only. |
| `DETERMINISTIC_TESTED` | A deterministic test (fake transport, no network) proved it. | `evidenceClass: 'DETERMINISTIC'` probe. |
| `LIVE_QUALIFIED` | A **real** provider run against a **real** endpoint proved it. | `evidenceClass: 'LIVE'` probe. |
| `LIVE_FAILED` | A real run ran and failed. | Live probe returned a normalized failure. |
| `LIVE_NOT_RUN` | No credential / no run happened. **Not** a failure, **not** unsupported. | Credential absent (Phase 9/43). |
| `UNSUPPORTED` | The provider/model genuinely does not implement the feature. | A run proved it does not exist (never a mere absence). |
| `STALE` | A qualification existed but its identity no longer matches. | Staleness evaluation (§4). |

**Invariants (property-tested, `tests/properties/qualification-invariants.test.ts`):**

- A missing credential can only ever produce `LIVE_NOT_RUN` — never `LIVE_FAILED`, never
  `UNSUPPORTED`.
- One feature's `LIVE_QUALIFIED` never implies another feature.
- A stale qualification never keeps advertising `LIVE_QUALIFIED`.
- A qualification record is immutable historical evidence; a later health change never rewrites it.

## 2. Qualification identity

A qualification is only meaningful when bound to exactly what was qualified. The identity
(`QualificationIdentity`) binds: `providerId`, `providerFamily`, endpoint kind + cluster,
a **safe endpoint projection**, `modelAlias`, a **safe provider-model ref**, the feature, the
adapter version, the contract version and a **config digest**.

Safety is structural, not a filter:

- The endpoint is projected to `{ scheme, host, port? }` — **path, query string, userinfo and
  fragment are dropped**, so a credential embedded in a URL can never be recorded.
- The provider model id is recorded as a derived `providerModelSafeRef` (a shape hint + FNV-1a
  digest), never echoed verbatim.
- The config digest is a stable FNV-1a fingerprint over preset, endpoint, cluster, model ref and
  declared features — enough to detect drift, useless as a secret.

**Never present in an identity or a record:** an API key, `credentialRef` value, Authorization
header, raw base URL with secrets, prompt text, full AI response, reasoning content or learner data.

## 3. Record

`ProviderQualificationRecord` is a closed, safe shape:

```text
qualificationId · identity · status · qualifiedAt? · adapterVersion · contractVersion
configDigest · evidenceClass · latencyMs? · usageProjection? · finishReason?
safeFailureReason? · notes?
```

- `usageProjection` counts are non-negative integers; **unknown is absent, never 0** (Phase 20).
- `safeFailureReason` is drawn from the closed failure vocabulary (`CONFIG_FAILURE`, `AUTH_FAILURE`,
  `PROVIDER_FAILURE`, `CAPABILITY_MISMATCH`, `ADAPTER_BUG`, `NETWORK_ENVIRONMENT`).
- `notes` is a **closed set of codes** (`DECLARATION_MISMATCH`, `REPAIR_USED`, `USAGE_INCONSISTENT`,
  `CANCELLATION_VERIFIED`, `LAST_KNOWN_LIVE_QUALIFIED`, …) so no provider prose can be smuggled in.
- `validateQualificationRecord()` re-asserts that no secret-bearing key exists anywhere in the shape,
  so a malicious provider error body (Phase 39) cannot leak in.

## 4. Staleness and drift

A qualification is not permanent. It goes `STALE` when its identity no longer matches "now":

| Reason | Trigger |
| --- | --- |
| `PROVIDER_MODEL_CHANGED` | same alias, changed provider model id (Phase 36) |
| `ENDPOINT_CHANGED` / `CLUSTER_CHANGED` | endpoint or cluster drift (Phase 6) |
| `ADAPTER_VERSION_CHANGED` / `CONTRACT_VERSION_CHANGED` | implementation or contract moved |
| `CONFIG_DIGEST_CHANGED` | effective config changed |
| `MODEL_FEATURE_DECLARATION_CHANGED` | the feature is no longer declared |
| `AGE_EXCEEDED` | optional age bound (**no automatic expiry in V1** — Phase 6) |

`evaluateStaleness()` is pure: it compares a stored record to the current context and reports every
drift axis at once. It never mutates storage.

## 5. Storage

AI Bridge owns no host database (AGENTS.md §9). `QualificationStorePort` is the seam:

- `InMemoryQualificationStore` — the reference (default in tests and the runner).
- `FileQualificationStore` — an **explicitly non-secret, versioned, portable** dev store. The host
  supplies the read/write functions (`QualificationFileIo`), so the package binds to no filesystem.

Retention is bounded: at most N records per `(providerId, modelAlias, feature)`, newest first. There
are no unbounded append logs (Phase 37). Unknown document format versions are rejected, never
best-effort parsed (AGENTS.md §5).

## 6. The runner

`ProviderQualificationRunner` is the single orchestrator. It does **not** know provider wire formats:
the caller supplies a per-feature `FeatureProbe` that dispatches through the adapter/runtime. The
runner is responsible only for:

1. validating the request first (`CONFIG_INVALID`, never a failed dispatch — Phase 34);
2. turning credential absence into `LIVE_NOT_RUN`, never `LIVE_FAILED` (Phases 9/43/51);
3. timing the probe, normalizing the outcome to a safe record, and saving it;
4. never letting a probe failure abort the other features (Phase 43).

`deriveQualificationContexts(provider)` turns a structurally-typed provider config into one
`CurrentQualificationContext` per declared feature, so a host can feed its own config in without this
package depending on `@aibridge/runtime`.

## 7. Operator diagnostics

`getQualificationStatus({ store, contexts })` returns a safe per-provider/model/feature view: status,
staleness flag + reasons, last qualified time, latency, usage projection and a coarse safe failure
reason. It never returns a credential, prompt, raw response or reasoning content (Phase 30).

**Qualification ≠ health (Phase 31).** A model `LIVE_QUALIFIED` last night whose provider is now
returning 503 keeps its historical qualification; runtime health reports `DEGRADED`. The two are
never merged.

**Qualification does not drive routing (Phase 32).** Stage 8 stores metadata only. An optional
`QualificationPolicy` (`ALLOW_DECLARED` | `REQUIRE_DETERMINISTIC` | `REQUIRE_LIVE`) exists for a
future opt-in strict-routing stage; it **defaults to `ALLOW_DECLARED`** so a credential-less
development environment is never blocked, and nothing in Stage 8 consults it. Never auto-offline a
`LIVE_NOT_RUN` model.

## 8. Running qualification

Opt-in only — **never** part of `npm run verify`, never at AIBridge startup (Phases 54/55).

```text
npm run qualify:providers   # every provider that has credentials; others LIVE_NOT_RUN
npm run qualify:openai
npm run qualify:deepseek
npm run qualify:xiaomi
npm run qualify:relay
```

Credentials come from the **environment only** (`AIBRIDGE_LIVE_*`, see `TESTING.md` §Live), never
from source, fixtures, docs, a tracked `.env`, browser cookies or a ChatGPT session. Output is safe:
provider id, model alias, feature, status, latency, a usage summary and a coarse failure class. A
safe document is written to `tmp/qualification/live-qualification.json` (gitignored).

A missing credential for one provider reports `LIVE_NOT_RUN` and **does not** stop the others or the
stage (Phase 43). A provider's `LIVE_NOT_RUN` never fails `npm run verify` (Phase 56).

## 9. OpenAI policy

A ChatGPT / OpenAI **subscription** with web login is **not** an API credential. There is no cookie
handling, no session extraction and no internal-token plumbing. Without
`AIBRIDGE_LIVE_OPENAI_API_KEY`, OpenAI reports `LIVE_NOT_RUN`, which is an acceptable Stage 8
outcome and **not** an AI Bridge defect (Phase 41).

## 10. Freeze

Stage 8 adds qualification **metadata** only. It does not change `code.debug.analyze@1.0`, the
`promptApplied` / `promptVersion` semantics, consumer-managed prompt ownership, the trusted/untrusted
channel split, the OJPlatform specialized dispatch contract or the AlgoQuest compatibility contract.
`tests/qualification/integration-freeze.test.ts` fails mechanically if any of those move (Phase 47).
