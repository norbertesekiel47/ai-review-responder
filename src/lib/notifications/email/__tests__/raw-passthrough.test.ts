// Stage-3 convention #7 (raw-passthrough preservation): the 3 email reads that
// consume the env value WITHOUT call-site normalization (`internal.ts` from,
// `contact-notify.ts` emailConfigured, `client.ts` getResend) must see the RAW
// string — including whitespace-only/empty — exactly as the old `process.env.X`
// did. The server schema reads these vars via `rawOptionalVar` (faithful
// passthrough), NOT the collapsing `optionalVar` (which would turn '   ' into
// undefined and change behavior: a spurious throw, a dropped lead, or Resend(
// undefined) instead of Resend('   ')).
//
// These cases FAIL under the collapsing optionalVar and PASS under rawOptionalVar
// (the red->green that locks the preserved behavior). Uses the convention-#6
// set->resetModules->import pattern (getServerConfig memoizes).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// process.env.NODE_ENV is typed read-only (Next.js); assign through an index so
// the writable string index signature applies (mirrors contact-notify.test.ts).
function setEnv(key: string, value: string): void {
  process.env[key] = value;
}

const CORE = {
  NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon',
  NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
};

const { mockSend, mockResendCtor, mockSendInternalEmail } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  mockResendCtor: vi.fn(),
  mockSendInternalEmail: vi.fn(),
}));
vi.mock('resend', () => ({
  Resend: class {
    emails = { send: mockSend };
    constructor(apiKey?: string) {
      mockResendCtor(apiKey);
    }
  },
}));

describe('email raw-passthrough: whitespace-only RESEND_FROM_EMAIL (internal.ts)', () => {
  const original = process.env;
  beforeEach(() => {
    process.env = { ...original, ...CORE };
    vi.resetModules();
    mockSend.mockReset().mockResolvedValue({ data: { id: 'msg-x' }, error: null });
    // Non-mock so the real send path (not the mock short-circuit) is taken.
    vi.doMock('@/lib/shared/mock-mode', () => ({ isMockMode: () => false }));
  });
  afterEach(() => { process.env = original; vi.resetModules(); vi.doUnmock('@/lib/shared/mock-mode'); });

  it('does NOT throw — sends with the raw whitespace `from` (old truthy-string behavior)', async () => {
    process.env.RESEND_FROM_EMAIL = '   ';
    const { sendInternalEmail } = await import('../templates/internal');
    await expect(
      sendInternalEmail({ to: 'a@b.com', subject: 'S', bodyHtml: '<p>x</p>' }),
    ).resolves.toEqual({ messageId: 'msg-x' });
    // The raw whitespace string flowed through as the sender (NOT collapsed to
    // undefined, which would have thrown "RESEND_FROM_EMAIL not configured").
    const payload = mockSend.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload.from).toBe('   ');
  });
});

describe('email raw-passthrough: whitespace-only RESEND_API_KEY (contact-notify emailConfigured)', () => {
  const original = process.env;
  const KEYS = ['NODE_ENV', 'CONTACT_NOTIFY_TO', 'RESEND_FROM_EMAIL', 'RESEND_API_KEY'];

  beforeEach(() => {
    process.env = { ...original, ...CORE };
    for (const k of KEYS) delete process.env[k];
    setEnv('NODE_ENV', 'test');
    process.env.CONTACT_NOTIFY_TO = 'ops@example.com';
    vi.resetModules();
    vi.doMock('@/lib/shared/mock-mode', () => ({ isMockMode: () => false }));
    vi.doMock('../templates/internal', () => ({ sendInternalEmail: mockSendInternalEmail }));
    vi.doMock('@sentry/nextjs', () => ({ captureMessage: vi.fn() }));
    mockSendInternalEmail.mockReset().mockResolvedValue({ messageId: 'ok' });
  });
  afterEach(() => {
    process.env = original;
    vi.resetModules();
    vi.doUnmock('@/lib/shared/mock-mode');
    vi.doUnmock('../templates/internal');
    vi.doUnmock('@sentry/nextjs');
  });

  it('treats whitespace-only RESEND_API_KEY as configured — attempts delivery, not {sent:false}', async () => {
    process.env.RESEND_API_KEY = '   ';
    const { notifyContactSubmission } = await import('../../contact-notify');
    const r = await notifyContactSubmission({ subject: 'S', lines: ['a'] });
    // Old Boolean('   ') === true → sends. Collapsing to undefined would have
    // silently dropped the lead with { sent: false }.
    expect(r).toEqual({ sent: true });
    expect(mockSendInternalEmail).toHaveBeenCalledOnce();
  });
});

describe('email raw-passthrough: empty/whitespace RESEND_API_KEY (client getResend)', () => {
  const original = process.env;
  beforeEach(() => {
    process.env = { ...original, ...CORE };
    vi.resetModules();
    mockResendCtor.mockClear();
  });
  afterEach(() => { process.env = original; vi.resetModules(); });

  it('constructs Resend with the RAW empty string (not undefined)', async () => {
    process.env.RESEND_API_KEY = '';
    const { getResend } = await import('../client');
    getResend();
    expect(mockResendCtor).toHaveBeenCalledWith('');
  });

  it('constructs Resend with the RAW whitespace string (not undefined)', async () => {
    process.env.RESEND_API_KEY = '   ';
    const { getResend } = await import('../client');
    getResend();
    expect(mockResendCtor).toHaveBeenCalledWith('   ');
  });
});
