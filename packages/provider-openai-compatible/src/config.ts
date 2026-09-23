/**
 * Adapter configuration and the minimal HTTP seam.
 *
 * **Everything provider-specific lives in this package** (ROADMAP Stage 3 §2): the base URL, the
 * wire payload, the headers, the authentication header, the response shape and the error body.
 * None of it appears in an exported *contract* type — the shapes below are the adapter's own
 * transport seam, deliberately self-declared so the published `.d.ts` never references a DOM or
 * vendor type (`Response`, `RequestInit`, `AbortSignal`, …). The declaration-hygiene gate in
 * `scripts/check-portability.mjs` enforces that mechanically.
 */
import type { ModelProfile, ProviderFeature, ProviderPricing } from '@aibridge/contracts';
import type { AuthScheme, ThinkingMapping } from './wire.js';

/** How a structured call asks the endpoint for machine-readable output. */
export const STRUCTURED_OUTPUT_MODES = ['PROMPT_ONLY', 'JSON_OBJECT', 'JSON_SCHEMA'] as const;

export type StructuredOutputMode = (typeof STRUCTURED_OUTPUT_MODES)[number];

/** Which request field carries the output token cap. MiMo documents `max_completion_tokens`. */
export const MAX_TOKENS_FIELDS = ['max_tokens', 'max_completion_tokens'] as const;

export type MaxTokensField = (typeof MAX_TOKENS_FIELDS)[number];

/** The request shape `fetch`-likes accept. Self-declared; a real `fetch` satisfies it at runtime. */
export type FetchRequestInitLike = {
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  /** An abort signal from any platform. Typed as `unknown` on purpose — no DOM type here. */
  readonly signal?: unknown;
  /** Redirect policy. The wire layer always sends `manual` and re-validates each target. */
  readonly redirect?: string;
};

/** The response header access this adapter needs. */
export type FetchHeadersLike = {
  get(name: string): string | null;
};

/** A reader over the response byte stream, as produced by a `fetch` body. */
export type ByteStreamReaderLike = {
  read(): Promise<{ readonly done: boolean; readonly value?: Uint8Array }>;
  cancel?(reason?: unknown): Promise<void>;
  releaseLock?(): void;
};

export type ByteStreamLike = {
  getReader(): ByteStreamReaderLike;
};

/** The response shape this adapter needs. A real `fetch` response satisfies it at runtime. */
export type FetchResponseLike = {
  readonly status: number;
  readonly ok: boolean;
  readonly headers: FetchHeadersLike;
  text(): Promise<string>;
  readonly body?: ByteStreamLike | null;
};

/** The transport seam. Injected in tests; `globalThis.fetch` in a real deployment. */
export type FetchLike = (url: string, init: FetchRequestInitLike) => Promise<FetchResponseLike>;

/** One operator-declared model behind the endpoint. Feature support is declared, never assumed. */
export type OpenAiCompatibleModelConfig = {
  /** Operator-side only. NEVER crosses to a consumer. */
  readonly modelRef: string;
  readonly displayName?: string;
  /**
   * Declared features — probed at configuration time and recorded, never assumed from the URL
   * shape (ARCHITECTURE.md §7.3). Required on purpose: an OpenAI-compatible wire format does not
   * imply compatible semantics.
   */
  readonly features: readonly ProviderFeature[];
  readonly maxContextTokens: number;
  readonly maxOutputTokens: number;
  readonly profiles?: readonly ModelProfile[];
  readonly pricing?: ProviderPricing;
};

export type OpenAiCompatibleConfig = {
  /** Operator-named instance id: `main`, `local`, `backup`. Not a brand. */
  readonly id: string;
  /** The endpoint base, e.g. `https://api.example.invalid/v1`. Never carries a credential. */
  readonly baseUrl: string;
  readonly models: readonly OpenAiCompatibleModelConfig[];
  readonly features?: readonly ProviderFeature[];
  readonly maxConcurrency?: number;
  /** Test seam. Defaults to `globalThis.fetch`. */
  readonly fetch?: FetchLike;
  /** Injectable clock for deadline arithmetic. Defaults to `Date.now`. */
  readonly nowMs?: () => number;
  /** Closed auth enum. Default `BEARER`. Never an arbitrary header map (ROADMAP Stage 4 §18). */
  readonly authScheme?: AuthScheme;
  /** How structured calls request machine-readable output. Default `JSON_OBJECT`. */
  readonly structuredOutput?: StructuredOutputMode;
  /** Which field carries the output token cap. Default `max_tokens`. */
  readonly maxTokensField?: MaxTokensField;
  /** Thinking/chain-of-thought mapping. Absent ⇒ the dialect sends no thinking fields. */
  readonly thinking?: ThinkingMapping;
  /** Development only, default `false`: relaxes HTTPS and private-network endpoint rules. */
  readonly allowPrivateNetworkForDevelopment?: boolean;
};
