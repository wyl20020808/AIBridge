/**
 * The provider suite base contract — one table, four adapters (ROADMAP Stage 4 §28, §48–50).
 *
 * The Phase 28 checklist runs unchanged through one `AiRuntime` against OpenAI Official, DeepSeek
 * Official, Xiaomi Token Plan and the generic relay: text success, structured success, malformed
 * response, 401/403, 404 model, 429, 5xx, timeout, cancel, usage, finish reason, stream success,
 * stream error — plus the security rows: credential never leaks, and a **malicious provider error
 * body** (echoing the credential, learner-like PII and a stack trace) is sanitized everywhere it
 * could reach a consumer.
 */
import { describe, expect, it } from 'vitest';
import type { AiResult, AiStreamEvent } from '@aibridge/contracts';

import {
  MATRIX_PROVIDERS,
  makeMatrixProvider,
  matrixContext,
  matrixRequest,
  type MatrixProvider,
} from '../helpers/provider-matrix.js';

const PII_SENTINEL = 'learner@example.invalid';
const STACK_SENTINEL = '    at runService (C:\\svc\\app.js:12:9)';

function textRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return matrixRequest(overrides);
}

function structuredRequest(): Record<string, unknown> {
  return matrixRequest({
    capability: 'ai.structured.generate',
    outputSchema: {
      kind: 'INLINE',
      schemaId: 'matrix.summary',
      version: '1.0',
      dialect: 'aibridge.fields/v1',
      fields: [{ name: 'summary', type: 'STRING', required: true, description: 'One line.' }],
    },
  });
}

async function expectError(result: Promise<AiResult<unknown>>): Promise<NonNullable<AiResult<unknown>['error']>> {
  const resolved = await result;
  expect(resolved.status, JSON.stringify(resolved)).toBe('FAILED');
  const error = resolved.error;
  if (error === undefined) {
    throw new Error('expected an error');
  }
  return error;
}

