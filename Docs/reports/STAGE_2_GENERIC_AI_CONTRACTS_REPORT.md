# AI BRIDGE V1 — STAGE 2

**`AIBRIDGE_STAGE_2 = PASS`**

Stage 2 = **generic AI contracts**. The Stage 1 architecture and the frozen parallel contract were
turned into compilable, runtime-validated, tested, portable, independently-consumable packages. No
real provider, no API key, no network call, no production runtime change, no UI, no host
modification.

---

## REPOSITORY

`D:\OJPlatformPlugins\AIBridge` — independent Git repository, `main`. `npm` workspaces, `"type":
"module"`, `module`/`moduleResolution: NodeNext` with explicit `.js` import specifiers, TypeScript
project references and a root `tsc -b`. Toolchain pinned: `typescript@5.9.3`, `vitest@3.2.7`,
`@types/node@22.20.4`; Node pinned by `.nvmrc` (`22.20.0`) and `engines`
(`>=22.0.0 <23.0.0`). `package-lock.json` is committed and resolves to `registry.npmjs.org`.

Strict TypeScript: `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`,
`noImplicitOverride`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, `noUnusedLocals`,
`noUnusedParameters`, `verbatimModuleSyntax`, `types: []`.

---

## PACKAGES

Three packages, one-way arrows:

```
@aibridge/contracts   (zero runtime dependencies)
        ▲
@aibridge/core        (contracts)
        ▲
@aibridge/host-sdk    (contracts, core)
```

- `packages/contracts` — versions, envelopes, error model, strict parsers, capability/descriptor
  types, the `aibridge.fields/v1` dialect, extraction/validation/repair.
- `packages/core` — input-safety boundary, structural output safety, `CapabilityRegistry`,
  `AiCapabilityDirectory`, kill switches, provider/model registries.
- `packages/host-sdk` — host port interfaces, in-memory + mutant fakes, scripted provider,
  host/provider conformance kits.

`contracts` declares **no runtime dependencies** and touches no DOM, Node API, filesystem, network
or `process.env`. Enforced by `scripts/check-runtime-deps.mjs` and the portability gate.

---

## REQUEST

`ConsumerAiRequest` (consumer half) and `TrustedDispatchContext` (host half), composed by
`composeAiRequest`.

- `parseConsumerAiRequest` is the **security boundary**. It rejects `callerPluginId`,
  `subjectToken`, `grantedPermissions`, `permissions`, `hostRequestId`, `principal`,
  `verifiedCaller` with `INVALID_REQUEST` / `TRUSTED_FIELD_IN_CONSUMER_REQUEST` — before reading any
  field, even when valid fields are also present.
- Provider-shaped/override-shaped fields (`apiKey`, `baseUrl`, `model`, `providerId`,
  `systemPrompt`, `policy`, `messages`, …) are `MALFORMED_ENVELOPE`. Unknown fields are rejected.
- `metadata` is a closed allow-list of exactly four keys; unknown key ⇒ `METADATA_NOT_ALLOWED`.
- `AiRequestEnvelope` (both halves, the frozen wire shape) parses for the trusted channel and for
  fixtures; it never grants a consumer authorship of host-bound fields.

---

## RESPONSE

`AiResult` with a **binary** `status`. Invariants enforced by `parseAiResult`: `SUCCEEDED` must carry
a validated `output` and must not carry `error`; `FAILED` must carry `error` and must not carry
`output`. **No partial results.** `usage` is all-optional and `estimatedCost` stays optional (absent
means unknown, not zero). `providerMetadata` is a closed safe projection; the excluded keys
(`modelRef`, `endpoint`, `rawResponse`, `subjectToken`, …) have an absence test. `finishReason` is
closed (`STOP | LENGTH | CONTENT_FILTER | UNKNOWN`). Warnings are the frozen eight-code set.

---

## ERRORS

The twelve codes and the closed stage/reason sets. `REASON_META` is the single
`reason → (code, stage, retryable)` table; `makeAiError` fills from it so the tables cannot drift.
`retryable` is authoritative for the caller. `FALLBACK_BY_CODE` / `fallbackEligibility` encode the
frozen rule: a request/content property is never retried on another provider.

