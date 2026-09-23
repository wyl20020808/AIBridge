/**
 * The provider conformance kit — **skeleton** (TESTING.md §1.1, ROADMAP Stage 2).
 *
 * Stage 2 has no real adapter, so the kit today runs against the scripted adapter. The cases are
 * chosen to be adapter-agnostic properties that a real adapter must also satisfy; Stage 3 adds the
 * fixture-injection port that lets a real adapter be scripted the same way.
 *
 * Two cases in TESTING.md §1.1 cannot be expressed at runtime and are enforced elsewhere:
 *  - **no vendor type escapes** — `scripts/check-adapter-coupling.mjs` and strict typecheck;
 *  - **no secret escapes** — the response-projection security test.
 */
import { AI_FINISH_REASONS, type AiProviderAdapter, type ProviderRequest } from '@aibridge/contracts';
import { rejectStep, structuredStep, textStep, type ScriptedProviderAdapter } from './scripted-provider.js';
import type { ConformanceFinding, ConformanceReport } from './host-conformance.js';

export type ProviderConformanceOptions = {
  readonly deadlineAtMs?: number;
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

export type ProviderConformanceCase = {
  readonly name: string;
  readonly run: (adapter: ScriptedProviderAdapter & AiProviderAdapter) => Promise<ConformanceFinding>;
};

function finding(name: string, ok: boolean, detail: string): ConformanceFinding {
  return { case: name, ok, detail };
}

export const PROVIDER_CONFORMANCE_CASES: readonly ProviderConformanceCase[] = [
  {
    name: 'text.happy-path',
    async run(adapter) {
      adapter.pushText(textStep('a conformance answer'));
      const result = await adapter.generateText(makeProviderRequest());
      const ok = result.text.length > 0 && (AI_FINISH_REASONS as readonly string[]).includes(result.finishReason);
      return finding('text.happy-path', ok, ok ? 'text is non-empty and the finish reason is closed' : 'text is empty or the finish reason is outside the closed set');
    },
  },
  {
    name: 'structured.happy-path',
    async run(adapter) {
      adapter.pushStructured(structuredStep('{"ok":true}'));
      const result = await adapter.generateStructured(makeProviderRequest({ capability: 'ai.structured.generate' }));
      const ok = result.text.length > 0 && (AI_FINISH_REASONS as readonly string[]).includes(result.finishReason);
      return finding('structured.happy-path', ok, ok ? 'a structured payload is returned as raw text' : 'the structured payload is empty or the finish reason is outside the closed set');
    },
  },
  {
    name: 'error.surfaces-as-failure',
    async run(adapter) {
      adapter.pushText(rejectStep(new Error('synthetic transport failure')));
      let threw = false;
      try {
        await adapter.generateText(makeProviderRequest());
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
    name: 'usage.shape',
    async run(adapter) {
      adapter.pushText(textStep('x', { usage: {} }));
      const result = await adapter.generateText(makeProviderRequest());
      const ok = typeof result.usage === 'object' && result.usage !== null;
      return finding('usage.shape', ok, ok ? 'usage is an object even when empty' : 'usage is absent rather than empty');
    },
  },
  {
    name: 'finish-reason.closed',
    async run(adapter) {
      adapter.pushText(textStep('x', { finishReason: 'LENGTH' }));
      const result = await adapter.generateText(makeProviderRequest());
      const ok = result.finishReason === 'LENGTH';
      return finding('finish-reason.closed', ok, ok ? 'a truncated answer reports LENGTH' : `reported "${result.finishReason}" instead of LENGTH`);
    },
  },
];

export async function runProviderConformance(
  adapter: ScriptedProviderAdapter & AiProviderAdapter,
): Promise<ConformanceReport> {
  const findings: ConformanceFinding[] = [];
  for (const conformanceCase of PROVIDER_CONFORMANCE_CASES) {
    try {
      findings.push(await conformanceCase.run(adapter));
    } catch (error) {
      findings.push({
        case: conformanceCase.name,
        ok: false,
        detail: `the case threw: ${error instanceof Error ? error.message : 'unknown error'}`,
      });
    }
  }
  return {
    subject: `provider:${adapter.id}`,
    passed: findings.every((entry) => entry.ok),
    findings,
  };
}
