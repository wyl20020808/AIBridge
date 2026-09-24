# Host Integration

How a **host** binds AI Bridge as a server-side capability provider. Written for the OJPlatform
Stage 6 integration and for every host after it. Names no host's internals on the AI Bridge side:
everything a host supplies arrives through the ports in
[`@aibridge/host-sdk`](../packages/host-sdk/src/ports.ts) and the plugin entry in
[`@aibridge/host`](../packages/host/src/plugin.ts).

## 1. What a host installs

AI Bridge is consumed as **npm-packed artifacts**, never as a source-tree dependency:

- `@aibridge/host` — the host-bindable plugin entry (`createAiBridgeServerPlugin`);
- `@aibridge/suite-all` — the complete adapter factory table and preset endpoint resolution
  (a host wanting a subset passes a filtered table; a private gateway uses
  `OPENAI_COMPATIBLE_CUSTOM` from the same table);
- their dependency closure (`contracts`, `core`, `host-sdk`, `governance`, `runtime`, the four
  provider packages) — 11 packages in total.

Produce and qualify the tarballs with:

```sh
npm run build
node scripts/qualify-packed-host.mjs
```

The qualification packs every package, installs the tarballs into a clean prefix (the exact
operator path), boots the packed plugin and drives a real `execute` against a loopback
OpenAI-compatible fake — asserting SUCCEEDED with usage and the resolved credential, idempotent
replay with no second dispatch, kill-switch gating through an atomic reload, and disposal. No
repo aliases, no source imports, no network beyond loopback.

## 2. What a host supplies

`createAiBridgeServerPlugin(options)`:

| Option | Shape | Notes |
| --- | --- | --- |
| `config` | `{providers, routes, governance}` | Trusted operator document. Validated at boot and at every reload; an invalid candidate keeps the active snapshot. See [`PROVIDER_CONFIGURATION.md`](PROVIDER_CONFIGURATION.md). |
| `adapterFactories` | `SUITE_ADAPTER_FACTORIES` | Preset → adapter constructor. |
| `resolveEndpoint` | `suiteResolveEndpoint` | Preset endpoint resolution; `CUSTOM` carries its own base URL. |
| `secrets` | `SecretStorePort` | Resolves `secret://…` handles. Configuration carries handles, never values. |
| `stores` | idempotency / rateLimit / quota / usageLedger + observability sinks | Host-owned persistence. Durable stores only — a host that cannot back one durably omits it and the bridge falls back to its in-memory reference (development posture, never "production-quiet"). |
| `clock` | `Clock` | Defaults to the system clock. |

Trust boundary (non-negotiable):

- the plugin is constructed from **trusted operator input only** — never from anything a browser
  or a consumer sent;
- `execute(request, trustedContext)` takes the consumer request and the **host-composed**
  `TrustedDispatchContext` in separate channels. A request carrying a trusted field is rejected
  (`TRUSTED_FIELD_IN_CONSUMER_REQUEST`); a missing identity is `CALLER_NOT_PERMITTED`;
- `subjectToken` is opaque and host-minted (no email, no user id, no session token);
- nothing here ever returns or logs a credential, a prompt or a raw provider error.

## 3. What a host gets

- `execute` / `stream` over the frozen envelopes in
  [`INTEGRATION_CONTRACT_V1.md`](INTEGRATION_CONTRACT_V1.md);
- `listCapabilities` / `getCapability` / `status` — discovery with `AVAILABLE / DEGRADED /
  UNAVAILABLE / DISABLED` and the operator kill switch applied on top;
- `reload` — atomic configuration reload. A candidate that changes the provider **shape**
  rebuilds the runtime around the same host stores, so Redis/Postgres-backed governance state
  survives;
- `diagnostics` — credential-free provider facts (ids, aliases, feature assurance, probe status);
- `configSnapshot` — the active `configVersion` / `contentDigest` for ledger provenance.

## 4. Kill switches

Three layers, all fail-closed, all operator-owned:

1. **Host layer** — the host gates its own broker before `execute` is ever called
   (OJPlatform: `OJPLATFORM_AI_DISABLED`).
2. **Configuration layer** — `governance.killSwitch = {global, providers, capabilities}` in the
   document; applied on boot and on every reload, replaced (never accumulated) per reload.
3. **Registry layer** — the live `KillSwitchRegistry` shared by the plugin, runtime and
   directory, for mid-flight switches.

A blocked call surfaces the exact closed reason — `KILL_SWITCH_GLOBAL` / `KILL_SWITCH_CAPABILITY`
/ `KILL_SWITCH_PROVIDER` — never a collapsed approximation.

## 5. Host gaps this design deliberately leaves open

Recorded as host work, not AI Bridge work (see
[`../Docs/reports/STAGE_6_OJPLATFORM_HOST_INTEGRATION_REPORT.md`](reports/STAGE_6_OJPLATFORM_HOST_INTEGRATION_REPORT.md)):

- durable encrypted idempotency store beyond the 15-minute replay window (V1 is transient by
  design);
- pricing-table maintenance (`governance.pricing`) per deployment's real price lists;
- live provider qualification runs (LIVE/NOT_RUN status stays honest until an operator runs
  them with real credentials).
