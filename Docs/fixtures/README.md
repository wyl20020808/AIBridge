# Contract fixtures

Shared **compatibility data** for AI Bridge and its consumers. Strategy and rationale:
[`../INTEGRATION_CONTRACT_V1.md`](../INTEGRATION_CONTRACT_V1.md) §14.

## The one rule

> Fixtures are **data**. They are loaded and validated by each side's **own** parser.
> **No cross-repo source import, ever.**

Neither repository may import the other's code to "share a validator". Sharing the bytes and
disagreeing about them is exactly the failure these fixtures exist to catch.

## Fixture document shape

```json
{
  "fixtureSetVersion": "1.0",
  "binding": "FROZEN | ILLUSTRATIVE",
  "kind": "request | response",
  "expect": "accept | reject",
  "capability": "ai.structured.generate",
  "capabilityVersion": "1.0",
  "case": "short-machine-readable-case-name",
  "reason": "METADATA_NOT_ALLOWED",
  "document": { }
}
```

| Field | Meaning |
| --- | --- |
| `fixtureSetVersion` | version of this fixture set. Major-compatible, like everything else. |
| `binding: "FROZEN"` | must pass against any conforming implementation in major 1, forever. |
| `binding: "ILLUSTRATIVE"` | for scaffolding consumer plumbing. May change with a compatibility note. |
| `expect: "accept"` | a conforming parser must accept `document`. |
| `expect: "reject"` | a conforming parser must reject `document`. |
| `reason` | present on `reject` fixtures: the exact `AiError.reason` expected. |

`binding: "FROZEN"` + `expect: "reject"` is the strongest guarantee in the set: two
implementations cannot both be "right" while disagreeing about a rule.

## Files

### `ai.structured.generate` — FROZEN

| File | Expect | Asserts |
| --- | --- | --- |
| `ai.structured.generate.request.ok.json` | accept | the canonical request: two channels, an untrusted binding, a REF output schema |
| `ai.structured.generate.request.unknown-metadata.json` | reject | deny-by-default metadata (`METADATA_NOT_ALLOWED`) |
| `ai.structured.generate.request.secret-input.json` | reject | a credential in `context[]` is refused (`SECRET_LIKE_INPUT`) |
| `ai.structured.generate.response.ok.json` | accept | the canonical success envelope and its safe projection |
| `ai.structured.generate.response.schema-mismatch.json` | accept | a **valid FAILED envelope** — the error model is part of the contract too |
| `ai.text.generate.response.ok.json` | accept | the text primitive's success envelope |

### `education.idea.evaluate` — ILLUSTRATIVE

| File | Expect | Asserts |
| --- | --- | --- |
| `education.idea.evaluate.request.ok.json` | accept | specialized request scaffolding |
| `education.idea.evaluate.response.ok.json` | accept | specialized response scaffolding |
| `education.idea.evaluate.response.unavailable.json` | accept | the degradation path a consumer must handle on day one |

The specialized schema is provisional
([`../INTEGRATION_CONTRACT_V1.md`](../INTEGRATION_CONTRACT_V1.md) §5.4). Consumers must keep it
behind one adapter boundary so a schema change is a one-file change.

### `code.debug.analyze@1.0` — ILLUSTRATIVE

| File | Expect | Asserts |
| --- | --- | --- |
| `code.debug.analyze.compatibility.json` | accept | additive version and logical/primitive identity mapping, including a colon-delimited idempotency key |
| `code.debug.analyze.request.ok.json` | accept | consumer-composed prompt provenance and untrusted source/diagnostic contexts |
| `code.debug.analyze.request.provenance-invalid.json` | reject | required prompt provenance pair (`MALFORMED_ENVELOPE`) |
| `code.debug.analyze.request.trust-invalid.json` | reject | source code cannot be labelled trusted (`MALFORMED_ENVELOPE`) |
| `code.debug.analyze.response.ok.json` | accept | closed diagnostic result with context-bound line references |
| `code.debug.analyze.response.output-reference-invalid.json` | reject | line reference exceeds supplied context (`SCHEMA_VALIDATION_FAILED`) |

The debug request parser restricts context to an untrusted `sourceCode` string and optional
untrusted `diagnostics` string. The response fixtures carry a `validationInput` companion so each
implementation can check references against the supplied context; this companion is fixture
metadata, not part of the response envelope. These fixtures are illustrative compatibility data,
not evidence of host qualification.

Note on shape: `ai.structured.generate` takes `input: { instructions, context[] }` with every
runtime value a labelled string binding. The broader specialized-pack proposals use
capability-defined typed inputs; the commissioned `code.debug.analyze@1.0` foundation retains the
two-channel structure and restricts `context[]` to an untrusted `sourceCode` string and optional
untrusted `diagnostics` string. Thus the illustrative `education.*` request fixture differs from
both the generic `ai.*` and commissioned debug request shapes — each follows its declared boundary.

## How each side uses them

| Side | Use |
| --- | --- |
| AI Bridge | run every fixture through `@aibridge/contracts`' parsers and assert `expect` + `reason`. |
| Consumer | run every fixture through **your own** parser (e.g. AlgoQuest's `parseIdeaEvaluation`, `parseGenericAiRequest`) and assert the same `expect` + `reason`. |
| Both | assert that no fixture contains anything resembling a credential. |

A change to a `FROZEN` fixture is a contract change and needs the three-step process in
[`../AGENTS.md`](../AGENTS.md) §8.