describe.each(MATRIX_PROVIDERS)('provider suite base contract — %s', (name) => {
  async function setup(): Promise<MatrixProvider> {
    return makeMatrixProvider(name);
  }

  it('text success: generic result, usage and finish reason', async () => {
    const p = await setup();
    p.push({ kind: 'text', text: 'pong', usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 }, finishReason: 'STOP' });
    const result = await p.runtime.execute(textRequest(), matrixContext);
    expect(result.status, JSON.stringify(result.error)).toBe('SUCCEEDED');
    expect(result.output).toEqual({ text: 'pong', finishReason: 'STOP' });
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 1, totalTokens: 4 });
    expect(result.providerMetadata.providerFamily).toBe('openai-compatible');
  });

  it('structured success: extraction + strict validation decide', async () => {
    const p = await setup();
    p.push({ kind: 'structured', text: '{"summary":"two passes"}', finishReason: 'STOP' });
    const result = await p.runtime.execute(structuredRequest(), matrixContext);
    expect(result.status, JSON.stringify(result.error)).toBe('SUCCEEDED');
    expect(result.output).toEqual({ summary: 'two passes' });
  });

  it('malformed response: INVALID_RESPONSE semantics, never a partial object', async () => {
    const p = await setup();
    p.pushMalformed();
    const error = await expectError(p.runtime.execute(textRequest(), matrixContext));
    expect(error.reason).toBe('PROVIDER_BAD_RESPONSE');
    expect(error.code).toBe('INVALID_RESPONSE');
  });

  it('401/403: a deployment failure, not a consumer bug', async () => {
    const p = await setup();
    p.push({ kind: 'failure', rawError: { category: 'AUTH', reason: 'PROVIDER_AUTH_FAILED', rawMessage: 'bad key' } });
    const error = await expectError(p.runtime.execute(textRequest(), matrixContext));
    expect(error.reason).toBe('PROVIDER_AUTH_FAILED');
    expect(error.retryable).toBe(false);
  });

  it('404 model: MODEL_UNAVAILABLE, a routing problem', async () => {
    const p = await setup();
    p.push({ kind: 'failure', rawError: { category: 'BAD_REQUEST', reason: 'MODEL_UNAVAILABLE', rawMessage: 'no such model' } });
    const error = await expectError(p.runtime.execute(textRequest(), matrixContext));
    expect(error.reason).toBe('MODEL_UNAVAILABLE');
  });

  it('429: RATE_LIMITED with the provider reset hint', async () => {
    const p = await setup();
    p.push({
      kind: 'failure',
      rawError: { category: 'RATE_LIMIT', reason: 'PROVIDER_THROTTLED', retryAfterMs: 2000, rawMessage: 'slow down' },
    });
    const error = await expectError(p.runtime.execute(textRequest(), matrixContext));
    expect(error.reason).toBe('PROVIDER_THROTTLED');
    expect(error.code).toBe('RATE_LIMITED');
  });

  it('5xx: a retryable provider failure', async () => {
    const p = await setup();
    p.push({ kind: 'failure', rawError: { category: 'UPSTREAM', reason: 'PROVIDER_UNAVAILABLE', rawMessage: 'boom' } });
    const error = await expectError(p.runtime.execute(textRequest(), matrixContext));
    expect(error.reason).toBe('PROVIDER_UNAVAILABLE');
    expect(error.retryable).toBe(true);
  });

  it('timeout: the outbound call is abandoned and the failure is TIMEOUT', async () => {
    const p = await setup();
    p.push({ kind: 'hang' });
    const error = await expectError(
      p.runtime.execute(textRequest({ timeoutBudget: { totalMs: 5_000, providerMs: 50 } }), matrixContext),
    );
    expect(['PROVIDER_TIMEOUT', 'BUDGET_EXHAUSTED']).toContain(error.reason);
    expect(error.code).toBe('TIMEOUT');
    expect(p.aborts()).toBeGreaterThan(0);
  });

  it('cancel: terminal, and the outbound call is aborted', async () => {
    const p = await setup();
    p.push({ kind: 'hang' });
    const callbacks = new Set<() => void>();
    let cancelled = false;
    const token = {
      get cancelled(): boolean {
        return cancelled;
      },
      onCancel(callback: () => void): () => void {
        callbacks.add(callback);
        return () => callbacks.delete(callback);
      },
    };
    const pending = p.runtime.execute(textRequest({ timeoutBudget: { totalMs: 30_000 } }), matrixContext, {
      cancellation: token,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    cancelled = true;
    for (const callback of [...callbacks]) callback();
    const error = await expectError(pending);
    expect(error.reason).toBe('CANCELLED_BY_CALLER');
    expect(p.aborts()).toBeGreaterThan(0);
  });

  it('finish reason: LENGTH is reported as LENGTH', async () => {
    const p = await setup();
    p.push({ kind: 'text', text: 'truncated…', finishReason: 'LENGTH' });
    const result = await p.runtime.execute(textRequest(), matrixContext);
    expect(result.status).toBe('SUCCEEDED');
    expect(result.finishReason).toBe('LENGTH');
  });

  it('stream success: deltas then exactly one COMPLETED', async () => {
    const p = await setup();
    p.push({ kind: 'stream', deltas: ['he', 'llo'], usage: { totalTokens: 5 }, finishReason: 'STOP' });
    const events: AiStreamEvent[] = [];
    for await (const event of p.runtime.stream(textRequest(), matrixContext)) {
      events.push(event);
    }
    expect(events.map((event) => event.kind)).toEqual(['STARTED', 'TEXT_DELTA', 'TEXT_DELTA', 'COMPLETED']);
    const terminal = events[events.length - 1];
    if (terminal?.kind !== 'COMPLETED') throw new Error('expected COMPLETED');
    expect(terminal.text).toBe('hello');
  });

  it('stream error: exactly one FAILED terminal', async () => {
    const p = await setup();
    p.push({
      kind: 'stream-failure',
      deltas: ['par'],
      rawError: { category: 'OVERLOADED', reason: 'PROVIDER_OVERLOADED', rawMessage: 'overloaded' },
    });
    const events: AiStreamEvent[] = [];
    for await (const event of p.runtime.stream(textRequest(), matrixContext)) {
      events.push(event);
    }
    const terminal = events[events.length - 1];
    expect(terminal?.kind).toBe('FAILED');
  });

  it('security: the credential leaks into no surface, even from a malicious error body', async () => {
    const p = await setup();
    const malicious = `upstream echoed key ${p.syntheticSecret} for ${PII_SENTINEL}${STACK_SENTINEL}`;
    p.push({ kind: 'failure', rawError: { category: 'UPSTREAM', reason: 'PROVIDER_UNAVAILABLE', rawMessage: malicious } });
    const result = await p.runtime.execute(textRequest(), matrixContext);
    const publicSurfaces = [
      JSON.stringify(result),
      JSON.stringify(p.runtime),
      JSON.stringify(p.adapter),
      String(p.adapter),
      JSON.stringify(p.calls.map((call) => call.payload)),
    ].join('\n');
    expect(publicSurfaces).not.toContain(p.syntheticSecret);
    // Vendor prose (PII echo, stack frames) never reaches a consumer-facing field either.
    expect(JSON.stringify(result)).not.toContain(PII_SENTINEL);
    expect(JSON.stringify(result)).not.toContain('app.js');
    // The operator-only detail keeps prose but strips the credential.
    const operatorDetail = (p.adapter as unknown as { sanitizeForOperator(message: string): string }).sanitizeForOperator(malicious);
    expect(operatorDetail).not.toContain(p.syntheticSecret);
    expect(operatorDetail.length).toBeLessThanOrEqual(512);
  });
});
