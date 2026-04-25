import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Hoisted mocks ───────────────────────────────────────────────────

const {
  mockCheckRateLimit,
  mockCreateBusinessTx,
  mockSql,
  mockGetUser,
  mockCreateServerClient,
} = vi.hoisted(() => {
  const sqlFn = vi.fn();
  (sqlFn as unknown as { begin: ReturnType<typeof vi.fn> }).begin = vi.fn(
    async (cb: (tx: unknown) => Promise<unknown>) => cb(sqlFn),
  );
  const getUser = vi.fn();
  return {
    mockCheckRateLimit: vi.fn(),
    mockCreateBusinessTx: vi.fn(),
    mockSql: sqlFn,
    mockGetUser: getUser,
    mockCreateServerClient: vi.fn(() => ({
      auth: { getUser },
    })),
  };
});

vi.mock('@/lib/shared/rate-limit', () => ({
  checkRateLimit: mockCheckRateLimit,
}));

vi.mock('@/lib/db/server', () => ({
  sql: mockSql,
  jsonb: (v: unknown) => v,
  supabaseServer: {
    // Not used in finish-signup — present only to satisfy imports that may
    // transitively touch this module.
    auth: { admin: { deleteUser: vi.fn() } },
  },
}));

vi.mock('@supabase/ssr', () => ({
  createServerClient: mockCreateServerClient,
}));

vi.mock('@/lib/onboarding/create-business', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/onboarding/create-business')
  >('@/lib/onboarding/create-business');
  return {
    ...actual,
    createBusinessTx: mockCreateBusinessTx,
  };
});

// Flag + env setup — must be set before importing the route.
process.env.SELF_SERVE_SIGNUP_ENABLED = 'true';
process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com';
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key';

// Import AFTER mocks + env.
import { POST } from '../finish-signup/route';

// ── Helpers ─────────────────────────────────────────────────────────

function mkReq(
  body: unknown,
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest('https://app.example.com/api/auth/finish-signup', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'https://app.example.com',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

const validBody = {
  ownerName: 'Jane Google',
  businessName: 'Acme Cafe',
  googlePlaceId: 'ChIJtest1234567890ab',
  subscriptionTier: 'standard' as const,
};

// Default session user — Google-signed-in owner.
const mockUser = {
  id: 'auth-uuid-123',
  email: 'owner@example.com',
  email_confirmed_at: '2026-04-23T12:00:00Z',
};

beforeEach(() => {
  mockCheckRateLimit.mockReset();
  mockCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 2 });

  mockSql.mockReset();
  mockSql.mockResolvedValue([]);
  (mockSql as unknown as { begin: ReturnType<typeof vi.fn> }).begin = vi.fn(
    async (cb: (tx: unknown) => Promise<unknown>) => cb(mockSql),
  );

  mockGetUser.mockReset();
  mockGetUser.mockResolvedValue({ data: { user: mockUser }, error: null });

  mockCreateServerClient.mockReset();
  mockCreateServerClient.mockImplementation(() => ({
    auth: { getUser: mockGetUser },
  }));

  mockCreateBusinessTx.mockReset();

  process.env.SELF_SERVE_SIGNUP_ENABLED = 'true';
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com';
});

// ── Tests ────────────────────────────────────────────────────────────

