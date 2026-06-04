import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const {
  mockRequireRole,
  mockRequireCurrentAal2FromSupabase,
  mockWriteAccountAuditLog,
  mockSql,
  mockTx,
  txResults,
  txCalls,
} = vi.hoisted(() => {
  const txCalls: { text: string; values: unknown[] }[] = [];
  const txResults: unknown[] = [];
  const mockTx = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    txCalls.push({ text: strings.join('?'), values });
    return Promise.resolve(txResults.shift() ?? Object.assign([], { count: 1 }));
  });
  const mockSql: any = vi.fn(() => Promise.resolve([]));
  mockSql.begin = vi.fn(async (cb: (tx: typeof mockTx) => Promise<unknown>) => cb(mockTx));
  return {
    mockRequireRole: vi.fn(),
    mockRequireCurrentAal2FromSupabase: vi.fn(),
    mockWriteAccountAuditLog: vi.fn(),
    mockSql,
    mockTx,
    txResults,
    txCalls,
  };
});

vi.mock('@/lib/db/auth', () => ({
  requireRole: mockRequireRole,
  cookieBackedServerClient: () => ({ auth: { mfa: {} } }),
  AuthError: class AuthError extends Error {
    constructor(message: string, public readonly statusCode: number) {
      super(message);
    }
  },
}));
vi.mock('@/lib/db/server', () => ({ sql: mockSql, jsonb: (v: unknown) => ({ __jsonb: v }) }));
vi.mock('@supabase/ssr', () => ({ createServerClient: vi.fn(() => ({ auth: { mfa: {} } })) }));
vi.mock('@/lib/auth/mfa', () => ({ requireCurrentAal2FromSupabase: mockRequireCurrentAal2FromSupabase }));
vi.mock('@/lib/audit/log', () => ({ writeAccountAuditLog: mockWriteAccountAuditLog }));

process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com';
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://supabase.example.com';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key';

const BUSINESS_ID = '33333333-3333-4333-8333-333333333333';
const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const ADMIN_ID = '22222222-2222-4222-8222-222222222222';
const RESPONSE_ID = '44444444-4444-4444-8444-444444444444';

function req(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(
    `https://app.example.com/api/admin/businesses/${BUSINESS_ID}/zernio-queue`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://app.example.com', ...headers },
      body: JSON.stringify(body),
    },
  );
}
const ctx = { params: Promise.resolve({ id: BUSINESS_ID }) };

describe('POST /api/admin/businesses/[id]/zernio-queue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    txCalls.length = 0;
    txResults.length = 0;
    process.env.ZERNIO_PUBLISHING_ENABLED = 'true';
    mockRequireRole.mockResolvedValue({
      id: ADMIN_ID, role: 'admin', email: 'admin@example.com', name: 'Admin',
      accountId: null, locationId: null,
    });
    mockRequireCurrentAal2FromSupabase.mockResolvedValue({ ok: true });
    mockWriteAccountAuditLog.mockResolvedValue(undefined);
  });

  it('rejects non-admin, missing AAL2, and bad bodies', async () => {
    const { AuthError } = await import('@/lib/db/auth');
    const { POST } = await import('../route');

    mockRequireRole.mockRejectedValueOnce(new AuthError('Forbidden', 403));
    expect((await POST(req({ action: 'force_drain' }), ctx)).status).toBe(403);

    mockRequireCurrentAal2FromSupabase.mockResolvedValueOnce({ ok: false, reason: 'mfa_required' });
    expect((await POST(req({ action: 'force_drain' }), ctx)).status).toBe(403);

    expect((await POST(req({ action: 'nonsense' }), ctx)).status).toBe(400);
  });

  it('returns 503 when ZERNIO_PUBLISHING_ENABLED is off (force_drain only)', async () => {
    process.env.ZERNIO_PUBLISHING_ENABLED = 'false';
    const { POST } = await import('../route');
    const res = await POST(req({ action: 'force_drain' }), ctx);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'feature_disabled' });
  });

  it('409 connection_not_active when no active connection', async () => {
    txResults.push([]); // connection select → none
    const { POST } = await import('../route');
    const res = await POST(req({ action: 'force_drain' }), ctx);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'connection_not_active' });
  });

  it('409 connection_not_active when the connection is pending (not active)', async () => {
    txResults.push([{ status: 'pending', account_id: ACCOUNT_ID }]); // present but not active
    const { POST } = await import('../route');
    const res = await POST(req({ action: 'force_drain' }), ctx);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'connection_not_active' });
  });

  it('409 queue_empty when nothing is parked', async () => {
    txResults.push([{ status: 'active', account_id: ACCOUNT_ID }]); // connection
    txResults.push([{ stuck_count: 0 }]); // count
    const { POST } = await import('../route');
    const res = await POST(req({ action: 'force_drain' }), ctx);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'queue_empty' });
  });

  it('force_drain enqueues a drain outbox row + audit, returns queued count', async () => {
    txResults.push([{ status: 'active', account_id: ACCOUNT_ID }]); // connection
    txResults.push([{ stuck_count: 2 }]); // count
    txResults.push(Object.assign([], { count: 1 })); // outbox insert
    const { POST } = await import('../route');
    const res = await POST(req({ action: 'force_drain' }), ctx);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, action: 'force_drain', queued: 2 });
    expect(txCalls.some((c) => /drain_pending_owner_connect/.test(c.text))).toBe(true);
    expect(mockWriteAccountAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: ACCOUNT_ID,
        actorUserId: ADMIN_ID,
        eventType: 'zernio_queue_force_drained',
        entityType: 'business',
        entityId: BUSINESS_ID,
        payload: { stuck_count: 2 },
      }),
      mockTx,
    );
  });

  it('dismiss supersedes a parked response + audit', async () => {
    txResults.push([{ id: RESPONSE_ID, account_id: ACCOUNT_ID }]); // select FOR UPDATE
    txResults.push(Object.assign([], { count: 1 })); // update
    const { POST } = await import('../route');
    const res = await POST(req({ action: 'dismiss', responseId: RESPONSE_ID }), ctx);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, action: 'dismiss' });
    expect(txCalls.some((c) => /SET status = 'superseded'/.test(c.text))).toBe(true);
    expect(txCalls.some((c) => /admin_dismissed_awaiting_connect/.test(c.values.join(' ') + c.text))).toBe(
      true,
    );
    expect(mockWriteAccountAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: ACCOUNT_ID,
        actorUserId: ADMIN_ID,
        eventType: 'zernio_queue_response_dismissed',
        entityType: 'response',
        entityId: RESPONSE_ID,
        payload: { business_id: BUSINESS_ID },
      }),
      mockTx,
    );
  });

  it('409 not_awaiting when the response is not parked / wrong business', async () => {
    txResults.push([]); // select FOR UPDATE → none
    const { POST } = await import('../route');
    const res = await POST(req({ action: 'dismiss', responseId: RESPONSE_ID }), ctx);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'not_awaiting' });
  });

  it('dismiss is NOT gated by ZERNIO_PUBLISHING_ENABLED', async () => {
    process.env.ZERNIO_PUBLISHING_ENABLED = 'false';
    txResults.push([{ id: RESPONSE_ID, account_id: ACCOUNT_ID }]);
    txResults.push(Object.assign([], { count: 1 }));
    const { POST } = await import('../route');
    const res = await POST(req({ action: 'dismiss', responseId: RESPONSE_ID }), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, action: 'dismiss' });
  });

  it('400 when dismiss is missing responseId', async () => {
    const { POST } = await import('../route');
    expect((await POST(req({ action: 'dismiss' }), ctx)).status).toBe(400);
  });
});
