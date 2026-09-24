/**
 * V1 stabilization audit regressions — trust boundary defects (Batch A).
 *
 * Each test pins a real defect found in the audit, with the exact file:line of the fix:
 *  - SSRF FQDN trailing-dot bypass (`packages/core/src/endpoint-safety.ts`);
 *  - redirect credential forwarding (`provider-openai-compatible/src/wire.ts`,
 *    `provider-openai/src/responses.ts`);
 *  - OpenAI balance/auth conflation (`provider-openai/src/responses.ts`);
 *  - late stream delta after FINISH (`provider-openai-compatible/src/adapter.ts`).
 */
import { checkEndpointSafety } from '@aibridge/core';
import {
  OpenAiCompatibleAdapter,
  type FetchLike,
  type FetchRequestInitLike,
  type FetchResponseLike,
} from '@aibridge/provider-openai-compatible';
import { classifyOpenAiFailure, sendRequest } from '@aibridge/provider-openai';
import { TextEncoder } from 'node:util';
import { describe, expect, it } from 'vitest';

const syntheticSecret = `sk-${'E'.repeat(32)}`;

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): FetchResponseLike {
  return {
    status,
    ok: status < 400,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
    body: null,
  };
}

function redirectResponse(location: string): FetchResponseLike {
  return jsonResponse('', 302, { location });
}

function capturedCall(init: FetchRequestInitLike | undefined): Record<string, string> {
  const headers = init?.headers;
  if (headers === undefined || typeof headers !== 'object') {
    return {};
  }
  return { ...(headers as Record<string, string>) };
}

describe('SSRF — a trailing DNS root dot is not a different host', () => {
  it('rejects https://localhost./ as loopback, not as an unknown public host', () => {
    const check = checkEndpointSafety('https://localhost./chat/completions');
    expect(check.safe).toBe(false);
  });

  it('rejects a metadata hostname with a trailing dot', () => {
    const check = checkEndpointSafety('https://metadata.google.internal./latest/meta-data');
    expect(check.safe).toBe(false);
  });

  it('still routes a genuine public hostname that carries a root dot', () => {
    const check = checkEndpointSafety('https://example.com./v1/chat/completions');
    expect(check.safe).toBe(true);
  });

  it('refuses a trailing-dot loopback endpoint at adapter construction', () => {
    let rawMessage = '';
    try {
      new OpenAiCompatibleAdapter({
        id: 'relay',
        baseUrl: 'https://localhost./v1',
        fetch: (() => Promise.reject(new Error('unused'))) as FetchLike,
        models: [{ modelRef: 'm', features: ['text'], maxContextTokens: 8, maxOutputTokens: 8 }],
      });
    } catch (error) {
      rawMessage = (error as { rawError?: { rawMessage?: string } }).rawError?.rawMessage ?? '';
    }
    expect(rawMessage).toContain('unsafe endpoint');
  });
});

describe('redirects — credentials never cross origins', () => {
  function relayWithCapture(seen: Array<{ url: string; headers: Record<string, string> }>, hop: FetchLike): OpenAiCompatibleAdapter {
    const fetch: FetchLike = (url, init) => {
      seen.push({ url, headers: capturedCall(init) });
      return hop(url, init);
    };
    const adapter = new OpenAiCompatibleAdapter({
      id: 'relay',
      baseUrl: 'https://relay.example.invalid/v1',
      fetch,
      models: [{ modelRef: 'm', features: ['text'], maxContextTokens: 8, maxOutputTokens: 8 }],
    });
    adapter.bindCredentials({ handle: 'secret://relay', secret: syntheticSecret });
    return adapter;
  }

  const completion = { choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }] };
  const request = {
    capability: 'ai.text.generate',
    profile: 'balanced',
    instructions: 'Summarise.',
    context: [],
    modelRef: 'm',
    deadlineAtMs: 1_000_000,
  } as const;

  it('strips the bearer credential on a cross-origin redirect (chat wire)', async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    const adapter = relayWithCapture(seen, () =>
      seen.length <= 1
        ? Promise.resolve(redirectResponse('https://other.example.invalid/v1/chat/completions'))
        : Promise.resolve(jsonResponse(completion)),
    );
    await adapter.generateText({ ...request });
    expect(seen).toHaveLength(2);
    expect(seen[0]?.headers['authorization']).toBe(`Bearer ${syntheticSecret}`);
    expect(seen[1]?.headers['authorization']).toBeUndefined();
    expect(seen[1]?.headers['api-key']).toBeUndefined();
  });

  it('keeps the credential on a same-origin redirect (chat wire)', async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    const adapter = relayWithCapture(seen, () =>
      seen.length <= 1
        ? Promise.resolve(redirectResponse('https://relay.example.invalid/v1/retry'))
        : Promise.resolve(jsonResponse(completion)),
    );
    await adapter.generateText({ ...request });
    expect(seen).toHaveLength(2);
    expect(seen[1]?.headers['authorization']).toBe(`Bearer ${syntheticSecret}`);
  });

  it('strips the bearer credential on a cross-origin redirect (Responses wire)', async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetch: FetchLike = (url, init) => {
      seen.push({ url, headers: capturedCall(init) });
      return seen.length <= 1
        ? Promise.resolve(redirectResponse('https://other.example.invalid/v1/responses'))
        : Promise.resolve(jsonResponse({ status: 'completed' }));
    };
    await sendRequest({
      fetch,
      url: 'https://relay.example.invalid/v1/responses',
      method: 'POST',
      body: '{}',
      headers: { authorization: `Bearer ${syntheticSecret}` },
      deadlineAtMs: 1_000_000,
      nowMs: () => 0,
    });
    expect(seen).toHaveLength(2);
    expect(seen[0]?.headers['authorization']).toBe(`Bearer ${syntheticSecret}`);
    expect(seen[1]?.headers['authorization']).toBeUndefined();
  });
});

