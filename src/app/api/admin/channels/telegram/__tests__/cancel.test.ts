import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sqlQueue, mockSql, mockRequireRole, mockRequireCurrentAal2FromSupabase } = vi.hoisted(() => {
  const sqlQueue: unknown[] = [];
  const mockSql: any = vi.fn(async () => {
    const next = sqlQueue.shift();
    return Array.isArray(next) ? next : [];
  });
  mockSql.begin = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(mockSql));
  return {
    sqlQueue,
    mockSql,
    mockRequireRole: vi.fn(),
    mockRequireCurrentAal2FromSupabase: vi.fn(),
  };
});

vi.mock('@/lib/db/server', () => ({ sql: mockSql, jsonb: (v: unknown) => v }));

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

import { POST } from '../cancel/route';

const APP_URL = 'http://localhost';

process.env.NEXT_PUBLIC_APP_URL = APP_URL;
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://supabase.example.com';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key';

function mkReq(body: unknown) {
  return new Request('http://localhost/api/admin/channels/telegram/cancel', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', Origin: APP_URL },
  });
}

beforeEach(() => {
  sqlQueue.length = 0;
  process.env.NEXT_PUBLIC_APP_URL = APP_URL;
  delete process.env.CHANNELS_TELEGRAM_ENABLED;
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_WEBHOOK_SECRET;
  process.env.MOCK_EXTERNAL_APIS = 'true';
  mockRequireRole.mockResolvedValue({ id: 'admin-1', role: 'admin' });
  mockRequireCurrentAal2FromSupabase.mockResolvedValue({ ok: true });
});

describe('POST /api/admin/channels/telegram/cancel', () => {
  it('returns 404 when flag is off', async () => {
    const res = await POST(mkReq({ businessId: 'biz-1' }) as any);
    expect(res.status).toBe(404);
  });

  it('returns 403 when MFA step-up is not satisfied (AAL2)', async () => {
    process.env.CHANNELS_TELEGRAM_ENABLED = 'true';
    mockRequireCurrentAal2FromSupabase.mockResolvedValueOnce({ ok: false, reason: 'aal2_required' });
    const res = await POST(mkReq({ businessId: 'biz-1' }) as any);
    expect(res.status).toBe(403);
  });

  it('clears verification hash + expiry on pending row and returns 200', async () => {
    process.env.CHANNELS_TELEGRAM_ENABLED = 'true';
    // Seeds the accounts join (SELECT a.id, a.subscription_status FROM accounts a
    // JOIN businesses b ...) that resolveAdminActor issues. Before the channel-route
    // unification the resolver was SELECT account_id FROM businesses, so this row
    // read `account_id`. Same value in prod either way (b.account_id = a.id); only
    // the projected column name changed. Matches what the start suites already seed.
    sqlQueue.push([{ id: 'acct-1', subscription_status: 'active' }]);
    // sql.begin callback fires: advisory lock SELECT + UPDATE
    sqlQueue.push([]); // pg_advisory_xact_lock
    sqlQueue.push([]); // UPDATE ... WHERE status='pending_verification'
    const res = await POST(mkReq({ businessId: 'biz-1' }) as any);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
  });
});
