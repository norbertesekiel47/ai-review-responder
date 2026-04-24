import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Hoisted mocks ───────────────────────────────────────────────────

const { mockSql, mockGetUser, mockCreateServerClient } = vi.hoisted(() => {
  const sqlFn = vi.fn();
  const getUser = vi.fn();
  return {
    mockSql: sqlFn,
    mockGetUser: getUser,
    mockCreateServerClient: vi.fn(() => ({
      auth: { getUser },
    })),
  };
});

vi.mock('@/lib/db/server', () => ({
  sql: mockSql,
  jsonb: (v: unknown) => v,
}));

vi.mock('@supabase/ssr', () => ({
  createServerClient: mockCreateServerClient,
}));

// Flag + env setup — must be set before importing the route.
process.env.SELF_SERVE_SIGNUP_ENABLED = 'true';
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key';

// Import AFTER mocks + env.
import { GET } from '../signup-status/route';

// ── Helpers ─────────────────────────────────────────────────────────

function mkReq(): NextRequest {
  return new NextRequest('https://app.example.com/api/auth/signup-status');
}

const mockUser = {
  id: 'auth-uuid-123',
  email: 'owner@example.com',
};

beforeEach(() => {
  mockSql.mockReset();
  mockSql.mockResolvedValue([]);

  mockGetUser.mockReset();
  mockGetUser.mockResolvedValue({ data: { user: mockUser }, error: null });

  mockCreateServerClient.mockReset();
  mockCreateServerClient.mockImplementation(() => ({
    auth: { getUser: mockGetUser },
  }));

  process.env.SELF_SERVE_SIGNUP_ENABLED = 'true';
});

// ── Tests ────────────────────────────────────────────────────────────

describe('GET /api/auth/signup-status', () => {
  it('returns 404 when SELF_SERVE_SIGNUP_ENABLED !== "true"', async () => {
    process.env.SELF_SERVE_SIGNUP_ENABLED = 'false';
    const res = await GET(mkReq());
    expect(res.status).toBe(404);
    expect(mockGetUser).not.toHaveBeenCalled();
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('returns 401 when no session (getUser returns { user: null })', async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: null }, error: null });
    const res = await GET(mkReq());
    expect(res.status).toBe(401);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('returns 404 account_incomplete when no users row for auth_id', async () => {
    // sql returns empty array — no matching users + businesses join row.
    mockSql.mockResolvedValueOnce([]);
    const res = await GET(mkReq());
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe('account_incomplete');
  });

  it('returns 200 + { subscriptionStatus, role } with no-store header on success', async () => {
    mockSql.mockResolvedValueOnce([
      { subscription_status: 'pending_payment', role: 'owner' },
    ]);
    const res = await GET(mkReq());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.subscriptionStatus).toBe('pending_payment');
    expect(json.role).toBe('owner');
    expect(res.headers.get('Cache-Control')).toBe('no-store, private');
  });

  it('returns subscriptionStatus "active" when Stripe has flipped the business', async () => {
    mockSql.mockResolvedValueOnce([
      { subscription_status: 'active', role: 'owner' },
    ]);
    const res = await GET(mkReq());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.subscriptionStatus).toBe('active');
  });

  it('passes the session auth_id as an interpolated value to sql (scoped query)', async () => {
    mockSql.mockResolvedValueOnce([
      { subscription_status: 'active', role: 'owner' },
    ]);
    await GET(mkReq());
    expect(mockSql).toHaveBeenCalledTimes(1);
    // Tagged-template call: mockSql(strings, ...values).
    // The auth_id ('auth-uuid-123') must appear in the spread values (index 1+).
    const callArgs = mockSql.mock.calls[0] as unknown[];
    // values are at index 1 onward (index 0 is TemplateStringsArray).
    const interpolatedValues = callArgs.slice(1);
    expect(interpolatedValues).toContain('auth-uuid-123');
  });
});
