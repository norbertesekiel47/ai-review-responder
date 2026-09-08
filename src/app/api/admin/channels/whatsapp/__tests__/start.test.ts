// src/app/api/admin/channels/whatsapp/__tests__/start.test.ts
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
  // #1183: the admin gate maps a resolved identity to its users row instead of
  // calling requireRole. Reuse the outcome resolveDualModeIdentity already
  // produced rather than invoking mockRequireRole a second time — a `...Once`
  // control would be consumed by the seam, and the second call would fall through
  // to the beforeEach default, silently turning a 403 case into a success.
  loadAppUser: async () => {
    const last = mockRequireRole.mock.results.at(-1);
    if (!last) return null;
    try {
      return await last.value;
    } catch {
      return null;
    }
  },
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

// #1183: the admin gate reads its identity through the Admin transport seam. This
// shim keeps the suite's existing controls meaningful — mockRequireRole still says
// whether there is a live admin, and mockRequireCurrentAal2FromSupabase still says
// whether the AAL2 step-up passed.
vi.mock('@/lib/auth/verified-identity', () => ({
  resolveDualModeIdentity: async (request: unknown) => {
    try {
      await mockRequireRole(request, 'admin');
    } catch (err) {
      const status = (err as { statusCode?: number } | null)?.statusCode;
      if (status === 401) return null; // no live credential → the gate's 401
      if (status !== 403) throw err; // a real fault → the gate's 500
      // 403 is "authenticated but not an admin"; loadAppUser reports that.
    }
    const aal = await mockRequireCurrentAal2FromSupabase();
    return {
      authUserId: 'auth-1',
      aal: aal?.ok ? 'aal2' : aal?.reason === 'mfa_check_failed' ? null : 'aal1',
      transport: 'cookie',
    };
  },
}));

vi.mock('qrcode', () => ({
  default: { toDataURL: vi.fn(async () => 'data:image/png;base64,TEST') },
}));

import { POST } from '../start/route';
import { resetServerConfigForTests } from '@/lib/config/server';

const APP_URL = 'http://localhost';

process.env.NEXT_PUBLIC_APP_URL = APP_URL;
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://supabase.example.com';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key';

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
  mockRequireRole.mockResolvedValue({ id: 'admin-1', role: 'admin' });
  mockRequireCurrentAal2FromSupabase.mockResolvedValue({ ok: true });
  // Migrated read: buildWhatsAppDeepLink now reads TWILIO_WHATSAPP_NUMBER via the
  // memoized getServerConfig(). Each test sets the number in its body BEFORE POST,
  // so clearing the memo here lets the first getServerConfig() in POST re-parse this
  // test's env (#6/#7).
  resetServerConfigForTests();
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

  it('returns 403 when MFA step-up is not satisfied (AAL2)', async () => {
    process.env.CHANNELS_WHATSAPP_ENABLED = 'true';
    mockRequireCurrentAal2FromSupabase.mockResolvedValueOnce({ ok: false, reason: 'aal2_required' });
    const res = await POST(mkReq({ businessId: 'biz-1' }) as any);
    expect(res.status).toBe(403);
  });

  it('returns 401 when auth fails', async () => {
    process.env.CHANNELS_WHATSAPP_ENABLED = 'true';
    const { AuthError } = await import('@/lib/db/auth');
    const AuthErrorClass = AuthError as unknown as new (msg: string, status: number) => Error & { statusCode: number };
    mockRequireRole.mockRejectedValueOnce(
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
    sqlQueue.push([{ id: 'acct-1', subscription_status: 'past_due' }]);
    const res = await POST(mkReq({ businessId: 'biz-1' }) as any);
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe('subscription_not_active');
  });

  it('happy path: inserts pending enrollment and returns deepLink + qrDataUrl + expiresAt', async () => {
    process.env.CHANNELS_WHATSAPP_ENABLED = 'true';
    process.env.TWILIO_WHATSAPP_NUMBER = 'whatsapp:+14155238886';
    sqlQueue.push([{ id: 'acct-1', subscription_status: 'active' }]); // subscription check
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
    sqlQueue.push([{ id: 'acct-1', subscription_status: 'active' }]);
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
    sqlQueue.push([{ id: 'acct-1', subscription_status: 'active' }]);
    sqlQueue.push([]);
    sqlQueue.push([]);
    sqlQueue.push([]);
    const res = await POST(mkReq({ businessId: 'biz-1' }) as any);
    expect(res.headers.get('Cache-Control')).toBe('no-store, private');
  });

  it('returns 409 when enrollment is already verified', async () => {
    process.env.CHANNELS_WHATSAPP_ENABLED = 'true';
    process.env.TWILIO_WHATSAPP_NUMBER = 'whatsapp:+14155238886';
    sqlQueue.push([{ id: 'acct-1', subscription_status: 'active' }]);
    sqlQueue.push([]); // advisory lock
    sqlQueue.push([{ id: 'enrl-1', status: 'verified' }]); // existing verified row
    const res = await POST(mkReq({ businessId: 'biz-1' }) as any);
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe('already_verified');
  });
});
