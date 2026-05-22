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
vi.mock('@/lib/auth/route-helpers', () => ({ withSameOrigin: () => (h: unknown) => h }));
vi.mock('@/lib/notifications/resolve-channels', () => ({ safeInvalidateChannelCache: vi.fn(async () => {}) }));
vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn(async () => 'data:image/png;base64,TEST') } }));

// Locations repo mock — default: single-location account (count=1).
const getActiveLocationCountMock = vi.fn(async () => 1);
vi.mock('@/lib/locations/repo', () => ({
  getActiveLocationCount: (...a: unknown[]) => getActiveLocationCountMock(...(a as [])),
}));

// WhatsApp enrollment mock — used only by the MultipleMobileChannelsError test.
const startWhatsAppEnrollmentMock = vi.fn<() => Promise<{ kind: string }>>();
vi.mock('@/lib/channels/whatsapp-enrollment', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/channels/whatsapp-enrollment')>();
  return {
    ...real,
    startWhatsAppEnrollment: (...a: unknown[]) => startWhatsAppEnrollmentMock(...(a as [])),
  };
});

import { POST } from '../start/route';
import { MultipleMobileChannelsError } from '@/lib/channels/unique-violation';

const APP_URL = 'http://localhost';
function mkReq() {
  return new Request('http://localhost/api/dashboard/channels/whatsapp/start', {
    method: 'POST', body: JSON.stringify({}), headers: { 'Content-Type': 'application/json', Origin: APP_URL },
  });
}

beforeEach(() => {
  sqlQueue.length = 0;
  requireRoleMock.mockResolvedValue({ userId: 'owner-1', role: 'owner', locationId: 'biz-1' });
  getActiveLocationCountMock.mockResolvedValue(1);
  startWhatsAppEnrollmentMock.mockResolvedValue({ kind: 'ok' });
  process.env.NEXT_PUBLIC_APP_URL = APP_URL;
  process.env.MOCK_EXTERNAL_APIS = 'true';
  process.env.TWILIO_WHATSAPP_NUMBER = 'whatsapp:+15551230000';
  delete process.env.CHANNELS_WHATSAPP_ENABLED;
});

describe('POST /api/dashboard/channels/whatsapp/start', () => {
  it('returns 404 when flag is off', async () => {
    const res = await POST(mkReq() as any);
    expect(res.status).toBe(404);
  });

  it('returns 503 when env is not ready (flag on, MOCK_EXTERNAL_APIS unset, required vars absent)', async () => {
    process.env.CHANNELS_WHATSAPP_ENABLED = 'true';
    delete process.env.MOCK_EXTERNAL_APIS;
    // Clear required WhatsApp env vars so assertWhatsAppEnvReady() fails.
    const vars = [
      'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_WHATSAPP_NUMBER',
      'TWILIO_VERIFY_SERVICE_SID',
    ];
    const saved: Record<string, string | undefined> = {};
    for (const v of vars) {
      saved[v] = process.env[v];
      delete process.env[v];
    }
    const res = await POST(mkReq() as any);
    expect(res.status).toBe(503);
    // Restore
    for (const v of vars) {
      if (saved[v] !== undefined) process.env[v] = saved[v];
    }
    process.env.MOCK_EXTERNAL_APIS = 'true';
  });

  it('returns 401 when requireRole throws AuthError', async () => {
    process.env.CHANNELS_WHATSAPP_ENABLED = 'true';
    const { AuthError } = await import('@/lib/db/auth');
    requireRoleMock.mockRejectedValue(Object.assign(new AuthError('unauthorized'), { statusCode: 401 }));
    const res = await POST(mkReq() as any);
    expect(res.status).toBe(401);
  });

  it('returns 403 when subscription is not active', async () => {
    process.env.CHANNELS_WHATSAPP_ENABLED = 'true';
    sqlQueue.push([{ id: 'acct-1', subscription_status: 'past_due' }]); // accounts lookup
    const res = await POST(mkReq() as any);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('subscription_not_active');
  });

  it('returns 403 multi_location_unsupported when account has >1 location', async () => {
    process.env.CHANNELS_WHATSAPP_ENABLED = 'true';
    sqlQueue.push([{ id: 'acct-1', subscription_status: 'active' }]); // accounts lookup
    getActiveLocationCountMock.mockResolvedValue(2);
    const res = await POST(mkReq() as any);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('multi_location_unsupported');
    // Enrollment helper must not have been invoked.
    expect(startWhatsAppEnrollmentMock).not.toHaveBeenCalled();
  });

  it('returns 409 multiple_mobile_channels when startWhatsAppEnrollment throws MultipleMobileChannelsError', async () => {
    process.env.CHANNELS_WHATSAPP_ENABLED = 'true';
    sqlQueue.push([{ id: 'acct-1', subscription_status: 'active' }]); // accounts lookup
    getActiveLocationCountMock.mockResolvedValue(1);
    startWhatsAppEnrollmentMock.mockRejectedValue(new MultipleMobileChannelsError());
    const res = await POST(mkReq() as any);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('multiple_mobile_channels');
  });

  it('returns deepLink + qrDataUrl on success', async () => {
    process.env.CHANNELS_WHATSAPP_ENABLED = 'true';
    sqlQueue.push([{ id: 'acct-1', subscription_status: 'active' }]); // accounts lookup
    sqlQueue.push([]);          // advisory lock
    sqlQueue.push([]);          // SELECT FOR UPDATE (no existing row)
    sqlQueue.push([]);          // INSERT
    startWhatsAppEnrollmentMock.mockResolvedValue({ kind: 'ok' });
    const res = await POST(mkReq() as any);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deepLink).toMatch(/^https:\/\/wa\.me\/15551230000\?text=start-/);
    expect(body.qrDataUrl).toBe('data:image/png;base64,TEST');
  });

  it('returns 409 already_verified when a verified row exists', async () => {
    process.env.CHANNELS_WHATSAPP_ENABLED = 'true';
    sqlQueue.push([{ id: 'acct-1', subscription_status: 'active' }]);
    startWhatsAppEnrollmentMock.mockResolvedValue({ kind: 'already_verified' });
    const res = await POST(mkReq() as any);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('already_verified');
  });
});
