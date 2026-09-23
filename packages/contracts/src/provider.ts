/**
 * Provider and model descriptors (ARCHITECTURE.md §7).
 *
 * These are **descriptions only**. No provider is implemented in Stage 2, no vendor SDK type
 * appears anywhere, and no provider name is ever projected to a consumer.
 *
 * Feature support is a property of the **model**, not of the provider: two models behind one
 * provider frequently differ.
 */
import { describe, isRecord, unknownKeys, isNonNegativeFiniteNumber, isPositiveInteger } from './guards.js';
import type { ValidationIssue, ValidationResult } from './issue.js';
import { at, createIssue, invalid, valid } from './issue.js';
import { isModelProfile, parseModelProfileList, type ModelProfile } from './profile.js';
import type { AiUsage } from './usage.js';
import type { OutputSchema } from './schema.js';
import type { AiErrorReason, ProviderCategory } from './errors.js';
import type { AiFinishReason } from './response.js';
import type { CancellationToken } from './cancellation.js';

/** The provider families AI Bridge may name. A family is a wire dialect, not a vendor. */
export const PROVIDER_FAMILIES = ['openai-compatible', 'anthropic', 'google', 'local', 'mock'] as const;

export type ProviderFamily = (typeof PROVIDER_FAMILIES)[number];

export function isProviderFamily(value: unknown): value is ProviderFamily {
  return typeof value === 'string' && (PROVIDER_FAMILIES as readonly string[]).includes(value);
}

/** Coarse model quality classes. The only quality signal a consumer may rely on. */
export const MODEL_CLASSES = ['REASONING', 'FAST', 'LOCAL', 'UNKNOWN'] as const;

export type ModelClass = (typeof MODEL_CLASSES)[number];

export function isModelClass(value: unknown): value is ModelClass {
  return typeof value === 'string' && (MODEL_CLASSES as readonly string[]).includes(value);
}

/**
 * Provider features. Declared, then **probed** — an OpenAI-compatible wire format does not imply
 * compatible semantics (ARCHITECTURE.md §7.3).
 */
export const PROVIDER_FEATURES = [
  'text',
  'structuredJson',
  'jsonSchema',
  'streaming',
  'reasoning',
  'usage',
  'vision',
  'tools',
  'caching',
] as const;

export type ProviderFeature = (typeof PROVIDER_FEATURES)[number];

export function isProviderFeature(value: unknown): value is ProviderFeature {
  return typeof value === 'string' && (PROVIDER_FEATURES as readonly string[]).includes(value);
}

export type ProviderPricing = {
  readonly inputPerMTok?: number;
  readonly outputPerMTok?: number;
  readonly currency: string;
  /** ISO date. Pricing goes stale, so a price always carries the date it was true. */
  readonly asOf: string;
};

export type ModelDescriptor = {
  readonly providerId: string;
  /** Operator-side only. NEVER crosses to a consumer. */
  readonly modelRef: string;
  /** Operator-side only. */
  readonly displayName: string;
  readonly features: readonly ProviderFeature[];
  readonly maxContextTokens: number;
  readonly maxOutputTokens: number;
  /** Which profiles this model can serve. */
  readonly profiles: readonly ModelProfile[];
  readonly pricing?: ProviderPricing;
};

export type ProviderDescriptor = {
  readonly id: string;
  readonly family: ProviderFamily;
  readonly features: readonly ProviderFeature[];
  readonly models: readonly ModelDescriptor[];
  readonly maxConcurrency: number;
  /** Almost always false: AI Bridge owns the idempotency registry (ARCHITECTURE.md §14.3). */
  readonly supportsIdempotency: boolean;
};

const MODEL_DESCRIPTOR_KEYS = [
  'providerId',
  'modelRef',
  'displayName',
  'features',
  'maxContextTokens',
  'maxOutputTokens',
  'profiles',
  'pricing',
] as const;

const PROVIDER_DESCRIPTOR_KEYS = ['id', 'family', 'features', 'models', 'maxConcurrency', 'supportsIdempotency'] as const;

const PROVIDER_PRICING_KEYS = ['inputPerMTok', 'outputPerMTok', 'currency', 'asOf'] as const;

