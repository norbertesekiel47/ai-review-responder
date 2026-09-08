// src/lib/auth/__tests__/admin-transport.test.ts
//
// The **Admin transport** predicate in isolation. Pure header parsing, so there is
// nothing to mock — which is the point: `src/proxy.ts` imports this module on the
// Edge (#1185), and a test needing a mock would mean the module grew a dependency
// it must not have.

import { describe, it, expect } from 'vitest';
import { isBearerRequest, readBearerToken } from '../admin-transport';

function req(headers: Record<string, string> = {}): Request {
  return new Request('https://app.example.com/api/admin/x', { method: 'POST', headers });
}

describe('isBearerRequest', () => {
  it('is false only when no Authorization header was sent', () => {
    expect(isBearerRequest(req())).toBe(false);
    expect(isBearerRequest(req({ 'x-other': 'v' }))).toBe(false);
  });

  it('is true for ANY Authorization header, including malformed and empty ones', () => {
    // The whole point of presence-not-shape: each of these selects the bearer arm,
    // so none of them can fall back to a session cookie. See readBearerToken for
    // which of them yields a token (none).
    const present = [
      'Bearer abc',
      'bearer abc',
      '',
      '   ',
      'Basic dXNlcjpwYXNz',
      'Bearer',
      'Bearer  ',
      'Bearer a b',
      'Token abc',
    ];

    for (const authorization of present) {
      expect(isBearerRequest(req({ authorization }))).toBe(true);
    }
  });
});

describe('readBearerToken', () => {
  it('reads the token, matching the scheme case-insensitively (RFC 7235)', () => {
    expect(readBearerToken(req({ authorization: 'Bearer abc.def.ghi' }))).toBe('abc.def.ghi');
    expect(readBearerToken(req({ authorization: 'bearer abc' }))).toBe('abc');
    expect(readBearerToken(req({ authorization: 'BEARER abc' }))).toBe('abc');
  });

  it('tolerates surrounding and inter-token whitespace', () => {
    expect(readBearerToken(req({ authorization: '  Bearer   abc  ' }))).toBe('abc');
    expect(readBearerToken(req({ authorization: 'Bearer\tabc' }))).toBe('abc');
  });

  it('returns null for every malformed shape', () => {
    // 'Bearer a b' is malformed rather than a token of 'a': RFC 6750 credentials are
    // a single token68 with no internal whitespace, and returning the first word
    // would let a caller smuggle a token past a filter reading the whole value.
    const malformed = [
      '',
      '   ',
      'Bearer',
      'Bearer  ',
      'Basic dXNlcjpwYXNz',
      'Token abc',
      'Bearer a b',
      'BearerNoSpace',
    ];

    for (const authorization of malformed) {
      expect(readBearerToken(req({ authorization }))).toBeNull();
    }
  });

  it('returns null when the header is absent', () => {
    expect(readBearerToken(req())).toBeNull();
  });

  it('agrees with isBearerRequest in the only direction that matters', () => {
    // A token can never be read from a request the predicate calls cookie-mode.
    // That is the invariant keeping `src/proxy.ts` (#1185) and the seam from
    // disagreeing into a bypass: everything readBearerToken accepts is also
    // bearer-mode, so no request is "cookie mode here, bearer mode there".
    const samples = ['Bearer abc', 'bearer abc', '', 'Basic x', 'Bearer', 'Bearer a b'];

    for (const authorization of samples) {
      const r = req({ authorization });
      if (readBearerToken(r) !== null) expect(isBearerRequest(r)).toBe(true);
    }
    expect(readBearerToken(req())).toBeNull();
    expect(isBearerRequest(req())).toBe(false);
  });
});
