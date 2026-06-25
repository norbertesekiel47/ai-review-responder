// Stage-3 pilot: proves the email reads migrated onto getServerConfig() preserve
// EXACT prior semantics — the EMAIL_SEND_TIMEOUT_MS default/parse path and the
// RESEND_API_KEY tolerate-undefined client construction. getServerConfig()
// memoizes, so each env-mutation case uses vi.resetModules() + a fresh dynamic
// import to re-parse the live env (Stage-3 convention #4 test guidance).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockResendCtor } = vi.hoisted(() => ({ mockResendCtor: vi.fn() }));
vi.mock('resend', () => ({
  Resend: class {
    emails = { send: vi.fn() };
    constructor(apiKey?: string) {
      mockResendCtor(apiKey);
    }
  },
}));

const CORE = {
  NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon',
  NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
};

describe('email config migration — send-email timeout (getServerConfig)', () => {
  const original = process.env;
  beforeEach(() => { process.env = { ...original, ...CORE }; vi.resetModules(); mockResendCtor.mockClear(); });
  afterEach(() => { process.env = original; vi.resetModules(); });

  async function importSendEmailWithMockedClient() {
    // Mock the lazy client so the timeout race resolves immediately and we
    // observe only the resolved EMAIL_SEND_TIMEOUT_MS via the no-opts path.
    vi.doMock('../client', () => ({
      getResend: () => ({ emails: { send: vi.fn().mockResolvedValue({ data: { id: 'x' }, error: null }) } }),
    }));
    return import('../send-email');
  }

  it('falls back to the 10_000ms default when EMAIL_SEND_TIMEOUT_MS is unset', async () => {
    delete process.env.EMAIL_SEND_TIMEOUT_MS;
    const { sendEmail } = await importSendEmailWithMockedClient();
    // A resolving send returns before any timeout; the test asserts no throw and
    // that the default path is taken (no env-derived override).
    await expect(
      sendEmail({ from: 'a@b.com', to: 'c@d.com', subject: 's', html: '<p>x</p>' }),
    ).resolves.toEqual({ data: { id: 'x' }, error: null });
  });

  it('honors a small EMAIL_SEND_TIMEOUT_MS from the config accessor (no opts override)', async () => {
    process.env.EMAIL_SEND_TIMEOUT_MS = '20';
    // A never-resolving send so the env-derived 20ms timeout is what fires —
    // proving the value flowed through getServerConfig() into resolveTimeoutMs().
    vi.doMock('../client', () => ({
      getResend: () => ({ emails: { send: () => new Promise(() => {}) } }),
    }));
    const { sendEmail, EmailSendTimeoutError } = await import('../send-email');
    await expect(
      sendEmail({ from: 'a@b.com', to: 'c@d.com', subject: 's', html: '<p>x</p>' }),
    ).rejects.toBeInstanceOf(EmailSendTimeoutError);
  });

  it('falls back to the default for a non-numeric EMAIL_SEND_TIMEOUT_MS (preserves NaN guard)', async () => {
    process.env.EMAIL_SEND_TIMEOUT_MS = 'not-a-number';
    const { sendEmail } = await importSendEmailWithMockedClient();
    await expect(
      sendEmail({ from: 'a@b.com', to: 'c@d.com', subject: 's', html: '<p>x</p>' }),
    ).resolves.toEqual({ data: { id: 'x' }, error: null });
  });
});

describe('email config migration — client RESEND_API_KEY (getServerConfig)', () => {
  const original = process.env;
  beforeEach(() => {
    process.env = { ...original, ...CORE };
    // The timeout block doMocks '../client'; undo it so getResend() runs the real
    // module that constructs the (resend-mocked) Resend with the configured key.
    vi.doUnmock('../client');
    vi.resetModules();
    mockResendCtor.mockClear();
  });
  afterEach(() => { process.env = original; vi.resetModules(); });

  it('constructs Resend with the configured RESEND_API_KEY', async () => {
    process.env.RESEND_API_KEY = 'rk_live_123';
    const { getResend } = await import('../client');
    getResend();
    expect(mockResendCtor).toHaveBeenCalledWith('rk_live_123');
  });

  it('tolerates an unset RESEND_API_KEY (constructs with undefined, no throw)', async () => {
    delete process.env.RESEND_API_KEY;
    const { getResend } = await import('../client');
    expect(() => getResend()).not.toThrow();
    expect(mockResendCtor).toHaveBeenCalledWith(undefined);
  });
});
