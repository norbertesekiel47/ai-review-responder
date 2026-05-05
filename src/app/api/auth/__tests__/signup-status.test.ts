import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Hoisted mocks ───────────────────────────────────────────────────

const { mockSql, mockGetUser, mockCreateServerClient, mockCheckRateLimit } = vi.hoisted(() => {
  const sqlFn = vi.fn();
  const getUser = vi.fn();
  return {
    mockSql: sqlFn,
    mockGetUser: getUser,
    mockCreateServerClient: vi.fn(() => ({
      auth: { getUser },
    })),
    mockCheckRateLimit: vi.fn(),
  };
});

vi.mock('@/lib/db/server', () => ({
  sql: mockSql,
  jsonb: (v: unknown) => v,
}));

vi.mock('@supabase/ssr', () => ({
  createServerClient: mockCreateServerClient,
}));

vi.mock('@/lib/shared/rate-limit', () => ({
  checkRateLimit: mockCheckRateLimit,
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

  mockCheckRateLimit.mockReset();
  mockCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 30 });

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

  // Helper — the route now selects raw columns and computes businessOnboarded
  // in JS (instead of SQL). Tests provide the raw columns directly.
  function rowFor(opts: {
    subscription_status?: string;
    role?: string;
    place_id_verified?: boolean;
    google_maps_url?: string | null;
    subscription_activated_at?: Date | null;
    updated_at?: Date;
  } = {}) {
    return {
      subscription_status: opts.subscription_status ?? 'pending_payment',
      role: opts.role ?? 'owner',
      place_id_verified: opts.place_id_verified ?? false,
      google_maps_url: opts.google_maps_url ?? null,
      subscription_activated_at: opts.subscription_activated_at ?? null,
      updated_at: opts.updated_at ?? new Date(),
    };
  }

  it('returns 200 + { subscriptionStatus, role, businessOnboarded } with no-store header on success', async () => {
    mockSql.mockResolvedValueOnce([rowFor({ subscription_status: 'pending_payment' })]);
    const res = await GET(mkReq());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.subscriptionStatus).toBe('pending_payment');
    expect(json.role).toBe('owner');
    expect(json.businessOnboarded).toBe(false);
    expect(res.headers.get('Cache-Control')).toBe('no-store, private');
  });

  it('returns subscriptionStatus "active" when Stripe has flipped the business', async () => {
    mockSql.mockResolvedValueOnce([rowFor({ subscription_status: 'active' })]);
    const res = await GET(mkReq());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.subscriptionStatus).toBe('active');
  });

  it('legacy flow: businessOnboarded=true when place_id_verified is true (placeAutocomplete path)', async () => {
    delete process.env.ONBOARDING_DEMO_ENABLED;
    mockSql.mockResolvedValueOnce([
      rowFor({ subscription_status: 'active', place_id_verified: true }),
    ]);
    const res = await GET(mkReq());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.businessOnboarded).toBe(true);
  });

  it('legacy flow: businessOnboarded=true when google_maps_url is set (URL fallback path)', async () => {
    delete process.env.ONBOARDING_DEMO_ENABLED;
    mockSql.mockResolvedValueOnce([
      rowFor({ subscription_status: 'active', google_maps_url: 'https://maps.google.com/...' }),
    ]);
    const res = await GET(mkReq());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.businessOnboarded).toBe(true);
  });

  it('legacy flow: businessOnboarded=false when both place_id_verified=false and google_maps_url=null', async () => {
    delete process.env.ONBOARDING_DEMO_ENABLED;
    mockSql.mockResolvedValueOnce([rowFor({ subscription_status: 'pending_payment' })]);
    const res = await GET(mkReq());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.businessOnboarded).toBe(false);
  });

  it('demo flow: businessOnboarded=false when subscription active but updated_at = subscription_activated_at (Stripe just fired, wizard not yet run)', async () => {
    process.env.ONBOARDING_DEMO_ENABLED = 'true';
    const activatedAt = new Date('2026-05-04T12:00:00Z');
    mockSql.mockResolvedValueOnce([
      rowFor({
        subscription_status: 'active',
        place_id_verified: true, // /start set this BEFORE Stripe — must NOT be treated as "onboarded"
        subscription_activated_at: activatedAt,
        updated_at: activatedAt,
      }),
    ]);
    const res = await GET(mkReq());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.businessOnboarded).toBe(false);
    delete process.env.ONBOARDING_DEMO_ENABLED;
  });

  it('demo flow: businessOnboarded=true when updated_at > subscription_activated_at + 2s (post-pay wizard ran)', async () => {
    process.env.ONBOARDING_DEMO_ENABLED = 'true';
    const activatedAt = new Date('2026-05-04T12:00:00Z');
    const wizardSubmitAt = new Date(activatedAt.getTime() + 5_000); // 5s later
    mockSql.mockResolvedValueOnce([
      rowFor({
        subscription_status: 'active',
        place_id_verified: true,
        subscription_activated_at: activatedAt,
        updated_at: wizardSubmitAt,
      }),
    ]);
    const res = await GET(mkReq());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.businessOnboarded).toBe(true);
    delete process.env.ONBOARDING_DEMO_ENABLED;
  });

  it('passes the session auth_id as an interpolated value to sql (scoped query)', async () => {
    mockSql.mockResolvedValueOnce([rowFor({ subscription_status: 'active' })]);
    await GET(mkReq());
    expect(mockSql).toHaveBeenCalledTimes(1);
    // Tagged-template call: mockSql(strings, ...values).
    // The auth_id ('auth-uuid-123') must appear in the spread values (index 1+).
    const callArgs = mockSql.mock.calls[0] as unknown[];
    // values are at index 1 onward (index 0 is TemplateStringsArray).
    const interpolatedValues = callArgs.slice(1);
    expect(interpolatedValues).toContain('auth-uuid-123');
  });

  it('returns 429 when rate-limit exceeded (30/min per authId)', async () => {
    mockCheckRateLimit.mockResolvedValueOnce({ allowed: false, remaining: 0 });
    const res = await GET(mkReq());
    expect(res.status).toBe(429);
    expect(mockSql).not.toHaveBeenCalled();
    // Confirm key shape.
    const firstCall = mockCheckRateLimit.mock.calls[0]!;
    expect(firstCall[0]).toBe('signup-status:auth:auth-uuid-123');
    expect(firstCall[1]).toBe(30);
    expect(firstCall[2]).toBe(60);
  });

  it('soft-fails (allows request) when rate-limit throws (Redis down)', async () => {
    // Non-strict: Redis outage must NOT 503 the polling endpoint.
    mockCheckRateLimit.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    mockSql.mockResolvedValueOnce([
      rowFor({ subscription_status: 'active', place_id_verified: true }),
    ]);
    const res = await GET(mkReq());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.subscriptionStatus).toBe('active');
  });
});
