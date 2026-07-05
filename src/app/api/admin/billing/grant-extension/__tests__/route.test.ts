import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const {
  mockRequireRole,
  mockRequireCurrentAal2FromSupabase,
  mockWriteAccountAuditLog,
  mockSql,
  mockTx,
  txResults,
  sqlCalls,
  txCalls,
} = vi.hoisted(() => {
  const sqlCalls: { text: string; values: unknown[] }[] = [];
  const txCalls: { text: string; values: unknown[] }[] = [];
  const txResults: unknown[] = [];

  const mockTx = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    txCalls.push({ text: strings.join('?'), values });
    return Promise.resolve(txResults.shift() ?? Object.assign([], { count: 1 }));
  });

  const mockSql: any = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    sqlCalls.push({ text: strings.join('?'), values });
    return Promise.resolve(Object.assign([], { count: 1 }));
  });
  mockSql.begin = vi.fn(async (cb: (tx: typeof mockTx) => Promise<void>) => cb(mockTx));

  return {
    mockRequireRole: vi.fn(),
    mockRequireCurrentAal2FromSupabase: vi.fn(),
    mockWriteAccountAuditLog: vi.fn(),
    mockSql,
    mockTx,
    txResults,
    sqlCalls,
    txCalls,
  };
});

vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn(() => ({ auth: { mfa: {} } })),
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

vi.mock('@/lib/auth/mfa', () => ({
  requireCurrentAal2FromSupabase: mockRequireCurrentAal2FromSupabase,
}));

vi.mock('@/lib/audit/log', () => ({
  writeAccountAuditLog: mockWriteAccountAuditLog,
}));

vi.mock('@/lib/db/server', () => ({
  sql: mockSql,
  jsonb: (value: unknown) => ({ __jsonb: value }),
}));

process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com';
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://supabase.example.com';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key';

const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const ADMIN_ID = '22222222-2222-4222-8222-222222222222';

