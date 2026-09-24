# AI Bridge — Security

AI Bridge sits between plugins that hold learner text and vendors that hold learner text. Every
boundary in this document exists to make one of those two crossings deliberate.

Scope note: AI Bridge is **not** a DLP product and does not claim to be. What it claims is a set
of mechanical, testable boundaries — and the tests to prove them
([`TESTING.md`](TESTING.md) §2).

> **Stage 3 status.** Several boundaries in this document are now enforced in code rather than
> described. The consumer/trusted split is `parseConsumerAiRequest` (which rejects `callerPluginId`,
> `subjectToken` and `permissions` with `TRUSTED_FIELD_IN_CONSUMER_REQUEST`) plus the
> host-injected `TrustedDispatchContext` (§4). Input safety is `screenAiInput` in `@aibridge/core`
> (§3): size → secret rejection → PII redaction. `scripts/check-no-secret-leak.mjs` scans every
> committed file for credential shapes, with exactly one allow-listed synthetic fixture. The
> response projection that excludes provider internals is a closed key set with an absence test
> (§6). What is **not** yet implemented is listed in [`PROJECT_STATUS.md`](PROJECT_STATUS.md).
>
> **Stage 3 adds the trusted secret boundary in code.** A credential exists only inside the runtime
> boundary: a `credentialRef` (`secret://…`) is resolved through the host's `SecretStorePort` at
> provider-registration time and handed to the adapter's `bindCredentials` over one trusted channel
> (`TrustedCredentials`). The value is held in a private field, excluded from `JSON.stringify` and
> `toString()`, placed only in the outbound `Authorization` header, and never present in a
> `ProviderRequest`, an `AiResult`, an `AiError`, a stream event, a snapshot or the operator log —
> each of which is asserted by the secret-leakage regression tests
> ([`TESTING.md`](TESTING.md) §2.1), including the worst case of a provider error body that echoes
> the key back. The operator channel (§6.2) now exists (`OperatorLogSink`) and its detail is
> credential-stripped, PII-stripped and truncated at the sink. The gate is proven to fail when
> deliberately broken (a planted credential-shaped file makes `check-no-secret-leak.mjs` exit 1 —
> asserted as a test and re-run manually for the Stage 3 report).

> **Stage 4 extends the boundary to the provider suite.** (a) **SSRF posture** (§2.4): a provider
> base URL comes only from trusted operator configuration and is validated fail-closed — HTTPS,
> no embedded credentials, no loopback/private/link-local/cloud-metadata targets (including
> integer IPv4 encodings), bounded redirects with every target re-validated; development-only
> relaxation defaults to off. A consumer request can never carry a URL, host or endpoint.
> (b) **Reasoning isolation**: chain-of-thought (`reasoning_content`, reasoning items/deltas) is
> read and discarded at the adapter boundary — never output, persisted or forwarded.
> (c) **Malicious provider errors**: a vendor error body deliberately echoing the credential,
> learner-like PII and a stack trace is sanitized on every consumer-reachable surface — tested for
> all four providers. (d) `ProviderDiagnostic` is credential-free by construction (handles only).
> (e) Live credentials enter only from the environment; web sessions, cookies and subscription
> logins are explicitly out of scope and no code touches them.

> **Stage 5 status.** The governance layer holds the same line. Every governance store — usage
> ledger, metrics, operational events, breaker/health state, quota and rate state, config history —
> is mechanically scanned for secrets, prompts, learner text, raw output and reasoning content
> (`tests/security/governance-privacy.test.ts`). Subject tokens appear only as `hashSubjectToken`
> output (`subjectHash`), never the token. Config snapshots hold `credentialRef` **handles** only; a
> raw credential fails validation. Idempotency request fingerprints are **hashed** before storage
> (`hashRequestFingerprint`) — a raw digest embeds the input, and the replay cache is not a prompt
> archive. One boundary is stated, not hidden: the idempotency replay cache holds the
> **consumer-visible result**, because a replay must be faithful (frozen §10.2). It is
> retention-limited in-memory state, **never a log** — and it may not contain credentials, prompts,
> reasoning content or raw errors (asserted).

---

## 1. Trust boundaries

```
   ┌────────────────── Host trust boundary ──────────────────┐
   │                                                         │
 consumer plugin ──▶ host broker ──▶ AI Bridge ──▶ provider  │──▶ vendor
   (untrusted        (identity,      (envelope,     adapter
    task data)        permission,    safety,        (secrets
                      subject)       routing)        live here)
   │                                                         │
   └─────────────────────────────────────────────────────────┘
```

