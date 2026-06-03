import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockRequireRole,
  mockRequireCurrentAal2FromSupabase,
  mockStartImpersonationSession,
  mockSignImpersonationSession,
  mockAssertImpersonationCookieConfigured,
  mockSql,
  sqlCalls,
} = vi.hoisted(() => {
  const sqlCalls: { text: string; values: unknown[] }[] = [];
  const mockSql = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    sqlCalls.push({ text: strings.join('?'), values });
    return Promise.resolve([
      {
        id: '33333333-3333-4333-8333-333333333333',
        account_id: '11111111-1111-4111-8111-111111111111',
      },
    ]);
  });

  return {
    mockRequireRole: vi.fn(),
    mockRequireCurrentAal2FromSupabase: vi.fn(),
    mockStartImpersonationSession: vi.fn(),
    mockSignImpersonationSession: vi.fn(),
    mockAssertImpersonationCookieConfigured: vi.fn(),
    mockSql,
    sqlCalls,
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

vi.mock('@/lib/db/server', () => ({
  sql: mockSql,
}));

vi.mock('@/lib/admin/impersonation/session', () => ({
  startImpersonationSession: mockStartImpersonationSession,
}));

vi.mock('@/lib/admin/impersonation/cookie', () => ({
  IMPERSONATION_COOKIE_NAME: 'rw_impersonation',
  assertImpersonationCookieConfigured: mockAssertImpersonationCookieConfigured,
  signImpersonationSession: mockSignImpersonationSession,
}));

process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com';
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://supabase.example.com';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key';

const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const ADMIN_ID = '22222222-2222-4222-8222-222222222222';
const OWNER_ID = '33333333-3333-4333-8333-333333333333';
const SESSION_ID = '44444444-4444-7444-8444-444444444444';
const EXPIRES_AT = new Date('2026-05-26T13:00:00.000Z');

function req(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('https://app.example.com/api/admin/impersonation/start', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'https://app.example.com',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function validBody() {
  return {
    accountId: ACCOUNT_ID,
    impersonatedUserId: OWNER_ID,
    ticketId: 'SUP-123',
    reason: 'Diagnose support ticket with owner context.',
  };
}

describe('POST /api/admin/impersonation/start', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sqlCalls.length = 0;
    mockSql.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
      sqlCalls.push({ text: strings.join('?'), values });
      return Promise.resolve([
      { id: OWNER_ID, account_id: ACCOUNT_ID },
      ]);
    });
    mockRequireRole.mockResolvedValue({
      id: ADMIN_ID,
      role: 'admin',
      email: 'admin@example.com',
      name: 'Admin',
      accountId: null,
      locationId: null,
    });
    mockRequireCurrentAal2FromSupabase.mockResolvedValue({ ok: true });
    mockStartImpersonationSession.mockResolvedValue({
      sessionId: SESSION_ID,
      expiresAt: EXPIRES_AT,
    });
    mockSignImpersonationSession.mockReturnValue('signed-session-cookie');
    mockAssertImpersonationCookieConfigured.mockReturnValue(undefined);
  });

  it('requires same-origin admin AAL2 before starting a session', async () => {
    const { AuthError } = await import('@/lib/db/auth');
    const { POST } = await import('../route');

    const csrfRes = await POST(req(validBody(), { origin: 'https://evil.example.com' }));
    expect(csrfRes.status).toBe(403);
    expect(mockRequireRole).not.toHaveBeenCalled();

    mockRequireRole.mockRejectedValueOnce(new AuthError('Forbidden', 403));
    const roleRes = await POST(req(validBody()));
    expect(roleRes.status).toBe(403);
    expect(await roleRes.json()).toEqual({ error: 'Forbidden' });

    mockRequireRole.mockResolvedValue({
      id: ADMIN_ID,
      role: 'admin',
      email: 'admin@example.com',
      name: 'Admin',
      accountId: null,
      locationId: null,
    });
    mockRequireCurrentAal2FromSupabase.mockResolvedValueOnce({
      ok: false,
      reason: 'mfa_required',
    });
    const aalRes = await POST(req(validBody()));
    expect(aalRes.status).toBe(403);
    expect(await aalRes.json()).toEqual({ error: 'mfa_required' });
  });

  it('requires ticket, reason, and an owner user on the requested account', async () => {
    const { POST } = await import('../route');

    const missingTicketRes = await POST(req({
      accountId: ACCOUNT_ID,
      impersonatedUserId: OWNER_ID,
      reason: 'Diagnose support ticket.',
    }));
    expect(missingTicketRes.status).toBe(400);

    const missingReasonRes = await POST(req({
      accountId: ACCOUNT_ID,
      impersonatedUserId: OWNER_ID,
      ticketId: 'SUP-123',
      reason: '',
    }));
    expect(missingReasonRes.status).toBe(400);

    mockSql.mockResolvedValueOnce([]);
    const missingOwnerRes = await POST(req(validBody()));
    expect(missingOwnerRes.status).toBe(404);
    expect(await missingOwnerRes.json()).toEqual({ error: 'impersonated_user_not_found' });
    expect(mockStartImpersonationSession).not.toHaveBeenCalled();
  });

  it('does not create a DB session when the signing secret is unconfigured', async () => {
    const { POST } = await import('../route');
    mockAssertImpersonationCookieConfigured.mockImplementationOnce(() => {
      throw new Error('IMPERSONATION_COOKIE_SECRET not configured');
    });

    const res = await POST(req(validBody()));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal_error' });
    expect(mockStartImpersonationSession).not.toHaveBeenCalled();
    expect(mockSignImpersonationSession).not.toHaveBeenCalled();
  });

  it('starts the session and sets an httpOnly signed cookie available to the view and end API', async () => {
    const { POST } = await import('../route');

    const res = await POST(req(validBody()));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      sessionId: SESSION_ID,
      viewUrl: `/admin/impersonate/${SESSION_ID}/view`,
      expiresAt: '2026-05-26T13:00:00.000Z',
    });
    expect(sqlCalls[0]!.text).toMatch(/FROM users u/i);
    expect(sqlCalls[0]!.text).toMatch(/u\.role = 'owner'/i);
    expect(sqlCalls[0]!.text).toMatch(/u\.account_id =/i);
    expect(mockStartImpersonationSession).toHaveBeenCalledWith({
      actorUserId: ADMIN_ID,
      impersonatedUserId: OWNER_ID,
      accountId: ACCOUNT_ID,
      ticketId: 'SUP-123',
      reason: 'Diagnose support ticket with owner context.',
    });
    expect(mockSignImpersonationSession).toHaveBeenCalledWith(SESSION_ID);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('rw_impersonation=signed-session-cookie');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie.toLowerCase()).toContain('samesite=strict');
    expect(setCookie).toMatch(/;\s*Path=\/(?:;|$)/);
  });
});
