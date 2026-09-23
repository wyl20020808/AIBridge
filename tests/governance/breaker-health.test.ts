/**
 * Circuit breaker and runtime health (ROADMAP Stage 5 Phase 11–16, 67).
 *
 * The state machine is small on purpose: a window of transient failures opens the circuit, a
 * cooldown half-opens it, a bounded probe closes or re-opens it. Caller-side failures never move
 * it (Phase 12), and one 429 never becomes a permanent `UNHEALTHY` (Phase 15).
 */
import { makeAiError, type AiError, type AiErrorReason } from '@aibridge/contracts';
import { TestClock } from '@aibridge/host-sdk';
import {
  CircuitBreaker,
  CircuitBreakerRegistry,
  RuntimeHealthRegistry,
} from '@aibridge/governance';
import { describe, expect, it } from 'vitest';

function errorWith(reason: AiErrorReason): AiError {
  return makeAiError({ reason, message: `synthetic ${reason}` });
}

const transient = () => errorWith('PROVIDER_UNAVAILABLE');
const caller = () => errorWith('MALFORMED_ENVELOPE');

describe('circuit breaker', () => {
  it('opens after the failure threshold inside the window (Phase 13)', () => {
    const clock = new TestClock(0);
    const breaker = new CircuitBreaker('relay::relay.text.primary', { failureThreshold: 3, windowMs: 10_000 }, clock);
    breaker.recordFailure(transient());
    breaker.recordFailure(transient());
    expect(breaker.state).toBe('CLOSED');
    breaker.recordFailure(transient());
    expect(breaker.state).toBe('OPEN');
  });

  it('never counts caller-side failures (Phase 12)', () => {
    const clock = new TestClock(0);
    const breaker = new CircuitBreaker('relay::relay.text.primary', { failureThreshold: 2 }, clock);
    breaker.recordFailure(caller());
    breaker.recordFailure(errorWith('POLICY_VIOLATION'));
    breaker.recordFailure(errorWith('CALLER_NOT_PERMITTED'));
    breaker.recordFailure(errorWith('CANCELLED_BY_CALLER'));
    expect(breaker.state).toBe('CLOSED');
  });

  it('forgets failures that fall out of the window', () => {
    const clock = new TestClock(0);
    const breaker = new CircuitBreaker('relay::relay.text.primary', { failureThreshold: 2, windowMs: 1_000 }, clock);
    breaker.recordFailure(transient());
    clock.advance(2_000);
    breaker.recordFailure(transient());
    expect(breaker.state).toBe('CLOSED');
  });

  it('blocks dispatch while open (Phase 52)', () => {
    const clock = new TestClock(0);
    const breaker = new CircuitBreaker('relay::relay.text.primary', { failureThreshold: 1, cooldownMs: 5_000 }, clock);
    breaker.recordFailure(transient());
    const verdict = breaker.dispatchVerdict();
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.retryAfterMs).toBeGreaterThan(0);
    }
  });

  it('half-opens after the cooldown, allows one probe, and closes or re-opens (Phase 14)', () => {
    const clock = new TestClock(0);
    const breaker = new CircuitBreaker('relay::relay.text.primary', { failureThreshold: 1, cooldownMs: 5_000, halfOpenProbeLimit: 1 }, clock);
    breaker.recordFailure(transient());
    expect(breaker.state).toBe('OPEN');

    clock.advance(5_001);
    const probe = breaker.dispatchVerdict();
    expect(probe).toMatchObject({ allowed: true, state: 'HALF_OPEN', probe: true });
    // A second probe while one is in flight is refused — bounded probe traffic.
    expect(breaker.dispatchVerdict().allowed).toBe(false);

    breaker.recordFailure(transient());
    expect(breaker.state).toBe('OPEN');

    clock.advance(5_001);
    expect(breaker.dispatchVerdict().allowed).toBe(true);
    breaker.recordSuccess();
    expect(breaker.state).toBe('CLOSED');
  });

  it('keys breakers per provider AND model alias — one bad model never disables the provider', () => {
    const clock = new TestClock(0);
    const registry = new CircuitBreakerRegistry({ config: { failureThreshold: 1 }, clock });
    registry.for('relay', 'relay.fast.primary').recordFailure(transient());
    expect(registry.for('relay', 'relay.fast.primary').state).toBe('OPEN');
    expect(registry.for('relay', 'relay.reasoning.primary').state).toBe('CLOSED');
    expect(registry.for('other', 'relay.fast.primary').state).toBe('CLOSED');
    expect(registry.snapshots().map((snapshot) => snapshot.key)).toContain('relay::relay.fast.primary');
  });
});

describe('runtime health — health is not capability (Phase 16)', () => {
  it('reports UNKNOWN before any observation and HEALTHY after one', () => {
    const clock = new TestClock(0);
    const health = new RuntimeHealthRegistry({ clock });
    expect(health.health('relay', 'relay.text.primary').state).toBe('UNKNOWN');
    health.recordSuccess('relay', 'relay.text.primary');
    expect(health.health('relay', 'relay.text.primary').state).toBe('HEALTHY');
  });

  it('does not call a target unhealthy over one 429 (Phase 15)', () => {
    const clock = new TestClock(0);
    const health = new RuntimeHealthRegistry({ clock });
    health.recordFailure('relay', 'relay.text.primary', errorWith('PROVIDER_THROTTLED'));
    expect(health.health('relay', 'relay.text.primary').state).toBe('HEALTHY');
    health.recordFailure('relay', 'relay.text.primary', errorWith('PROVIDER_THROTTLED'));
    expect(health.health('relay', 'relay.text.primary').state).toBe('DEGRADED');
    // …and it recovers on the next success: DEGRADED is not a verdict.
    health.recordSuccess('relay', 'relay.text.primary');
    expect(health.health('relay', 'relay.text.primary').state).toBe('HEALTHY');
  });

  it('composes observed state, breaker state and the operator switch', () => {
    const clock = new TestClock(0);
    const breakers = new CircuitBreakerRegistry({ config: { failureThreshold: 1 }, clock });
    const health = new RuntimeHealthRegistry({ clock, breakers });
    breakers.for('relay', 'relay.text.primary').recordFailure(transient());
    expect(health.health('relay', 'relay.text.primary').state).toBe('OPEN_CIRCUIT');

    health.setDisabled('relay', 'relay.text.primary', true);
    // DISABLED outranks every observed state (Phase 49).
    expect(health.health('relay', 'relay.text.primary').state).toBe('DISABLED');
    health.setDisabled('relay', 'relay.text.primary', false);
    expect(health.health('relay', 'relay.text.primary').state).toBe('OPEN_CIRCUIT');
  });

  it('reports generic failure classes only — never a raw provider error (Phase 48)', () => {
    const clock = new TestClock(0);
    const health = new RuntimeHealthRegistry({ clock });
    health.recordFailure('relay', 'relay.text.primary', errorWith('PROVIDER_OVERLOADED'));
    const report = health.health('relay', 'relay.text.primary');
    expect(report.recentFailureClasses['PROVIDER_TRANSIENT']).toBe(1);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('rawMessage');
    expect(serialized).not.toContain('message');
  });
});
