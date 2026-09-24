import {
  CALLER_OWNED_OUTPUT_SCHEMA,
  CapabilityRegistry,
  GENERIC_CAPABILITY_REGISTRATIONS,
  GENERIC_STRUCTURED_POLICY,
  GENERIC_TEXT_POLICY,
  TurnCallCounter,
  allowsCallerOutputSchema,
  authorizeCapabilityCall,
} from '@aibridge/core';
import { parseCapabilityDescriptor } from '@aibridge/contracts';
import type { CapabilityRegistration } from '@aibridge/core';
import { describe, expect, it } from 'vitest';

import { unwrap, unwrapFailure } from '../helpers/assertions.js';

const specialized: CapabilityRegistration = {
  id: 'education.idea.evaluate',
  version: '1.0',
  kind: 'SPECIALIZED',
  inputSchema: { kind: 'REF', ref: { schemaId: 'education.idea.evaluate.input', version: '1.0' } },
  outputSchema: { kind: 'REF', ref: { schemaId: 'education.idea.evaluate.output', version: '1.0' } },
  requiredPrimitive: 'ai.structured.generate',
  policy: {
    id: 'education-idea-evaluate-v1',
    version: '1.0',
    inputAllowList: ['ideaText'],
    outputRules: ['SCHEMA_CONFORMANCE'],
    forbiddenOutput: ['declaresSolution'],
    maxOutputBytes: 8192,
  },
  profiles: ['reasoning'],
  limits: { maxInputBytes: 16_384, maxOutputBytes: 8192, totalTimeoutMs: 20_000, maxCallsPerTurn: 1 },
  allowGenericFallback: true,
  retention: 'METADATA_ONLY',
  schemaOwnership: { input: 'REGISTRY', output: 'REGISTRY', policy: 'REGISTRY' },
};

