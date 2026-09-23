/**
 * Idempotency, rate limiting and quota (ROADMAP Stage 5 Phase 17–26, 61).
 *
 * The load-bearing properties:
 *  - one fingerprint ⇒ at most one provider execution chain (Phase 63);
 *  - a different body under one key is `IDEMPOTENCY_CONFLICT`, never a stale answer (Phase 20);
 *  - concurrent duplicates join instead of dispatching (Phase 18);
 *  - a rate rejection makes **zero** provider calls (Phase 22);
 *  - quota reservations make "two requests both see 1000 tokens left" impossible (Phase 25);
 *  - unknown usage settles conservatively, never at zero (Phase 24).
 */
import { makeAiError, type AiResult } from '@aibridge/contracts';
import { TestClock } from '@aibridge/host-sdk';
import {
  IdempotencyRegistry,
  InMemoryIdempotencyStore,
  InMemoryQuotaStore,
  InMemoryRateLimitStore,
  QuotaManager,
  RateLimiter,
  idempotencyIdentityKey,
} from '@aibridge/governance';
import { describe, expect, it } from 'vitest';

function resultOf(status: 'SUCCEEDED' | 'FAILED' = 'SUCCEEDED'): AiResult<unknown> {
  return {
    contractVersion: '1.1',
    requestId: 'req-1',
    capability: 'ai.text.generate',
    capabilityVersion: '1.0',
    status,
    ...(status === 'SUCCEEDED' ? { output: { text: 'ok', finishReason: 'STOP' } } : { error: makeAiError({ reason: 'PROVIDER_UNAVAILABLE', message: 'down' }) }),
    usage: {},
    providerMetadata: { providerId: 'relay', providerFamily: 'mock', modelClass: 'FAST', routeDepth: 0, attemptCount: 1, repaired: false },
    latencyMs: 1,
    finishReason: 'UNKNOWN',
    warnings: [],
  };
}

const identity = {
  callerPluginId: 'test.caller',
  capability: 'ai.text.generate',
  capabilityVersion: '1.0',
  idempotencyKey: 'turn-1',
};

