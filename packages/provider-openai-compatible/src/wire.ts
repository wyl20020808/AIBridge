/**
 * The **internal reusable OpenAI-compatible wire layer** (ROADMAP Stage 4 §2).
 *
 * Extracted because three adapters genuinely share it — the generic relay, DeepSeek Official and
 * Xiaomi MiMo Token Plan all speak the OpenAI chat-completions dialect — and each reuse is proven
 * by tests that run through all three adapters. It is an internal layer, not a consumer contract:
 * nothing here may depend on `@aibridge/runtime`, and no type here is part of the frozen consumer
 * contract. `@aibridge/provider-openai` deliberately does **not** use the chat dialect helpers —
 * OpenAI Official speaks the Responses API on its own wire path.
 *
 * What lives here is exactly the part that is provider-independent *within the dialect*: the two
 * prompt channels, authentication header schemes, bounded redirects with endpoint re-validation,
 * deadline/cancellation abort scopes, raw-message sanitization, and the reasoning-content
 * isolation rule (`reasoning_content` is chain-of-thought and is **never** output).
 */
import {
  ProviderCallError,
  renderContextBlock,
  type AiFinishReason,
  type ModelProfile,
  type CapabilityRequirements,
  type ProviderBoundValue,
  type ProviderRequest,
  type ProviderRawError,
} from '@aibridge/contracts';
import { SECRET_PATTERNS, checkEndpointSafety } from '@aibridge/core';
import {
  classifyHttpFailure,
  parseRetryAfterMs,
  parseVendorJson,
} from './http.js';
import type {
  FetchLike,
  FetchRequestInitLike,
  FetchResponseLike,
} from './config.js';

/* -------------------------------------------------------------------------------------------------
 * Authentication — a closed enum, never an arbitrary header map (ROADMAP Stage 4 §18).
 * ----------------------------------------------------------------------------------------------- */

export const AUTH_SCHEMES = ['BEARER', 'API_KEY_HEADER'] as const;

export type AuthScheme = (typeof AUTH_SCHEMES)[number];

export function isAuthScheme(value: unknown): value is AuthScheme {
  return typeof value === 'string' && (AUTH_SCHEMES as readonly string[]).includes(value);
}

/** The fixed header each scheme uses. `API_KEY_HEADER` is the documented `api-key` header. */
export function authHeaders(scheme: AuthScheme, secret: string): Readonly<Record<string, string>> {
  return scheme === 'BEARER'
    ? { authorization: `Bearer ${secret}` }
    : { 'api-key': secret };
}

/* -------------------------------------------------------------------------------------------------
 * Operator-only detail
 * ----------------------------------------------------------------------------------------------- */

export const RAW_MESSAGE_MAX_LENGTH = 512;

/**
 * Truncate and credential-strip operator-only diagnostic text (the contracts rule for
 * `ProviderRawError.rawMessage`). PII stripping happens at the log sink as well; a provider error
 * body that echoes a credential back must not keep it even in the operator channel.
 */
export function sanitizeRawMessage(message: string, boundSecrets: readonly string[] = []): string {
  let redacted = message;
  for (const secret of boundSecrets) {
    if (secret.length > 0) {
      redacted = redacted.split(secret).join('[REDACTED]');
    }
  }
  for (const secret of SECRET_PATTERNS) {
    const flags = secret.pattern.flags.includes('g') ? secret.pattern.flags : `${secret.pattern.flags}g`;
    redacted = redacted.replace(new RegExp(secret.pattern.source, flags), `[REDACTED:${secret.id}]`);
  }
  return redacted.slice(0, RAW_MESSAGE_MAX_LENGTH);
}

/* -------------------------------------------------------------------------------------------------
 * The two prompt channels (ARCHITECTURE.md §11.2) — trusted instructions vs untrusted data.
 * ----------------------------------------------------------------------------------------------- */

export type ChatMessage = {
  readonly role: 'system' | 'user';
  readonly content: string;
};