Stage 2 additions (recorded in the frozen contract's compatibility note): stage `INTERNAL`; reasons
`TRUSTED_FIELD_IN_CONSUMER_REQUEST`, `OUTPUT_SCHEMA_OVERRIDE_FORBIDDEN`, `JSON_PARSE_FAILED`.
`AiError.details` is deny-by-default per reason. **The non-penetration rule holds structurally:** no
provider message, status, body or header appears in any exported type; only a mapped
`providerCategory` may cross.

---

## CAPABILITIES

Two V1 generic primitives registered as **metadata** (no handler, no execution): `ai.text.generate`
and `ai.structured.generate`. `CapabilityRegistry` is idempotent for a byte-identical
re-registration and `CONFLICTING_REGISTRATION` otherwise. `AiCapabilityDirectory` applies governance
and reports `AVAILABLE | DEGRADED | UNAVAILABLE | DISABLED` — `DISABLED` ≠ `UNAVAILABLE`.
`maxCallsPerTurn` breach is `POLICY / POLICY_VIOLATION` with `details.rule = 'maxCallsPerTurn'`.
Descriptors expose no provider ids, model names, prices or endpoints.

---

## SCHEMA

`aibridge.fields/v1` field table — six frozen types, `required`, `description`, optional
`untrusted`/`maxLength`; `REF` or `INLINE`. Unknown dialect or unsupported major ⇒
`OUTPUT_SCHEMA_UNSUPPORTED`. **Schema ownership is locked:** only `ai.structured.generate` allows a
caller `outputSchema` (`CALLER`); every other capability owns its input, output and policy schema,
and a caller override is `OUTPUT_SCHEMA_OVERRIDE_FORBIDDEN`. Extraction is fenced → balanced span →
plain → `EXTRACTION_FAILED`, with `JSON_PARSE_FAILED` kept distinct. Validation never coerces types
and never yields a partial object. Repair is one bounded attempt, contract-only. `INTEGER`/`ENUM`
were evaluated and recorded as a proposed `fields/v2` gap — the frozen `v1` is unchanged.

---

## SECURITY

- **Secrets:** `scripts/check-no-secret-leak.mjs` scans every committed file for credential shapes;
  one synthetic fixture is allow-listed by name. `screenAiInput` rejects secret-shaped input
  (`SECRET_LIKE_INPUT`) and redacts PII (`INPUT_REDACTED`) after a size check. The in-memory secret
  store excludes its values from `JSON.stringify`/`toString`.
- **Identity:** host-bound, non-forgeable; `null` from the identity port is honest and leads to
  `CALLER_NOT_PERMITTED`. `subjectToken` is opaque; identity-shaped tokens are refused.
- **Projection:** provider internals and `subjectToken` cannot appear in the consumer projection.
- **Tests:** `tests/security/boundaries.test.ts` and the host-conformance kit assert the
  mechanically checkable boundaries above.

---

## MODEL

Five V1 profiles: `fast`, `balanced`, `reasoning`, `cheap`, `high-context`. `vision` is reserved and
out of scope for V1. Requirements narrow a route and never name a model; `streaming`/`vision`
`true` is unsatisfiable (no quiet downgrade). Provider/model registries hold **descriptions only**.

---

## CORE

Input safety (size → secret reject → PII redact), output safety (structural only; business safety
belongs to a capability policy and the consumer's guard), `CapabilityRegistry` + directory, three
kill switches with `global → capability → provider` precedence, provider/model registries, and
dependency-free helpers. No concrete provider, host or consumer.

---

## HOST SDK

Ports split by sync/async; `makeInMemoryHost()` plus mutant hosts each wrong in exactly one way, so
the host conformance kit can be shown to **fail** on a bad host. `ScriptedProviderAdapter` drives
the pipeline with no network. `runHostConformance` never throws; `runProviderConformance` runs
adapter-agnostic cases. Two `TESTING.md` §1.1 cases (no vendor type escapes, no secret escapes) are
enforced statically by the coupling gate, strict typecheck and the projection test.

---

## FIXTURES

Nine documents in `Docs/fixtures/fixture-set.v1/` (six `FROZEN`, three `ILLUSTRATIVE`).
`tests/fixtures/fixtures.test.ts` runs each through the repo's own parser and asserts the declared
`expect` + `reason`: request fixtures via `parseAiRequestEnvelope` (plus `screenAiInput` for the
`secret-input` case), response fixtures via `parseAiResult`. Exactly one fixture contains a
credential-shaped value and it is the allow-listed synthetic one.

---

## PORTABILITY

No `@ojplatform/*` or `@algoquest/*` dependency in any package, and no cross-repo source import.
`npm run check:portability` builds, `npm pack`s all three packages, installs them **offline** into
an isolated project, typechecks a consumer with **no `node` types**, and runs a runtime smoke with
nine assertions; the scratch directory is removed on success and on failure. The coupling gate
(`scripts/check-adapter-coupling.mjs`) fails the build on any host/consumer coupling.

---

## TESTS

`npm run verify` = strict typecheck (`tsc -b` + test typecheck) → gates → tests → build →
portability.

- **18 test files / 139 tests**, all passing.
- `tests/contracts/` (63): versions, error-model, request, schema, response, structured, killswitch.
- `tests/core/` (36): input-safety, output-safety, registry, providers, directory.
- `tests/host-sdk/` (16): fakes, host-conformance, provider-conformance.
- `tests/security/` (9): boundary tests.
- `tests/properties/` (4): invariants.
- `tests/fixtures/` (11): the fixture runner.
- Secret-leak gate: 100 files scanned, one named allow-listed fixture.

---

## DEPLOYMENT

**Production runtime changed: NO.** No `deploy/`, `compose*.yaml`, `.env.*` example or Windows
installer was touched. `plugin.manifest.json` declares `"deploymentImpact": "NONE"` and still has
`"entry": null`.

---

## AI

**Real provider: NOT CONNECTED.** No API key, no base URL, no network call, no provider SDK import.
`AiProviderAdapter` is a port only; `ProviderRequest` is AI Bridge's own shape. There is no routing,
retry, fallback, quota persistence or usage database.

---

## UI

**UI: NOT ALLOWED.** No UI, admin console, React/Vue/CSS or page was added. Future admin
configuration is recorded in [`../ROADMAP.md`](../ROADMAP.md); configuration stays file-based.

---

## WORKBENCH

**Stage 1: PASS. Stage 2: PASS.**

Stage 3 — **OpenAI-compatible provider** — is next and is **not started**: `@aibridge/provider-openai-compatible`, a probed provider profile, and the provider conformance kit's fixture-injection
port. Per instruction, Stage 3 does not begin in this session.

---

## GIT

**Path:** `D:\OJPlatformPlugins\AIBridge`. **Branch:** `main`. **Remote:** none created.

Stage 2 landed as a series of logical commits (toolchain and workspace; contracts; core; host-sdk;
gates and portability; tests and fixtures; CI; docs and report). Working tree clean at the Stage 2
commit.

**Status:** `AIBRIDGE_STAGE_2 = PASS`.