describe('capability registry — metadata only, conflict-aware', () => {
  it('registers both generic primitives', () => {
    const registry = new CapabilityRegistry();
    for (const registration of GENERIC_CAPABILITY_REGISTRATIONS) {
      const descriptor = unwrap(registry.register(registration));
      expect(descriptor.id).toBe(registration.id);
      expect(descriptor.kind).toBe('GENERIC');
    }
    expect(registry.size).toBe(2);
    expect(registry.has('ai.text.generate')).toBe(true);
    expect(registry.get('ai.text.generate', '1.0')?.policyId).toBe('ai-text-default');
  });

  it('declares stable consumer-composed defaults on generic descriptors', () => {
    const descriptors = new CapabilityRegistry();
    GENERIC_CAPABILITY_REGISTRATIONS.forEach((registration) => unwrap(descriptors.register(registration)));

    for (const descriptor of descriptors.list()) {
      expect(descriptor.readiness).toBe('STABLE');
      expect(descriptor.instructionMode).toBe('CONSUMER_COMPOSED');
    }
  });

  it('keeps specialized registrations reserved by default and reads legacy descriptors', () => {
    const registry = new CapabilityRegistry();
    const descriptor = unwrap(registry.register(specialized));
    expect(descriptor.readiness).toBe('RESERVED');
    expect(descriptor.instructionMode).toBe('CONSUMER_COMPOSED');

    const { readiness: _readiness, instructionMode: _instructionMode, ...legacyDescriptor } = descriptor;
    const parsedLegacy = unwrap(parseCapabilityDescriptor(legacyDescriptor));
    expect(parsedLegacy.readiness).toBeUndefined();
    expect(parsedLegacy.instructionMode).toBeUndefined();
  });

  it('preserves an explicit readiness and rejects unsupported descriptor modes', () => {
    const registry = new CapabilityRegistry();
    const descriptor = unwrap(
      registry.register({
        ...specialized,
        readiness: 'EXPERIMENTAL',
        instructionMode: 'CONSUMER_COMPOSED',
      }),
    );
    expect(descriptor.readiness).toBe('EXPERIMENTAL');
    expect(descriptor.instructionMode).toBe('CONSUMER_COMPOSED');
    expect(unwrap(parseCapabilityDescriptor(descriptor)).readiness).toBe('EXPERIMENTAL');
    expect(unwrap(parseCapabilityDescriptor(descriptor)).instructionMode).toBe('CONSUMER_COMPOSED');

    const invalidReadinessDescriptor = {
      ...descriptor,
      readiness: 'FUTURE',
    };
    expect(parseCapabilityDescriptor(invalidReadinessDescriptor).ok).toBe(false);
    expect(
      parseCapabilityDescriptor({ ...descriptor, instructionMode: 'CAPABILITY_MANAGED' }).ok,
    ).toBe(false);
    expect(
      registry.register({ ...specialized, readiness: 'FUTURE' } as unknown as CapabilityRegistration).ok,
    ).toBe(false);
    expect(
      registry.register({
        ...specialized,
        instructionMode: 'CAPABILITY_MANAGED',
      } as unknown as CapabilityRegistration).ok,
    ).toBe(false);
  });

  it('is idempotent for a byte-identical re-registration', () => {
    const registry = new CapabilityRegistry();
    const first = GENERIC_CAPABILITY_REGISTRATIONS[0]!;
    unwrap(registry.register(first));
    expect(unwrap(registry.register(first)).id).toBe(first.id);
    expect(registry.size).toBe(1);
  });

  it('rejects a conflicting registration for the same id@major', () => {
    const registry = new CapabilityRegistry();
    unwrap(registry.register(specialized));
    const conflicting: CapabilityRegistration = {
      ...specialized,
      limits: { ...specialized.limits, maxOutputBytes: 4096 },
    };
    const failure = unwrapFailure(registry.register(conflicting));
    expect(failure.reason).toBe('MALFORMED_ENVELOPE');
    expect(failure.issues.some((issue) => issue.code === 'CONFLICTING_REGISTRATION')).toBe(true);
    expect(registry.size).toBe(1);
  });

  it('rejects a product-namespaced or malformed capability id', () => {
    const registry = new CapabilityRegistry();
    const failure = unwrapFailure(registry.register({ ...specialized, id: 'algoquest.idea.evaluate' }));
    expect(failure.reason).toBe('MALFORMED_ENVELOPE');
    const malformed = unwrapFailure(registry.register({ ...specialized, id: 'NotAnId' }));
    expect(malformed.reason).toBe('MALFORMED_ENVELOPE');
  });

  it('refuses a specialized capability that lets the caller own its output schema', () => {
    const registry = new CapabilityRegistry();
    const failure = unwrapFailure(
      registry.register({
        ...specialized,
        schemaOwnership: { input: 'REGISTRY', output: 'CALLER', policy: 'REGISTRY' },
      }),
    );
    expect(failure.issues.some((issue) => issue.path === '$.schemaOwnership.output')).toBe(true);
  });

  it('rejects non-positive limits', () => {
    const registry = new CapabilityRegistry();
    const failure = unwrapFailure(
      registry.register({ ...specialized, limits: { ...specialized.limits, maxCallsPerTurn: 0 } }),
    );
    expect(failure.issues.some((issue) => issue.path === '$.limits.maxCallsPerTurn')).toBe(true);
  });

  it('keeps the generic policies structural', () => {
    expect(GENERIC_STRUCTURED_POLICY.forbiddenOutput).toEqual([]);
    expect(GENERIC_TEXT_POLICY.forbiddenOutput).toEqual([]);
    expect(GENERIC_TEXT_POLICY.inputAllowList).toContain('instructions');
    expect(allowsCallerOutputSchema({ output: 'CALLER' })).toBe(true);
    expect(allowsCallerOutputSchema({ output: 'REGISTRY' })).toBe(false);
    expect(CALLER_OWNED_OUTPUT_SCHEMA.kind).toBe('REF');
  });
});

describe('maxCallsPerTurn — a capability that quietly calls four times is un-auditable', () => {
  it('authorizes up to the limit and then reports POLICY_VIOLATION', () => {
    expect(authorizeCapabilityCall(1, 0)).toEqual({ authorized: true, remaining: 1 });
    const denied = authorizeCapabilityCall(1, 1);
    expect(denied.authorized).toBe(false);
    if (!denied.authorized) {
      expect(denied.error.reason).toBe('POLICY_VIOLATION');
      expect(denied.error.details?.['rule']).toBe('maxCallsPerTurn');
      expect(denied.error.stage).toBe('POLICY');
    }
  });

  it('counts per turn and resets', () => {
    const counter = new TurnCallCounter(1);
    expect(counter.authorize().authorized).toBe(true);
    expect(counter.authorize().authorized).toBe(false);
    expect(counter.callsMade).toBe(1);
    counter.reset();
    expect(counter.authorize().authorized).toBe(true);
  });
});
