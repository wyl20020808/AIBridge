/**
 * The provider conformance kit (TESTING.md §1.1).
 *
 * A reusable suite that every `AiProviderAdapter` must pass **unchanged** — the scripted stand-in
 * and the real reference adapter alike. An adapter that needs an exemption has a design problem.
 *
 * Cases are expressed as neutral **behaviors** (`ConformanceBehavior`), and each adapter's test
 * harness translates behaviors through its own injection seam — a script queue for the scripted
 * adapter, a fake HTTP transport for the OpenAI-compatible adapter. That is the "fixture-injection
 * port" of TESTING.md §1.1: one suite, many adapters, no vendor type in sight.
 *
 * Two cases cannot be expressed at runtime and are enforced elsewhere:
 *  - **no vendor type escapes** — the declaration-hygiene scan in `scripts/check-portability.mjs`
 *    plus strict typecheck;
 *  - **the full `AiError` mapping** — `normalizeProviderError` is asserted at the runtime layer
 *    (`tests/runtime/errors.test.ts`), where the generic error model lives.
 */
import {
  AI_FINISH_REASONS,
  ProviderCallError,
  type AiFinishReason,
  type AiProviderAdapter,
  type AiUsage,
  type ProviderRequest,
  type ProviderRawError,
  type ProviderStreamEvent,
} from '@aibridge/contracts';
import { rejectStep, streamStep, structuredStep, textStep, type ScriptedProviderAdapter } from './scripted-provider.js';
import type { ConformanceFinding, ConformanceReport } from './host-conformance.js';

/** A neutral scripted behaviour. Never vendor-shaped. */
export type ConformanceBehavior =
  | { readonly kind: 'text'; readonly text: string; readonly usage?: AiUsage; readonly finishReason?: AiFinishReason }
  | { readonly kind: 'structured'; readonly text: string; readonly usage?: AiUsage; readonly finishReason?: AiFinishReason }
  | { readonly kind: 'failure'; readonly rawError: ProviderRawError }
  | { readonly kind: 'hang' }
  | {
      readonly kind: 'stream';
      readonly deltas: readonly string[];
      readonly usage?: AiUsage;
      readonly finishReason?: AiFinishReason;
    }
  | { readonly kind: 'stream-failure'; readonly deltas: readonly string[]; readonly rawError: ProviderRawError };

/** An adapter plus the seam that scripts its next call. */
export type ConformanceTarget = {
  readonly adapter: AiProviderAdapter;
  enqueue(behavior: ConformanceBehavior): void;
};

/** Wrap a scripted adapter as a conformance target. */
export function scriptedConformanceTarget(adapter: ScriptedProviderAdapter): ConformanceTarget {
  return {
    adapter,
    enqueue(behavior: ConformanceBehavior): void {
      switch (behavior.kind) {
        case 'text':
          adapter.pushText(
            textStep(behavior.text, {
              ...(behavior.usage === undefined ? {} : { usage: behavior.usage }),
              ...(behavior.finishReason === undefined ? {} : { finishReason: behavior.finishReason }),
            }),
          );
          return;
        case 'structured':
          adapter.pushStructured(
            structuredStep(behavior.text, {
              ...(behavior.usage === undefined ? {} : { usage: behavior.usage }),
              ...(behavior.finishReason === undefined ? {} : { finishReason: behavior.finishReason }),
            }),
          );
          return;
        case 'failure':
          adapter.pushText(rejectStep(new ProviderCallError(behavior.rawError)));
          return;
        case 'hang':
          adapter.pushText({ kind: 'hang' });
          return;
        case 'stream':
          adapter.pushStream(
            streamStep(behavior.deltas, {
              ...(behavior.usage === undefined ? {} : { usage: behavior.usage }),
              ...(behavior.finishReason === undefined ? {} : { finishReason: behavior.finishReason }),
            }),
          );
          return;
        case 'stream-failure':
          adapter.pushStream(streamStep(behavior.deltas, { rawError: behavior.rawError }));
          return;
        default: {
          const exhaustive: never = behavior;
          void exhaustive;
        }
      }
    },
  };
}

export type ProviderConformanceOptions = {
  /**
   * A synthetic credential the kit binds and then searches for in every surface. Always synthetic
   * (TESTING.md §2.1): a test that uses a real key is itself a finding.
   */
  readonly syntheticSecret?: string;
};

export type ProviderConformanceCase = {
  readonly name: string;
  readonly run: (target: ConformanceTarget, options: ProviderConformanceOptions) => Promise<ConformanceFinding>;
};

