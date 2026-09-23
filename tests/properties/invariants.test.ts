/**
 * Property / fuzz tests over the portable primitives (TESTING.md §1, §3.10).
 *
 * These assert totality and cross-implementation agreement rather than individual examples: the
 * input screen never throws, a clean result contains no secret any more, and the dependency-free
 * byte counter agrees with Node's.
 */
import { canonicalize, jsonByteLength, mapStrings, screenAiInput, utf8ByteLength, walkStrings } from '@aibridge/core';
import { findSecrets } from '@aibridge/core';
import { describe, expect, it } from 'vitest';

import { syntheticKey } from '../helpers/synthetic.js';

/** A tiny deterministic PRNG, so a failure is reproducible. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

const WORDS = ['learn', 'map', 'lookup', 'idea', 'value', 'index', 'target', 'pass', 'hash', 'complement'];

function randomValue(random: () => number, depth = 0): unknown {
  const roll = random();
  if (depth >= 3) {
    return WORDS[Math.floor(random() * WORDS.length)];
  }
  if (roll < 0.35) {
    return WORDS[Math.floor(random() * WORDS.length)];
  }
  if (roll < 0.45) {
    return Math.floor(random() * 1000);
  }
  if (roll < 0.5) {
    return random() < 0.5;
  }
  if (roll < 0.6) {
    return null;
  }
  if (roll < 0.8) {
    return Array.from({ length: Math.floor(random() * 4) }, () => randomValue(random, depth + 1));
  }
  const record: Record<string, unknown> = {};
  const size = Math.floor(random() * 4);
  for (let index = 0; index < size; index += 1) {
    record[`k${index}`] = randomValue(random, depth + 1);
  }
  return record;
}

describe('portable primitives hold on arbitrary input', () => {
  it('the pure UTF-8 byte counter agrees with Node on every string it sees', () => {
    const samples = [
      '',
      'ascii only',
      '中文测试',
      '😀😀',
      'mixed 中文 and 😀',
      'sk-' + 'A'.repeat(32),
      '\u0000\u007f',
      'e\u0301',
    ];
    for (const sample of samples) {
      expect(utf8ByteLength(sample), JSON.stringify(sample)).toBe(Buffer.byteLength(sample, 'utf8'));
    }
  });

  it('canonicalize ignores key order and jsonByteLength measures serialized bytes', () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
    expect(jsonByteLength({ a: '中文' })).toBe(Buffer.byteLength(JSON.stringify({ a: '中文' }), 'utf8'));
    expect(jsonByteLength({ cyclic: undefined, bad: 1n })).toBeNull();
  });

  it('mapStrings rebuilds exactly what walkStrings reports', () => {
    const value = { a: 'x', b: ['y', { c: 'z' }] };
    const walked: Array<[string, string]> = [];
    walkStrings(value, '$', (text, path) => walked.push([path, text]));
    expect(walked).toEqual([
      ['$.a', 'x'],
      ['$.b[0]', 'y'],
      ['$.b[1].c', 'z'],
    ]);
    expect(mapStrings(value, '$', (text) => text.toUpperCase())).toEqual({ a: 'X', b: ['Y', { c: 'Z' }] });
  });

  it('the input screen is total: it never throws and never returns a secret on success', () => {
    const random = lcg(20_260_923);
    const secret = syntheticKey();
    for (let iteration = 0; iteration < 500; iteration += 1) {
      const value = randomValue(random);
      // Occasionally inject something hostile.
      if (iteration % 17 === 0 && typeof value === 'object' && value !== null && !Array.isArray(value)) {
        (value as Record<string, unknown>)['injected'] = secret;
      }
      const result = screenAiInput(value);
      if (result.ok) {
        // A success must be genuinely clean: no secret remains anywhere.
        expect(findSecrets(result.value)).toEqual([]);
      } else {
        expect(['SECRET_LIKE_INPUT', 'INPUT_TOO_LARGE', 'MALFORMED_ENVELOPE']).toContain(result.error.reason);
        // The offending value is never echoed into the error.
        expect(JSON.stringify(result.error)).not.toContain(secret);
      }
    }
  });
});
