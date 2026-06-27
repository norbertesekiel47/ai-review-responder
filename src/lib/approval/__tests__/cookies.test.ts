import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHash, createHmac } from 'node:crypto';

// Set secret before importing (module reads env on first call)
process.env.SESSION_COOKIE_SECRET = 'test-secret-for-cookies-32chars!!';

import {
  setDeviceCookie,
  getDeviceCookieHash,
  verifyDeviceCookie,
  validateCsrf,
} from '../cookies';
import { NextRequest, NextResponse } from 'next/server';

// ── Helpers ──────────────────────────────────────────────────────────────

function makeRequest(
  cookies: Record<string, string> = {},
  headers: Record<string, string> = {},
): NextRequest {
  const url = 'https://app.test/api/approve/test-token';
  const req = new NextRequest(url, { headers });
  for (const [name, value] of Object.entries(cookies)) {
    req.cookies.set(name, value);
  }
  return req;
}

function signCookie(uuid: string): string {
  const hmac = createHmac('sha256', 'test-secret-for-cookies-32chars!!')
    .update(uuid)
    .digest('hex');
  return `${uuid}.${hmac}`;
}

// ── setDeviceCookie ──────────────────────────────────────────────────────

describe('setDeviceCookie', () => {
  beforeEach(() => {
    process.env.SESSION_COOKIE_SECRET = 'test-secret-for-cookies-32chars!!';
  });

  it('returns a uuid.hmac formatted string and sets cookie on response', () => {
    const response = NextResponse.json({});
    const result = setDeviceCookie(response);

    // Format: uuid.hmac
    const parts = result.split('.');
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(parts[1]).toHaveLength(64); // SHA-256 hex

    // Cookie was set on the response
    const cookie = response.cookies.get('__device');
    expect(cookie).toBeDefined();
    expect(cookie!.value).toBe(result);
  });
});

// ── getDeviceCookieHash ──────────────────────────────────────────────────

describe('getDeviceCookieHash', () => {
  it('returns SHA-256 of cookie value when cookie is valid', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    const signed = signCookie(uuid);
    const req = makeRequest({ __device: signed });

    const hash = getDeviceCookieHash(req);

    const expected = createHash('sha256').update(signed).digest('hex');
    expect(hash).toBe(expected);
  });

  it('returns null when cookie is missing', () => {
    const req = makeRequest();

    const hash = getDeviceCookieHash(req);

    expect(hash).toBeNull();
  });
});

// ── verifyDeviceCookie ───────────────────────────────────────────────────

describe('verifyDeviceCookie', () => {
  it('returns true for a valid HMAC-signed cookie', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    const signed = signCookie(uuid);
    const req = makeRequest({ __device: signed });

    expect(verifyDeviceCookie(req)).toBe(true);
  });

  it('returns false for a tampered cookie', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    const signed = signCookie(uuid);
    // Tamper with the HMAC portion
    const tampered = signed.slice(0, -4) + 'dead';
    const req = makeRequest({ __device: tampered });

    expect(verifyDeviceCookie(req)).toBe(false);
  });
});

// ── getSessionSecret length guard ────────────────────────────────────────

describe('getSessionSecret (via setDeviceCookie)', () => {
  it('throws when SESSION_COOKIE_SECRET is shorter than 32 bytes', async () => {
    // cookies.ts → session-cookie-secret.ts now reads SESSION_COOKIE_SECRET via
    // the memoized getServerConfig(). The other tests in this file share the
    // valid secret set before the static import; this one needs the SHORT secret,
    // so it set→resetModules→re-imports cookies.ts so the config memo re-parses
    // 'short' (Stage-3 convention #6). Assertion unchanged.
    const prev = process.env.SESSION_COOKIE_SECRET;
    process.env.SESSION_COOKIE_SECRET = 'short';
    try {
      vi.resetModules();
      const { setDeviceCookie: freshSetDeviceCookie } = await import('../cookies');
      const response = NextResponse.json({});
      expect(() => freshSetDeviceCookie(response)).toThrow(/SESSION_COOKIE_SECRET/);
    } finally {
      if (prev === undefined) {
        delete process.env.SESSION_COOKIE_SECRET;
      } else {
        process.env.SESSION_COOKIE_SECRET = prev;
      }
      vi.resetModules();
    }
  });
});

// ── validateCsrf ─────────────────────────────────────────────────────────

describe('validateCsrf', () => {
  it('returns true when header matches cookie', () => {
    const csrfToken = 'csrf-token-value-123';
    const req = makeRequest(
      { __csrf: csrfToken },
      { 'x-csrf-token': csrfToken },
    );

    expect(validateCsrf(req)).toBe(true);
  });

  it('returns false when header does not match cookie', () => {
    const req = makeRequest(
      { __csrf: 'correct-token' },
      { 'x-csrf-token': 'wrong-token-value' },
    );

    expect(validateCsrf(req)).toBe(false);
  });
});
