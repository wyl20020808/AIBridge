import {
  AIBRIDGE_CONTRACT_VERSION,
  AIBRIDGE_RESPONSE_SCHEMA_VERSION,
  CAPABILITY_DESCRIPTOR_VERSION,
  GENERIC_REQUEST_SCHEMA_VERSION,
  checkMajorCompatibility,
  isMajorCompatible,
  parseMajor,
} from '@aibridge/contracts';
import { describe, expect, it } from 'vitest';

describe('version policy — reject unknown majors, never best-effort parse', () => {
  it('accepts the frozen major-compatible forms', () => {
    // Request/descriptor changes are additive within major 1; response shape stays unchanged.
    expect(AIBRIDGE_CONTRACT_VERSION).toBe('1.2');
    expect(GENERIC_REQUEST_SCHEMA_VERSION).toBe('1.2');
    expect(CAPABILITY_DESCRIPTOR_VERSION).toBe('1.1');
    expect(AIBRIDGE_RESPONSE_SCHEMA_VERSION).toBe('1.1');
    expect(parseMajor('1')).toBe(1);
    expect(parseMajor('1.0')).toBe(1);
    expect(parseMajor('1.0.3')).toBe(1);
    expect(parseMajor(1)).toBe(1);
    expect(parseMajor(' 1.0 ')).toBe(1);
  });

  it('cannot read a malformed version', () => {
    expect(parseMajor('1.x')).toBeNull();
    expect(parseMajor('v1')).toBeNull();
    expect(parseMajor('')).toBeNull();
    expect(parseMajor('not-a-version')).toBeNull();
    expect(parseMajor(null)).toBeNull();
    expect(parseMajor(undefined)).toBeNull();
    expect(parseMajor(1.5)).toBeNull();
    expect(parseMajor(-1)).toBeNull();
  });

  it('rejects a higher major rather than guessing', () => {
    expect(checkMajorCompatibility('2.0', '1.0')).toEqual({
      compatible: false,
      expectedMajor: 1,
      actualMajor: 2,
      mustReject: true,
    });
    expect(isMajorCompatible('2.0')).toBe(false);
    expect(isMajorCompatible('1.0')).toBe(true);
    expect(isMajorCompatible('1')).toBe(true);
    expect(isMajorCompatible('1.0.9')).toBe(true);
  });

  it('treats an unreadable actual or expected version as incompatible', () => {
    expect(isMajorCompatible('1.x')).toBe(false);
    expect(checkMajorCompatibility('1.0', 'garbage').compatible).toBe(false);
    expect(checkMajorCompatibility('1.0', 'garbage').mustReject).toBe(true);
  });
});