function parseFeatureList(value: unknown, path: string, issues: ValidationIssue[]): readonly ProviderFeature[] {
  if (!Array.isArray(value)) {
    issues.push(createIssue('INVALID_TYPE', path, 'must be an array of provider features'));
    return [];
  }
  const seen = new Set<string>();
  const features: ProviderFeature[] = [];
  value.forEach((entry, index) => {
    const entryPath = at(path, index);
    if (!isProviderFeature(entry)) {
      issues.push(createIssue('INVALID_VALUE', entryPath, `must be one of ${PROVIDER_FEATURES.join(', ')}`));
      return;
    }
    if (seen.has(entry)) {
      issues.push(createIssue('DUPLICATE_FIELD', entryPath, `duplicate feature "${entry}"`));
      return;
    }
    seen.add(entry);
    features.push(entry);
  });
  return features;
}

function parsePricing(value: unknown, path: string, issues: ValidationIssue[]): ProviderPricing | undefined {
  if (!isRecord(value)) {
    issues.push(createIssue('INVALID_TYPE', path, `must be an object, got ${describe(value)}`));
    return undefined;
  }
  for (const key of unknownKeys(value, PROVIDER_PRICING_KEYS)) {
    issues.push(createIssue('UNKNOWN_FIELD', at(path, key), 'unknown pricing field'));
  }
  for (const key of ['inputPerMTok', 'outputPerMTok'] as const) {
    const entry = value[key];
    if (entry !== undefined && !isNonNegativeFiniteNumber(entry)) {
      issues.push(createIssue('INVALID_TYPE', at(path, key), 'must be a finite, non-negative number'));
    }
  }
  if (typeof value['currency'] !== 'string' || value['currency'].length === 0) {
    issues.push(createIssue('INVALID_TYPE', at(path, 'currency'), 'must be a non-empty string'));
  }
  if (typeof value['asOf'] !== 'string' || value['asOf'].length === 0) {
    issues.push(createIssue('INVALID_TYPE', at(path, 'asOf'), 'must be a non-empty ISO date string'));
  }
  if (issues.length > 0) {
    return undefined;
  }
  return {
    ...(typeof value['inputPerMTok'] === 'number' ? { inputPerMTok: value['inputPerMTok'] } : {}),
    ...(typeof value['outputPerMTok'] === 'number' ? { outputPerMTok: value['outputPerMTok'] } : {}),
    currency: value['currency'] as string,
    asOf: value['asOf'] as string,
  };
}

export function parseModelDescriptor(value: unknown, path = '$'): ValidationResult<ModelDescriptor> {
  if (!isRecord(value)) {
    return invalid('MALFORMED_ENVELOPE', [createIssue('INVALID_TYPE', path, `must be an object, got ${describe(value)}`)]);
  }
  const issues: ValidationIssue[] = [];
  for (const key of unknownKeys(value, MODEL_DESCRIPTOR_KEYS)) {
    issues.push(createIssue('UNKNOWN_FIELD', at(path, key), 'unknown model descriptor field'));
  }
  for (const key of ['providerId', 'modelRef', 'displayName'] as const) {
    if (typeof value[key] !== 'string' || (value[key] as string).length === 0) {
      issues.push(createIssue('INVALID_TYPE', at(path, key), 'must be a non-empty string'));
    }
  }
  const features = parseFeatureList(value['features'], at(path, 'features'), issues);
  for (const key of ['maxContextTokens', 'maxOutputTokens'] as const) {
    if (!isPositiveInteger(value[key])) {
      issues.push(createIssue('INVALID_TYPE', at(path, key), 'must be a positive integer'));
    }
  }
  const profiles = parseModelProfileList(value['profiles'], at(path, 'profiles'));
  if (!profiles.ok) {
    issues.push(...profiles.failure.issues);
  }
  let pricing: ProviderPricing | undefined;
  if (value['pricing'] !== undefined) {
    pricing = parsePricing(value['pricing'], at(path, 'pricing'), issues);
  }
  if (issues.length > 0) {
    return invalid('MALFORMED_ENVELOPE', issues);
  }
  return valid({
    providerId: value['providerId'] as string,
    modelRef: value['modelRef'] as string,
    displayName: value['displayName'] as string,
    features,
    maxContextTokens: value['maxContextTokens'] as number,
    maxOutputTokens: value['maxOutputTokens'] as number,
    profiles: profiles.ok ? profiles.value : [],
    ...(pricing === undefined ? {} : { pricing }),
  });
}

