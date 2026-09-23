/**
 * A scripted provider adapter: deterministic answers for tests, with no network and no vendor type.
 *
 * It exists so every downstream test (structured pipeline, routing, reliability) can be written
 * before a real provider does. An empty script is a test bug, not an empty answer: `generate*`
 * throws rather than inventing a result.
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
  type ProviderRequest,
  type ProviderStructuredResult,
  type ProviderTextResult,
} from '@aibridge/contracts';

export type ScriptedTextStep =
  | { readonly kind: 'result'; readonly result: ProviderTextResult }
  | { readonly kind: 'reject'; readonly error: Error }
  | { readonly kind: 'hang' };

export type ScriptedStructuredStep =
  | { readonly kind: 'result'; readonly result: ProviderStructuredResult }
  | { readonly kind: 'reject'; readonly error: Error }
  | { readonly kind: 'hang' };

/** Build a successful text step. */
export function textStep(
  text: string,
  options: { readonly usage?: AiUsage; readonly finishReason?: AiFinishReason; readonly rawError?: { category: ProviderCategory; rawMessage?: string } } = {},
): ScriptedTextStep {
  return {
    kind: 'result',
    result: {
      text,
      usage: options.usage ?? {},
      finishReason: options.finishReason ?? 'STOP',
      ...(options.rawError === undefined
        ? {}
        : {
            rawError: {
              category: options.rawError.category,
              ...(options.rawError.rawMessage === undefined ? {} : { rawMessage: options.rawError.rawMessage }),
            },
          }),
    },
  };
}

/** Build a successful structured step from a raw payload (JSON string or prose around JSON). */
export function structuredStep(
  text: string,
  options: { readonly usage?: AiUsage; readonly finishReason?: AiFinishReason; readonly rawError?: { category: ProviderCategory; rawMessage?: string } } = {},
): ScriptedStructuredStep {
  return {
    kind: 'result',
    result: {
      text,
      usage: options.usage ?? {},
      finishReason: options.finishReason ?? 'STOP',
      ...(options.rawError === undefined
        ? {}
        : {
            rawError: {
              category: options.rawError.category,
              ...(options.rawError.rawMessage === undefined ? {} : { rawMessage: options.rawError.rawMessage }),
            },
          }),
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

export type ScriptedProviderOptions = {
  readonly id?: string;
  readonly textSteps?: readonly ScriptedTextStep[];
  readonly structuredSteps?: readonly ScriptedStructuredStep[];
};

export class ScriptedProviderAdapter implements AiProviderAdapter {
  readonly id: string;
  readonly family = 'mock' as const;
  readonly adapterApiVersion = PROVIDER_ADAPTER_API_VERSION;
  readonly descriptor: ProviderDescriptor;

  readonly #textSteps: ScriptedTextStep[];
  readonly #structuredSteps: ScriptedStructuredStep[];
  readonly #requests: ProviderRequest[] = [];

  constructor(options: ScriptedProviderOptions = {}) {
    this.id = options.id ?? 'scripted';
    this.#textSteps = [...(options.textSteps ?? [])];
    this.#structuredSteps = [...(options.structuredSteps ?? [])];
    this.descriptor = {
      id: this.id,
      family: 'mock',
      features: ['text', 'structuredJson', 'usage'],
      models: [
        {
          providerId: this.id,
          modelRef: `${this.id}-model`,
          displayName: 'Scripted model (operator-side only)',
          features: ['text', 'structuredJson', 'usage'],
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

  pushText(step: ScriptedTextStep): void {
    this.#textSteps.push(step);
  }

  pushStructured(step: ScriptedStructuredStep): void {
    this.#structuredSteps.push(step);
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

  async probe(_signal: CancellationToken): Promise<ProviderHealth> {
    return { status: 'HEALTHY', checkedAtMs: 0 };
  }
}