describe('idempotency registry (Phase 17–20)', () => {
  it('lets one identity execute once and replays the stored result afterwards', async () => {
    const clock = new TestClock(0);
    const registry = new IdempotencyRegistry({ store: new InMemoryIdempotencyStore({ clock }), clock });

    const first = await registry.gate(identity, 'fp-1', 'lreq-1');
    expect(first.kind).toBe('PROCEED');
    if (first.kind === 'PROCEED') {
      await first.settle(resultOf());
    }

    const replay = await registry.gate(identity, 'fp-1', 'lreq-2');
    expect(replay.kind).toBe('REPLAY');
  });

  it('replays a final failure too — one turn is one billable chain (Phase 63)', async () => {
    const clock = new TestClock(0);
    const registry = new IdempotencyRegistry({ store: new InMemoryIdempotencyStore({ clock }), clock });
    const first = await registry.gate(identity, 'fp-1', 'lreq-1');
    if (first.kind === 'PROCEED') {
      await first.settle(resultOf('FAILED'));
    }
    expect((await registry.gate(identity, 'fp-1', 'lreq-2')).kind).toBe('REPLAY');
  });

  it('coalesces a concurrent duplicate onto the in-flight call', async () => {
    const clock = new TestClock(0);
    const registry = new IdempotencyRegistry({ store: new InMemoryIdempotencyStore({ clock }), clock });
    const first = await registry.gate(identity, 'fp-1', 'lreq-1');
    expect(first.kind).toBe('PROCEED');

    const second = await registry.gate(identity, 'fp-1', 'lreq-2');
    expect(second.kind).toBe('JOIN');

    if (first.kind === 'PROCEED' && second.kind === 'JOIN') {
      const settled = resultOf();
      await first.settle(settled);
      const joined = await second.result;
      expect(joined).toBe(settled);
    }
  });

  it('is IDEMPOTENCY_CONFLICT for the same key with a different fingerprint (Phase 20)', async () => {
    const clock = new TestClock(0);
    const registry = new IdempotencyRegistry({ store: new InMemoryIdempotencyStore({ clock }), clock });
    const first = await registry.gate(identity, 'fp-1', 'lreq-1');
    if (first.kind === 'PROCEED') {
      await first.settle(resultOf());
    }
    const conflicting = await registry.gate(identity, 'fp-other', 'lreq-2');
    expect(conflicting.kind).toBe('CONFLICT');
  });

  it('scopes the identity so another caller or capability can never collide', () => {
    const key = idempotencyIdentityKey(identity);
    expect(idempotencyIdentityKey({ ...identity, callerPluginId: 'other' })).not.toBe(key);
    expect(idempotencyIdentityKey({ ...identity, capability: 'ai.structured.generate' })).not.toBe(key);
    expect(idempotencyIdentityKey({ ...identity, idempotencyKey: 'turn-2' })).not.toBe(key);
  });

  it('expires after the retention window and evicts least-recently-used entries', async () => {
    const clock = new TestClock(0);
    const store = new InMemoryIdempotencyStore({ clock, retentionMs: 1_000, capacity: 2 });
    await store.claim({ identity: 'a', fingerprint: 'fp', status: 'IN_FLIGHT', createdAtMs: 0, expiresAtMs: 60_000, logicalRequestId: 'lreq-a' });
    await store.claim({ identity: 'b', fingerprint: 'fp', status: 'IN_FLIGHT', createdAtMs: 0, expiresAtMs: 60_000, logicalRequestId: 'lreq-b' });
    await store.claim({ identity: 'c', fingerprint: 'fp', status: 'IN_FLIGHT', createdAtMs: 0, expiresAtMs: 60_000, logicalRequestId: 'lreq-c' });
    expect(store.size).toBe(2);

    clock.advance(60_000);
    expect(await store.get('a')).toBeNull();
    expect(await store.get('b')).toBeNull();
    expect(await store.get('c')).toBeNull();
  });

  it('atomically claims under concurrency — exactly one PROCEED (Phase 61)', async () => {
    const clock = new TestClock(0);
    const registry = new IdempotencyRegistry({ store: new InMemoryIdempotencyStore({ clock }), clock });
    const gates = await Promise.all(
      Array.from({ length: 8 }, (_, index) => registry.gate(identity, 'fp-1', `lreq-${index}`)),
    );
    const proceeds = gates.filter((gate) => gate.kind === 'PROCEED');
    const joins = gates.filter((gate) => gate.kind === 'JOIN');
    expect(proceeds).toHaveLength(1);
    expect(joins).toHaveLength(7);
  });
});

describe('rate limiting (Phase 21–22)', () => {
  it('enforces each dimension and reports the strictest refusal with a safe retry hint', async () => {
    const clock = new TestClock(0);
    const limiter = new RateLimiter({
      store: new InMemoryRateLimitStore(),
      clock,
      policies: [
        { dimension: 'global', limit: 10, windowMs: 1_000 },
        { dimension: 'callerPlugin', limit: 2, windowMs: 1_000 },
      ],
    });
    const request = { callerPluginId: 'test.caller', capability: 'ai.text.generate' };
    expect((await limiter.consume(request)).allowed).toBe(true);
    expect((await limiter.consume(request)).allowed).toBe(true);

    const refused = await limiter.consume(request);
    expect(refused.allowed).toBe(false);
    if (!refused.allowed) {
      expect(refused.dimension).toBe('callerPlugin');
      expect(refused.error.reason).toBe('RATE_LIMIT_CALLER');
      expect(refused.retryAfterMs).toBeGreaterThan(0);
    }
  });

  it('slides the window deterministically from the clock', async () => {
    const clock = new TestClock(0);
    const store = new InMemoryRateLimitStore();
    const limiter = new RateLimiter({ store, clock, policies: [{ dimension: 'subject', limit: 1, windowMs: 1_000 }] });
    const request = { callerPluginId: 'test.caller', capability: 'ai.text.generate', subjectRef: 'subj-abc' };
    expect((await limiter.consume(request)).allowed).toBe(true);
    expect((await limiter.consume(request)).allowed).toBe(false);
    clock.advance(1_001);
    expect((await limiter.consume(request)).allowed).toBe(true);
  });

  it('keeps subjects apart', async () => {
    const clock = new TestClock(0);
    const limiter = new RateLimiter({
      store: new InMemoryRateLimitStore(),
      clock,
      policies: [{ dimension: 'subject', limit: 1, windowMs: 10_000 }],
    });
    expect((await limiter.consume({ callerPluginId: 'c', capability: 'ai.text.generate', subjectRef: 'a' })).allowed).toBe(true);
    expect((await limiter.consume({ callerPluginId: 'c', capability: 'ai.text.generate', subjectRef: 'b' })).allowed).toBe(true);
  });
});

