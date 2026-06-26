import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// getSessionCookieSecret now reads SESSION_COOKIE_SECRET via getServerConfig()
// (memoized). Set/delete the env, reset modules, then dynamically import so the
// config memo re-parses (Stage-3 convention #6). Every assertion is unchanged.
async function freshSecret() {
  vi.resetModules();
  return import('../session-cookie-secret');
}

describe('getSessionCookieSecret', () => {
  let SNAP: string | undefined;
  beforeEach(() => { SNAP = process.env.SESSION_COOKIE_SECRET; delete process.env.SESSION_COOKIE_SECRET; });
  afterEach(() => {
    if (SNAP === undefined) delete process.env.SESSION_COOKIE_SECRET;
    else process.env.SESSION_COOKIE_SECRET = SNAP;
  });

  it('throws when unset', async () => {
    const { getSessionCookieSecret } = await freshSecret();
    expect(() => getSessionCookieSecret()).toThrow(/SESSION_COOKIE_SECRET/);
  });
  it('throws when shorter than 32 bytes', async () => {
    process.env.SESSION_COOKIE_SECRET = 'short';
    const { getSessionCookieSecret } = await freshSecret();
    expect(() => getSessionCookieSecret()).toThrow(/32 bytes/);
  });
  it('accepts a secret of exactly 32 bytes', async () => {
    process.env.SESSION_COOKIE_SECRET = 'a'.repeat(32);
    const { getSessionCookieSecret } = await freshSecret();
    expect(getSessionCookieSecret()).toBe('a'.repeat(32));
  });
  it('counts bytes not chars (multibyte secret >=32 bytes, .length < 32)', async () => {
    const s = '€'.repeat(11); // 33 bytes, length 11
    process.env.SESSION_COOKIE_SECRET = s;
    const { getSessionCookieSecret } = await freshSecret();
    expect(getSessionCookieSecret()).toBe(s);
  });
});