export function parseProviderDescriptor(value: unknown, path = '$'): ValidationResult<ProviderDescriptor> {
  if (!isRecord(value)) {
    return invalid('MALFORMED_ENVELOPE', [createIssue('INVALID_TYPE', path, `must be an object, got ${describe(value)}`)]);
  }
  const issues: ValidationIssue[] = [];
  for (const key of unknownKeys(value, PROVIDER_DESCRIPTOR_KEYS)) {
    issues.push(createIssue('UNKNOWN_FIELD', at(path, key), 'unknown provider descriptor field'));
  }
  if (typeof value['id'] !== 'string' || value['id'].length === 0) {
    issues.push(createIssue('INVALID_TYPE', at(path, 'id'), 'must be a non-empty string'));
  }
  if (!isProviderFamily(value['family'])) {
    issues.push(createIssue('INVALID_VALUE', at(path, 'family'), `must be one of ${PROVIDER_FAMILIES.join(', ')}`));
  }
  const features = parseFeatureList(value['features'], at(path, 'features'), issues);
  if (!isPositiveInteger(value['maxConcurrency'])) {
    issues.push(createIssue('INVALID_TYPE', at(path, 'maxConcurrency'), 'must be a positive integer'));
  }
  if (typeof value['supportsIdempotency'] !== 'boolean') {
    issues.push(createIssue('INVALID_TYPE', at(path, 'supportsIdempotency'), 'must be a boolean'));
  }
  const models: ModelDescriptor[] = [];
  if (!Array.isArray(value['models'])) {
    issues.push(createIssue('INVALID_TYPE', at(path, 'models'), 'must be an array of model descriptors'));
  } else {
    value['models'].forEach((entry, index) => {
      const parsed = parseModelDescriptor(entry, at(at(path, 'models'), index));
      if (parsed.ok) {
        models.push(parsed.value);
      } else {
        issues.push(...parsed.failure.issues);
      }
    });
  }
  if (issues.length > 0) {
    return invalid('MALFORMED_ENVELOPE', issues);
  }
  return valid({
    id: value['id'] as string,
    family: value['family'] as ProviderFamily,
    features,
    models,
    maxConcurrency: value['maxConcurrency'] as number,
    supportsIdempotency: value['supportsIdempotency'] as boolean,
  });
}

/* -------------------------------------------------------------------------------------------------
 * The adapter port. Defined now, implemented in Stage 3.
 * ----------------------------------------------------------------------------------------------- */

/** A value bound for the prompt. Every runtime value travels on the data channel. */
export type ProviderBoundValue = {
  readonly name: string;
  readonly label: string;
  readonly untrusted: boolean;
  /** Already serialized as text by the caller. */
  readonly value: string;
};

/**
 * AI Bridge's own request shape — not a vendor "chat completions" object.
 * `modelRef` is operator-side; it never travels back to a consumer.
 */
export type ProviderRequest = {
  readonly capability: string;
  readonly profile: ModelProfile;
  /** The trusted instruction channel. Authored, versioned. */
  readonly instructions: string;
  /** The data channel: runtime values, each flagged `untrusted`. */
  readonly context: readonly ProviderBoundValue[];
  /** Rendered output-format instruction, when the capability declares a schema. */
  readonly outputFormatInstruction?: string;
  readonly outputSchema?: OutputSchema;
  readonly modelRef: string;
  /** Absolute epoch milliseconds. The adapter must abandon work past it. */
  readonly deadlineAtMs: number;
  readonly maxOutputTokens?: number;
  /** In-process cancellation (Stage 3 additive). The adapter aborts outbound work on cancel. */
  readonly cancellation?: CancellationToken;
};

/** A raw, mapped provider error. Core reads `category` (and the optional mapped `reason`);
 * `rawMessage` is operator-only. */
export type ProviderRawError = {
  readonly category: ProviderCategory;
  /**
   * The generic reason this failure maps to (Stage 3 additive). When absent, the runtime derives
   * one from `category` via `reasonForProviderCategory`, so two adapters cannot disagree.
   */
  readonly reason?: AiErrorReason;
  /** A provider-reported throttle/quota reset hint, mapped to milliseconds. Never prose. */
  readonly retryAfterMs?: number;
  /** Operator-only diagnostic text, truncated and credential-stripped. Never crosses the boundary. */
  readonly rawMessage?: string;
};

/**
 * Thrown by an adapter to report a mapped provider failure (Stage 3).
 *
 * The `Error.message` is deliberately fixed and sanitized: a thrown value may end up in a stack
 * trace, and vendor prose is never a public contract (ARCHITECTURE.md §6.4). The mapped facts
 * travel on `rawError`; the runtime normalizes them to an `AiError`.
 */
