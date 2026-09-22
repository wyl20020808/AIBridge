# AGENTS.md — working rules for AI Bridge

These rules exist because each one prevents a specific, expensive failure. Do not weaken one
without writing down the failure it stops preventing.

## 1. Host neutrality

`@aibridge/*` packages must not import `@ojplatform/*` or `@algoquest/*`, and must not import
anything from those repositories' source trees. Host-specific knowledge belongs in a
**separate adapter package** whose dependency arrow points one way.

Failure prevented: AI Bridge becoming unportable and silently un-maintainable outside the one
host it was born in.

Enforcement target: a coupling check script (Stage 2), modelled on
`scripts/check-adapter-coupling.mjs` in AlgoQuest.

## 2. No AlgoQuest dependency — and AlgoQuest must not depend on us

AlgoQuest does not import AI Bridge. AI Bridge does not import AlgoQuest. They meet only at
[`Docs/INTEGRATION_CONTRACT_V1.md`](Docs/INTEGRATION_CONTRACT_V1.md) and at the JSON fixtures
in [`Docs/fixtures/`](Docs/fixtures/).

Shared test material is **data** (JSON fixtures), never shared source.

Failure prevented: two products collapsing into one repository graph, so neither can be
released, tested or replaced independently.

## 3. Secrets never committed, never logged, never returned

No API key, base URL credential, bearer token, session token or `.env` with real values may be
committed, echoed into a log line, included in an error message, or projected into
`providerMetadata`. Config examples use placeholders only.

Any test that touches credentials asserts mechanically that they do not leak. See
[`Docs/TESTING.md`](Docs/TESTING.md) §2.

Failure prevented: one leaked key in a committed fixture or a stack trace becoming a billing
and privacy incident.

## 4. Provider raw errors are not a public contract

A provider's status prose, response body, headers or error string must never reach a consumer
plugin or a learner. Normalize to the closed error vocabulary in
[`Docs/ARCHITECTURE.md`](Docs/ARCHITECTURE.md) §6.

Failure prevented: consumers parsing "429 slow down" text, which changes whenever a vendor
rewords it.

## 5. Reject unknown majors. Never best-effort parse.

An envelope, a capability version or an output schema with an unsupported major version is
rejected with `INVALID_REQUEST` + `reason: CONTRACT_VERSION_UNSUPPORTED`. Do not "try to read
it anyway".

Failure prevented: a plausible-looking wrong answer reaching a child.

## 6. UI gate

No UI, no admin console, no React/Vue/CSS, no pages, in any stage until an approved design
exists and the gate is lifted in writing. Provider, model, key, routing and quota configuration
is file/config based until then.

If a task says "add a settings panel", the answer is: record the requirement in
[`Docs/ROADMAP.md`](Docs/ROADMAP.md) and stop.

## 7. Deployment-impact check

Any change must state explicitly whether it changes the production runtime. Changing
`deploy/`, `compose*.yaml`, any `.env.*` example consumed by a deployment, or a Windows
installer is **out of scope** for AI Bridge stages and requires a separate, explicitly approved
change to the host.

Failure prevented: an architecture change silently altering how a school's instance boots.

## 8. Parallel contract discipline

[`Docs/INTEGRATION_CONTRACT_V1.md`](Docs/INTEGRATION_CONTRACT_V1.md) is **frozen** so another
team can build against it without waiting for us. Changing a frozen field requires:

1. a written compatibility note in that document,
2. a version bump on the affected contract,
3. a fixture update in [`Docs/fixtures/`](Docs/fixtures/).

Do not freeze anything provider-specific (vendor model names, request/response shapes, SDK
types). Those are deliberately outside the contract.

## 9. Scope discipline

AI Bridge provides AI **capability**. It does not own teaching logic, learner identity, problem
business, judging, learning scores, business prompts, or arbitrary host data lookup. If a change
starts needing a host database read, it is out of scope — record the need as a host gap instead.

## 10. Keep the working tree clean

Every stage ends with `git status` clean and a report in `Docs/reports/`. Do not leave scratch
files, temp exports or inspection dumps in the repository.
