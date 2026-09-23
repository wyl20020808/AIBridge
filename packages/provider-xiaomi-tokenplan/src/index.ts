/**
 * `@aibridge/provider-xiaomi-tokenplan` — the **Xiaomi MiMo Token Plan** adapter.
 *
 * Token Plan (subscription, `tp-…` keys, regional clusters) — not the pay-as-you-go MiMo API. The
 * endpoint comes from the cluster preset or trusted operator configuration; consumers never choose
 * a base URL. `reasoning_content` is chain-of-thought and never output. Model IDs come from
 * trusted host configuration.
 *
 * Implemented protocol: OpenAI-compatible Chat Completions. Deferred protocols: the documented
 * Anthropic compatibility protocol and the Responses surface (see the Stage 4 report).
 */

export {
  DEFAULT_XIAOMI_THINKING,
  XIAOMI_TOKENPLAN_PRESET,
  XIAOMI_TOKEN_PLAN_CLUSTERS,
  XIAOMI_TOKEN_PLAN_ENDPOINTS,
  XiaomiTokenPlanAdapter,
  looksLikeTokenPlanKey,
  type XiaomiTokenPlanCluster,
  type XiaomiTokenPlanConfig,
  type XiaomiTokenPlanModelConfig,
} from './xiaomi.js';

/** The transport seam (re-exported from the internal wire layer): self-declared, no vendor types. */
export type {
  FetchLike,
  FetchRequestInitLike,
  FetchResponseLike,
  ThinkingMapping,
} from '@aibridge/provider-openai-compatible';