export class ProviderCallError extends Error {
  readonly rawError: ProviderRawError;

  constructor(rawError: ProviderRawError) {
    super('provider call failed');
    this.name = 'ProviderCallError';
    this.rawError = rawError;
  }
}

/** True for a `ProviderCallError`, including one from another realm or module instance. */
export function isProviderCallError(value: unknown): value is ProviderCallError {
  return (
    typeof value === 'object' &&
    value !== null &&
    'name' in value &&
    (value as { name?: unknown }).name === 'ProviderCallError' &&
    'rawError' in value
  );
}

export type ProviderTextResult = {
  readonly text: string;
  readonly usage: AiUsage;
  readonly finishReason: 'STOP' | 'LENGTH' | 'CONTENT_FILTER' | 'UNKNOWN';
  readonly rawError?: ProviderRawError;
};

export type ProviderStructuredResult = {
  /** Raw prose, kept internal. A structured answer does not need its raw text to cross the boundary. */
  readonly text: string;
  readonly usage: AiUsage;
  readonly finishReason: 'STOP' | 'LENGTH' | 'CONTENT_FILTER' | 'UNKNOWN';
  readonly rawError?: ProviderRawError;
};

export type ProviderHealth = {
  readonly status: 'HEALTHY' | 'DEGRADED' | 'UNAVAILABLE';
  readonly checkedAtMs: number;
};

/**
 * Trusted credentials bound to an adapter (Stage 3).
 *
 * The **only** channel a credential value may travel on. The value never appears in a
 * `ProviderRequest`, a result, an error, a log line or a serialization — that absence is asserted
 * by the secret-leakage regression tests (TESTING.md §2.1).
 */
export type TrustedCredentials = {
  /** The operator-side handle the credential was resolved from. Safe to log. */
  readonly handle: string;
  /** The resolved secret. Never logged, never serialized, never returned to a consumer. */
  readonly secret: string;
};

/**
 * The mapped provider-side stream events (Stage 3).
 *
 * AI Bridge's own shape — never a vendor SSE frame. Exactly one terminal event (`FINISH` xor
 * `ERROR`) closes a provider stream; a stream without one is a transport failure.
 */
export const PROVIDER_STREAM_EVENT_KINDS = ['TEXT_DELTA', 'FINISH', 'ERROR'] as const;

export type ProviderStreamTextDelta = {
  readonly kind: 'TEXT_DELTA';
  readonly text: string;
};

export type ProviderStreamFinish = {
  readonly kind: 'FINISH';
  readonly usage: AiUsage;
  readonly finishReason: AiFinishReason;
};

export type ProviderStreamError = {
  readonly kind: 'ERROR';
  readonly error: ProviderRawError;
};

export type ProviderStreamEvent = ProviderStreamTextDelta | ProviderStreamFinish | ProviderStreamError;

/**
 * The provider abstraction. No vendor SDK type may appear in any signature.
 * Provider adapters are independent packages, not plugins (ARCHITECTURE.md §7.4).
 */
export interface AiProviderAdapter {
  readonly id: string;
  readonly family: ProviderFamily;
  readonly adapterApiVersion: number;
  readonly descriptor: ProviderDescriptor;
  generateText(request: ProviderRequest): Promise<ProviderTextResult>;
  generateStructured(request: ProviderRequest): Promise<ProviderStructuredResult>;
  /** Optional. A port that cannot stream says so rather than pretending (Stage 3 additive). */
  streamText?(request: ProviderRequest): AsyncIterable<ProviderStreamEvent>;
  /** Trusted (Stage 3 additive). Bind a resolved credential. The value is never logged or returned. */
  bindCredentials?(credentials: TrustedCredentials): void;
  /** A port that cannot probe says so rather than pretending. */
  probe?(signal: CancellationToken): Promise<ProviderHealth>;
  shutdown?(): Promise<void>;
}

/** True when a model descriptor lists the given feature and profile. */
export function modelSupports(model: ModelDescriptor, feature: ProviderFeature, profile: ModelProfile): boolean {
  return model.features.includes(feature) && model.profiles.includes(profile);
}

/** A model descriptor whose profile list contains only known profiles. */
export function modelProfilesOf(model: ModelDescriptor): readonly ModelProfile[] {
  return model.profiles.filter((profile) => isModelProfile(profile));
}