/** A neutral request an adapter may be handed. Not vendor-shaped in any way. */
export function makeProviderRequest(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  const base: ProviderRequest = {
    capability: 'ai.text.generate',
    profile: 'balanced',
    instructions: 'conformance: describe the supplied value.',
    context: [],
    modelRef: 'conformance-model',
    deadlineAtMs: 1_000_000,
  };
  return { ...base, ...overrides };
}

function finding(name: string, ok: boolean, detail: string): ConformanceFinding {
  return { case: name, ok, detail };
}

/** The `rawError` a call surfaced, whether it arrived as a result field or a `ProviderCallError`. */
async function surfacedRawError(
  call: () => Promise<{ readonly rawError?: ProviderRawError }>,
): Promise<{ readonly rawError: ProviderRawError | null; readonly threwMessage: string | null; readonly resultJson: string }> {
  try {
    const result = await call();
    return {
      rawError: result.rawError ?? null,
      threwMessage: null,
      resultJson: JSON.stringify(result),
    };
  } catch (error) {
    const callError = error instanceof ProviderCallError ? error : null;
    return {
      rawError: callError?.rawError ?? null,
      threwMessage: error instanceof Error ? error.message : 'unknown error',
      resultJson: '',
    };
  }
}

export const PROVIDER_CONFORMANCE_CASES: readonly ProviderConformanceCase[] = [
  {
    name: 'text.happy-path',
    async run(target) {
      target.enqueue({ kind: 'text', text: 'a conformance answer' });
      const result = await target.adapter.generateText(makeProviderRequest());
      const ok = result.text.length > 0 && (AI_FINISH_REASONS as readonly string[]).includes(result.finishReason);
      return finding(
        'text.happy-path',
        ok,
        ok ? 'text is non-empty and the finish reason is closed' : 'text is empty or the finish reason is outside the closed set',
      );
    },
  },
  {
    name: 'structured.happy-path',
    async run(target) {
      target.enqueue({ kind: 'structured', text: '{"ok":true}' });
      const result = await target.adapter.generateStructured(
        makeProviderRequest({ capability: 'ai.structured.generate' }),
      );
      const ok = result.text.length > 0 && (AI_FINISH_REASONS as readonly string[]).includes(result.finishReason);
      return finding(
        'structured.happy-path',
        ok,
        ok ? 'a structured payload is returned as raw text' : 'the structured payload is empty or the finish reason is outside the closed set',
      );
    },
  },
  {
    name: 'error.surfaces-as-failure',
    async run(target) {
      target.enqueue({
        kind: 'failure',
        rawError: { category: 'UPSTREAM', reason: 'PROVIDER_UNAVAILABLE', rawMessage: 'synthetic transport failure' },
      });
      let threw = false;
      try {
        await target.adapter.generateText(makeProviderRequest());
      } catch {
        threw = true;
      }
      return finding(
        'error.surfaces-as-failure',
        threw,
        threw ? 'a transport failure is visible, not swallowed' : 'a transport failure was swallowed and looked like success',
      );
    },
  },
  {
    name: 'error.mapped-category',
    async run(target) {
      const sentinel = 'vendor-auth-prose-sentinel-12345';
      target.enqueue({
        kind: 'failure',
        rawError: { category: 'AUTH', reason: 'PROVIDER_AUTH_FAILED', rawMessage: sentinel },
      });
      const surfaced = await surfacedRawError(() => target.adapter.generateText(makeProviderRequest()));
      const categoryOk = surfaced.rawError?.category === 'AUTH' && surfaced.rawError?.reason === 'PROVIDER_AUTH_FAILED';
      const proseOk = !surfaced.resultJson.includes(sentinel) && !(surfaced.threwMessage ?? '').includes(sentinel);
      return finding(
        'error.mapped-category',
        categoryOk && proseOk,
        categoryOk && proseOk
          ? 'the mapped category and reason survive; vendor prose stays operator-only'
          : 'the failure lost its mapped category or leaked vendor prose into a public field',
      );
    },
  },
  {
    name: 'usage.shape',
    async run(target) {
      target.enqueue({ kind: 'text', text: 'x', usage: {} });
      const result = await target.adapter.generateText(makeProviderRequest());
      const ok = typeof result.usage === 'object' && result.usage !== null;
      return finding('usage.shape', ok, ok ? 'usage is an object even when empty' : 'usage is absent rather than empty');
    },
  },
  {
    name: 'finish-reason.closed',
    async run(target) {
      target.enqueue({ kind: 'text', text: 'x', finishReason: 'LENGTH' });
      const result = await target.adapter.generateText(makeProviderRequest());
      const ok = result.finishReason === 'LENGTH';
      return finding(
        'finish-reason.closed',
        ok,
        ok ? 'a truncated answer reports LENGTH' : `reported "${result.finishReason}" instead of LENGTH`,
      );
    },
  },
  {
    name: 'stream.round-trip',
    async run(target) {
      const streamText = target.adapter.streamText;
      const declaresStreaming = target.adapter.descriptor.features.includes('streaming');
      if (streamText === undefined) {
        return finding(
          'stream.round-trip',
          !declaresStreaming,
          declaresStreaming
            ? 'the descriptor declares streaming but the adapter cannot stream'
            : 'streaming is not declared and not implemented (honest)',
        );
      }
      target.enqueue({ kind: 'stream', deltas: ['conformance ', 'stream'], usage: { totalTokens: 3 }, finishReason: 'STOP' });
      const events: ProviderStreamEvent[] = [];
      for await (const event of streamText.call(target.adapter, makeProviderRequest())) {
        events.push(event);
      }
      const terminal = events[events.length - 1];
      const deltasBeforeTerminal = events.slice(0, -1).every((event) => event.kind === 'TEXT_DELTA');
      const ok =
        deltasBeforeTerminal &&
        terminal?.kind === 'FINISH' &&
        typeof terminal.usage === 'object' &&
        (AI_FINISH_REASONS as readonly string[]).includes(terminal.finishReason);
      return finding(
        'stream.round-trip',
        ok,
        ok ? 'deltas are followed by exactly one FINISH with usage and a closed finish reason' : 'the stream did not close with a single FINISH',
      );
    },
  },
  {
    name: 'stream.error-terminal',
    async run(target) {
      const streamText = target.adapter.streamText;
      if (streamText === undefined) {
        return finding('stream.error-terminal', true, 'streaming is not implemented (honest)');
      }
      target.enqueue({
        kind: 'stream-failure',
        deltas: ['partial'],
        rawError: { category: 'OVERLOADED', reason: 'PROVIDER_OVERLOADED', rawMessage: 'synthetic overload' },
      });
      const events: ProviderStreamEvent[] = [];
      for await (const event of streamText.call(target.adapter, makeProviderRequest())) {
        events.push(event);
      }
      const terminal = events[events.length - 1];
      const ok = events.slice(0, -1).every((event) => event.kind === 'TEXT_DELTA') && terminal?.kind === 'ERROR' && terminal.error.category === 'OVERLOADED';
      return finding(
        'stream.error-terminal',
        ok,
        ok ? 'a mid-stream failure closes the stream with exactly one ERROR event' : 'the stream failure did not close with one ERROR event',
      );
    },
  },
  {
    name: 'secret.no-escape',
    async run(target, options) {
      const bind = target.adapter.bindCredentials;
      const synthetic = options.syntheticSecret;
      if (bind === undefined) {
        return finding('secret.no-escape', true, 'the adapter binds no credential (honest)');
      }
      if (synthetic === undefined) {
        return finding('secret.no-escape', true, 'no synthetic secret supplied; binding probe skipped');
      }
      bind.call(target.adapter, { handle: 'secret://conformance/synthetic', secret: synthetic });
      target.enqueue({ kind: 'text', text: 'a conformance answer' });
      const surfaced = await surfacedRawError(() => target.adapter.generateText(makeProviderRequest()));
      const serialized = `${surfaced.resultJson}\n${surfaced.threwMessage ?? ''}\n${JSON.stringify(target.adapter)}\n${String(target.adapter)}`;
      const leaked = serialized.includes(synthetic);
      return finding(
        'secret.no-escape',
        !leaked,
        leaked ? 'the bound credential appears in an adapter output surface' : 'the bound credential appears in no output surface',
      );
    },
  },
];

function toTarget(subject: ConformanceTarget | ScriptedProviderAdapter): ConformanceTarget {
  if ('enqueue' in subject && 'adapter' in subject) {
    return subject;
  }
  return scriptedConformanceTarget(subject);
}

/** Run every provider-conformance case. Never throws: a thrown case is a failed finding. */
export async function runProviderConformance(
  subject: ConformanceTarget | ScriptedProviderAdapter,
  options: ProviderConformanceOptions = {},
): Promise<ConformanceReport> {
  const target = toTarget(subject);
  const findings: ConformanceFinding[] = [];
  for (const conformanceCase of PROVIDER_CONFORMANCE_CASES) {
    try {
      findings.push(await conformanceCase.run(target, options));
    } catch (error) {
      findings.push({
        case: conformanceCase.name,
        ok: false,
        detail: `the case threw: ${error instanceof Error ? error.message : 'unknown error'}`,
      });
    }
  }
  return {
    subject: `provider:${target.adapter.id}`,
    passed: findings.every((entry) => entry.ok),
    findings,
  };
}