/**
 * Compose chat messages from a `ProviderRequest`. The instruction channel (system) and the data
 * channel (user) are combined **only** at this final wire step, and untrusted values stay fenced
 * as data by `renderContextBlock` — the trust distinction is never flattened before this point.
 */
export function buildChatMessages(
  instructions: string,
  outputFormatInstruction: string | undefined,
  context: readonly ProviderBoundValue[],
): readonly ChatMessage[] {
  const system =
    outputFormatInstruction === undefined ? instructions : `${instructions}\n\n${outputFormatInstruction}`;
  const data = renderContextBlock(context);
  return [
    { role: 'system', content: system },
    ...(data.length > 0 ? [{ role: 'user' as const, content: data }] : []),
  ];
}

/* -------------------------------------------------------------------------------------------------
 * Reasoning / thinking controls — explicit, configurable, never silently upgraded.
 * ----------------------------------------------------------------------------------------------- */

export const THINKING_EFFORTS = ['low', 'high', 'max'] as const;

export type ThinkingEffort = (typeof THINKING_EFFORTS)[number];

/**
 * What a provider call should do about chain-of-thought.
 *
 * `omit` sends no thinking fields at all (a dialect without thinking controls). `disabled` and
 * `enabled` are the documented toggles. A profile with **no** configured mapping resolves to
 * `disabled` — never to "high" (ROADMAP Stage 4 §8: an unknown profile must not silently become
 * high effort).
 */
export type ThinkingDecision =
  | { readonly kind: 'omit' }
  | { readonly kind: 'disabled' }
  | { readonly kind: 'enabled'; readonly effort?: ThinkingEffort };

export type ThinkingMapping = {
  /** Profiles that enable thinking, with their effort where the dialect supports one. */
  readonly effortByProfile: Readonly<Partial<Record<ModelProfile, ThinkingEffort | 'default'>>>;
};

/** Resolve a profile to a thinking decision. Unmapped profiles are `disabled`, never `high`. */
export function resolveThinking(
  mapping: ThinkingMapping | undefined,
  profile: ModelProfile,
  _requirements: CapabilityRequirements,
): ThinkingDecision {
  if (mapping === undefined) {
    return { kind: 'omit' };
  }
  const effort = mapping.effortByProfile[profile];
  if (effort === undefined) {
    return { kind: 'disabled' };
  }
  return effort === 'default' ? { kind: 'enabled' } : { kind: 'enabled', effort };
}

/* -------------------------------------------------------------------------------------------------
 * Transport: deadline/cancellation abort scope and bounded, re-validated redirects.
 * ----------------------------------------------------------------------------------------------- */

export const MAX_REDIRECTS = 3;

export type SendOptions = {
  readonly fetch: FetchLike;
  readonly url: string;
  readonly body?: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly deadlineAtMs: number;
  readonly nowMs: () => number;
  readonly cancellation?: ProviderRequest['cancellation'];
  /** SSRF policy for the initial URL **and every redirect target**. */
  readonly allowPrivateNetworkForDevelopment?: boolean;
};

/**
 * POST with an abort scope (deadline + cancellation) and a bounded redirect policy.
 *
 * Redirect targets are re-validated with `checkEndpointSafety` — a redirect is the classic SSRF
 * bypass — and the redirect count is capped. Transport failures never propagate a platform
 * message: they surface as mapped `ProviderCallError`s. A non-2xx response is classified from its
 * vendor error body right here, so no caller can accidentally parse an error page as an answer.
 */
export async function sendPost(options: SendOptions): Promise<FetchResponseLike> {
  return sendWithPolicy({ ...options, method: 'POST' });
}

/** GET with the same abort scope and redirect policy (used by non-generative probes). */
export async function sendGet(options: SendOptions): Promise<FetchResponseLike> {
  return sendWithPolicy({ ...options, method: 'GET' });
}

