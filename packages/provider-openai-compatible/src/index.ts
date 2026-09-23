/**
 * `@aibridge/provider-openai-compatible` — the **Generic OpenAI-Compatible / Relay Provider** and
 * the internal reusable OpenAI-compatible wire layer.
 *
 * Two roles, deliberately:
 *
 *  1. `OpenAiCompatibleAdapter` is the relay/custom-gateway provider (中转站, self-hosted
 *     compatible gateways, third-party OpenAI-compatible endpoints). It carries no vendor brand
 *     list — behaviour is declared by configuration.
 *  2. `wire.ts` / `http.ts` are the **internal reusable layer** for the OpenAI chat-completions
 *     dialect, shared with `@aibridge/provider-deepseek` and `@aibridge/provider-xiaomi-tokenplan`
 *     (extracted because three adapters genuinely reuse it, each reuse proven by tests). It is not
 *     a consumer contract and must never depend on `@aibridge/runtime`.
 *
 * `@aibridge/provider-openai` deliberately does **not** use the chat dialect helpers: OpenAI
 * Official speaks the Responses API on its own wire path.
 */

export {
  OpenAiCompatibleAdapter,
  classifyVendorErrorBody,
  type ChatDialectSettings,
} from './adapter.js';

export type {
  ByteStreamLike,
  ByteStreamReaderLike,
  FetchHeadersLike,
  FetchLike,
  FetchRequestInitLike,
  FetchResponseLike,
  MaxTokensField,
  OpenAiCompatibleConfig,
  OpenAiCompatibleModelConfig,
  StructuredOutputMode,
} from './config.js';

export { MAX_TOKENS_FIELDS, STRUCTURED_OUTPUT_MODES } from './config.js';

export {
  SseStreamParser,
  classifyHttpFailure,
  malformedResponseError,
  mapFinishReason,
  mapUsage,
  parseRetryAfterMs,
  parseVendorJson,
  type VendorChatCompletion,
} from './http.js';

export {
  AUTH_SCHEMES,
  MAX_REDIRECTS,
  RAW_MESSAGE_MAX_LENGTH,
  THINKING_EFFORTS,
  authHeaders,
  buildChatMessages,
  consumeChatChunk,
  extractChatText,
  isAuthScheme,
  resolveThinking,
  sanitizeRawMessage,
  sendGet,
  sendPost,
  type AuthScheme,
  type ChatChunkOutcome,
  type ChatMessage,
  type ChatTextOutcome,
  type SendOptions,
  type ThinkingDecision,
  type ThinkingEffort,
  type ThinkingMapping,
} from './wire.js';