describe('quota with reservations (Phase 23–26)', () => {
  it('reserves first, settles at the actual figure, and never over-commits', async () => {
    const clock = new TestClock(0);
    const manager = new QuotaManager({
      store: new InMemoryQuotaStore(),
      clock,
      policies: [{ scope: 'subject', meter: 'TOKENS', period: 'DAY', limit: 1_000 }],
    });
    const request = { callerPluginId: 'c', capability: 'ai.text.generate', subjectRef: 'subj-a' };

    const first = await manager.reserve(request, { tokens: 600 });
    expect(first.ok).toBe(true);
    // The concurrent second caller cannot also see "600 left" (Phase 25).
    const second = await manager.reserve(request, { tokens: 600 });
    expect(second.ok).toBe(false);

    if (first.ok) {
      await manager.settle(first.reservation, { usageKnown: true, tokens: 100 });
    }
    // Releasing the surplus makes room again.
    const third = await manager.reserve(request, { tokens: 600 });
    expect(third.ok).toBe(true);
  });

  it('settles unknown usage at the conservative reservation, never at zero (Phase 24)', async () => {
    const clock = new TestClock(0);
    const store = new InMemoryQuotaStore();
    const manager = new QuotaManager({
      store,
      clock,
      policies: [{ scope: 'subject', meter: 'TOKENS', period: 'DAY', limit: 1_000 }],
    });
    const request = { callerPluginId: 'c', capability: 'ai.text.generate', subjectRef: 'subj-a' };
    const reservation = await manager.reserve(request, { tokens: 400 });
    expect(reservation.ok).toBe(true);
    if (reservation.ok) {
      await manager.settle(reservation.reservation, { usageKnown: false });
    }
    const bucket = 'qt|subject|subj-a|TOKENS|DAY|1970-01-01';
    expect(await store.consumed(bucket)).toBe(400);
  });

  it('accounts every scope with its own reason and period bucket', async () => {
    const clock = new TestClock(0);
    const manager = new QuotaManager({
      store: new InMemoryQuotaStore(),
      clock,
      policies: [
        { scope: 'callerPlugin', meter: 'REQUESTS', period: 'DAY', limit: 1 },
        { scope: 'global', meter: 'REQUESTS', period: 'MONTH', limit: 100 },
      ],
    });
    const request = { callerPluginId: 'c', capability: 'ai.text.generate' };
    expect((await manager.reserve(request)).ok).toBe(true);
    const refused = await manager.reserve(request);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.reason).toBe('QUOTA_CALLER');
      expect(refused.error.details?.['period']).toBe('DAY');
    }
  });

  it('is atomic under concurrency — the limit is never overshot (Phase 61)', async () => {
    const clock = new TestClock(0);
    const manager = new QuotaManager({
      store: new InMemoryQuotaStore(),
      clock,
      policies: [{ scope: 'global', meter: 'TOKENS', period: 'DAY', limit: 1_000 }],
    });
    const request = { callerPluginId: 'c', capability: 'ai.text.generate' };
    const results = await Promise.all(Array.from({ length: 10 }, () => manager.reserve(request, { tokens: 250 })));
    expect(results.filter((result) => result.ok)).toHaveLength(4);
  });

  it('releases cleanly when a request dies before dispatch', async () => {
    const clock = new TestClock(0);
    const store = new InMemoryQuotaStore();
    const manager = new QuotaManager({
      store,
      clock,
      policies: [{ scope: 'global', meter: 'ESTIMATED_COST', period: 'DAY', limit: 10 }],
    });
    const request = { callerPluginId: 'c', capability: 'ai.text.generate' };
    const reservation = await manager.reserve(request, { cost: 10 });
    expect(reservation.ok).toBe(true);
    if (reservation.ok) {
      await manager.release(reservation.reservation);
    }
    expect(await store.consumed('qt|global|global|ESTIMATED_COST|DAY|1970-01-01')).toBe(0);
  });
});