async function sendWithPolicy(options: SendOptions & { readonly method: 'POST' | 'GET' }): Promise<FetchResponseLike> {
  const initial = checkEndpointSafety(options.url, {
    ...(options.allowPrivateNetworkForDevelopment === undefined
      ? {}
      : { allowPrivateNetworkForDevelopment: options.allowPrivateNetworkForDevelopment }),
  });
  if (!initial.safe) {
    // `dispatched: false` — provably nothing left this process, so a repeat is free of double-billing risk.
    throw new ProviderCallError({ category: 'BAD_REQUEST', reason: 'PROVIDER_REQUEST_REJECTED', dispatched: false, rawMessage: `unsafe endpoint (${initial.rejection})` });
  }

  const controller = new AbortController();
  let abortedByDeadline = false;
  const unsubscribe = options.cancellation?.onCancel(() => controller.abort()) ?? ((): void => undefined);
  const timer = setTimeout(() => {
    abortedByDeadline = true;
    controller.abort();
  }, Math.max(0, options.deadlineAtMs - options.nowMs()));

  try {
    let url = options.url;
    let headers = options.headers;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const init: FetchRequestInitLike = {
        method: options.method,
        headers,
        ...(options.body === undefined ? {} : { body: options.body }),
        signal: controller.signal,
        redirect: 'manual',
      };
      let response: FetchResponseLike;
      try {
        response = await options.fetch(url, init);
      } catch {
        // No `dispatched` marker: an aborted call or a transport failure is an **unknown** outcome
        // — the provider may have generated and billed before the connection broke.
        throw new ProviderCallError(
          abortedByDeadline
            ? { category: 'UPSTREAM', reason: 'PROVIDER_TIMEOUT', rawMessage: 'the outbound call was abandoned at its deadline' }
            : { category: 'UPSTREAM', reason: 'PROVIDER_UNAVAILABLE', rawMessage: 'transport failure' },
        );
      }
      if (isRedirect(response.status)) {
        const location = response.headers.get('location');
        if (location === null || location.length === 0) {
          throw new ProviderCallError({ category: 'UPSTREAM', reason: 'PROVIDER_BAD_RESPONSE', dispatched: true, rawMessage: 'redirect without a Location header' });
        }
        const target = resolveRedirect(url, location);
        const next = checkEndpointSafety(target, {
          ...(options.allowPrivateNetworkForDevelopment === undefined
            ? {}
            : { allowPrivateNetworkForDevelopment: options.allowPrivateNetworkForDevelopment }),
        });
        if (!next.safe) {
          throw new ProviderCallError({ category: 'BAD_REQUEST', reason: 'PROVIDER_REQUEST_REJECTED', dispatched: true, rawMessage: `unsafe redirect target (${next.rejection})` });
        }
        if (redirectCrossesOrigin(url, target)) {
          // A credential bound for one origin must never ride along to another: a
          // compromised/malicious endpoint answering 302 to an attacker host would otherwise
          // harvest the operator secret. Same-origin redirects keep their headers.
          headers = stripAuthHeaders(headers);
        }
        url = target;
        continue;
      }
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        const vendorBody = parseVendorJson(text) ?? {};
        const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
        throw new ProviderCallError(
          classifyHttpFailure({
            status: response.status,
            body: vendorBody as { error?: { type?: unknown; code?: unknown; message?: unknown } },
            ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
          }),
        );
      }
      return response;
    }
    throw new ProviderCallError({ category: 'UPSTREAM', reason: 'PROVIDER_BAD_RESPONSE', dispatched: true, rawMessage: 'too many redirects' });
  } finally {
    clearTimeout(timer);
    unsubscribe();
  }
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function resolveRedirect(current: string, location: string): string {
  try {
    return new URL(location, current).href;
  } catch {
    throw new ProviderCallError({ category: 'UPSTREAM', reason: 'PROVIDER_BAD_RESPONSE', dispatched: true, rawMessage: 'unparseable redirect target' });
  }
}

