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

import { FIXTURE_SET_VERSION, parseAiRequestEnvelope, parseAiResult } from '@aibridge/contracts';
import { screenAiInput } from '@aibridge/core';
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
};

const FIXTURE_DIR = fileURLToPath(new URL('../../Docs/fixtures/fixture-set.v1', import.meta.url));

const EXPECTED_FILES = [
  'ai.structured.generate.request.ok.json',
  'ai.structured.generate.request.secret-input.json',
  'ai.structured.generate.request.unknown-metadata.json',
  'ai.structured.generate.response.ok.json',
  'ai.structured.generate.response.schema-mismatch.json',
  'ai.text.generate.response.balance-exhausted.json',
  'ai.text.generate.response.ok.json',
  'ai.text.generate.response.reliability.json',
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

    // Response fixtures are all `accept`: a valid FAILED envelope is part of the contract too.
    expect(fixture.expect).toBe('accept');
    const result = unwrap(parseAiResult(fixture.document));
    expect(result.capability).toBe(fixture.capability);
    expect(result.capabilityVersion).toBe(fixture.capabilityVersion);
  });
});