| Boundary | What crosses | What must not |
| --- | --- | --- |
| consumer → AI Bridge | `AiRequestEnvelope` + task data the consumer already holds | host data handles, credentials, session tokens, policy overrides |
| AI Bridge → provider adapter | prompt messages, bound fields, output format instruction, model ref, deadline | consumer identity, `subjectToken`, `callerPluginId` verbatim |
| provider adapter → AI Bridge | text / structured candidate, usage, mapped error category | raw vendor error text into any public field |
| AI Bridge → consumer | `AiResult` with the closed projection | model names, endpoints, keys, raw errors, raw payloads |

The provider adapter is the **only** component that may hold a credential, and it is the only
component that may see a vendor's raw response.

---

## 2. Secret management

### 2.1 The invariant

> Provider credentials are **server-side only**. They never enter a browser bundle, a consumer
> plugin, AlgoQuest, a request envelope, a response, or a log line.

"Server-side" here means: a process that is not reachable from a browser, and not shipped in any
static asset.

### 2.2 Where a key may live

| Source | V1 verdict | Note |
| --- | --- | --- |
| **Host secret store** | **preferred** | AI Bridge holds `apiKeyRef: "secret://…"` and resolves it at call time. Ideally the bridge never sees the value. |
| **Environment variables** | acceptable | for a single-instance deployment. Config uses indirection (`${AIBRIDGE_MAIN_API_KEY}`), never a literal. |
| **Encrypted config file** | acceptable | where no secret store exists. The decryption key is supplied out of band, never beside the file. |
| Browser bundle / client config | **never** | |
| Consumer plugin package | **never** | |
| Request / response envelope | **never** | [`ARCHITECTURE.md`](ARCHITECTURE.md) §4.1 |
| Logs, traces, metrics labels | **never** | §6 |
| Git, fixtures, docs, test snapshots | **never** | [`TESTING.md`](TESTING.md) §2.1 |

Nothing is implemented in Stage 1. This is the design the implementation must satisfy.

### 2.3 Handling rules

- A credential is read once at config load into process memory and never serialized.
- A credential is never placed in a URL query string (it lands in proxy logs and `Referer`).
- Redaction is applied at the **logging sink**, not at each call site — a call site that forgets
  must not be able to leak.
- `apiKeyRef` is a reference. A config file that fails validation because it contains a literal
  key-shaped value is rejected outright (`check-no-secret-leak.mjs`).

---

## 3. Input safety boundary

### 3.1 Size limits

| Limit | Default | On breach |
| --- | --- | --- |
| `maxInputBytes` | 32 768 | `INVALID_REQUEST` / `INPUT_TOO_LARGE` |
| `maxOutputBytes` | 65 536 | `OUTPUT_TOO_LARGE` |
| per-string field `maxLength` | per `FieldSpec` | truncate + `INPUT_TRUNCATED`, or reject per policy |
| `metadata` serialized size | 512 bytes | `INVALID_REQUEST` / `METADATA_NOT_ALLOWED` |

Size is checked **before** the payload is priced, sent or logged. A limit that is only enforced
after the provider bills for it is not a limit.

### 3.2 Secret-like material — **reject**

Reject with `INVALID_REQUEST` / `SECRET_LIKE_INPUT`. Never forward, never redact-and-continue.

Patterns, at minimum:

- bearer / authorization headers and `api_key=…`, `sk-…`, `ghp_…`, `AKIA…`, `xox[baprs]-…`
- PEM / PKCS private key blocks
- JWT-shaped triplets (`eyJ…`)
- long high-entropy strings presented as `token`, `secret`, `password`, `credential`

**Rationale for reject-over-redact on secrets:** forwarding a secret to a third-party model is an
irreversible disclosure. Redaction is a heuristic and will miss variants; rejection is a
decision the caller can see and act on. Silently scrubbing also hides that a caller is
mis-handling credentials.

### 3.3 PII categories — **redact**, then warn

Redact and continue with `warnings: [{ code: 'INPUT_REDACTED' }]`:

- email addresses
- phone numbers
- national-id-shaped digit runs
- postal addresses where detectable

**Rationale for redact-over-reject on PII:** a learner pasting a phone number into an idea
description is not misusing a credential; rejecting their turn would punish them for the
platform's data policy. Removing the number preserves the learning intent.

Additional rules:

- `session ids`, cookies and raw auth tokens are treated as **secret-like** (§3.2), not PII.
- AI Bridge keeps **no** PII store. It has nothing to look an identity up in and must not
  acquire one.

### 3.4 Metadata allow-list

Exactly `locale`, `traceId`, `surface`, `correlationId`
([`ARCHITECTURE.md`](ARCHITECTURE.md) §4.2). Unknown key ⇒ reject. Deny-by-default is testable;
silent dropping is not.

### 3.5 Context security — deny by default

> AI Bridge **must not** read host data. Not the user database, not the problem database, not
> the judge database. Not to "enrich" a prompt. Not to "improve quality". Not at all.

Rules:

