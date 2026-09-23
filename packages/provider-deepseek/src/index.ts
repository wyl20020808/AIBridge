/**
 * `@aibridge/provider-deepseek` — the **DeepSeek Official API** adapter.
 *
 * OpenAI-compatible chat protocol, DeepSeek semantics encapsulated here: the `thinking` /
 * `reasoning_effort` mapping (explicit, configurable, never silently upgraded), `reasoning_content`
 * isolation (chain-of-thought is never output), and JSON Output that is *valid JSON only* — never
 * advertised as strict schema adherence. Model IDs come from trusted host configuration.
 */

export {
  DEFAULT_DEEPSEEK_THINKING,
  DEEPSEEK_PRESET,
  DeepSeekAdapter,
  type DeepSeekConfig,
  type DeepSeekModelConfig,
} from './deepseek.js';