/** True when following a redirect would move the request to a different origin. */
function redirectCrossesOrigin(current: string, target: string): boolean {
  let from: OriginLike | null = null;
  let to: OriginLike | null = null;
  try {
    from = new URL(current);
    to = new URL(target);
  } catch {
    // Unparseable here means the safety check above already failed closed; never claim
    // same-origin when the comparison itself cannot be made.
    return true;
  }
  return from.protocol !== to.protocol || from.hostname !== to.hostname || from.port !== to.port;
}

/** Drop credential-carrying headers (case-insensitive) before a cross-origin redirect hop. */
function stripAuthHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  const stripped: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (lower === 'authorization' || lower === 'api-key') {
      continue;
    }
    stripped[name] = value;
  }
  return stripped;
}

/** The minimal WHATWG URL surface used here. Type-only; erased at emit. */
type UrlLike = { readonly href: string };
type OriginLike = { readonly protocol: string; readonly hostname: string; readonly port: string };
declare const URL: { new (input: string, base?: string): UrlLike & OriginLike };

/* -------------------------------------------------------------------------------------------------
 * Chat-dialect response and stream translation
 * ----------------------------------------------------------------------------------------------- */

export type ChatTextOutcome = {
  readonly text: string;
  readonly finishReason: AiFinishReason;
  /** False when the payload carried no `content` field at all — a malformed response, not an empty answer. */
  readonly hasContent: boolean;
};

/**
 * Extract the final answer from a chat-completions body.
 *
 * **Reasoning isolation** (ROADMAP Stage 4 §9): `message.reasoning_content` is chain-of-thought
 * and is discarded here — it is never returned as output, never persisted and never forwarded.
 * An `extraFinishReasons` table maps dialect spellings (`repetition_truncation`, `tool_calls`) to
 * the closed generic set; anything unmapped is `UNKNOWN`, never guessed. `hasContent` separates a
 * genuinely empty answer (a documented JSON-mode case) from a malformed payload.
 */
export function extractChatText(
  completion: {
    readonly choices?: readonly {
      readonly message?: { readonly content?: unknown; /** Chain-of-thought. Read and discarded. */ readonly reasoning_content?: unknown };
      readonly finish_reason?: unknown;
    }[];
  },
  mapFinish: (value: unknown) => AiFinishReason,
): ChatTextOutcome {
  const choice = completion.choices?.[0];
  const finishReason = mapFinish(choice?.finish_reason);
  const content = choice?.message?.content;
  if (typeof content === 'string') {
    return { text: content, finishReason, hasContent: true };
  }
  return { text: '', finishReason, hasContent: false };
}

/** The outcome of consuming one SSE `data:` payload from a chat-dialect stream. */
export type ChatChunkOutcome =
  | { readonly kind: 'DELTA'; readonly text: string }
  | { readonly kind: 'FINISH'; readonly finishReason: AiFinishReason }
  | { readonly kind: 'IGNORED' }
  | { readonly kind: 'ERROR'; readonly rawError: ProviderRawError };

/**
 * Consume one chat-dialect SSE chunk. `delta.reasoning_content` is dropped — reasoning isolation
 * holds for streams too. `delta.content` becomes a text delta; `finish_reason` closes the stream.
 */
export function consumeChatChunk(
  chunk: {
    readonly choices?: readonly {
      readonly delta?: { readonly content?: unknown; /** Chain-of-thought. Read and discarded. */ readonly reasoning_content?: unknown };
      readonly finish_reason?: unknown;
    }[];
  },
  mapFinish: (value: unknown) => AiFinishReason,
): ChatChunkOutcome {
  const choice = chunk.choices?.[0];
  if (choice === undefined) {
    return { kind: 'IGNORED' };
  }
  const delta = choice.delta?.content;
  if (typeof delta === 'string' && delta.length > 0) {
    return { kind: 'DELTA', text: delta };
  }
  if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
    return { kind: 'FINISH', finishReason: mapFinish(choice.finish_reason) };
  }
  // A chunk carrying only `reasoning_content` (or nothing usable) is deliberately ignored.
  return { kind: 'IGNORED' };
}