describe('POST /api/auth/finish-signup', () => {
  it('returns 404 when SELF_SERVE_SIGNUP_ENABLED !== "true"', async () => {
    process.env.SELF_SERVE_SIGNUP_ENABLED = 'false';
    const res = await POST(mkReq(validBody));
    expect(res.status).toBe(404);
    expect(mockGetUser).not.toHaveBeenCalled();
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
  });

  it('returns 403 when Origin header mismatches NEXT_PUBLIC_APP_URL', async () => {
    const res = await POST(
      mkReq(validBody, { origin: 'https://evil.example.com' }),
    );
    expect(res.status).toBe(403);
    expect(mockGetUser).not.toHaveBeenCalled();
  });

  it('returns 401 when no session cookie (getUser returns { user: null })', async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: null }, error: null });
    const res = await POST(mkReq(validBody));
    expect(res.status).toBe(401);
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
    expect(mockCreateBusinessTx).not.toHaveBeenCalled();
  });

  it('returns 401 account_incomplete when session user has no email', async () => {
    mockGetUser.mockResolvedValueOnce({
      data: {
        user: {
          id: 'auth-no-email',
          email: null,
          email_confirmed_at: '2026-04-23T12:00:00Z',
        },
      },
      error: null,
    });
    const res = await POST(mkReq(validBody));
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe('account_incomplete');
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
  });

  it('returns 401 account_incomplete when session user has email but no email_confirmed_at', async () => {
    mockGetUser.mockResolvedValueOnce({
      data: {
        user: {
          id: 'auth-unconfirmed',
          email: 'owner@example.com',
          email_confirmed_at: null,
        },
      },
      error: null,
    });
    const res = await POST(mkReq(validBody));
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe('account_incomplete');
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
    expect(mockCreateBusinessTx).not.toHaveBeenCalled();
  });

  it('returns 400 on invalid body (missing required fields per FinishSignupSchema)', async () => {
    const res = await POST(mkReq({ businessName: 'Acme' })); // missing ownerName, etc.
    expect(res.status).toBe(400);
    expect(mockCreateBusinessTx).not.toHaveBeenCalled();
  });

  it('returns 400 when body is not valid JSON', async () => {
    const req = new NextRequest('https://app.example.com/api/auth/finish-signup', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://app.example.com',
      },
      body: 'not-json',
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('returns 409 when pre-check finds users.auth_id row (double-submit defense), no createBusinessTx call', async () => {
    // Advisory-locked pre-check inside sql.begin:
    //   tx`SELECT pg_advisory_xact_lock(...)`     → []
    //   tx`SELECT id FROM users WHERE auth_id ...`→ [{ id }]
    mockSql.mockResolvedValueOnce([]); // pg_advisory_xact_lock
    mockSql.mockResolvedValueOnce([{ id: 'existing-user' }]); // byAuth hit

    const res = await POST(mkReq(validBody));
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe('already_complete');
    expect(mockCreateBusinessTx).not.toHaveBeenCalled();
  });

  it('returns 409 when pre-check finds users.email row with different auth_id (admin collision), no createBusinessTx call', async () => {
    mockSql.mockResolvedValueOnce([]); // pg_advisory_xact_lock
    mockSql.mockResolvedValueOnce([]); // byAuth miss
    mockSql.mockResolvedValueOnce([{ id: 'admin-created' }]); // byEmail hit

    const res = await POST(mkReq(validBody));
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe('account_exists');
    expect(mockCreateBusinessTx).not.toHaveBeenCalled();
  });

  it('returns 201 + calls createBusinessTx with {mode:"self_serve",authId:<session.user.id>} on happy path', async () => {
    mockCreateBusinessTx.mockResolvedValueOnce({
      businessId: 'biz-1',
      userId: 'u-1',
      paymentUrl: 'https://buy.example.com',
    });

    const res = await POST(mkReq(validBody));
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.redirectTo).toBe('/onboarding/pay');

    expect(mockCreateBusinessTx).toHaveBeenCalledTimes(1);
    expect(mockCreateBusinessTx).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerEmail: 'owner@example.com',
        ownerName: 'Jane Google',
        businessName: 'Acme Cafe',
        placeId: expect.objectContaining({
          placeIdVerified: true,
          placeId: 'ChIJtest1234567890ab',
        }),
      }),
      { mode: 'self_serve', authId: 'auth-uuid-123' },
    );
  });

  it('returns 409 when createBusinessTx throws DuplicateEmailError (race). NO deleteUser call.', async () => {
    const { DuplicateEmailError } = await import(
      '@/lib/onboarding/create-business'
    );
    mockCreateBusinessTx.mockRejectedValueOnce(new DuplicateEmailError());

    const { supabaseServer } = await import('@/lib/db/server');
    const deleteSpy = supabaseServer.auth.admin.deleteUser as unknown as ReturnType<
      typeof vi.fn
    >;

    const res = await POST(mkReq(validBody));
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe('account_exists');
    // Critical: auth user came from Google OAuth — legitimate — we must NOT delete.
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it('returns 500 when createBusinessTx throws generic error. NO deleteUser call.', async () => {
    mockCreateBusinessTx.mockRejectedValueOnce(new Error('db on fire'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { supabaseServer } = await import('@/lib/db/server');
    const deleteSpy = supabaseServer.auth.admin.deleteUser as unknown as ReturnType<
      typeof vi.fn
    >;

    const res = await POST(mkReq(validBody));
    expect(res.status).toBe(500);
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('returns 429 when rate-limit exceeded (per-authId 10/hour)', async () => {
    mockCheckRateLimit.mockResolvedValueOnce({ allowed: false, remaining: 0 });
    const res = await POST(mkReq(validBody));
    expect(res.status).toBe(429);
    expect(mockCreateBusinessTx).not.toHaveBeenCalled();
    // Confirm the rate limit key was per-authId.
    expect(mockCheckRateLimit).toHaveBeenCalledWith(
      'finish-signup:auth:auth-uuid-123',
      10,
      3600,
      { strict: true },
    );
  });

  it('returns 503 when rate-limit throws in strict mode (Redis down)', async () => {
    mockCheckRateLimit.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const res = await POST(mkReq(validBody));
    expect(res.status).toBe(503);
    expect(mockCreateBusinessTx).not.toHaveBeenCalled();
  });

  it('builds placeId input from googleMapsUrl when googlePlaceId is absent', async () => {
    mockCreateBusinessTx.mockResolvedValueOnce({
      businessId: 'b',
      userId: 'u',
      paymentUrl: null,
    });

    const body: Record<string, unknown> = {
      ownerName: 'Jane',
      businessName: 'Acme',
      googleMapsUrl: 'https://maps.google.com/?cid=123',
      subscriptionTier: 'standard',
    };

    const res = await POST(mkReq(body));
    expect(res.status).toBe(201);
    expect(mockCreateBusinessTx).toHaveBeenCalledWith(
      expect.objectContaining({
        placeId: expect.objectContaining({
          placeIdVerified: false,
          googleMapsUrl: 'https://maps.google.com/?cid=123',
        }),
      }),
      expect.objectContaining({ mode: 'self_serve', authId: 'auth-uuid-123' }),
    );
  });

  it('normalizes session email to lowercase + trimmed before passing to createBusinessTx', async () => {
    mockGetUser.mockResolvedValueOnce({
      data: {
        user: {
          id: 'auth-mixed',
          email: '  Owner@Example.COM  ',
          email_confirmed_at: '2026-04-23T12:00:00Z',
        },
      },
      error: null,
    });
    mockCreateBusinessTx.mockResolvedValueOnce({
      businessId: 'b',
      userId: 'u',
      paymentUrl: null,
    });

    const res = await POST(mkReq(validBody));
    expect(res.status).toBe(201);
    expect(mockCreateBusinessTx).toHaveBeenCalledWith(
      expect.objectContaining({ ownerEmail: 'owner@example.com' }),
      { mode: 'self_serve', authId: 'auth-mixed' },
    );
  });
});
