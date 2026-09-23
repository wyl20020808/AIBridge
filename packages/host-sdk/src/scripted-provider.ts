/**
 * A scripted provider adapter: deterministic answers for tests, with no network and no vendor type.
 *
 * It exists so every downstream test (runtime pipeline, structured pipeline, routing, reliability)
 * can be written before a real provider does. An empty script is a test bug, not an empty answer:
 * `generate*` throws rather than inventing a result.
 *
 * Credential handling is deliberately one-way: `bindCredentials` records the **handle** and
 * discards the value, so this adapter physically cannot leak a secret it was given.
 */
import {
  PROVIDER_ADAPTER_API_VERSION,
  type AiFinishReason,
  type AiProviderAdapter,
  type AiUsage,
  type CancellationToken,
  type ProviderCategory,
  type ProviderDescriptor,
  type ProviderHealth,
  type ProviderRawError,
  type ProviderRequest,
  type ProviderStreamEvent,
  type ProviderStructuredResult,
  type ProviderTextResult,
  type AiErrorReason,
  type TrustedCredentials,
} from '@aibridge/contracts';

export type ScriptedTextStep =
  | { readonly kind: 'result'; readonly result: ProviderTextResult }
  | { readonly kind: 'reject'; readonly error: Error }
  | { readonly kind: 'hang' };

export type ScriptedStructuredStep =
  | { readonly kind: 'result'; readonly result: ProviderStructuredResult }
  | { readonly kind: 'reject'; readonly error: Error }
  | { readonly kind: 'hang' };

export type ScriptedStreamStep =
  | { readonly kind: 'result'; readonly events: readonly ProviderStreamEvent[] }
  | { readonly kind: 'reject'; readonly error: Error }
  | { readonly kind: 'hang' };

export type ScriptedResultOptions = {
  readonly usage?: AiUsage;
  readonly finishReason?: AiFinishReason;
  readonly rawError?: { category: ProviderCategory; reason?: AiErrorReason; retryAfterMs?: number; rawMessage?: string };
};

function scriptedRawError(options: ScriptedResultOptions): ProviderRawError | undefined {
  if (options.rawError === undefined) {
    return undefined;
  }
  return {
    category: options.rawError.category,
    ...(options.rawError.reason === undefined ? {} : { reason: options.rawError.reason }),
    ...(options.rawError.retryAfterMs === undefined ? {} : { retryAfterMs: options.rawError.retryAfterMs }),
    ...(options.rawError.rawMessage === undefined ? {} : { rawMessage: options.rawError.rawMessage }),
  };
}

/** Build a successful text step. */
export function textStep(text: string, options: ScriptedResultOptions = {}): ScriptedTextStep {
  const rawError = scriptedRawError(options);
  return {
    kind: 'result',
    result: {
      text,
      usage: options.usage ?? {},
      finishReason: options.finishReason ?? 'STOP',
      ...(rawError === undefined ? {} : { rawError }),
    },
  };
}

/** Build a successful structured step from a raw payload (JSON string or prose around JSON). */
export function structuredStep(text: string, options: ScriptedResultOptions = {}): ScriptedStructuredStep {
  const rawError = scriptedRawError(options);
  return {
    kind: 'result',
    result: {
      text,
      usage: options.usage ?? {},
      finishReason: options.finishReason ?? 'STOP',
      ...(rawError === undefined ? {} : { rawError }),
    },
  };
}

/** A step that rejects with a synthetic transport error. */
export function rejectStep(error: Error): ScriptedTextStep & ScriptedStructuredStep {
  return { kind: 'reject', error };
}

/** A step that never resolves — used to test deadlines. */
export function hangStep(): ScriptedTextStep & ScriptedStructuredStep {
  return { kind: 'hang' };
}

/**
 * Build a stream step from text increments. Always terminated with `FINISH` unless `rawError` is
 * given, in which case the stream closes with an `ERROR` event — exactly one terminal either way.
 */
export function streamStep(
  deltas: readonly string[],
  options: ScriptedResultOptions = {},
): ScriptedStreamStep {
  const rawError = scriptedRawError(options);
  const events: ProviderStreamEvent[] = deltas.map((text) => ({ kind: 'TEXT_DELTA', text }));
  events.push(
    rawError === undefined
      ? {
          kind: 'FINISH',
          usage: options.usage ?? {},
          finishReason: options.finishReason ?? 'STOP',
        }
      : { kind: 'ERROR', error: rawError },
  );
  return { kind: 'result', events };
}

/** A stream step that rejects mid-flight — used to test stream error behaviour. */
export function streamRejectStep(error: Error): ScriptedStreamStep {
  return { kind: 'reject', error };
}

