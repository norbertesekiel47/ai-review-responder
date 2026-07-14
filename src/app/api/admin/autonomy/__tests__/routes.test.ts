import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockRequireRole,
  mockRequireCurrentAal2FromSupabase,
  mockListSuspendedPolicies,
  mockSql,
  sqlReturnQueue,
  sqlCalls,
  resetMockSql,
  mkTaggedResult,
} = await vi.hoisted(async () => {
  const helpers = await import('../../../../../../worker/__tests__/helpers/mock-sql');
  return {
    mockRequireRole: vi.fn(),
    mockRequireCurrentAal2FromSupabase: vi.fn(),
    mockListSuspendedPolicies: vi.fn(),
    ...helpers.createMockSql(),
    mkTaggedResult: helpers.mkTaggedResult,
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

vi.mock('@/lib/db/server', () => ({ sql: mockSql }));

vi.mock('@/lib/auto-approval/suspension', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auto-approval/suspension')>();
  return { ...actual, listSuspendedPolicies: mockListSuspendedPolicies };
});

process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com';
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://supabase.example.com';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key';

const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const ADMIN_ID = '22222222-2222-4222-8222-222222222222';

function getRequest(): NextRequest {
  return new NextRequest('https://app.example.com/api/admin/autonomy/suspensions');
}

function postRequest(body: unknown, origin = 'https://app.example.com'): NextRequest {
  return new NextRequest('https://app.example.com/api/admin/autonomy/unsuspend', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify(body),
  });
}

describe('admin autonomy routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMockSql();
    mockRequireRole.mockResolvedValue({
      id: ADMIN_ID,
      role: 'admin',
      email: 'admin@example.com',
      name: 'Admin',
      accountId: null,
      locationId: null,
    });
    mockRequireCurrentAal2FromSupabase.mockResolvedValue({ ok: true });
    mockListSuspendedPolicies.mockResolvedValue([]);
  });

  it('GET rejects non-admins before the cross-account list query', async () => {
    const { AuthError } = await import('@/lib/db/auth');
    const { GET } = await import('../suspensions/route');
    mockRequireRole.mockRejectedValueOnce(new AuthError('Forbidden', 403));

    const response = await GET(getRequest());

    expect(response.status).toBe(403);
    expect(mockListSuspendedPolicies).not.toHaveBeenCalled();
  });

  it('GET returns the bounded list shape after admin AAL2', async () => {
    const suspension = {
      policyId: 'policy-1',
      accountId: ACCOUNT_ID,
      accountName: 'Northstar Dental',
      locationId: null,
      locationName: null,
      scope: 'account' as const,
      suspendedReason: 'Safety review flag.',
      trigger: 'judge_flag' as const,
      suspendedAt: new Date('2026-07-13T12:00:00.000Z'),
      governorRates: {
        edit: { numerator: 1, denominator: 5, rate: 0.2 },
        veto: { numerator: 0, denominator: 5, rate: 0 },
        judgeSignal: { numerator: 1, denominator: 5, rate: 0.2 },
      },
      recentFlagVerdicts: [],
    };
    mockListSuspendedPolicies.mockResolvedValueOnce([suspension]);
    const { GET } = await import('../suspensions/route');

    const response = await GET(getRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      suspensions: [{ ...suspension, suspendedAt: '2026-07-13T12:00:00.000Z' }],
    });
    expect(response.headers.get('cache-control')).toBe('no-store, private');
    expect(mockListSuspendedPolicies).toHaveBeenCalledWith(mockSql);
  });

  it('POST requires same-origin admin AAL2 and a trimmed nonempty note', async () => {
    const { AuthError } = await import('@/lib/db/auth');
    const { POST } = await import('../unsuspend/route');

    const csrfResponse = await POST(postRequest({ accountId: ACCOUNT_ID, note: 'Reviewed.' }, 'https://evil.example.com'));
    expect(csrfResponse.status).toBe(403);
    expect(mockRequireRole).not.toHaveBeenCalled();

    mockRequireRole.mockRejectedValueOnce(new AuthError('Forbidden', 403));
    const roleResponse = await POST(postRequest({ accountId: ACCOUNT_ID, note: 'Reviewed.' }));
    expect(roleResponse.status).toBe(403);
    expect(mockSql.begin).not.toHaveBeenCalled();

    mockRequireCurrentAal2FromSupabase.mockResolvedValueOnce({
      ok: false,
      reason: 'mfa_required',
    });
    const aalResponse = await POST(postRequest({ accountId: ACCOUNT_ID, note: 'Reviewed.' }));
    expect(aalResponse.status).toBe(403);
    expect(mockSql.begin).not.toHaveBeenCalled();

    const missingNote = await POST(postRequest({ accountId: ACCOUNT_ID, note: '   ' }));
    expect(missingNote.status).toBe(400);
    expect(mockSql.begin).not.toHaveBeenCalled();
  });

  it('POST uses the canonical writer and audit in one transaction, then reports armed state', async () => {
    sqlReturnQueue.push(
      mkTaggedResult([{ id: ACCOUNT_ID }]),
      mkTaggedResult([{
        previous_reason: 'A safety review paused auto-posting.',
        auto_approve_min_star: 4,
      }]),
      mkTaggedResult([]),
    );
    const { POST } = await import('../unsuspend/route');

    const response = await POST(postRequest({ accountId: ACCOUNT_ID, note: '  Reviewed with owner.  ' }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ rearmed: true });
    expect(mockSql.begin).toHaveBeenCalledOnce();
    expect(sqlCalls[0]!.text).toContain('FROM accounts');
    expect(sqlCalls[1]!.text).toContain('UPDATE auto_approval_policies');
    expect(sqlCalls[2]!.text).toContain('INSERT INTO account_audit_log');
    expect(sqlCalls[2]!.values).toContain(ADMIN_ID);
    expect(sqlCalls[2]!.values).toContain('autonomy_unsuspended');
    expect(mockSql.json).toHaveBeenCalledWith({
      note: 'Reviewed with owner.',
      previous_reason: 'A safety review paused auto-posting.',
    });
  });

  it('POST returns 409 when the account default is not suspended', async () => {
    sqlReturnQueue.push(mkTaggedResult([{ id: ACCOUNT_ID }]), mkTaggedResult([]));
    const { POST } = await import('../unsuspend/route');

    const response = await POST(postRequest({ accountId: ACCOUNT_ID, note: 'Reviewed.' }));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'not_suspended' });
    expect(sqlCalls).toHaveLength(2);
  });

  it('POST maps a nonexistent account to the same idempotent 409', async () => {
    sqlReturnQueue.push(mkTaggedResult([]));
    const { POST } = await import('../unsuspend/route');

    const response = await POST(postRequest({ accountId: ACCOUNT_ID, note: 'Reviewed.' }));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'not_suspended' });
    expect(sqlCalls).toHaveLength(1);
  });
});
