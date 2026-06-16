import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getSessionCookieSecret } from '../session-cookie-secret';

describe('getSessionCookieSecret', () => {
  let SNAP: string | undefined;
  beforeEach(() => { SNAP = process.env.SESSION_COOKIE_SECRET; delete process.env.SESSION_COOKIE_SECRET; });
  afterEach(() => {
    if (SNAP === undefined) delete process.env.SESSION_COOKIE_SECRET;
    else process.env.SESSION_COOKIE_SECRET = SNAP;
  });

  it('throws when unset', () => {
    expect(() => getSessionCookieSecret()).toThrow(/SESSION_COOKIE_SECRET/);
  });
  it('throws when shorter than 32 bytes', () => {
    process.env.SESSION_COOKIE_SECRET = 'short';
    expect(() => getSessionCookieSecret()).toThrow(/32 bytes/);
  });
  it('accepts a secret of exactly 32 bytes', () => {
    process.env.SESSION_COOKIE_SECRET = 'a'.repeat(32);
    expect(getSessionCookieSecret()).toBe('a'.repeat(32));
  });
  it('counts bytes not chars (multibyte secret >=32 bytes, .length < 32)', () => {
    const s = '€'.repeat(11); // 33 bytes, length 11
    process.env.SESSION_COOKIE_SECRET = s;
    expect(getSessionCookieSecret()).toBe(s);
  });
});
