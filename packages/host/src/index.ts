/**
 * `@aibridge/host` — the host-bindable server plugin entry (ROADMAP Stage 6).
 *
 * A host loads this module through its own trusted bootstrap, passes its ports and configuration,
 * and receives the plugin object: `execute`, capability discovery, atomic `reload`, safe
 * diagnostics and `dispose`. Depends on `@aibridge/contracts`, `@aibridge/core`,
 * `@aibridge/governance`, `@aibridge/host-sdk` and `@aibridge/runtime`. Names no host, imports no
 * host internals, and never touches a provider package (adapters arrive as an injected factory
 * table — see `@aibridge/suite-all` for the complete table).
 */

export {
  AIBRIDGE_PLUGIN_API_VERSION,
  AIBRIDGE_PLUGIN_CONTRACT_VERSIONS,
  AIBRIDGE_PLUGIN_ENTRY_MODULE,
  AIBRIDGE_PLUGIN_ID,
  AIBRIDGE_CONSUMED_CAPABILITIES,
  AIBRIDGE_PROVIDED_CAPABILITIES,
  aibridgePluginManifest,
  type AiBridgePluginManifest,
} from './manifest.js';

export {
  createAiBridgeServerPlugin,
  type AiBridgeHostStores,
  type AiBridgeServerPlugin,
  type AiBridgeServerPluginOptions,
} from './plugin.js';
