import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSql, sqlReturnQueue, sqlCalls, resetMockSql, mockRequireRole, mockRequireCurrentAal2FromSupabase } = await vi.hoisted(async () => {
  const { createMockSql } = await import('../../../../../../../worker/__tests__/helpers/mock-sql');
  return {
    ...createMockSql(),
    mockRequireRole: vi.fn(),
    mockRequireCurrentAal2FromSupabase: vi.fn(),
  };
});
// The route delegates to disconnectChannel, which opens sql.begin; the mock tx
// shares the same tagged-template fn so every UPDATE/audit INSERT is captured
// in sqlCalls and pulls from sqlReturnQueue in order.
vi.mock('@/lib/db/server', () => ({ sql: mockSql, jsonb: (v: unknown) => v }));

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

vi.mock('@/lib/db/redis-cache', () => ({
  getCacheRedis: () => ({
    keys: vi.fn(async () => []),
    del: vi.fn(async () => 0),
  }),
}));

import { POST } from '../disable/route';

const APP_URL = 'http://localhost';

process.env.NEXT_PUBLIC_APP_URL = APP_URL;
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://supabase.example.com';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key';

function mkReq(body: unknown) {
  return new Request('http://localhost/api/admin/channels/whatsapp/disable', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', Origin: APP_URL },
  });
}

beforeEach(() => {
  resetMockSql();
  process.env.NEXT_PUBLIC_APP_URL = APP_URL;
  delete process.env.CHANNELS_WHATSAPP_ENABLED;
  delete process.env.TWILIO_ACCOUNT_SID;
  delete process.env.TWILIO_AUTH_TOKEN;
  delete process.env.TWILIO_WHATSAPP_NUMBER;
  delete process.env.WHATSAPP_APPROVAL_TEMPLATE_SID;
  delete process.env.WHATSAPP_APPROVAL_URL_BASE;
  process.env.MOCK_EXTERNAL_APIS = 'true';
  mockRequireRole.mockResolvedValue({ id: 'admin-1', role: 'admin' });
  mockRequireCurrentAal2FromSupabase.mockResolvedValue({ ok: true });
});

describe('POST /api/admin/channels/whatsapp/disable', () => {
  it('returns 404 when flag is off', async () => {
    const res = await POST(mkReq({ businessId: 'biz-1' }) as any);
    expect(res.status).toBe(404);
  });

  it('returns 403 when MFA step-up is not satisfied (AAL2)', async () => {
    process.env.CHANNELS_WHATSAPP_ENABLED = 'true';
    mockRequireCurrentAal2FromSupabase.mockResolvedValueOnce({ ok: false, reason: 'aal2_required' });
    const res = await POST(mkReq({ businessId: 'biz-1' }) as any);
    expect(res.status).toBe(403);
  });

  it('flips verified → disabled (account-scoped) and returns 200', async () => {
    process.env.CHANNELS_WHATSAPP_ENABLED = 'true';
    sqlReturnQueue.push([{ account_id: 'acct-1' }]); // businesses → account_id lookup
    sqlReturnQueue.push([{ id: 'enrl-1' }]); // org-default UPDATE RETURNING
    sqlReturnQueue.push([]); // override cascade UPDATE
    const res = await POST(mkReq({ businessId: 'biz-1' }) as any);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);

    // Guard: the disable UPDATE must key by account_id (acct-1) + org-default
    // scope, NOT the legacy business_id. Reverting to business_id fails here.
    const disableUpdate = sqlCalls.find(
      (c) => c.text.includes('UPDATE channel_enrollments') && c.text.includes("status = 'verified'"),
    );
    expect(disableUpdate).toBeDefined();
    expect(disableUpdate!.text).toMatch(/account_id = /);
    expect(disableUpdate!.text).toMatch(/location_id IS NULL/);
    expect(disableUpdate!.text).not.toMatch(/business_id = /);
    expect(disableUpdate!.values).toContain('acct-1');
  });

  it('returns 404 when no verified row and no live override matches', async () => {
    process.env.CHANNELS_WHATSAPP_ENABLED = 'true';
    sqlReturnQueue.push([{ account_id: 'acct-1' }]); // businesses → account_id lookup
    sqlReturnQueue.push([]); // org-default UPDATE matches nothing
    sqlReturnQueue.push([]); // override cascade UPDATE matches nothing
    const res = await POST(mkReq({ businessId: 'biz-1' }) as any);
    expect(res.status).toBe(404);
  });

  it('returns 404 when the business does not exist', async () => {
    process.env.CHANNELS_WHATSAPP_ENABLED = 'true';
    sqlReturnQueue.push([]); // businesses → account_id lookup returns nothing
    const res = await POST(mkReq({ businessId: 'biz-1' }) as any);
    expect(res.status).toBe(404);
  });
});