export type ScriptedProviderOptions = {
  readonly id?: string;
  readonly textSteps?: readonly ScriptedTextStep[];
  readonly structuredSteps?: readonly ScriptedStructuredStep[];
  readonly streamSteps?: readonly ScriptedStreamStep[];
};

export class ScriptedProviderAdapter implements AiProviderAdapter {
  readonly id: string;
  readonly family = 'mock' as const;
  readonly adapterApiVersion = PROVIDER_ADAPTER_API_VERSION;
  readonly descriptor: ProviderDescriptor;

  readonly #textSteps: ScriptedTextStep[];
  readonly #structuredSteps: ScriptedStructuredStep[];
  readonly #streamSteps: ScriptedStreamStep[];
  readonly #requests: ProviderRequest[] = [];
  #credentialHandle: string | null = null;

  constructor(options: ScriptedProviderOptions = {}) {
    this.id = options.id ?? 'scripted';
    this.#textSteps = [...(options.textSteps ?? [])];
    this.#structuredSteps = [...(options.structuredSteps ?? [])];
    this.#streamSteps = [...(options.streamSteps ?? [])];
    this.descriptor = {
      id: this.id,
      family: 'mock',
      features: ['text', 'structuredJson', 'streaming', 'usage'],
      models: [
        {
          providerId: this.id,
          modelRef: `${this.id}-model`,
          displayName: 'Scripted model (operator-side only)',
          features: ['text', 'structuredJson', 'streaming', 'usage'],
          maxContextTokens: 8_192,
          maxOutputTokens: 4_096,
          profiles: ['fast', 'balanced', 'reasoning', 'cheap', 'high-context'],
        },
      ],
      maxConcurrency: 1,
      supportsIdempotency: false,
    };
  }

  /** Every request this adapter has seen, in order. */
  get requests(): readonly ProviderRequest[] {
    return [...this.#requests];
  }

  get callCount(): number {
    return this.#requests.length;
  }

  /**
   * Trusted credential binding. The **handle** is recorded; the value is dropped on the floor, so
   * this adapter cannot leak a secret even if a test tries too.
   */
  bindCredentials(credentials: TrustedCredentials): void {
    this.#credentialHandle = credentials.handle;
  }

  /** The operator-side handle this adapter was bound to. Never a value. */
  get credentialHandle(): string | null {
    return this.#credentialHandle;
  }

  pushText(step: ScriptedTextStep): void {
    this.#textSteps.push(step);
  }

  pushStructured(step: ScriptedStructuredStep): void {
    this.#structuredSteps.push(step);
  }

  pushStream(step: ScriptedStreamStep): void {
    this.#streamSteps.push(step);
  }

  async generateText(request: ProviderRequest): Promise<ProviderTextResult> {
    this.#requests.push(request);
    const step = this.#textSteps.shift();
    if (step === undefined) {
      throw new Error('ScriptedProviderAdapter: no scripted text step remains');
    }
    switch (step.kind) {
      case 'result':
        return step.result;
      case 'reject':
        throw step.error;
      case 'hang':
        return await new Promise<ProviderTextResult>(() => {
          // never resolves
        });
      default: {
        const exhaustive: never = step;
        void exhaustive;
        throw new Error('ScriptedProviderAdapter: unknown text step');
      }
    }
  }

  async generateStructured(request: ProviderRequest): Promise<ProviderStructuredResult> {
    this.#requests.push(request);
    const step = this.#structuredSteps.shift();
    if (step === undefined) {
      throw new Error('ScriptedProviderAdapter: no scripted structured step remains');
    }
    switch (step.kind) {
      case 'result':
        return step.result;
      case 'reject':
        throw step.error;
      case 'hang':
        return await new Promise<ProviderStructuredResult>(() => {
          // never resolves
        });
      default: {
        const exhaustive: never = step;
        void exhaustive;
        throw new Error('ScriptedProviderAdapter: unknown structured step');
      }
    }
  }

  async *streamText(request: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
    this.#requests.push(request);
    const step = this.#streamSteps.shift();
    if (step === undefined) {
      throw new Error('ScriptedProviderAdapter: no scripted stream step remains');
    }
    switch (step.kind) {
      case 'result':
        for (const event of step.events) {
          yield event;
        }
        return;
      case 'reject':
        throw step.error;
      case 'hang':
        await new Promise<never>(() => {
          // never resolves
        });
        return;
      default: {
        const exhaustive: never = step;
        void exhaustive;
        throw new Error('ScriptedProviderAdapter: unknown stream step');
      }
    }
  }

  async probe(_signal: CancellationToken): Promise<ProviderHealth> {
    return { status: 'HEALTHY', checkedAtMs: 0 };
  }
}
