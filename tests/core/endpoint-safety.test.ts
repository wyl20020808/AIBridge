/**
 * Endpoint safety — the relay SSRF boundary (ROADMAP Stage 4 §19–20).
 *
 * The relay provider accepts operator-configured endpoints, so the endpoint itself is the attack
 * surface. These tests pin the fail-closed rules: HTTPS by default, no embedded credentials, no
 * loopback/private/link-local/metadata targets (including integer IPv4 encodings), bounded and
 * re-validated redirects, and an explicit development-only escape hatch that defaults to off.
 */
import { checkEndpointSafety, validateEndpointUrl } from '@aibridge/core';
import { describe, expect, it } from 'vitest';

import { unwrapFailure } from '../helpers/assertions.js';

describe('endpoint safety — production defaults', () => {
  it('accepts a plain public HTTPS endpoint', () => {
    const check = checkEndpointSafety('https://api.example.invalid/v1');
    expect(check.safe).toBe(true);
  });

  it('requires HTTPS', () => {
    const check = checkEndpointSafety('http://api.example.invalid/v1');
    expect(check.safe).toBe(false);
    if (!check.safe) {
      expect(check.rejection).toBe('HTTPS_REQUIRED');
    }
  });

  it('rejects credentials embedded in the URL', () => {
    const check = checkEndpointSafety('https://user:pass@api.example.invalid/v1');
    expect(check.safe).toBe(false);
    if (!check.safe) {
      expect(check.rejection).toBe('EMBEDDED_CREDENTIALS');
    }
  });

  it('rejects loopback, localhost variants and .local names', () => {
    for (const url of [
      'https://localhost/v1',
      'https://api.localhost/v1',
      'https://gateway.local/v1',
      'https://ip6-localhost/v1',
    ]) {
      const check = checkEndpointSafety(url);
      expect(check.safe, url).toBe(false);
      if (!check.safe) {
        expect(check.rejection, url).toBe('BLOCKED_HOST');
      }
    }
  });

  it('rejects private, loopback and link-local IP literals', () => {
    for (const url of [
      'https://127.0.0.1/v1',
      'https://10.1.2.3/v1',
      'https://172.16.0.9/v1',
      'https://192.168.1.1/v1',
      'https://100.64.0.1/v1',
      'https://0.0.0.0/v1',
      'https://[::1]/v1',
      'https://[fc00::1]/v1',
      'https://[fe80::1]/v1',
      'https://[::ffff:127.0.0.1]/v1',
    ]) {
      const check = checkEndpointSafety(url);
      expect(check.safe, url).toBe(false);
      if (!check.safe) {
        expect(['PRIVATE_ADDRESS', 'BLOCKED_HOST'], url).toContain(check.rejection);
      }
    }
  });

  it('rejects integer-encoded IPv4 — the classic literal bypass', () => {
    // 2130706433 == 127.0.0.1; the WHATWG parser normalizes it before the range check runs.
    const check = checkEndpointSafety('https://2130706433/v1');
    expect(check.safe).toBe(false);
    if (!check.safe) {
      expect(check.rejection).toBe('PRIVATE_ADDRESS');
    }
  });

  it('rejects cloud metadata targets', () => {
    for (const url of ['https://169.254.169.254/v1', 'https://metadata.google.internal/v1']) {
      const check = checkEndpointSafety(url);
      expect(check.safe, url).toBe(false);
      if (!check.safe) {
        expect(['METADATA_ADDRESS', 'BLOCKED_HOST', 'PRIVATE_ADDRESS'], url).toContain(check.rejection);
      }
    }
  });

  it('fails closed on an unparseable URL', () => {
    for (const url of ['', 'not a url', 'ftp://api.example.invalid/v1', '/relative/path']) {
      const check = checkEndpointSafety(url);
      expect(check.safe, url).toBe(false);
      if (!check.safe) {
        expect(['INVALID_URL', 'HTTPS_REQUIRED'], url).toContain(check.rejection);
      }
    }
  });

  it('has an explicit development escape hatch that defaults to off', () => {
    expect(checkEndpointSafety('http://127.0.0.1:8080/v1').safe).toBe(false);
    expect(
      checkEndpointSafety('http://127.0.0.1:8080/v1', { allowPrivateNetworkForDevelopment: true }).safe,
    ).toBe(true);
    // The escape hatch is development-only; a metadata address stays blocked semantics-wise in
    // documentation, but the dev flag is the operator's explicit, recorded choice.
    expect(checkEndpointSafety('https://169.254.169.254/', { allowPrivateNetworkForDevelopment: true }).safe).toBe(true);
  });

  it('exposes rejections as rooted validation issues', () => {
    const failure = unwrapFailure(validateEndpointUrl('https://localhost/v1', '$.endpoint'));
    expect(failure.issues[0]?.path).toBe('$.endpoint');
    expect(failure.issues[0]?.message).toContain('BLOCKED_HOST');
  });
});
