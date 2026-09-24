/**
 * Layer 11 — compatibility fixtures (TESTING.md §1, §3.1; Docs/fixtures/README.md).
 *
 * Every fixture is **data**, loaded and validated by the repo's own parser. A `FROZEN` fixture is
 * the strongest guarantee in the set; if this suite fails, AI Bridge and its consumer disagree
 * about the contract.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AIBRIDGE_CONTRACT_VERSION,
  AIBRIDGE_ERROR_VERSION,
  AIBRIDGE_FIELD_DIALECT,
  AIBRIDGE_RESPONSE_SCHEMA_VERSION,
  CAPABILITY_DESCRIPTOR_VERSION,
  FIXTURE_SET_VERSION,
  GENERIC_REQUEST_SCHEMA_VERSION,
  parseAiRequestEnvelope,
  parseAiResult,
} from '@aibridge/contracts';
import { screenAiInput } from '@aibridge/core';
import { defaultCapabilityRegistry, parseCodeDebugInput, validateCodeDebugOutput } from '@aibridge/runtime';
import { describe, expect, it } from 'vitest';

import { unwrap, unwrapFailure } from '../helpers/assertions.js';

type Fixture = {
  readonly fixtureSetVersion: string;
  readonly binding: 'FROZEN' | 'ILLUSTRATIVE';
  readonly kind: 'request' | 'response';
  readonly expect: 'accept' | 'reject';
  readonly capability: string;
  readonly capabilityVersion: string;
  readonly case: string;
  readonly reason?: string;
  readonly document: Record<string, unknown>;
  readonly validationInput?: unknown;
  readonly compatibility?: {
    readonly contractVersion: string;
    readonly requestSchemaVersion: string;
    readonly responseSchemaVersion: string;
    readonly errorVersion: string;
    readonly descriptorVersion: string;
    readonly fieldDialect: string;
    readonly logicalCapability: string;
    readonly capabilityVersion: string;
    readonly requiredPrimitive: string;
    readonly readiness: string;
    readonly instructionMode: string;
    readonly colonIdempotencyKey: string;
  };
};

const FIXTURE_DIR = fileURLToPath(new URL('../../Docs/fixtures/fixture-set.v1', import.meta.url));

const EXPECTED_FILES = [
  'ai.structured.generate.request.ok.json',
  'ai.structured.generate.request.secret-input.json',
  'ai.structured.generate.request.unknown-metadata.json',
  'ai.structured.generate.response.ok.json',
  'ai.structured.generate.response.schema-mismatch.json',
  'ai.text.generate.request.prompt-provenance.json',
  'ai.text.generate.response.balance-exhausted.json',
  'ai.text.generate.response.ok.json',
  'ai.text.generate.response.reliability.json',
  'code.debug.analyze.compatibility.json',
  'code.debug.analyze.request.ok.json',
  'code.debug.analyze.request.provenance-invalid.json',
  'code.debug.analyze.request.trust-invalid.json',
  'code.debug.analyze.response.ok.json',
  'code.debug.analyze.response.output-reference-invalid.json',
  'education.idea.evaluate.request.ok.json',
  'education.idea.evaluate.response.ok.json',
  'education.idea.evaluate.response.unavailable.json',
] as const;

const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /\bghp_[A-Za-z0-9]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
];

const files = readdirSync(FIXTURE_DIR)
  .filter((entry) => entry.endsWith('.json'))
  .sort();

function load(name: string): Fixture {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf8')) as Fixture;
}

describe('compatibility fixtures', () => {
  it('ships exactly the documented, versioned fixture set', () => {
    expect(files).toEqual([...EXPECTED_FILES]);
    for (const name of files) {
      const fixture = load(name);
      expect(fixture.fixtureSetVersion, name).toBe(FIXTURE_SET_VERSION);
      expect(['FROZEN', 'ILLUSTRATIVE'], name).toContain(fixture.binding);
      expect(['request', 'response'], name).toContain(fixture.kind);
      expect(['accept', 'reject'], name).toContain(fixture.expect);
      expect(fixture.case.length, name).toBeGreaterThan(0);
      if (fixture.expect === 'reject') {
        expect(fixture.reason, `${name} declares reject but names no reason`).toBeDefined();
      }
    }
  });

  it('requires the commissioned specialized capability fixtures and case names', () => {
    expect(files.filter((name) => name.startsWith('code.debug.analyze.'))).toEqual([
      'code.debug.analyze.compatibility.json',
      'code.debug.analyze.request.ok.json',
      'code.debug.analyze.request.provenance-invalid.json',
      'code.debug.analyze.request.trust-invalid.json',
      'code.debug.analyze.response.ok.json',
      'code.debug.analyze.response.output-reference-invalid.json',
    ]);
    expect(files.filter((name) => name.startsWith('code.debug.analyze.')).map((name) => load(name).case)).toEqual([
      'code-debug-v1-compatibility-mapping',
      'valid-code-debug-request-with-prompt-provenance',
      'reject-code-debug-without-prompt-version',
      'reject-trusted-source-code-context',
      'valid-closed-code-debug-result',
      'reject-reference-outside-supplied-context',
    ]);
  });

  it('pins the additive Stage 7 compatibility mapping without changing response or field dialect versions', () => {
    const fixture = load('code.debug.analyze.compatibility.json');
    const compatibility = fixture.compatibility;
    expect(compatibility).toBeDefined();
    expect(compatibility).toMatchObject({
      contractVersion: '1.2',
      requestSchemaVersion: '1.2',
      responseSchemaVersion: '1.1',
      errorVersion: '1.2',
      descriptorVersion: '1.1',
      fieldDialect: 'aibridge.fields/v1',
      logicalCapability: 'code.debug.analyze',
      capabilityVersion: '1.0',
      requiredPrimitive: 'ai.structured.generate',
      readiness: 'STABLE',
      instructionMode: 'CONSUMER_COMPOSED',
      colonIdempotencyKey: expect.stringContaining(':'),
    });
    expect(compatibility?.contractVersion).toBe(AIBRIDGE_CONTRACT_VERSION);
    expect(compatibility?.requestSchemaVersion).toBe(GENERIC_REQUEST_SCHEMA_VERSION);
    expect(compatibility?.responseSchemaVersion).toBe(AIBRIDGE_RESPONSE_SCHEMA_VERSION);
    expect(compatibility?.errorVersion).toBe(AIBRIDGE_ERROR_VERSION);
    expect(compatibility?.descriptorVersion).toBe(CAPABILITY_DESCRIPTOR_VERSION);
    expect(compatibility?.fieldDialect).toBe(AIBRIDGE_FIELD_DIALECT);

    const descriptor = defaultCapabilityRegistry().get('code.debug.analyze', '1.0');
    expect(descriptor).toMatchObject({
      id: compatibility?.logicalCapability,
      version: compatibility?.capabilityVersion,
      kind: 'SPECIALIZED',
      requiredPrimitive: compatibility?.requiredPrimitive,
      readiness: compatibility?.readiness,
      instructionMode: compatibility?.instructionMode,
    });
  });

  it('contains a credential-shaped value in exactly one file — the allow-listed synthetic one', () => {
    for (const name of files) {
      const text = readFileSync(join(FIXTURE_DIR, name), 'utf8');
      const matches = CREDENTIAL_PATTERNS.some((pattern) => pattern.test(text));
      if (name.includes('secret-input')) {
        expect(matches, `${name} is the synthetic secret fixture and must match a pattern`).toBe(true);
      } else {
        expect(matches, `${name} must not contain a credential-shaped value`).toBe(false);
      }
    }
  });

  it.each(files)('%s', (name) => {
    const fixture = load(name);

    if (fixture.kind === 'request') {
      const parsed = parseAiRequestEnvelope(fixture.document);

      if (fixture.capability === 'code.debug.analyze') {
        if (!parsed.ok) {
          expect(fixture.expect).toBe('reject');
          expect(parsed.failure.reason).toBe(fixture.reason);
          expect(parsed.failure.issues.length).toBeGreaterThan(0);
          return;
        }

        const envelope = unwrap(parsed);
        expect(envelope.capability).toBe('code.debug.analyze');
        expect(envelope.capabilityVersion).toBe('1.0');
        const specializedInput = parseCodeDebugInput(envelope.input);
        if (fixture.expect === 'accept') {
          expect(specializedInput.ok, fixture.case).toBe(true);
          if (specializedInput.ok) {
            expect(specializedInput.value.context.every((entry) => entry.untrusted)).toBe(true);
          }
        } else {
          const failure = unwrapFailure(specializedInput);
          expect(failure.reason).toBe(fixture.reason);
        }
        return;
      }

      if (fixture.expect === 'accept') {
        const envelope = unwrap(parsed);
        expect(envelope.capability).toBe(fixture.capability);
        expect(envelope.capabilityVersion).toBe(fixture.capabilityVersion);
        return;
      }

      expect(fixture.reason).toBeDefined();
      if (fixture.reason === 'SECRET_LIKE_INPUT') {
        // The envelope is well-formed; the credential is caught when the input is screened.
        expect(parsed.ok, `${name}: the envelope itself must be shape-valid`).toBe(true);
        const screened = screenAiInput(fixture.document['input']);
        expect(screened.ok).toBe(false);
        if (!screened.ok) {
          expect(screened.error.reason).toBe('SECRET_LIKE_INPUT');
        }
        return;
      }

      const failure = unwrapFailure(parsed);
      expect(failure.reason).toBe(fixture.reason);
      expect(failure.issues.length).toBeGreaterThan(0);
      return;
    }

    const result = unwrap(parseAiResult(fixture.document));
    expect(result.capability).toBe(fixture.capability);
    expect(result.capabilityVersion).toBe(fixture.capabilityVersion);
    if (fixture.capability === 'code.debug.analyze') {
      const input = parseCodeDebugInput(fixture.validationInput);
      expect(input.ok, `${fixture.case}: validation input must be valid`).toBe(true);
      if (!input.ok) {
        return;
      }
      const output = validateCodeDebugOutput(result.output, input.value);
      if (fixture.expect === 'accept') {
        expect(output.ok, fixture.case).toBe(true);
      } else {
        const failure = unwrapFailure(output);
        expect(failure.reason).toBe(fixture.reason);
      }
      return;
    }

    // Existing non-debug response fixtures are valid envelopes, including frozen failures.
    expect(fixture.expect).toBe('accept');
  });
});
