// src/app/api/admin/channels/telegram/__tests__/start.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted so vi.mock factory can reference the shared queue + consumer.
const { sqlQueue, consume, mockRequireRole, mockRequireCurrentAal2FromSupabase } = vi.hoisted(() => {
  const q: unknown[] = [];
  const c = async () => {
    const next = q.shift();
    return Array.isArray(next) ? next : [];
  };
  return {
    sqlQueue: q,
    consume: c,
    mockRequireRole: vi.fn(),
    mockRequireCurrentAal2FromSupabase: vi.fn(),
  };
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
  requireRole: mockRequireRole,
  cookieBackedServerClient: () => ({ auth: { mfa: {} } }),
  AuthError: class AuthError extends Error {
    constructor(message: string, public readonly statusCode: number) {
      super(message);
    }
  },
}));

vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn(() => ({ auth: { mfa: {} } })),
}));

vi.mock('@/lib/auth/mfa', () => ({
  requireCurrentAal2FromSupabase: mockRequireCurrentAal2FromSupabase,
}));

import { POST } from '../start/route';

const APP_URL = 'http://localhost';

process.env.NEXT_PUBLIC_APP_URL = APP_URL;
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://supabase.example.com';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key';

function mkReq(body: unknown, opts: { origin?: string | null } = {}) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  const origin = opts.origin === undefined ? APP_URL : opts.origin;
  if (origin !== null) headers.Origin = origin;

  return new Request('http://localhost/api/admin/channels/telegram/start', {
    method: 'POST',
    body: JSON.stringify(body),
    headers,
  });
}

beforeEach(() => {
  sqlQueue.length = 0;
  process.env.NEXT_PUBLIC_APP_URL = APP_URL;
  delete process.env.CHANNELS_TELEGRAM_ENABLED;
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_WEBHOOK_SECRET;
  delete process.env.TELEGRAM_BOT_USERNAME;
  process.env.MOCK_EXTERNAL_APIS = 'true'; // skip env readiness check in unit tests
  mockRequireRole.mockResolvedValue({ id: 'admin-1', role: 'admin' });
  mockRequireCurrentAal2FromSupabase.mockResolvedValue({ ok: true });
});

describe('POST /api/admin/channels/telegram/start', () => {
  it('returns 403 when Origin header is absent', async () => {
    process.env.CHANNELS_TELEGRAM_ENABLED = 'true';

    const res = await POST(mkReq({ businessId: 'biz-1' }, { origin: null }) as any);
    expect(res.status).toBe(403);
  });

  it('returns 403 when Origin does not match the app origin', async () => {
    process.env.CHANNELS_TELEGRAM_ENABLED = 'true';

    const res = await POST(mkReq({ businessId: 'biz-1' }, { origin: 'https://evil.example.com' }) as any);
    expect(res.status).toBe(403);
  });

  it('returns 403 when MFA step-up is not satisfied (AAL2)', async () => {
    process.env.CHANNELS_TELEGRAM_ENABLED = 'true';
    mockRequireCurrentAal2FromSupabase.mockResolvedValueOnce({ ok: false, reason: 'aal2_required' });
    const res = await POST(mkReq({ businessId: 'biz-1' }) as any);
    expect(res.status).toBe(403);
  });

  it('returns 404 when flag is off', async () => {
    const res = await POST(mkReq({ businessId: 'biz-1' }) as any);
    expect(res.status).toBe(404);
  });

  it('returns 503 when flag on but env missing (and not in mock mode)', async () => {
    process.env.CHANNELS_TELEGRAM_ENABLED = 'true';
    delete process.env.MOCK_EXTERNAL_APIS;
    const res = await POST(mkReq({ businessId: 'biz-1' }) as any);
    expect(res.status).toBe(503);
  });

  it('happy path: inserts pending enrollment and returns deepLink + qrDataUrl + expiresAt', async () => {
    process.env.CHANNELS_TELEGRAM_ENABLED = 'true';
    process.env.TELEGRAM_BOT_USERNAME = 'RepWorthBot';
    sqlQueue.push([{ id: 'acct-1', subscription_status: 'active' }]); // subscription check
    sqlQueue.push([]); // advisory lock
    sqlQueue.push([]); // SELECT existing enrollment (none)
    sqlQueue.push([]); // INSERT enrollment
    const res = await POST(mkReq({ businessId: 'biz-1' }) as any);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.deepLink).toMatch(/^https:\/\/t\.me\/RepWorthBot\?start=/);
    expect(json.qrDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(json.expiresAt).toBeDefined();
  });

  it('returns 409 when enrollment is already verified', async () => {
    process.env.CHANNELS_TELEGRAM_ENABLED = 'true';
    process.env.TELEGRAM_BOT_USERNAME = 'RepWorthBot';
    sqlQueue.push([{ id: 'acct-1', subscription_status: 'active' }]);
    sqlQueue.push([]);
    sqlQueue.push([{ id: 'enrl-1', status: 'verified' }]); // existing verified row
    const res = await POST(mkReq({ businessId: 'biz-1' }) as any);
    expect(res.status).toBe(409);
  });
});