function req(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('https://app.example.com/api/admin/billing/grant-extension', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'https://app.example.com',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe('POST /api/admin/billing/grant-extension', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sqlCalls.length = 0;
    txCalls.length = 0;
    txResults.length = 0;
    txResults.push(
      [{ past_due_at: '2026-05-20T12:00:00.000Z' }],
      Object.assign([], { count: 1 }),
    );
    mockRequireRole.mockResolvedValue({
      id: ADMIN_ID,
      role: 'admin',
      email: 'admin@example.com',
      name: 'Admin',
      accountId: null,
      locationId: null,
    });
    mockRequireCurrentAal2FromSupabase.mockResolvedValue({ ok: true });
    mockWriteAccountAuditLog.mockResolvedValue(undefined);
  });

  it('requires admin role, AAL2, ticket id, and reason', async () => {
    const { AuthError } = await import('@/lib/db/auth');
    const { POST } = await import('../route');

    mockRequireRole.mockRejectedValueOnce(new AuthError('Forbidden', 403));
    const roleRes = await POST(req({
      accountId: ACCOUNT_ID,
      days: 3,
      ticketId: 'SUP-123',
      reason: 'Owner needs time to update card.',
    }));
    expect(roleRes.status).toBe(403);

    mockRequireRole.mockResolvedValue({
      id: ADMIN_ID,
      role: 'admin',
      email: 'admin@example.com',
      name: 'Admin',
      accountId: null,
      locationId: null,
    });
    mockRequireCurrentAal2FromSupabase.mockResolvedValueOnce({ ok: false, reason: 'mfa_required' });
    const aalRes = await POST(req({
      accountId: ACCOUNT_ID,
      days: 3,
      ticketId: 'SUP-123',
      reason: 'Owner needs time to update card.',
    }));
    expect(aalRes.status).toBe(403);
    expect(await aalRes.json()).toEqual({ error: 'mfa_required' });

    mockRequireCurrentAal2FromSupabase.mockResolvedValue({ ok: true });
    const missingTicketRes = await POST(req({
      accountId: ACCOUNT_ID,
      days: 3,
      reason: 'Owner needs time to update card.',
    }));
    expect(missingTicketRes.status).toBe(400);

    const missingReasonRes = await POST(req({
      accountId: ACCOUNT_ID,
      days: 3,
      ticketId: 'SUP-123',
      reason: '',
    }));
    expect(missingReasonRes.status).toBe(400);
  });

  it('updates accounts.flags.past_due_extension and writes account_audit_log in one transaction', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-26T12:00:00.000Z'));
    const { POST } = await import('../route');

    const res = await POST(req({
      accountId: ACCOUNT_ID,
      days: 3,
      ticketId: 'SUP-123',
      reason: 'Owner needs time to update card.',
    }));

    expect(res.status).toBe(200);
    // expires_at is the actual extended read-only cutoff: past_due_at + 7d grace
    // + 3 extension days = 2026-05-20 + 10d = 2026-05-30. (NOT now + days, which
    // would expire the extension before it ever took effect.)
    expect(await res.json()).toEqual({
      ok: true,
      extension: {
        days: 3,
        expires_at: '2026-05-30T12:00:00.000Z',
      },
    });
    expect(mockSql.begin).toHaveBeenCalledTimes(1);
    expect(txCalls).toHaveLength(2);
    expect(txCalls[0]!.text).toMatch(/SELECT past_due_at/i);
    expect(txCalls[0]!.text).toMatch(/FOR UPDATE/i);
    expect(txCalls[1]!.text).toMatch(/UPDATE accounts/i);
    expect(txCalls[1]!.text).toMatch(/jsonb_set/i);
    expect(txCalls[1]!.text).toMatch(/past_due_extension/i);
    expect(txCalls[1]!.text).toMatch(/subscription_status = 'past_due'/i);
    expect(txCalls[1]!.values).toContain(ACCOUNT_ID);
    expect(txCalls[1]!.values).toContainEqual({
      __jsonb: {
        granted_at: '2026-05-26T12:00:00.000Z',
        granted_by_user_id: ADMIN_ID,
        days: 3,
        reason: 'Owner needs time to update card.',
        ticket_id: 'SUP-123',
        expires_at: '2026-05-30T12:00:00.000Z',
      },
    });
    expect(mockWriteAccountAuditLog).toHaveBeenCalledWith(
      mockTx,
      {
        accountId: ACCOUNT_ID,
        actorUserId: ADMIN_ID,
        eventType: 'past_due_extension_granted',
        entityType: 'account',
        entityId: ACCOUNT_ID,
        payload: {
          days: 3,
          reason: 'Owner needs time to update card.',
          ticket_id: 'SUP-123',
          expires_at: '2026-05-30T12:00:00.000Z',
        },
      },
    );
    expect(sqlCalls).toHaveLength(0);
    vi.useRealTimers();
  });

  it('grants real added time for an already-locked-out account (>7 days past due)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-26T12:00:00.000Z'));
    // past_due 11 days ago: grace deadline (T+7) is already in the past.
    txResults.length = 0;
    txResults.push(
      [{ past_due_at: '2026-05-15T12:00:00.000Z' }],
      Object.assign([], { count: 1 }),
    );
    const { POST } = await import('../route');

    const res = await POST(req({
      accountId: ACCOUNT_ID,
      days: 3,
      ticketId: 'SUP-123',
      reason: 'Locked out, replacing card.',
    }));

    expect(res.status).toBe(200);
    // Must extend from now (not the stale grace deadline): now + 3 days = 2026-05-29.
    // The old past_due_at-anchored formula yielded 2026-05-25 (in the past), which
    // parseExtension discards — leaving the customer read-only despite "granted".
    expect(await res.json()).toEqual({
      ok: true,
      extension: { days: 3, expires_at: '2026-05-29T12:00:00.000Z' },
    });
    vi.useRealTimers();
  });

  it('a max 7-day grant on a fresh past_due account yields ~14 days total (deep-scan §6.3 additive ceiling)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-26T12:00:00.000Z'));
    // Fresh past_due (== now): grace deadline is now + 7d; an additional +7 anchors
    // to that deadline → 14 days total from past_due. This pins the chosen ADDITIVE
    // semantics (NOT extend-to-N-total) and the documented up-to-14 ceiling.
    txResults.length = 0;
    txResults.push(
      [{ past_due_at: '2026-05-26T12:00:00.000Z' }],
      Object.assign([], { count: 1 }),
    );
    const { POST } = await import('../route');

    const res = await POST(req({
      accountId: ACCOUNT_ID,
      days: 7,
      ticketId: 'SUP-999',
      reason: 'Max grant on a fresh past_due account.',
    }));

    expect(res.status).toBe(200);
    // max(past_due_at + 7d, now) + 7d = 2026-06-02 + 7d = 2026-06-09 = past_due_at + 14d.
    expect(await res.json()).toEqual({
      ok: true,
      extension: { days: 7, expires_at: '2026-06-09T12:00:00.000Z' },
    });
    vi.useRealTimers();
  });

  it('rejects accounts missing past_due_at because the extension would not be honored', async () => {
    const { POST } = await import('../route');
    txResults.length = 0;
    txResults.push([{ past_due_at: null }]);

    const res = await POST(req({
      accountId: ACCOUNT_ID,
      days: 3,
      ticketId: 'SUP-123',
      reason: 'Owner needs time to update card.',
    }));

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'past_due_at_missing' });
    expect(mockWriteAccountAuditLog).not.toHaveBeenCalled();
  });

  it('rejects extension over 7 days by default', async () => {
    const { POST } = await import('../route');

    const res = await POST(req({
      accountId: ACCOUNT_ID,
      days: 8,
      ticketId: 'SUP-123',
      reason: 'Too long.',
    }));

    expect(res.status).toBe(400);
    expect(mockSql.begin).not.toHaveBeenCalled();
    expect(mockWriteAccountAuditLog).not.toHaveBeenCalled();
  });
});
