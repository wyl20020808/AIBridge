/**
 * `@aibridge/provider-openai` — the **OpenAI Official API** adapter.
 *
 * Independent Responses API wire path (`POST {base}/responses`), deliberately not built on the
 * Chat-Completions adapter. Native Structured Outputs (`text.format`) are gated on declared model
 * features and are only a first layer — the AI Bridge validator is the final contract boundary.
 * No model IDs are hardcoded; they come from trusted host configuration.
 *
 * This package speaks the official **API** only. A ChatGPT subscription web login is not an API
 * credential: no cookie, session or internal-token handling exists here. A future official
 * account-authorization flow would arrive as a reserved `HOST_OAUTH_REF` credential type without
 * touching the consumer contract.
 */

export { OpenAiAdapter } from './adapter.js';

export {
  RESPONSES_REASONING_EFFORTS,
  type ByteStreamLike,
  type ByteStreamReaderLike,
  type FetchHeadersLike,
  type FetchLike,
  type FetchRequestInitLike,
  type FetchResponseLike,
  type OpenAiConfig,
  type OpenAiModelConfig,
  type ResponsesReasoningEffort,
} from './config.js';

export {
  SseFrameParser,
  buildResponsesPayload,
  classifyOpenAiFailure,
  consumeResponsesEvent,
  extractResponseText,
  malformedResponseError,
  mapResponsesFinish,
  mapResponsesUsage,
  parseOpenAiJson,
  parseRetryAfterMs,
  sanitizeRawMessage,
  sendRequest,
  type ResponsesEventOutcome,
  type ResponsesRequestInput,
  type ResponsesTextOutcome,
  type SendOptions,
  type StreamState,
} from './responses.js';
