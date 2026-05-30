import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveContactNotifyTo, notifyContactSubmission } from '../contact-notify';

const { mockCaptureMessage } = vi.hoisted(() => ({ mockCaptureMessage: vi.fn() }));
vi.mock('@sentry/nextjs', () => ({ captureMessage: mockCaptureMessage }));

const { mockSendInternalEmail, mockIsMockMode } = vi.hoisted(() => ({
  mockSendInternalEmail: vi.fn(),
  mockIsMockMode: vi.fn(() => false),
}));
vi.mock('../email/templates/internal', () => ({ sendInternalEmail: mockSendInternalEmail }));
vi.mock('@/lib/shared/mock-mode', () => ({ isMockMode: mockIsMockMode }));

// process.env.NODE_ENV is typed read-only (Next.js); assign through an index so
// the writable string index signature applies. Mirrors startup-assertion.test.ts.
function setEnv(key: string, value: string): void {
  process.env[key] = value;
}

describe('resolveContactNotifyTo', () => {
  const SNAP: Record<string, string | undefined> = {};
  const KEYS = ['NODE_ENV', 'CONTACT_NOTIFY_TO', 'RESEND_FROM_EMAIL'];
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    for (const k of KEYS) { SNAP[k] = process.env[k]; delete process.env[k]; }
    // Default to production so the fallback-warning path is exercised; the
    // "does not warn outside production" test overrides this.
    setEnv('NODE_ENV', 'production');
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockCaptureMessage.mockClear();
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
    expect(mockCaptureMessage).not.toHaveBeenCalled();
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
    expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      'contact_notify_to_unset',
      expect.objectContaining({ extra: { resolvedTo: 'notifications@repworth.com', source: 'from-email' } }),
    );
  });

  it('falls back to the RESEND_FROM_EMAIL mailbox (bare addr form)', () => {
    process.env.RESEND_FROM_EMAIL = 'notifications@repworth.com';
    expect(resolveContactNotifyTo()).toEqual({ to: 'notifications@repworth.com', source: 'from-email' });
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it('falls back to the default noreply mailbox when both unset, and warns', () => {
    expect(resolveContactNotifyTo()).toEqual({ to: 'noreply@repworth.net', source: 'default' });
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      'contact_notify_to_unset',
      expect.objectContaining({ level: 'error', tags: { subsystem: 'contact-notify' }, extra: { resolvedTo: 'noreply@repworth.net', source: 'default' } }),
    );
  });

  it('uses the default when RESEND_FROM_EMAIL is unparseable', () => {
    process.env.RESEND_FROM_EMAIL = 'not-an-email';
    expect(resolveContactNotifyTo()).toEqual({ to: 'noreply@repworth.net', source: 'default' });
  });

  it('resolves the fallback but does NOT warn outside production', () => {
    setEnv('NODE_ENV', 'development');
    process.env.RESEND_FROM_EMAIL = 'notifications@repworth.com';
    expect(resolveContactNotifyTo()).toEqual({ to: 'notifications@repworth.com', source: 'from-email' });
    expect(warnSpy).not.toHaveBeenCalled();
    expect(mockCaptureMessage).not.toHaveBeenCalled();
  });
});

describe('notifyContactSubmission', () => {
  const SNAP: Record<string, string | undefined> = {};
  const KEYS = ['NODE_ENV', 'CONTACT_NOTIFY_TO', 'RESEND_FROM_EMAIL', 'RESEND_API_KEY'];

  beforeEach(() => {
    for (const k of KEYS) { SNAP[k] = process.env[k]; delete process.env[k]; }
    setEnv('NODE_ENV', 'test');
    process.env.CONTACT_NOTIFY_TO = 'ops@example.com';
    mockSendInternalEmail.mockReset().mockResolvedValue({ messageId: 'ok' });
    mockIsMockMode.mockReset().mockReturnValue(false);
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (SNAP[k] === undefined) delete process.env[k]; else process.env[k] = SNAP[k];
    }
  });

  it('sends from the company no-reply default when RESEND_FROM_EMAIL is unset (preserves pre-#167 delivery)', async () => {
    process.env.RESEND_API_KEY = 'k';
    const r = await notifyContactSubmission({ subject: 'S', lines: ['a'] });
    expect(r).toEqual({ sent: true });
    expect(mockSendInternalEmail).toHaveBeenCalledWith(
      expect.objectContaining({ from: 'noreply@repworth.net' }),
    );
  });

  it('skips (sent:false) when not in mock mode and RESEND_API_KEY is unset', async () => {
    process.env.RESEND_FROM_EMAIL = 'notifications@repworth.com';
    const r = await notifyContactSubmission({ subject: 'S', lines: ['a'] });
    expect(r).toEqual({ sent: false });
    expect(mockSendInternalEmail).not.toHaveBeenCalled();
  });

  it('sends in mock mode without a real API key', async () => {
    process.env.RESEND_FROM_EMAIL = 'notifications@repworth.com';
    mockIsMockMode.mockReturnValue(true);
    const r = await notifyContactSubmission({ subject: 'S', lines: ['a'] });
    expect(r).toEqual({ sent: true });
    expect(mockSendInternalEmail).toHaveBeenCalledOnce();
  });

  it('delegates to sendInternalEmail with resolved recipient, internal category, escaped HTML body', async () => {
    process.env.RESEND_API_KEY = 'k';
    process.env.RESEND_FROM_EMAIL = 'notifications@repworth.com';
    await notifyContactSubmission({ subject: 'New lead', lines: ['Name: <Al & Co>', 'Email: a@b.com'] });
    expect(mockSendInternalEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'ops@example.com', from: 'notifications@repworth.com', subject: 'New lead', category: 'internal' }),
    );
    const arg = mockSendInternalEmail.mock.calls[0]![0] as { bodyHtml: string };
    expect(arg.bodyHtml).toContain('Name: &lt;Al &amp; Co&gt;');
    expect(arg.bodyHtml).toContain('Email: a@b.com');
  });

  it('propagates a send error so the caller can surface a 500', async () => {
    process.env.RESEND_API_KEY = 'k';
    process.env.RESEND_FROM_EMAIL = 'notifications@repworth.com';
    mockSendInternalEmail.mockRejectedValueOnce(new Error('resend down'));
    await expect(notifyContactSubmission({ subject: 'S', lines: ['a'] })).rejects.toThrow('resend down');
  });
});
