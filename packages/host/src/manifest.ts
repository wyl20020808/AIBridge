/**
 * The AI Bridge plugin manifest, in the **canonical host plugin dialect** (Stage 6).
 *
 * One source of truth: the repository-root `plugin.manifest.json` is the document; this module
 * projects the same facts as code so a host can discover identity and capabilities without reading
 * the repository. A test asserts the two never drift.
 *
 * Dialect notes (see `Docs/HOST_INTEGRATION.md`):
 *  - `apiVersion` is the canonical field. The historical spelling `pluginApiVersion` is accepted
 *    by hosts as an alias and normalized — it is not emitted here.
 *  - `providesCapabilities` / `consumesCapabilities` are flat arrays of capability references
 *    (`id` or `id@major` or `id@major.x`). Provider models, credentials and prompts are **never**
 *    manifest material.
 *  - A server-capability plugin has no browser slot, so `contributes.slots` is empty and `entry`
 *    names the module a host loads through its own trusted bootstrap.
 */
import {
  AIBRIDGE_CONTRACT_VERSION,
  AIBRIDGE_ERROR_VERSION,
  AIBRIDGE_RESPONSE_SCHEMA_VERSION,
  GENERIC_REQUEST_SCHEMA_VERSION,
} from '@aibridge/contracts';

export const AIBRIDGE_PLUGIN_ID = 'ai.bridge';

/** The host plugin API major this entry speaks. */
export const AIBRIDGE_PLUGIN_API_VERSION = 1;

/** What AI Bridge provides, as a plugin. Capability ids are host-neutral (INTEGRATION_CONTRACT_V1 §1). */
export const AIBRIDGE_PROVIDED_CAPABILITIES = [
  'ai.text.generate@1.x',
  'ai.structured.generate@1.x',
] as const;

/** What AI Bridge consumes from other plugins. Nothing, by design: it is a leaf provider. */
export const AIBRIDGE_CONSUMED_CAPABILITIES: readonly string[] = [];

export type AiBridgePluginManifest = {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly apiVersion: number;
  readonly entry: string;
  readonly contributes: { readonly slots: readonly string[] };
  readonly providesCapabilities: readonly string[];
  readonly consumesCapabilities: readonly string[];
  /** Contract versions the entry implements (informational for operators; see INTEGRATION_CONTRACT_V1 §2). */
  readonly contractVersions: Readonly<Record<string, string>>;
};

/** The default entry module id a host imports to construct this plugin. */
export const AIBRIDGE_PLUGIN_ENTRY_MODULE = '@aibridge/host';

export const AIBRIDGE_PLUGIN_CONTRACT_VERSIONS: Readonly<Record<string, string>> = Object.freeze({
  // Derived from `@aibridge/contracts` — the frozen contract is the single home for these
  // values, never a literal duplicated here (stabilization audit: VERSION_DRIFT).
  aiBridge: AIBRIDGE_CONTRACT_VERSION,
  genericAiRequest: GENERIC_REQUEST_SCHEMA_VERSION,
  genericAiResponse: AIBRIDGE_RESPONSE_SCHEMA_VERSION,
  aiError: AIBRIDGE_ERROR_VERSION,
});

/**
 * The canonical manifest projection. `version` is the plugin version, not a contract version.
 */
export function aibridgePluginManifest(version = '0.2.0'): AiBridgePluginManifest {
  return {
    id: AIBRIDGE_PLUGIN_ID,
    name: 'AI Bridge',
    version,
    apiVersion: AIBRIDGE_PLUGIN_API_VERSION,
    entry: AIBRIDGE_PLUGIN_ENTRY_MODULE,
    contributes: { slots: [] },
    providesCapabilities: [...AIBRIDGE_PROVIDED_CAPABILITIES],
    consumesCapabilities: [...AIBRIDGE_CONSUMED_CAPABILITIES],
    contractVersions: { ...AIBRIDGE_PLUGIN_CONTRACT_VERSIONS },
  };
}