1. A consumer sends only a `ContextBundle` it is **already permitted to hold**. Whatever the
   consumer may legitimately see is what may reach the model — no more.
2. AI Bridge has no host data client in its dependency graph. If a change needs one, it is out of
   scope ([`AGENTS.md`](../AGENTS.md) §9) and becomes a host gap instead.
3. Specialized capabilities declare an **`inputAllowList`** (§[`CAPABILITIES.md`](CAPABILITIES.md)
   §5.2). An input key outside it is rejected. Deny by default.
4. `code.*` capabilities must never receive hidden testcases, reference answers, checker
   internals or judge secrets. The allow-list makes this a type error rather than a code review
   question.

The security property being bought: an over-broad consumer cannot turn AI Bridge into a
confused-deputy reader of host data.

### 3.6 Prompt-injection resistance

The envelope carries two channels
([`ARCHITECTURE.md`](ARCHITECTURE.md) §11.2):

- the **instruction channel** is authored and versioned (policy + prompt strategy + output format
  instruction);
- the **data channel** holds every runtime value, each flagged `untrusted`.

A value flagged `untrusted: true` is rendered as delimited data and never concatenated into an
instruction. A learner's free text therefore cannot rewrite the policy **by construction**, not
by being scanned for the word "ignore".

---

## 4. Caller identity — `callerPluginId`

> `callerPluginId` must be bound by the host plugin runtime. It must **not** be forgeable by a
> browser, by a query parameter, or by a self-declared field in a request body.

