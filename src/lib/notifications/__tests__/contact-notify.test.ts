import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveContactNotifyTo } from '../contact-notify';

describe('resolveContactNotifyTo', () => {
  const SNAP: Record<string, string | undefined> = {};
  const KEYS = ['NODE_ENV', 'CONTACT_NOTIFY_TO', 'RESEND_FROM_EMAIL'];
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    for (const k of KEYS) { SNAP[k] = process.env[k]; delete process.env[k]; }
    // Default to production so the fallback-warning path is exercised; the
    // "does not warn outside production" test overrides this.
    process.env.NODE_ENV = 'production';
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (SNAP[k] === undefined) delete process.env[k]; else process.env[k] = SNAP[k];
    }
    warnSpy.mockRestore();
  });

  it('returns CONTACT_NOTIFY_TO when set, no warning', () => {
    process.env.CONTACT_NOTIFY_TO = 'leads@example.com';
    expect(resolveContactNotifyTo()).toEqual({ to: 'leads@example.com', source: 'env' });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('trims CONTACT_NOTIFY_TO and ignores whitespace-only', () => {
    process.env.CONTACT_NOTIFY_TO = '  ops@example.com  ';
    expect(resolveContactNotifyTo()).toEqual({ to: 'ops@example.com', source: 'env' });
  });

  it('treats whitespace-only CONTACT_NOTIFY_TO as unset and falls back', () => {
    process.env.CONTACT_NOTIFY_TO = '   ';
    process.env.RESEND_FROM_EMAIL = 'notifications@repworth.com';
    expect(resolveContactNotifyTo()).toEqual({ to: 'notifications@repworth.com', source: 'from-email' });
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it('falls back to the RESEND_FROM_EMAIL mailbox (Display <addr> form) and warns', () => {
    process.env.RESEND_FROM_EMAIL = 'RepWorth <notifications@repworth.com>';
    expect(resolveContactNotifyTo()).toEqual({ to: 'notifications@repworth.com', source: 'from-email' });
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it('falls back to the RESEND_FROM_EMAIL mailbox (bare addr form)', () => {
    process.env.RESEND_FROM_EMAIL = 'notifications@repworth.com';
    expect(resolveContactNotifyTo()).toEqual({ to: 'notifications@repworth.com', source: 'from-email' });
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it('falls back to the default noreply mailbox when both unset, and warns', () => {
    expect(resolveContactNotifyTo()).toEqual({ to: 'noreply@repworth.com', source: 'default' });
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it('uses the default when RESEND_FROM_EMAIL is unparseable', () => {
    process.env.RESEND_FROM_EMAIL = 'not-an-email';
    expect(resolveContactNotifyTo()).toEqual({ to: 'noreply@repworth.com', source: 'default' });
  });

  it('resolves the fallback but does NOT warn outside production', () => {
    process.env.NODE_ENV = 'development';
    process.env.RESEND_FROM_EMAIL = 'notifications@repworth.com';
    expect(resolveContactNotifyTo()).toEqual({ to: 'notifications@repworth.com', source: 'from-email' });
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
