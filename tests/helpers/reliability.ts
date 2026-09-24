/**
 * The Stage 5 reliability harness: fake providers with per-call behaviours, a fake clock and
 * in-memory governance stores.
 *
 * Everything is deterministic and local: no network, no real sleeps (backoff goes through an
 * `instantSleeper` that advances the test clock), and every provider is a behaviour function so a
 * test can script "timeout, then 429, then success" without touching a transport.
 */
import {
  PROVIDER_ADAPTER_API_VERSION,
  type AiFinishReason,
  type AiProviderAdapter,
  type AiUsage,
  type CancellationToken,
  type ModelProfile,
  type ProviderDescriptor,
  type ProviderFeature,
  type ProviderHealth,
  type ProviderRawError,
  type ProviderRequest,
  type ProviderStreamEvent,
  type ProviderStructuredResult,
  type ProviderTextResult,
} from '@aibridge/contracts';
import { TestClock } from '@aibridge/host-sdk';import {
  BudgetTracker,
  CircuitBreakerRegistry,
  IdempotencyRegistry,
  InMemoryIdempotencyStore,
  InMemoryMetrics,
  InMemoryQuotaStore,
  InMemoryRateLimitStore,
  InMemoryUsageLedger,
  QuotaManager,
  RateLimiter,
  RecordingOperationalEvents,
  RuntimeHealthRegistry,
  createIdMint,
  instantSleeper,
} from '@aibridge/governance';
import { AiRuntime, type RuntimeOptions } from '@aibridge/runtime';

export type FakeStep =
  | { readonly kind: 'text'; readonly text: string; readonly usage?: AiUsage; readonly finishReason?: AiFinishReason }
  | { readonly kind: 'structured'; readonly text: string; readonly usage?: AiUsage }
  | { readonly kind: 'rawError'; readonly rawError: ProviderRawError; readonly usage?: AiUsage }
  | { readonly kind: 'throw'; readonly error: unknown }
  | { readonly kind: 'hang' };

export type FakeBehavior = (call: number, request: ProviderRequest) => FakeStep | Promise<FakeStep>;

const DEFAULT_FEATURES: readonly ProviderFeature[] = ['text', 'structuredJson', 'streaming', 'usage'];

/** A provider adapter whose every call runs a behaviour function. Counted and inspectable. */
export class FakeProvider implements AiProviderAdapter {
  readonly id: string;
  readonly family = 'mock' as const;
  readonly adapterApiVersion = PROVIDER_ADAPTER_API_VERSION;
  readonly descriptor: ProviderDescriptor;
  readonly requests: ProviderRequest[] = [];
  readonly #behavior: FakeBehavior;
  #credentialHandle: string | null = null;

  constructor(options: {
    readonly id: string;
    readonly behavior: FakeBehavior;
    readonly features?: readonly ProviderFeature[];
    readonly supportsReliableIdempotency?: boolean;
    readonly modelRef?: string;
  }) {
    this.id = options.id;
    this.#behavior = options.behavior;
    const features = options.features ?? DEFAULT_FEATURES;
    this.descriptor = {
      id: options.id,
      family: 'mock',
      features: [...features],
      models: [
        {
          providerId: options.id,
          modelRef: options.modelRef ?? `${options.id}-model`,
          displayName: 'Fake model (operator-side only)',
          features: [...features],
          maxContextTokens: 8_192,
          maxOutputTokens: 4_096,
          profiles: ['fast', 'balanced', 'reasoning', 'cheap', 'high-context'],
        },
      ],
      maxConcurrency: 4,
      supportsIdempotency: options.supportsReliableIdempotency === true,
      ...(options.supportsReliableIdempotency === true ? { supportsReliableIdempotency: true } : {}),
    };
  }

  get callCount(): number {
    return this.requests.length;
  }

  bindCredentials(credentials: { readonly handle: string; readonly secret: string }): void {
    this.#credentialHandle = credentials.handle;
  }

