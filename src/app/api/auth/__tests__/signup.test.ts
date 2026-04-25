import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Hoisted mocks ───────────────────────────────────────────────────

const {
  mockCheckRateLimit,
  mockSupabaseServer,
  mockCreateBusinessTx,
  mockSql,
} = vi.hoisted(() => {
  const sqlFn = vi.fn();
  // sql is both a tagged-template function and has a .begin() method.
  (sqlFn as unknown as { begin: ReturnType<typeof vi.fn> }).begin = vi.fn(
    async (cb: (tx: unknown) => Promise<unknown>) => cb(sqlFn),
  );
  return {
    mockCheckRateLimit: vi.fn(),
    mockSupabaseServer: {
      auth: {
        signUp: vi.fn(),
        admin: { deleteUser: vi.fn() },
      },
    },
    mockCreateBusinessTx: vi.fn(),
    mockSql: sqlFn,
  };
});

vi.mock('@/lib/shared/rate-limit', () => ({
  checkRateLimit: mockCheckRateLimit,
}));

vi.mock('@/lib/db/server', () => ({
  sql: mockSql,
  jsonb: (v: unknown) => v,
  supabaseServer: mockSupabaseServer,
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

// Import AFTER mocks + env.
import { POST } from '../signup/route';

// ── Helpers ─────────────────────────────────────────────────────────

function mkReq(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('https://app.example.com/api/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

const validBody = {
  ownerEmail: 'owner@example.com',
  ownerName: 'Jane',
  password: 'password123',
};

beforeEach(() => {
  mockCheckRateLimit.mockReset();
  mockCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 4 });

  mockSql.mockReset();
  // Default: email pre-check returns empty (no existing user).
  mockSql.mockResolvedValue([]);
  (mockSql as unknown as { begin: ReturnType<typeof vi.fn> }).begin = vi.fn(
    async (cb: (tx: unknown) => Promise<unknown>) => cb(mockSql),
  );

  mockSupabaseServer.auth.signUp.mockReset();
  mockSupabaseServer.auth.admin.deleteUser.mockReset();
  mockSupabaseServer.auth.admin.deleteUser.mockResolvedValue({
    data: null,
    error: null,
  });

  mockCreateBusinessTx.mockReset();

  process.env.SELF_SERVE_SIGNUP_ENABLED = 'true';
});

// ── Tests ────────────────────────────────────────────────────────────

describe('POST /api/auth/signup', () => {
  it('returns 404 when SELF_SERVE_SIGNUP_ENABLED !== "true"', async () => {
    process.env.SELF_SERVE_SIGNUP_ENABLED = 'false';
    const res = await POST(mkReq(validBody));
    expect(res.status).toBe(404);
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
  });

  it('returns 400 on invalid body (schema violation)', async () => {
    const res = await POST(mkReq({ ownerEmail: 'not-an-email' }));
    expect(res.status).toBe(400);
    expect(mockSupabaseServer.auth.signUp).not.toHaveBeenCalled();
    expect(mockCreateBusinessTx).not.toHaveBeenCalled();
  });

  it('returns 400 when body is not valid JSON', async () => {
    const req = new NextRequest('https://app.example.com/api/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not-json',
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('returns 409 + does NOT call supabase.auth.signUp when email pre-check finds existing user', async () => {
    // Pre-check SELECT returns an existing row.
    mockSql.mockResolvedValueOnce([]); // pg_advisory_xact_lock
    mockSql.mockResolvedValueOnce([{ id: 'existing-uid' }]); // SELECT id FROM users

    const res = await POST(mkReq(validBody));
    expect(res.status).toBe(409);
    expect(mockSupabaseServer.auth.signUp).not.toHaveBeenCalled();
    expect(mockCreateBusinessTx).not.toHaveBeenCalled();
  });

  it('returns 201 + calls createBusinessTx with identity-only input + {mode:"self_serve",authId} on happy path', async () => {
    mockSupabaseServer.auth.signUp.mockResolvedValueOnce({
      data: { user: { id: 'new-auth-uuid' } },
      error: null,
    });
    mockCreateBusinessTx.mockResolvedValueOnce({
      businessId: 'biz-1',
      userId: 'u-1',
      paymentUrl: 'https://buy.example.com',
    });

    const res = await POST(mkReq(validBody));
    expect(res.status).toBe(201);

    const json = await res.json();
    // redirectTo carries the email pre-fill so /signup/check-email can
    // render the OTP entry form without a typed-twice email step.
    expect(json.redirectTo).toBe(
      '/signup/check-email?email=owner%40example.com',
    );

    expect(mockSupabaseServer.auth.signUp).toHaveBeenCalledTimes(1);
    // Identity-only contract: createBusinessTx receives ONLY the three
    // identity fields. Business details (name, place ID, etc.) are
    // collected later via /api/onboarding/business after Stripe payment.
    expect(mockCreateBusinessTx).toHaveBeenCalledWith(
      {
        ownerEmail: 'owner@example.com',
        ownerName: 'Jane',
        ownerPhone: null,
      },
      { mode: 'self_serve', authId: 'new-auth-uuid' },
    );
  });

  it('returns 409 + calls auth.admin.deleteUser(authId) when tx throws DuplicateEmailError', async () => {
    const { DuplicateEmailError } = await import('@/lib/onboarding/create-business');
    mockSupabaseServer.auth.signUp.mockResolvedValueOnce({
      data: { user: { id: 'orphan-auth' } },
      error: null,
    });
    mockCreateBusinessTx.mockRejectedValueOnce(new DuplicateEmailError());

    const res = await POST(mkReq(validBody));
    expect(res.status).toBe(409);
    expect(mockSupabaseServer.auth.admin.deleteUser).toHaveBeenCalledWith('orphan-auth');
  });

  it('returns 500 + calls auth.admin.deleteUser(authId) when tx throws generic error', async () => {
    mockSupabaseServer.auth.signUp.mockResolvedValueOnce({
      data: { user: { id: 'orphan-auth-2' } },
      error: null,
    });
    mockCreateBusinessTx.mockRejectedValueOnce(new Error('db is on fire'));

    const res = await POST(mkReq(validBody));
    expect(res.status).toBe(500);
    expect(mockSupabaseServer.auth.admin.deleteUser).toHaveBeenCalledWith('orphan-auth-2');
  });

  it('returns 409 (no enumeration leak) when supabase.auth.signUp returns error', async () => {
    mockSupabaseServer.auth.signUp.mockResolvedValueOnce({
      data: { user: null },
      error: { message: 'User already registered', status: 422 },
    });

    const res = await POST(mkReq(validBody));
    expect(res.status).toBe(409);
    expect(mockCreateBusinessTx).not.toHaveBeenCalled();
    // No orphan auth user was created, so nothing to delete.
    expect(mockSupabaseServer.auth.admin.deleteUser).not.toHaveBeenCalled();
  });

  it('returns 429 when rate-limit is exceeded', async () => {
    mockCheckRateLimit.mockResolvedValueOnce({ allowed: false, remaining: 0 });
    const res = await POST(mkReq(validBody));
    expect(res.status).toBe(429);
    expect(mockSupabaseServer.auth.signUp).not.toHaveBeenCalled();
    expect(mockCreateBusinessTx).not.toHaveBeenCalled();
  });

  it('returns 503 when rate-limit throws in strict mode (Redis down)', async () => {
    mockCheckRateLimit.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const res = await POST(mkReq(validBody));
    expect(res.status).toBe(503);
    expect(mockSupabaseServer.auth.signUp).not.toHaveBeenCalled();
  });

  it('still returns 409 (and logs) when compensating deleteUser itself fails', async () => {
    const { DuplicateEmailError } = await import('@/lib/onboarding/create-business');
    mockSupabaseServer.auth.signUp.mockResolvedValueOnce({
      data: { user: { id: 'orphan-3' } },
      error: null,
    });
    mockCreateBusinessTx.mockRejectedValueOnce(new DuplicateEmailError());
    mockSupabaseServer.auth.admin.deleteUser.mockRejectedValueOnce(
      new Error('supabase admin api down'),
    );
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await POST(mkReq(validBody));
    expect(res.status).toBe(409);
    expect(mockSupabaseServer.auth.admin.deleteUser).toHaveBeenCalledWith('orphan-3');
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('passes ownerPhone through when supplied', async () => {
    mockSupabaseServer.auth.signUp.mockResolvedValueOnce({
      data: { user: { id: 'auth-phone' } },
      error: null,
    });
    mockCreateBusinessTx.mockResolvedValueOnce({
      businessId: 'b',
      userId: 'u',
      paymentUrl: null,
    });

    const res = await POST(mkReq({ ...validBody, ownerPhone: '+1-555-0100' }));
    expect(res.status).toBe(201);
    expect(mockCreateBusinessTx).toHaveBeenCalledWith(
      {
        ownerEmail: 'owner@example.com',
        ownerName: 'Jane',
        ownerPhone: '+1-555-0100',
      },
      expect.objectContaining({ mode: 'self_serve' }),
    );
  });
});
