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

Note on shape: `ai.structured.generate` takes `input: { instructions, context[] }` with every
runtime value a labelled string binding. A **specialized** capability takes a typed `input`
object instead; its pack binds those fields into the primitive's `context[]` internally, and its
`inputAllowList` decides which keys may appear at all. That is why the `education.*` request
fixture looks different from the `ai.*` ones — both are correct for their capability.

## How each side uses them

| Side | Use |
| --- | --- |
| AI Bridge | run every fixture through `@aibridge/contracts`' parsers and assert `expect` + `reason`. |
| Consumer | run every fixture through **your own** parser (e.g. AlgoQuest's `parseIdeaEvaluation`, `parseGenericAiRequest`) and assert the same `expect` + `reason`. |
| Both | assert that no fixture contains anything resembling a credential. |

A change to a `FROZEN` fixture is a contract change and needs the three-step process in
[`../AGENTS.md`](../AGENTS.md) §8.
