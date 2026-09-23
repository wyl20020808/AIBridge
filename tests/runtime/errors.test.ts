/**
 * Generic error propagation (ROADMAP Stage 3 §5).
 *
 * Provider and network failures below the runtime are normalized into the **existing** Stage 2
 * error model — twelve codes, closed reasons, one authoritative retryability. Provider raw error
 * bodies are read only inside the adapter and never reach a consumer: every case below asserts
 * both the mapping and the non-penetration of a vendor prose sentinel.
 */
import { ScriptedProviderAdapter, TestClock, rejectStep, textStep } from '@aibridge/host-sdk';
import { AiRuntime, normalizeProviderError, normalizeThrown } from '@aibridge/runtime';
import { ProviderCallError, type AiError, type AiResult } from '@aibridge/contracts';
import { describe, expect, it } from 'vitest';

import { makeFakeOpenAi } from '../helpers/openai-fake.js';

const VENDOR_SENTINEL = 'vendor-prose-sentinel-67890';

function makeFakeRuntime(): ReturnType<typeof makeFakeOpenAi> & { readonly runtime: AiRuntime } {
  const fake = makeFakeOpenAi({ id: 'main', modelRef: 'fake-model' });
  const runtime = new AiRuntime({
    providers: [{ adapter: fake.adapter }],
    routes: { balanced: [{ providerId: 'main', modelRef: 'fake-model' }] },
    clock: new TestClock(0),
  });
  return { ...fake, runtime };
}

function textRequest(turn = 1): Record<string, unknown> {
  // One logical turn ⇒ one idempotencyKey (frozen §10). A test that runs two turns must say so.
  return {
    contractVersion: '1.0',
    requestId: `req-err-${turn}`,
    idempotencyKey: `turn-err.attempt-${turn}`,
    capability: 'ai.text.generate',
    capabilityVersion: '1.0',
    profile: 'balanced',
    input: { instructions: 'Summarise.', context: [] },
  };
}

const context = { callerPluginId: 'test.caller', grantedPermissions: ['ai.text.generate'] };

function expectMapping(
  result: AiResult<unknown>,
  expected: { readonly code: string; readonly reason: string; readonly retryable: boolean; readonly category?: string },
): AiError {
  expect(result.status, JSON.stringify(result)).toBe('FAILED');
  const error = result.error;
  if (error === undefined) {
    throw new Error('expected an error');
  }
  expect(error.code, JSON.stringify(error)).toBe(expected.code);
  expect(error.reason, JSON.stringify(error)).toBe(expected.reason);
  expect(error.retryable).toBe(expected.retryable);
  if (expected.category !== undefined) {
    expect(error.details?.['providerCategory']).toBe(expected.category);
  }
  const serialized = JSON.stringify(result);
  expect(serialized).not.toContain(VENDOR_SENTINEL);
  return error;
}