describe('OpenAI error mapping — an empty wallet is not a broken credential', () => {
  it('maps insufficient_quota to PROVIDER_BALANCE_EXHAUSTED', () => {
    const failure = classifyOpenAiFailure({
      status: 429,
      body: { error: { type: 'insufficient_quota', message: 'quota spent' } },
    });
    expect(failure.reason).toBe('PROVIDER_BALANCE_EXHAUSTED');
  });

  it('maps HTTP 402 to PROVIDER_BALANCE_EXHAUSTED', () => {
    const failure = classifyOpenAiFailure({ status: 402, body: {} });
    expect(failure.reason).toBe('PROVIDER_BALANCE_EXHAUSTED');
  });
});

describe('streaming — a delta after FINISH in one flush is discarded', () => {
  function singleChunkSse(fetch: FetchLike): FetchLike {
    return fetch;
  }

  async function collectStreamedText(adapter: OpenAiCompatibleAdapter): Promise<{ deltas: string[]; finish: number }> {
    const deltas: string[] = [];
    let finish = 0;
    for await (const event of adapter.streamText({
      capability: 'ai.text.generate',
      profile: 'balanced',
      instructions: 'Summarise.',
      context: [],
      modelRef: 'm',
      deadlineAtMs: 1_000_000,
    })) {
      if (event.kind === 'TEXT_DELTA') {
        deltas.push(event.text);
      } else if (event.kind === 'FINISH') {
        finish += 1;
      } else if (event.kind === 'ERROR') {
        throw new Error(`unexpected stream error: ${event.error.reason}`);
      }
    }
    return { deltas, finish };
  }

  function chunkedBody(frames: string): NonNullable<FetchResponseLike['body']> {
    const encoder = new TextEncoder();
    const value = encoder.encode(frames);
    let consumed = false;
    return {
      getReader() {
        return {
          async read() {
            if (consumed) {
              return { done: true };
            }
            consumed = true;
            return { done: false, value };
          },
          async cancel() {
            consumed = true;
          },
          releaseLock() {},
        };
      },
    };
  }

  function adapterWithFrames(frames: string): OpenAiCompatibleAdapter {
    const fetch: FetchLike = singleChunkSse(() =>
      Promise.resolve({
        status: 200,
        ok: true,
        headers: { get: () => 'text/event-stream' },
        text: () => Promise.resolve(''),
        body: chunkedBody(frames),
      }),
    );
    return new OpenAiCompatibleAdapter({
      id: 'relay',
      baseUrl: 'https://relay.example.invalid/v1',
      fetch,
      models: [{ modelRef: 'm', features: ['text', 'streaming'], maxContextTokens: 8, maxOutputTokens: 8 }],
    });
  }

  it('delivers a normal delta-then-finish stream untouched', async () => {
    const frames =
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'Hel' } }] })}\n\n` +
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n` +
      'data: [DONE]\n\n';
    const { deltas, finish } = await collectStreamedText(adapterWithFrames(frames));
    expect(deltas).toEqual(['Hel']);
    expect(finish).toBe(1);
  });

  it('discards a delta that arrives after FINISH inside the same network chunk', async () => {
    const frames =
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n` +
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'late' } }] })}\n\n` +
      'data: [DONE]\n\n';
    const { deltas, finish } = await collectStreamedText(adapterWithFrames(frames));
    expect(deltas).toEqual([]);
    expect(finish).toBe(1);
  });
});