  get credentialHandle(): string | null {
    return this.#credentialHandle;
  }

  async generateText(request: ProviderRequest): Promise<ProviderTextResult> {
    return this.#run(request) as Promise<ProviderTextResult>;
  }

  async generateStructured(request: ProviderRequest): Promise<ProviderStructuredResult> {
    return this.#run(request) as Promise<ProviderStructuredResult>;
  }

  async *streamText(request: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
    this.requests.push(request);
    yield { kind: 'FINISH', usage: {}, finishReason: 'STOP' };
  }

  async probe(_signal: CancellationToken): Promise<ProviderHealth> {
    return { status: 'HEALTHY', checkedAtMs: 0 };
  }

  async #run(request: ProviderRequest): Promise<ProviderTextResult | ProviderStructuredResult> {
    this.requests.push(request);
    const step = await this.#behavior(this.requests.length, request);
    switch (step.kind) {
      case 'text':
        return { text: step.text, usage: step.usage ?? {}, finishReason: step.finishReason ?? 'STOP' };
      case 'structured':
        return { text: step.text, usage: step.usage ?? {}, finishReason: 'STOP' };
      case 'rawError':
        return { text: '', usage: step.usage ?? {}, finishReason: 'UNKNOWN', rawError: step.rawError };
      case 'throw':
        throw step.error;
      case 'hang':
        return await new Promise<never>(() => {
          // never resolves; the attempt deadline abandons it
        });
      default: {
        const exhaustive: never = step;
        void exhaustive;
        throw new Error('unknown fake step');
      }
    }
  }
}

/** A scripted sequence of behaviours: the n-th call takes the n-th entry, the last one repeats. */
export function script(...steps: readonly FakeStep[]): FakeBehavior {
  return (call) => steps[Math.min(call, steps.length) - 1] ?? steps[steps.length - 1] ?? { kind: 'hang' };
}

export type HarnessProvider = {
  readonly id: string;
  readonly behavior: FakeBehavior;
  readonly features?: readonly ProviderFeature[];
  readonly supportsReliableIdempotency?: boolean;
};

export type Harness = {
  readonly runtime: AiRuntime;
  readonly providers: Readonly<Record<string, FakeProvider>>;
  readonly clock: TestClock;
  readonly ledger: InMemoryUsageLedger;
  readonly metrics: InMemoryMetrics;
  readonly events: RecordingOperationalEvents;
  readonly quotaStore: InMemoryQuotaStore;
  readonly rateStore: InMemoryRateLimitStore;
  readonly idempotencyStore: InMemoryIdempotencyStore;
  readonly slept: number[];
};

