/**
 * OpenAI Official adapter configuration and its **self-declared** transport seam.
 *
 * The seam types are duplicated from the chat-dialect layer on purpose: OpenAI Official speaks the
 * Responses API on its own wire path (ROADMAP Stage 4 §3) and must not be forced through the
 * Chat-Completions adapter. What is shared is provider-neutral (`@aibridge/core` endpoint safety).
 * Published `.d.ts` stay free of DOM and vendor types.
 *
 * No model ID is hardcoded anywhere: `ModelDescriptor`s come from trusted host configuration.
 */
import type { ModelProfile, ProviderFeature, ProviderPricing } from '@aibridge/contracts';

/** The request shape `fetch`-likes accept. Self-declared; a real `fetch` satisfies it at runtime. */
export type FetchRequestInitLike = {
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly signal?: unknown;
  readonly redirect?: string;
};

export type FetchHeadersLike = {
  get(name: string): string | null;
};

export type ByteStreamReaderLike = {
  read(): Promise<{ readonly done: boolean; readonly value?: Uint8Array }>;
  cancel?(reason?: unknown): Promise<void>;
  releaseLock?(): void;
};

export type ByteStreamLike = {
  getReader(): ByteStreamReaderLike;
};

export type FetchResponseLike = {
  readonly status: number;
  readonly ok: boolean;
  readonly headers: FetchHeadersLike;
  text(): Promise<string>;
  readonly body?: ByteStreamLike | null;
};

export type FetchLike = (url: string, init: FetchRequestInitLike) => Promise<FetchResponseLike>;

/** Reasoning effort for the Responses API `reasoning.effort` field. */
export const RESPONSES_REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high'] as const;

export type ResponsesReasoningEffort = (typeof RESPONSES_REASONING_EFFORTS)[number];

export type OpenAiModelConfig = {
  /** Operator-side only. From trusted host configuration, never hardcoded. */
  readonly modelRef: string;
  readonly displayName?: string;
  readonly features: readonly ProviderFeature[];
  readonly maxContextTokens: number;
  readonly maxOutputTokens: number;
  readonly profiles?: readonly ModelProfile[];
  readonly pricing?: ProviderPricing;
};

export type OpenAiConfig = {
  /** Operator-named instance id: `main`, `backup`. Not a brand. */
  readonly id: string;
  /** Trusted base URL (the official preset supplies `https://api.openai.com/v1`). SSRF-validated. */
  readonly baseUrl: string;
  readonly models: readonly OpenAiModelConfig[];
  readonly features?: readonly ProviderFeature[];
  readonly maxConcurrency?: number;
  readonly fetch?: FetchLike;
  readonly nowMs?: () => number;
  /**
   * Profile → reasoning effort. Unmapped profiles send **no** `reasoning` field — an unknown
   * profile is never silently upgraded to high effort (ROADMAP Stage 4 §8).
   */
  readonly reasoningEffortByProfile?: Readonly<Partial<Record<ModelProfile, ResponsesReasoningEffort>>>;
  /** Development only, default `false`. */
  readonly allowPrivateNetworkForDevelopment?: boolean;
};
