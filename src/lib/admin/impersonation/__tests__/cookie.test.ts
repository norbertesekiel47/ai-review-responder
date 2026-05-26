import { describe, expect, it } from 'vitest';
import {
  assertImpersonationCookieConfigured,
  IMPERSONATION_COOKIE_NAME,
  signImpersonationSession,
  verifyImpersonationSession,
} from '../cookie';

describe('impersonation cookie', () => {
  it('signs and verifies an impersonation session id', () => {
    process.env.IMPERSONATION_COOKIE_SECRET = 'test-secret';

    const signed = signImpersonationSession('018f0000-0000-7000-8000-000000000048');

    expect(IMPERSONATION_COOKIE_NAME).toBe('rw_impersonation');
    expect(verifyImpersonationSession(signed)).toBe('018f0000-0000-7000-8000-000000000048');
  });

  it('rejects tampered signatures', () => {
    process.env.IMPERSONATION_COOKIE_SECRET = 'test-secret';
    const signed = signImpersonationSession('018f0000-0000-7000-8000-000000000048');

    expect(verifyImpersonationSession(`${signed}tampered`)).toBeNull();
    expect(verifyImpersonationSession(`${signed}.extra`)).toBeNull();
  });

  it('fails fast when the cookie secret is not configured', () => {
    delete process.env.IMPERSONATION_COOKIE_SECRET;

    expect(() => assertImpersonationCookieConfigured()).toThrow(
      'IMPERSONATION_COOKIE_SECRET not configured',
    );
  });
});
