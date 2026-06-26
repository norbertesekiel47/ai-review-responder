import { describe, expect, it, vi } from 'vitest';

// The impersonation cookie helpers now read IMPERSONATION_COOKIE_SECRET via
// getServerConfig() (memoized). Set/delete the env, reset modules, then
// dynamically import so the config memo re-parses (Stage-3 convention #6). Every
// assertion below is unchanged.
async function freshCookie() {
  vi.resetModules();
  return import('../cookie');
}

describe('impersonation cookie', () => {
  it('signs and verifies an impersonation session id', async () => {
    process.env.IMPERSONATION_COOKIE_SECRET = 'test-secret-at-least-32-characters-long';
    const { IMPERSONATION_COOKIE_NAME, signImpersonationSession, verifyImpersonationSession } =
      await freshCookie();

    const signed = signImpersonationSession('018f0000-0000-7000-8000-000000000048');

    expect(IMPERSONATION_COOKIE_NAME).toBe('rw_impersonation');
    expect(verifyImpersonationSession(signed)).toBe('018f0000-0000-7000-8000-000000000048');
  });

  it('rejects tampered signatures', async () => {
    process.env.IMPERSONATION_COOKIE_SECRET = 'test-secret-at-least-32-characters-long';
    const { signImpersonationSession, verifyImpersonationSession } = await freshCookie();
    const signed = signImpersonationSession('018f0000-0000-7000-8000-000000000048');

    expect(verifyImpersonationSession(`${signed}tampered`)).toBeNull();
    expect(verifyImpersonationSession(`${signed}.extra`)).toBeNull();
  });

  it('fails fast when the cookie secret is not configured', async () => {
    delete process.env.IMPERSONATION_COOKIE_SECRET;
    const { assertImpersonationCookieConfigured } = await freshCookie();

    expect(() => assertImpersonationCookieConfigured()).toThrow(
      'IMPERSONATION_COOKIE_SECRET not configured',
    );
  });

  it('rejects a too-short cookie secret', async () => {
    process.env.IMPERSONATION_COOKIE_SECRET = 'short';
    const { assertImpersonationCookieConfigured } = await freshCookie();

    expect(() => assertImpersonationCookieConfigured()).toThrow(/too short/i);
  });
});
