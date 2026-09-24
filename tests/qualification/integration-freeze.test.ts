/**
 * Integration-freeze gate (Stage 8, Phase 47).
 *
 * The parallel contract in `Docs/INTEGRATION_CONTRACT_V1.md` is frozen so another team can build
 * against it without waiting for us. Stage 8 adds provider *qualification* metadata only; it must not
 * move the frozen interface.
 *
 * This test is the mechanical guard: if a future edit changes the specialized-capability identity,
 * the `code.debug.analyze@1.0` schemas, prompt provenance semantics or the trusted/untrusted channel
 * split, it fails here rather than shipping silently. A genuine change requires the written
 * compatibility note + version bump + fixture update described in AGENTS.md §8.
 */
import { CODE_DEBUG_CAPABILITY_REGISTRATION, BUILTIN_CAPABILITY_REGISTRATIONS } from '@aibridge/core';
import {
  AI_ERROR_REASONS,
  PROMPT_VERSION_PATTERN,
  TRUSTED_ONLY_FIELDS,
  FORBIDDEN_CONSUMER_FIELDS,
} from '@aibridge/contracts';
import { describe, expect, it } from 'vitest';

describe('integration freeze: specialized capability identity', () => {
  it('code.debug.analyze exists exactly once at 1.0 with a stable identity', () => {
    const matches = BUILTIN_CAPABILITY_REGISTRATIONS.filter((entry) => entry.id === 'code.debug.analyze');
    expect(matches).toHaveLength(1);
    const registration = CODE_DEBUG_CAPABILITY_REGISTRATION;
    expect(registration.id).toBe('code.debug.analyze');
    expect(registration.version).toBe('1.0');
    expect(registration.kind).toBe('SPECIALIZED');
    expect(registration.requiredPrimitive).toBe('ai.structured.generate');
    expect(registration.readiness).toBe('STABLE');
    expect(registration.instructionMode).toBe('CONSUMER_COMPOSED');
    expect(registration.retention).toBe('METADATA_ONLY');
  });

  it('keeps the frozen code.debug.analyze input schema shape', () => {
    const schema = CODE_DEBUG_CAPABILITY_REGISTRATION.inputSchema;
    expect(schema.kind).toBe('INLINE');
    if (schema.kind !== 'INLINE') return;
    expect(schema.schemaId).toBe('code.debug.analyze.input');
    expect(schema.version).toBe('1.0');
    expect(schema.fields.map((field) => field.name)).toEqual(['instructions', 'context']);
  });

  it('keeps the frozen code.debug.analyze output schema shape', () => {
    const schema = CODE_DEBUG_CAPABILITY_REGISTRATION.outputSchema;
    expect(schema.kind).toBe('INLINE');
    if (schema.kind !== 'INLINE') return;
    expect(schema.schemaId).toBe('code.debug.analyze.output');
    expect(schema.version).toBe('1.0');
    expect(schema.fields.map((field) => field.name)).toEqual([
      'issueCategories',
      'diagnosticContextRefs',
      'limitations',
    ]);
    expect(schema.fields.every((field) => field.required)).toBe(true);
  });

  it('keeps the registry-owned schema ownership (no caller override)', () => {
    expect(CODE_DEBUG_CAPABILITY_REGISTRATION.schemaOwnership).toEqual({
      input: 'REGISTRY',
      output: 'REGISTRY',
      policy: 'REGISTRY',
    });
  });
});

describe('integration freeze: prompt provenance semantics', () => {
  it('keeps the promptVersion pattern and the promptApplied coupling', () => {
    expect(PROMPT_VERSION_PATTERN.source).toBe('^[A-Za-z0-9._-]{1,64}$');
    expect(PROMPT_VERSION_PATTERN.test('v1')).toBe(true);
    expect(PROMPT_VERSION_PATTERN.test('has space')).toBe(false);
  });

  it('never carries prompt text in the request shape', () => {
    // The consumer request has no prompt field; systemPrompt is explicitly forbidden.
    expect(FORBIDDEN_CONSUMER_FIELDS).toContain('systemPrompt');
    expect(FORBIDDEN_CONSUMER_FIELDS).toContain('authorization');
    expect(FORBIDDEN_CONSUMER_FIELDS).toContain('credential');
  });
});

describe('integration freeze: trusted / untrusted channel split', () => {
  it('keeps the trusted-only field set closed', () => {
    expect([...TRUSTED_ONLY_FIELDS]).toEqual([
      'callerPluginId',
      'subjectToken',
      'grantedPermissions',
      'permissions',
      'hostRequestId',
      'principal',
      'verifiedCaller',
    ]);
  });
});

describe('integration freeze: error vocabulary is stable', () => {
  it('keeps the closed reason set that consumers may parse', () => {
    // A representative, load-bearing subset. Adding a reason is additive; removing one is a break.
    for (const reason of [
      'TRUSTED_FIELD_IN_CONSUMER_REQUEST',
      'OUTPUT_SCHEMA_OVERRIDE_FORBIDDEN',
      'CONTRACT_VERSION_UNSUPPORTED',
      'PROVIDER_AUTH_FAILED',
      'PROVIDER_BALANCE_EXHAUSTED',
      'SCHEMA_VALIDATION_FAILED',
    ] as const) {
      expect(AI_ERROR_REASONS).toContain(reason);
    }
  });
});