describe('provider failures map to the closed generic error model', () => {
  it('maps 401/403 to an auth failure — not a consumer bug, not retried blindly', async () => {
    const { runtime, push } = makeFakeRuntime();
    push({ status: 401, json: { error: { type: 'invalid_request_error', message: VENDOR_SENTINEL } } });
    expectMapping(await runtime.execute(textRequest(), context), {
      code: 'PROVIDER_ERROR',
      reason: 'PROVIDER_AUTH_FAILED',
      retryable: false,
      category: 'AUTH',
    });

    push({ status: 403, json: { error: { type: 'invalid_request_error', message: VENDOR_SENTINEL } } });
    expectMapping(await runtime.execute(textRequest(), context), {
      code: 'PROVIDER_ERROR',
      reason: 'PROVIDER_AUTH_FAILED',
      retryable: false,
      category: 'AUTH',
    });
  });

  it('maps a model-not-found body to MODEL_UNAVAILABLE — a routing problem', async () => {
    const { runtime, push } = makeFakeRuntime();
    push({ status: 404, json: { error: { type: 'model_not_found', message: VENDOR_SENTINEL } } });
    const error = expectMapping(await runtime.execute(textRequest(), context), {
      code: 'MODEL_UNAVAILABLE',
      reason: 'MODEL_UNAVAILABLE',
      retryable: false,
    });
    expect(error.stage).toBe('ROUTING');

    push({ status: 400, json: { error: { type: 'invalid_model_error', message: VENDOR_SENTINEL } } });
    expectMapping(await runtime.execute(textRequest(), context), {
      code: 'MODEL_UNAVAILABLE',
      reason: 'MODEL_UNAVAILABLE',
      retryable: false,
    });
  });

  it('maps 429 to RATE_LIMITED with the provider reset hint', async () => {
    const { runtime, push } = makeFakeRuntime();
    push({ status: 429, headers: { 'retry-after': '1.5' }, json: { error: { type: 'rate_limit_error', message: VENDOR_SENTINEL } } });
    const error = expectMapping(await runtime.execute(textRequest(), context), {
      code: 'RATE_LIMITED',
      reason: 'PROVIDER_THROTTLED',
      retryable: true,
      category: 'RATE_LIMIT',
    });
    expect(error.retryAfterMs).toBe(1500);
  });

  it('maps 5xx to a retryable provider failure, 503 to overloaded', async () => {
    const { runtime, push } = makeFakeRuntime();
    push({ status: 500, json: { error: { type: 'server_error', message: VENDOR_SENTINEL } } });
    expectMapping(await runtime.execute(textRequest(1), context), {
      code: 'PROVIDER_ERROR',
      reason: 'PROVIDER_UNAVAILABLE',
      retryable: true,
      category: 'UPSTREAM',
    });

    push({ status: 503, json: { error: { type: 'invalid_request_error', message: VENDOR_SENTINEL } } });
    expectMapping(await runtime.execute(textRequest(2), context), {
      code: 'PROVIDER_ERROR',
      reason: 'PROVIDER_OVERLOADED',
      retryable: true,
      category: 'OVERLOADED',
    });
  });

  it('maps a provider-rejected request to INVALID_REQUEST — fallback is pointless', async () => {
    const { runtime, push } = makeFakeRuntime();
    push({ status: 400, json: { error: { type: 'invalid_request_error', message: VENDOR_SENTINEL } } });
    expectMapping(await runtime.execute(textRequest(), context), {
      code: 'INVALID_REQUEST',
      reason: 'PROVIDER_REQUEST_REJECTED',
      retryable: false,
      category: 'BAD_REQUEST',
    });
  });

  it('maps a malformed provider response to INVALID_RESPONSE', async () => {
    const { runtime, push } = makeFakeRuntime();
    push({ text: 'this is not json' });
    expectMapping(await runtime.execute(textRequest(1), context), {
      code: 'INVALID_RESPONSE',
      reason: 'PROVIDER_BAD_RESPONSE',
      retryable: true,
      category: 'UPSTREAM',
    });

    push({ json: { choices: [{ finish_reason: 'stop' }] } });
    expectMapping(await runtime.execute(textRequest(2), context), {
      code: 'INVALID_RESPONSE',
      reason: 'PROVIDER_BAD_RESPONSE',
      retryable: true,
      category: 'UPSTREAM',
    });
  });

  it('maps an unmapped thrown failure to INTERNAL, discarding the thrown message', async () => {
    const adapter = new ScriptedProviderAdapter({ id: 'scripted' });
    const runtime = new AiRuntime({
      providers: [{ adapter }],
      routes: { balanced: [{ providerId: 'scripted', modelRef: 'scripted-model' }] },
      clock: new TestClock(0),
    });
    adapter.pushText(rejectStep(new Error(VENDOR_SENTINEL)));
    const result = await runtime.execute(textRequest(), context);
    const error = expectMapping(result, { code: 'INTERNAL', reason: 'INTERNAL_ERROR', retryable: false });
    expect(error.message).toBe('The provider call failed unexpectedly.');
    expect(error.stage).toBe('INTERNAL');
  });

  it('normalizes a result that carries rawError, and a thrown ProviderCallError alike', async () => {
    const adapter = new ScriptedProviderAdapter({ id: 'scripted' });
    const runtime = new AiRuntime({
      providers: [{ adapter }],
      routes: { balanced: [{ providerId: 'scripted', modelRef: 'scripted-model' }] },
      clock: new TestClock(0),
    });
    adapter.pushText(textStep('', { rawError: { category: 'AUTH', rawMessage: VENDOR_SENTINEL } }));
    expectMapping(await runtime.execute(textRequest(1), context), {
      code: 'PROVIDER_ERROR',
      reason: 'PROVIDER_AUTH_FAILED',
      retryable: false,
      category: 'AUTH',
    });

    adapter.pushText(rejectStep(new ProviderCallError({ category: 'UPSTREAM', reason: 'PROVIDER_TIMEOUT', rawMessage: VENDOR_SENTINEL })));
    expectMapping(await runtime.execute(textRequest(2), context), {
      code: 'TIMEOUT',
      reason: 'PROVIDER_TIMEOUT',
      retryable: true,
      category: 'UPSTREAM',
    });
  });

  it('exposes the category → reason defaults for adapters that map no further', () => {
    expect(normalizeProviderError({ category: 'AUTH' })).toMatchObject({ code: 'PROVIDER_ERROR', reason: 'PROVIDER_AUTH_FAILED' });
    expect(normalizeProviderError({ category: 'UNKNOWN' })).toMatchObject({ code: 'PROVIDER_ERROR', reason: 'PROVIDER_UNAVAILABLE' });
    expect(normalizeThrown(new Error(VENDOR_SENTINEL))).toMatchObject({ code: 'INTERNAL', reason: 'INTERNAL_ERROR' });
  });
});
