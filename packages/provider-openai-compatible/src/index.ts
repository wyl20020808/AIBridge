/**
 * `@aibridge/provider-openai-compatible` — the Stage 3 reference provider adapter.
 *
 * One adapter, deliberately: this stage validates the adapter **architecture**, not a provider
 * marketplace. Every provider-specific fact (HTTP payload, headers, base URL, authentication,
 * response shape, error body) stays inside this package; what it exports is AI Bridge's own
 * provider port shape plus the transport seam used to test it.
 */

export {
  OpenAiCompatibleAdapter,
  classifyVendorErrorBody,
} from './adapter.js';

export type {
  ByteStreamLike,
  ByteStreamReaderLike,
  FetchHeadersLike,
  FetchLike,
  FetchRequestInitLike,
  FetchResponseLike,
  OpenAiCompatibleConfig,
  OpenAiCompatibleModelConfig,
} from './config.js';

export {
  SseStreamParser,
  classifyHttpFailure,
  malformedResponseError,
  mapFinishReason,
  mapUsage,
  parseRetryAfterMs,
  parseVendorJson,
} from './http.js';
