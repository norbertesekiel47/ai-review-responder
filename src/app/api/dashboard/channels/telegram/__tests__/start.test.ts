import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sqlQueue, consume } = vi.hoisted(() => {
  const q: unknown[] = [];
  const c = async () => {
    const next = q.shift();
    return Array.isArray(next) ? next : [];
  };
  return { sqlQueue: q, consume: c };
});

vi.mock('@/lib/db/server', () => ({
  sql: Object.assign(consume, { begin: async (fn: (tx: unknown) => Promise<unknown>) => fn(consume) }),
  jsonb: (v: unknown) => v,
}));

const requireRoleMock = vi.fn(async () => ({ userId: 'owner-1', role: 'owner', locationId: 'biz-1' }));
vi.mock('@/lib/db/auth', () => ({
  requireRole: (...a: unknown[]) => requireRoleMock(...(a as [])),
  AuthError: class extends Error { statusCode = 401; },
}));
vi.mock('@/lib/auth/route-helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/route-helpers')>();
  return { ...actual, withSameOrigin: () => (h: unknown) => h };
});
vi.mock('@/lib/notifications/resolve-channels', () => ({ safeInvalidateChannelCache: vi.fn(async () => {}) }));
vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn(async () => 'data:image/png;base64,TEST') } }));

const startMobileEnrollmentMock = vi.fn<() => Promise<{ kind: string }>>();
vi.mock('@/lib/channels/mobile-enrollment', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/channels/mobile-enrollment')>();
  return {
    ...real,
    startMobileEnrollment: (...a: unknown[]) => startMobileEnrollmentMock(...(a as [])),
  };
});

import { POST } from '../start/route';
import { MultipleMobileChannelsError } from '@/lib/channels/unique-violation';
import { resetServerConfigForTests } from '@/lib/config/server';

const APP_URL = 'http://localhost';
function mkReq() {
  return new Request('http://localhost/api/dashboard/channels/telegram/start', {
    method: 'POST', body: JSON.stringify({}), headers: { 'Content-Type': 'application/json', Origin: APP_URL },
  });
}

beforeEach(() => {
  sqlQueue.length = 0;
  requireRoleMock.mockResolvedValue({ userId: 'owner-1', role: 'owner', locationId: 'biz-1' });
  startMobileEnrollmentMock.mockResolvedValue({ kind: 'ok' });
  process.env.NEXT_PUBLIC_APP_URL = APP_URL;
  process.env.MOCK_EXTERNAL_APIS = 'true';
  delete process.env.CHANNELS_TELEGRAM_ENABLED;
  delete process.env.TELEGRAM_BOT_USERNAME;
  // Migrated read: the t.me deep link now reads TELEGRAM_BOT_USERNAME via the
  // memoized getServerConfig(). Each test sets/clears the var in its body BEFORE
  // POST, so clearing the memo here lets the first getServerConfig() in POST
  // re-parse this test's env (#6/#7).
  resetServerConfigForTests();
});

describe('POST /api/dashboard/channels/telegram/start', () => {
  it('returns 404 when flag is off', async () => {
    const res = await POST(mkReq() as any);
    expect(res.status).toBe(404);
  });

  it('returns 401 when requireRole throws AuthError', async () => {
    process.env.CHANNELS_TELEGRAM_ENABLED = 'true';
    const { AuthError } = await import('@/lib/db/auth');
    requireRoleMock.mockRejectedValue(new AuthError('unauthorized', 401));
    const res = await POST(mkReq() as any);
    expect(res.status).toBe(401);
  });

  it('returns 409 multiple_mobile_channels when startMobileEnrollment throws MultipleMobileChannelsError', async () => {
    // Mobile-channel exclusivity (email + exactly ONE of telegram/whatsapp): a
    // 2nd mobile enroll hits the one_mobile_per_scope unique index (23505),
    // classified to MultipleMobileChannelsError, which this route maps to 409.
    // Mirrors the WhatsApp /start coverage so neither mobile channel can
    // regress the exclusivity contract.
    process.env.CHANNELS_TELEGRAM_ENABLED = 'true';
    sqlQueue.push([{ id: 'acct-1', subscription_status: 'active' }]); // accounts lookup
    startMobileEnrollmentMock.mockRejectedValue(new MultipleMobileChannelsError());
    const res = await POST(mkReq() as any);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('multiple_mobile_channels');
  });

  it('uses the configured TELEGRAM_BOT_USERNAME in the t.me deep link', async () => {
    process.env.CHANNELS_TELEGRAM_ENABLED = 'true';
    process.env.TELEGRAM_BOT_USERNAME = 'MyCustomBot';
    sqlQueue.push([{ id: 'acct-1', subscription_status: 'active' }]);
    startMobileEnrollmentMock.mockResolvedValue({ kind: 'ok' });
    const res = await POST(mkReq() as any);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deepLink).toMatch(/^https:\/\/t\.me\/MyCustomBot\?start=/);
    expect(body.qrDataUrl).toBe('data:image/png;base64,TEST');
  });

  it('falls back to RepWorthBot when TELEGRAM_BOT_USERNAME is blank/whitespace', async () => {
    // A whitespace-only env value must not produce a broken https://t.me/?start=
    // link — the `?.trim() || 'RepWorthBot'` fallback collapses it to the default.
    process.env.CHANNELS_TELEGRAM_ENABLED = 'true';
    process.env.TELEGRAM_BOT_USERNAME = '   ';
    sqlQueue.push([{ id: 'acct-1', subscription_status: 'active' }]);
    startMobileEnrollmentMock.mockResolvedValue({ kind: 'ok' });
    const res = await POST(mkReq() as any);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deepLink).toMatch(/^https:\/\/t\.me\/RepWorthBot\?start=/);
  });

  it('falls back to RepWorthBot when TELEGRAM_BOT_USERNAME is unset', async () => {
    process.env.CHANNELS_TELEGRAM_ENABLED = 'true';
    delete process.env.TELEGRAM_BOT_USERNAME;
    sqlQueue.push([{ id: 'acct-1', subscription_status: 'active' }]);
    startMobileEnrollmentMock.mockResolvedValue({ kind: 'ok' });
    const res = await POST(mkReq() as any);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deepLink).toMatch(/^https:\/\/t\.me\/RepWorthBot\?start=/);
  });
});
