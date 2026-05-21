// src/app/api/admin/channels/whatsapp/__tests__/start.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted so vi.mock factory can reference the shared queue + consumer.
const { sqlQueue, consume } = vi.hoisted(() => {
  const q: unknown[] = [];
  const c = async () => {
    const next = q.shift();
    return Array.isArray(next) ? next : [];
  };
  return { sqlQueue: q, consume: c };
});

vi.mock('@/lib/db/server', () => ({
  // Bare sql() calls + tx calls inside sql.begin share the same queue so
  // fixtures read out in statement order regardless of tx boundaries.
  sql: Object.assign(consume, {
    begin: async (fn: (tx: unknown) => Promise<unknown>) => fn(consume),
  }),
  jsonb: (v: unknown) => v,
}));

vi.mock('@/lib/db/auth', () => ({
  requireRole: vi.fn(async () => ({ userId: 'admin-1', role: 'admin' })),
  AuthError: class extends Error {},
}));

vi.mock('qrcode', () => ({
  default: { toDataURL: vi.fn(async () => 'data:image/png;base64,TEST') },
}));

import { POST } from '../start/route';

const APP_URL = 'http://localhost';

function mkReq(body: unknown) {
  return new Request('http://localhost/api/admin/channels/whatsapp/start', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', Origin: APP_URL },
  });
}

beforeEach(() => {
  sqlQueue.length = 0;
  process.env.NEXT_PUBLIC_APP_URL = APP_URL;
  delete process.env.CHANNELS_WHATSAPP_ENABLED;
  delete process.env.TWILIO_WHATSAPP_NUMBER;
  delete process.env.TWILIO_ACCOUNT_SID;
  delete process.env.TWILIO_AUTH_TOKEN;
  delete process.env.WHATSAPP_APPROVAL_TEMPLATE_SID;
  delete process.env.WHATSAPP_APPROVAL_URL_BASE;
  process.env.MOCK_EXTERNAL_APIS = 'true'; // skip env readiness check in unit tests
});

describe('POST /api/admin/channels/whatsapp/start', () => {
  it('returns 404 when flag is off', async () => {
    const res = await POST(mkReq({ businessId: 'biz-1' }) as any);
    expect(res.status).toBe(404);
  });

  it('returns 503 when flag on but env missing (and not in mock mode)', async () => {
    process.env.CHANNELS_WHATSAPP_ENABLED = 'true';
    delete process.env.MOCK_EXTERNAL_APIS;
    const res = await POST(mkReq({ businessId: 'biz-1' }) as any);
    expect(res.status).toBe(503);
  });

  it('returns 401 when auth fails', async () => {
    process.env.CHANNELS_WHATSAPP_ENABLED = 'true';
    const { requireRole, AuthError } = await import('@/lib/db/auth');
    const AuthErrorClass = AuthError as unknown as new (msg: string, status: number) => Error & { statusCode: number };
    vi.mocked(requireRole).mockRejectedValueOnce(
      Object.assign(new AuthErrorClass('Unauthorized', 401), { statusCode: 401 }),
    );
    const res = await POST(mkReq({ businessId: 'biz-1' }) as any);
    expect(res.status).toBe(401);
  });

  it('returns 400 when businessId is missing', async () => {
    process.env.CHANNELS_WHATSAPP_ENABLED = 'true';
    const res = await POST(mkReq({}) as any);
    expect(res.status).toBe(400);
  });

  it('returns 404 when business does not exist', async () => {
    process.env.CHANNELS_WHATSAPP_ENABLED = 'true';
    sqlQueue.push([]); // no business row
    const res = await POST(mkReq({ businessId: 'biz-missing' }) as any);
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe('not_found');
  });

  it('returns 403 when subscription is not active', async () => {
    process.env.CHANNELS_WHATSAPP_ENABLED = 'true';
    sqlQueue.push([{ subscription_status: 'past_due' }]);
    const res = await POST(mkReq({ businessId: 'biz-1' }) as any);
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe('subscription_not_active');
  });

  it('happy path: inserts pending enrollment and returns deepLink + qrDataUrl + expiresAt', async () => {
    process.env.CHANNELS_WHATSAPP_ENABLED = 'true';
    process.env.TWILIO_WHATSAPP_NUMBER = 'whatsapp:+14155238886';
    sqlQueue.push([{ subscription_status: 'active' }]); // subscription check
    sqlQueue.push([]); // advisory lock
    sqlQueue.push([]); // SELECT existing enrollment (none)
    sqlQueue.push([]); // INSERT enrollment
    const res = await POST(mkReq({ businessId: 'biz-1' }) as any);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.deepLink).toMatch(/^https:\/\/wa\.me\/14155238886\?text=start-/);
    expect(json.qrDataUrl).toBe('data:image/png;base64,TEST');
    expect(json.expiresAt).toBeDefined();
  });

  it('deep link uses digits only (no + or whatsapp: prefix)', async () => {
    process.env.CHANNELS_WHATSAPP_ENABLED = 'true';
    process.env.TWILIO_WHATSAPP_NUMBER = 'whatsapp:+14155238886';
    sqlQueue.push([{ subscription_status: 'active' }]);
    sqlQueue.push([]);
    sqlQueue.push([]);
    sqlQueue.push([]);
    const res = await POST(mkReq({ businessId: 'biz-1' }) as any);
    expect(res.status).toBe(200);
    const { deepLink } = await res.json();
    // Must start with https://wa.me/<digits> — no + or whatsapp: in the number segment
    expect(deepLink).toMatch(/^https:\/\/wa\.me\/\d+\?text=/);
    expect(deepLink).not.toContain('+');
    expect(deepLink).not.toContain('whatsapp:');
  });

  it('returns Cache-Control: no-store, private on success', async () => {
    process.env.CHANNELS_WHATSAPP_ENABLED = 'true';
    process.env.TWILIO_WHATSAPP_NUMBER = 'whatsapp:+14155238886';
    sqlQueue.push([{ subscription_status: 'active' }]);
    sqlQueue.push([]);
    sqlQueue.push([]);
    sqlQueue.push([]);
    const res = await POST(mkReq({ businessId: 'biz-1' }) as any);
    expect(res.headers.get('Cache-Control')).toBe('no-store, private');
  });

  it('returns 409 when enrollment is already verified', async () => {
    process.env.CHANNELS_WHATSAPP_ENABLED = 'true';
    process.env.TWILIO_WHATSAPP_NUMBER = 'whatsapp:+14155238886';
    sqlQueue.push([{ subscription_status: 'active' }]);
    sqlQueue.push([]); // advisory lock
    sqlQueue.push([{ id: 'enrl-1', status: 'verified' }]); // existing verified row
    const res = await POST(mkReq({ businessId: 'biz-1' }) as any);
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe('already_verified');
  });
});
