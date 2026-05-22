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

import { POST } from '../start/route';

const APP_URL = 'http://localhost';
function mkReq() {
  return new Request('http://localhost/api/dashboard/channels/whatsapp/start', {
    method: 'POST', body: JSON.stringify({}), headers: { 'Content-Type': 'application/json', Origin: APP_URL },
  });
}

beforeEach(() => {
  sqlQueue.length = 0;
  requireRoleMock.mockResolvedValue({ userId: 'owner-1', role: 'owner', locationId: 'biz-1' });
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

  it('returns 403 when subscription is not active', async () => {
    process.env.CHANNELS_WHATSAPP_ENABLED = 'true';
    sqlQueue.push([{ id: 'acct-1', subscription_status: 'past_due' }]); // accounts lookup
    const res = await POST(mkReq() as any);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('subscription_not_active');
  });

  it('returns deepLink + qrDataUrl on success', async () => {
    process.env.CHANNELS_WHATSAPP_ENABLED = 'true';
    sqlQueue.push([{ id: 'acct-1', subscription_status: 'active' }]); // accounts lookup
    sqlQueue.push([]);          // advisory lock
    sqlQueue.push([]);          // SELECT FOR UPDATE (no existing row)
    sqlQueue.push([]);          // INSERT
    const res = await POST(mkReq() as any);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deepLink).toMatch(/^https:\/\/wa\.me\/15551230000\?text=start-/);
    expect(body.qrDataUrl).toBe('data:image/png;base64,TEST');
  });

  it('returns 409 already_verified when a verified row exists', async () => {
    process.env.CHANNELS_WHATSAPP_ENABLED = 'true';
    sqlQueue.push([{ id: 'acct-1', subscription_status: 'active' }]);
    sqlQueue.push([]);                                  // advisory lock
    sqlQueue.push([{ id: 'e1', status: 'verified' }]);  // SELECT FOR UPDATE
    const res = await POST(mkReq() as any);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('already_verified');
  });
});