Requirements recorded for the host ([`ARCHITECTURE.md`](ARCHITECTURE.md) §25.2 gap #2):

1. The host mints the identity at the plugin load/activation boundary and attaches it to every
   outbound capability call.
2. The transport carries it in a channel the plugin cannot write to (in-process parameter
   injection, or a host-signed assertion over HTTP).
3. AI Bridge **rejects** a call whose `callerPluginId` is absent or unverified
   (`PERMISSION / CALLER_NOT_PERMITTED`). It never falls back to trusting a self-declared value.

Until the host provides this, AI Bridge enforces at **registry level** (a caller may only invoke
capabilities it declared) and records that per-caller attribution is *not yet trustworthy*. Being
honest about that is itself a security control.

---

## 5. Permission model

Not every plugin may call arbitrary AI.

```
consumer manifest ──declares──▶ capability ids
        │
        ▼
   HOST decides allow / deny          ← the authority is the host
        │
        ▼
   AI Bridge enforces again           ← defence in depth
```

### 5.1 Consumer manifest declaration

```json
"capabilities": {
  "requires": ["ai.structured.generate", "education.idea.evaluate"],
  "optional": ["education.hint.generate"]
}
```

A consumer declares what it may use. Anything undeclared is denied.

### 5.2 AI Bridge's own enforcement

Even with a permissive host, AI Bridge checks:

| Check | Failure |
| --- | --- |
| `callerPluginId` present and verified | `PERMISSION / CALLER_NOT_PERMITTED` |
| capability declared for this caller | `PERMISSION / CALLER_NOT_PERMITTED` |
| capability exists and major is supported | `ENVELOPE / CAPABILITY_UNKNOWN` or `CAPABILITY_VERSION_UNSUPPORTED` |
| capability not switched off | `GOVERNANCE / KILL_SWITCH_CAPABILITY` |
| `subjectToken` present when a subject dimension is configured | `PERMISSION / SUBJECT_MISSING` |
| `policyId` registered for this capability | `ENVELOPE / MALFORMED_ENVELOPE` |

### 5.3 Capability selection is not policy override

A consumer may pass `policyId` to **select** a registered policy. It may never supply policy
content, add a rule, remove a rule, raise a size limit, or widen `forbiddenOutput`. A
`policyId` that does not exist for the requested capability is a hard error.

---

## 6. Logging and redaction

### 6.1 Defaults

| Data | Default |
| --- | --- |
| full prompt | **not logged** |
| full response | **not logged** |
| learner free text | **never logged** |
| byte counts, token counts, timings, statuses, error codes | logged |
| `callerPluginId`, `capability`, `capabilityVersion`, `policyId` | logged |
| `subjectToken` | **hashed only** |
| `modelRef` | operator-only channel |

Retention defaults to `METADATA_ONLY`
([`ARCHITECTURE.md`](ARCHITECTURE.md) §16.3). `CONTENT` requires an explicit operator decision
and a documented retention window.

### 6.2 Provider raw errors

A provider's raw message may be written to the **operator-only** diagnostic channel, and only
after:

- credential stripping (§2.3),
- truncation to a fixed bound,
- removal of request/response bodies beyond the error field.

It is never written to a consumer-facing log, never returned, and never rendered in UI.

### 6.3 Redaction placement

Redaction runs at the **sink** (the logger/telemetry exporter), not at call sites. A call site
that forgets to redact must still be unable to leak.

### 6.4 Telemetry labels

Metrics labels may carry `capability`, `capabilityVersion`, `providerId`, `modelClass`, `status`,
`errorCode`. They must not carry `subjectToken`, `requestId` values of learner content, prompt
text, or `modelRef`. A label cardinality explosion is a mild incident; a label carrying a
learner's sentence is a serious one.

### 6.5 Qualification records (Stage 8)

The provider live-qualification model (`@aibridge/qualification`) produces durable records that an
operator may keep, diff and copy between checkouts. Their safety is **structural**, not a filter:

- An endpoint is projected to `{ scheme, host, port? }` — path, query string, userinfo and fragment
  are dropped, so a credential embedded in a URL can never be recorded.
- The provider model id is recorded as a derived safe ref, never echoed verbatim.
- The record has **no field** for prompt text, a full AI response, reasoning content, an API key, an
  Authorization header or learner data. `validateQualificationRecord()` re-asserts this so a
  regression that widens the shape is caught.
- `safeFailureReason` is a closed classification, and `notes` is a closed set of codes — a provider's
  raw error prose (which may echo a credential, PII or a stack trace) has nowhere to land.
- CLI output and `getQualificationStatus()` expose provider id, model alias, feature, status, latency,
  a usage summary and a coarse failure class only.

These are asserted by `tests/qualification/security.test.ts` (a deliberately poisoned provider error
body) and the qualification property/fuzz suites ([`TESTING.md`](TESTING.md) §1.3).

---

## 7. Output safety — structural vs business

### 7.1 AI Bridge owns **structural** safety

| Control | Where |
| --- | --- |
| output conforms to the declared schema | [`ARCHITECTURE.md`](ARCHITECTURE.md) §11.4 |
| output size caps | §3.1 |
| malformed / unparseable output handling | `INVALID_RESPONSE` / `SCHEMA_MISMATCH` |
| provider error non-penetration | §6.2 |
| `forbiddenOutput` **rule checking** at the capability layer | [`CAPABILITIES.md`](CAPABILITIES.md) §5.2 |

### 7.2 Business safety belongs to the capability policy **and** the consumer's final guard

"Never give a child the complete answer" is not a structural property. It is a rule of
`education.idea.evaluate`'s policy, and it is **also** the consumer's responsibility to enforce
as a final guard on the answer it renders.

> Two independent guards, deliberately. A capability policy is written by one team and versioned
> once; a consumer's guard is written by the team that knows what a child will see. Neither
> replaces the other.

`declaresSolution` is a **self-report**, screened and never trusted
([`CAPABILITIES.md`](CAPABILITIES.md) §7.1). A model claiming it did not reveal a solution is
evidence of nothing.

Do not push business safety into the generic bridge: that is how `ai.structured.generate` grows
one product's rules and stops being reusable.

---

## 8. Abuse, cost and denial-of-wallet

| Threat | Control |
| --- | --- |
| one learner exhausting a school's budget | per-subject rate limit + quota (§[`ARCHITECTURE.md`](ARCHITECTURE.md) §15) |
| one plugin making unbounded calls | per-caller rate limit + quota; `maxCallsPerTurn: 1` per capability |
| a caller inflating cost with a huge prompt | `maxInputBytes`, checked pre-dispatch |
| a caller inflating cost with a huge request for output | `maxOutputBytes`, `maxOutputTokens` |
| a caller hopping providers to escape a quota | `fallbackOnQuotaExceeded` defaults **false** |
| retry amplification | bounded retry (§[`ARCHITECTURE.md`](ARCHITECTURE.md) §10.3), repair capped at one |
| billing duplication on transport retry | `idempotencyKey` (§14) |
| duplicate billing on retry | unknown-outcome retry requires `supportsReliableIdempotency` |
| denial of wallet via fallback chains | one shared overall deadline + shared cost budget |
| a throttled caller becoming an abusive one | in-process retry of `RATE_LIMITED` is discouraged; `retryAfterMs` is returned instead |
| emergency stop | three kill switches (§20) |

---

## 9. Threats explicitly out of scope

Stated so nobody assumes coverage:

- **Model output correctness.** A wrong answer is not a security boundary breach. Consumers must
  not treat a validated schema as validated truth.
- **Jailbreak-proofing.** §3.6 buys *structural* resistance, not immunity.
- **Vendor-side retention and training.** Governed by configuration and by the capability's
  declared `dataUse`/`retention` metadata, not controlled by AI Bridge.
- **Host compromise.** A host that mints a false `callerPluginId` defeats §4. Host identity is a
  host responsibility.
- **Multi-tenant isolation inside one subject.** The subject token is opaque; AI Bridge cannot
  tell two learners in one classroom apart beyond it.
