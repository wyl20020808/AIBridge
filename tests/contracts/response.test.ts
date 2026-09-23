import {
  AI_FINISH_REASONS,
  EXCLUDED_PROVIDER_METADATA_KEYS,
  isEmptyUsage,
  makeAiError,
  makeFailureResult,
  makeSuccessResult,
  parseAiResult,
  parseProviderMetadataProjection,
  type AiResult,
  type ProviderMetadataProjection,
} from '@aibridge/contracts';
import { describe, expect, it } from 'vitest';

import { unwrap, unwrapFailure } from '../helpers/assertions.js';

const projection: ProviderMetadataProjection = {
  providerId: 'main',
  providerFamily: 'openai-compatible',
  modelClass: 'REASONING',
  routeDepth: 0,
  attemptCount: 1,
  repaired: false,
};

function successEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contractVersion: '1.0',
    requestId: 'req-1',
    capability: 'ai.text.generate',
    capabilityVersion: '1.0',
    status: 'SUCCEEDED',
    output: { text: 'hello', finishReason: 'STOP' },
    usage: {},
    providerMetadata: projection,
    latencyMs: 12,
    finishReason: 'STOP',
    warnings: [],
    ...overrides,
  };
}

describe('response envelope — binary status, no partial results', () => {
  it('accepts both a success and a valid failure envelope', () => {
    const success = unwrap(parseAiResult(successEnvelope()));
    expect(success.status).toBe('SUCCEEDED');
    expect(success.output).toEqual({ text: 'hello', finishReason: 'STOP' });

    const failedEnvelope = successEnvelope({
      status: 'FAILED',
      error: makeAiError({ reason: 'OUTPUT_REPAIR_EXHAUSTED', message: 'did not conform' }),
    });
    delete failedEnvelope['output'];
    const failure = unwrap(parseAiResult(failedEnvelope));
    expect(failure.status).toBe('FAILED');
    expect(failure.error?.reason).toBe('OUTPUT_REPAIR_EXHAUSTED');
  });

  it('enforces SUCCEEDED ⇔ output and FAILED ⇔ error', () => {
    const successWithError = unwrapFailure(
      parseAiResult(successEnvelope({ error: makeAiError({ reason: 'INTERNAL_ERROR', message: 'x' }) })),
    );
    expect(successWithError.issues.some((issue) => issue.code === 'INVARIANT_VIOLATION')).toBe(true);

    const successWithoutOutput = successEnvelope();
    delete successWithoutOutput['output'];
    expect(unwrapFailure(parseAiResult(successWithoutOutput)).issues.some((issue) => issue.code === 'MISSING_FIELD')).toBe(
      true,
    );

    const failedWithOutput = unwrapFailure(
      parseAiResult(
        successEnvelope({
          status: 'FAILED',
          error: makeAiError({ reason: 'INTERNAL_ERROR', message: 'x' }),
        }),
      ),
    );
    expect(failedWithOutput.issues.some((issue) => issue.code === 'INVARIANT_VIOLATION')).toBe(true);

    const failedWithoutError = successEnvelope({ status: 'FAILED' });
    delete failedWithoutError['output'];
    expect(unwrapFailure(parseAiResult(failedWithoutError)).issues.some((issue) => issue.code === 'MISSING_FIELD')).toBe(
      true,
    );
  });

  it('never lets a partial object ride through: a failed envelope carries exactly one error', () => {
    const failedEnvelope = successEnvelope({
      status: 'FAILED',
      error: makeAiError({ reason: 'SCHEMA_VALIDATION_FAILED', message: 'no', details: { issueCount: 2 } }),
    });
    delete failedEnvelope['output'];
    const failure = unwrap(parseAiResult(failedEnvelope)) as AiResult<unknown>;
    expect(Object.prototype.hasOwnProperty.call(failure, 'output')).toBe(false);
    expect(failure.error).toBeDefined();
  });

  it('rejects unknown top-level fields and an unknown finish reason', () => {
    expect(unwrapFailure(parseAiResult(successEnvelope({ surprise: 1 }))).issues.some((i) => i.code === 'UNKNOWN_FIELD')).toBe(
      true,
    );
    expect(unwrapFailure(parseAiResult(successEnvelope({ finishReason: 'OTHER' }))).issues.length).toBeGreaterThan(0);
    expect(AI_FINISH_REASONS).toEqual(['STOP', 'LENGTH', 'CONTENT_FILTER', 'UNKNOWN']);
  });

  it('rejects an unknown warning code', () => {
    expect(
      unwrapFailure(parseAiResult(successEnvelope({ warnings: [{ code: 'SOMETHING_NEW' }] }))).reason,
    ).toBe('MALFORMED_ENVELOPE');
  });

  it('keeps cost honest: absent means unknown, and a present cost demands a basis', () => {
    expect(isEmptyUsage({})).toBe(true);
    expect(isEmptyUsage({ totalTokens: 0 })).toBe(false);
    const withoutBasis = unwrapFailure(
      parseAiResult(successEnvelope({ usage: { estimatedCost: { value: 0.1, currency: 'USD' } } })),
    );
    expect(withoutBasis.issues.some((issue) => issue.path.includes('basis'))).toBe(true);
    const withBasis = unwrap(
      parseAiResult(
        successEnvelope({ usage: { estimatedCost: { value: 0.1, currency: 'USD', basis: 'PRICE_TABLE' } } }),
      ),
    );
    expect(withBasis.usage.estimatedCost?.basis).toBe('PRICE_TABLE');
  });

  it('excludes every unsafe provider field from the projection', () => {
    for (const key of EXCLUDED_PROVIDER_METADATA_KEYS) {
      const failure = unwrapFailure(parseProviderMetadataProjection({ ...projection, [key]: 'leak' }));
      expect(failure.issues.some((issue) => issue.code === 'UNKNOWN_FIELD'), key).toBe(true);
    }
    expect(unwrap(parseProviderMetadataProjection(projection))).toEqual(projection);
  });

  it('builds success and failure results with sensible defaults', () => {
    const success = makeSuccessResult({
      contractVersion: '1.0',
      requestId: 'req-1',
      capability: 'ai.text.generate',
      capabilityVersion: '1.0',
      output: { text: 'hi' },
      providerMetadata: projection,
      latencyMs: 3,
    });
    expect(success.status).toBe('SUCCEEDED');
    expect(success.finishReason).toBe('STOP');
    expect(success.usage).toEqual({});

    const failure = makeFailureResult({
      contractVersion: '1.0',
      requestId: 'req-1',
      capability: 'ai.text.generate',
      capabilityVersion: '1.0',
      error: makeAiError({ reason: 'INTERNAL_ERROR', message: 'boom' }),
      providerMetadata: projection,
      latencyMs: 3,
    });
    expect(failure.status).toBe('FAILED');
    expect(failure.finishReason).toBe('UNKNOWN');
  });
});
