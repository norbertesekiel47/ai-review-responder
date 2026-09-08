// src/lib/auth/__tests__/admin-transport.test.ts
//
// The **Admin transport** predicate in isolation. Pure header parsing, so there is
// nothing to mock — which is the point: `src/proxy.ts` imports this module on the
// Edge (#1185), and a test needing a mock would mean the module grew a dependency
// it must not have.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

describe('Edge safety', () => {
  it('has no imports at all, so src/proxy.ts can take it to the Edge (#1185)', () => {
    // The module's header calls Edge-safety "a hard constraint rather than a
    // nicety" and, until this test, enforced nothing. Adding `import { sql } from
    // '@/lib/db/server'` here is a green build today and a broken Edge bundle in
    // someone else's PR — the failure lands on the wrong author, months later.
    //
    // Asserted as "zero imports" rather than "no BAD imports" deliberately: the
    // module is pure header parsing, so it needs nothing, and an allowlist would
    // have to be maintained against a runtime whose constraints we do not own.
    // If a future edit genuinely needs an import, this test is the conversation.
    const source = readFileSync(join(__dirname, '..', 'admin-transport.ts'), 'utf8');
    // Comments are stripped first: this module's own header NAMES the things it
    // must not do ("no node:*, no process.env"), so a naive scan of the raw file
    // fails on the documentation of the rule it is checking.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    // Scan for the TOKEN, not for a line shape. The first version of this guard
    // matched `^\s*import .* from ` per line and a red-team pass walked straight
    // through it twice: `import 'node:crypto';` has no `from`, and a
    // Prettier-wrapped `import {\n  x,\n} from 'node:crypto'` puts the `from` on a
    // different line than the `import`. A guard that only catches the tidy form of
    // a violation is not a guard. "Zero imports" is a claim about the whole file,
    // so it is asserted against the whole file.
    expect(code).not.toMatch(/\bimport\b/);
    expect(code).not.toMatch(/\brequire\s*\(/);
    expect(code).not.toMatch(/\bprocess\.env\b/);
  });
});