export function makeHarness(
  options: {
    readonly providers: readonly HarnessProvider[];
    readonly chains?: Readonly<Partial<Record<ModelProfile, readonly string[]>>>;
    readonly governance?: RuntimeOptions['governanceConfig'];
    readonly configManager?: RuntimeOptions['configManager'];
    readonly killSwitches?: NonNullable<RuntimeOptions['killSwitches']>;
  },
): Harness {
  const clock = new TestClock(0);
  const ledger = new InMemoryUsageLedger();
  const metrics = new InMemoryMetrics();
  const events = new RecordingOperationalEvents();
  const quotaStore = new InMemoryQuotaStore();
  const rateStore = new InMemoryRateLimitStore();
  const idempotencyStore = new InMemoryIdempotencyStore({ clock });
  const idempotency = new IdempotencyRegistry({ store: idempotencyStore, clock });
  const quotas = new QuotaManager({ store: quotaStore, clock });
  const breakers = new CircuitBreakerRegistry({ clock, config: options.governance?.breaker ?? {} });
  const health = new RuntimeHealthRegistry({ clock, breakers });
  const slept: number[] = [];

  const providers: Record<string, FakeProvider> = {};
  const registrations: { adapter: AiProviderAdapter; credentialRef?: string }[] = [];
  for (const provider of options.providers) {
    const instance = new FakeProvider({
      id: provider.id,
      behavior: provider.behavior,
      ...(provider.features === undefined ? {} : { features: provider.features }),
      ...(provider.supportsReliableIdempotency === undefined ? {} : { supportsReliableIdempotency: provider.supportsReliableIdempotency }),
    });
    providers[provider.id] = instance;
    registrations.push({ adapter: instance });
  }

  const chains = options.chains ?? { balanced: options.providers.map((provider) => provider.id) };
  const routes: Record<string, { providerId: string; modelRef: string; modelAlias: string }[]> = {};
  for (const [profile, providerIds] of Object.entries(chains)) {
    routes[profile] = (providerIds ?? []).map((providerId) => ({
      providerId,
      modelRef: `${providerId}-model`,
      modelAlias: `${providerId}.text.primary`,
    }));
  }

  const runtime = new AiRuntime({
    providers: registrations,
    routes,
    clock,
    ...(options.configManager === undefined ? {} : { configManager: options.configManager }),
    ...(options.governance === undefined ? {} : { governanceConfig: options.governance }),
    ...(options.killSwitches === undefined ? {} : { killSwitches: options.killSwitches }),
    services: {
      ledger,
      metrics,
      events,
      quotas,
      idempotency,
      breakers,
      health,
      rateLimiter: new RateLimiter({ store: rateStore, clock }),
      sleeper: instantSleeper((ms) => {
        slept.push(ms);
        clock.advance(ms);
      }),
      ids: createIdMint(),
    },
  });

  return { runtime, providers, clock, ledger, metrics, events, quotaStore, rateStore, idempotencyStore, slept };
}

/** One consumer turn. `turn` makes the logical identity unique — one turn ⇒ one key (frozen §10). */
export function textTurn(turn: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contractVersion: '1.0',
    requestId: `req-${turn}`,
    idempotencyKey: `turn-${turn}`,
    capability: 'ai.text.generate',
    capabilityVersion: '1.0',
    profile: 'balanced',
    input: { instructions: 'Summarise.', context: [] },
    ...overrides,
  };
}

export const STRUCTURED_SCHEMA = {
  kind: 'INLINE',
  schemaId: 'test.summary',
  version: '1.0',
  dialect: 'aibridge.fields/v1',
  fields: [{ name: 'summary', type: 'STRING', required: true, description: 'One line.' }],
} as const;

/** One consumer turn for `ai.structured.generate`, with the caller-owned schema. */
export function structuredTurn(turn: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contractVersion: '1.0',
    requestId: `req-${turn}`,
    idempotencyKey: `turn-${turn}`,
    capability: 'ai.structured.generate',
    capabilityVersion: '1.0',
    profile: 'balanced',
    input: { instructions: 'Summarise.', context: [] },
    outputSchema: STRUCTURED_SCHEMA,
    ...overrides,
  };
}

/** One consumer-composed bounded code-debug turn; the source remains explicitly untrusted. */
export function codeDebugTurn(turn: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contractVersion: '1.2',
    requestId: `req-${turn}`,
    idempotencyKey: `turn-${turn}`,
    capability: 'code.debug.analyze',
    capabilityVersion: '1.0',
    profile: 'balanced',
    promptApplied: true,
    promptVersion: 'consumer.debug.v1',
    input: {
      instructions: 'Classify only evidence in the supplied source.',
      context: [{ name: 'sourceCode', label: 'Source code', type: 'STRING', untrusted: true, value: 'const value = ;' }],
    },
    ...overrides,
  };
}

export const codeDebugCallerContext = {
  callerPluginId: 'test.caller',
  grantedPermissions: ['code.debug.analyze@1'],
};

export const callerContext = {
  callerPluginId: 'test.caller',
  grantedPermissions: ['ai.text.generate', 'ai.structured.generate'],
};

export function subjectContext(subjectToken: string): Record<string, unknown> {
  return { ...callerContext, subjectToken };
}

export { BudgetTracker, instantSleeper };
