import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Hoisted mocks ───────────────────────────────────────────────────

const {
  mockCheckRateLimit,
  mockSupabaseServer,
  mockSql,
} = vi.hoisted(() => {
  const sqlFn = vi.fn();
  return {
    mockCheckRateLimit: vi.fn(),
    mockSupabaseServer: {
      auth: {
        resetPasswordForEmail: vi.fn(),
      },
    },
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

// Flag + env setup — must be set before importing the route.
process.env.SELF_SERVE_SIGNUP_ENABLED = 'true';
process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com';

// Import AFTER mocks + env.
import { POST } from '../forgot-password/route';

// ── Helpers ─────────────────────────────────────────────────────────

function mkReq(
  body: unknown,
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest('https://app.example.com/api/auth/forgot-password', {
    method: 'POST',
    // Same-origin guard runs first — default the Origin header so tests
    // that aren't specifically exercising the 403 cross-origin branch
    // don't trip it. Override per-test when needed.
    headers: {
      'content-type': 'application/json',
      origin: 'https://app.example.com',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  mockCheckRateLimit.mockReset();
  mockCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 2 });

  mockSql.mockReset();
  // Default: no users row found — enumeration-protected 200 response.
  mockSql.mockResolvedValue([]);

  mockSupabaseServer.auth.resetPasswordForEmail.mockReset();
  mockSupabaseServer.auth.resetPasswordForEmail.mockResolvedValue({
    data: {},
    error: null,
  });

  process.env.SELF_SERVE_SIGNUP_ENABLED = 'true';
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com';
});

// ── Tests ────────────────────────────────────────────────────────────

describe('POST /api/auth/forgot-password', () => {
  // ── Validation ───────────────────────────────────────────────────

  it('returns 400 when role is missing', async () => {
    const res = await POST(mkReq({ email: 'someone@example.com' }));
    expect(res.status).toBe(400);
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
    expect(mockSupabaseServer.auth.resetPasswordForEmail).not.toHaveBeenCalled();
  });

  it('returns 400 when role is unknown', async () => {
    const res = await POST(
      mkReq({ email: 'someone@example.com', role: 'hacker' }),
    );
    expect(res.status).toBe(400);
    expect(mockSupabaseServer.auth.resetPasswordForEmail).not.toHaveBeenCalled();
  });

  it('returns 400 when email is malformed', async () => {
    const res = await POST(mkReq({ email: 'not-an-email', role: 'owner' }));
    expect(res.status).toBe(400);
    expect(mockSupabaseServer.auth.resetPasswordForEmail).not.toHaveBeenCalled();
  });

  it('returns 400 when body is not valid JSON', async () => {
    const req = new NextRequest(
      'https://app.example.com/api/auth/forgot-password',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'https://app.example.com',
        },
        body: 'not-json',
      },
    );
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  // ── Same-origin (CSRF) guard — runs BEFORE rate limit + body parse ─

  it('returns 403 when Origin header is missing (no rate-limit increment, no DB read, no SMTP)', async () => {
    const res = await POST(
      mkReq(
        { email: 'owner@example.com', role: 'owner' },
        { origin: '' }, // explicit empty wins over default in spread
      ),
    );
    expect(res.status).toBe(403);
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
    expect(mockSql).not.toHaveBeenCalled();
    expect(mockSupabaseServer.auth.resetPasswordForEmail).not.toHaveBeenCalled();
  });

  it('returns 403 when Origin header is from a different host', async () => {
    const res = await POST(
      mkReq(
        { email: 'owner@example.com', role: 'owner' },
        { origin: 'https://attacker.example.net' },
      ),
    );
    expect(res.status).toBe(403);
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
    expect(mockSql).not.toHaveBeenCalled();
    expect(mockSupabaseServer.auth.resetPasswordForEmail).not.toHaveBeenCalled();
  });

  // ── Flag gating ──────────────────────────────────────────────────

  it('returns 404 when SELF_SERVE_SIGNUP_ENABLED !== "true" AND role=owner', async () => {
    process.env.SELF_SERVE_SIGNUP_ENABLED = 'false';
    const res = await POST(
      mkReq({ email: 'owner@example.com', role: 'owner' }),
    );
    expect(res.status).toBe(404);
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
    expect(mockSupabaseServer.auth.resetPasswordForEmail).not.toHaveBeenCalled();
  });

  it('returns 200 + proceeds when flag is OFF AND role=admin (admin never gated)', async () => {
    process.env.SELF_SERVE_SIGNUP_ENABLED = 'false';
    mockSql.mockResolvedValueOnce([{ role: 'admin' }]);

    const res = await POST(
      mkReq({ email: 'admin@example.com', role: 'admin' }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(mockCheckRateLimit).toHaveBeenCalled();
    expect(mockSupabaseServer.auth.resetPasswordForEmail).toHaveBeenCalledWith(
      'admin@example.com',
      {
        redirectTo:
          'https://app.example.com/api/auth/callback?flow=admin&next=/admin/reset-password',
      },
    );
  });

  // ── Enumeration protection ───────────────────────────────────────

  it('returns generic 200 + does NOT call resetPasswordForEmail when email has no users row', async () => {
    mockSql.mockResolvedValueOnce([]); // no user found

    const res = await POST(
      mkReq({ email: 'ghost@example.com', role: 'owner' }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(mockSupabaseServer.auth.resetPasswordForEmail).not.toHaveBeenCalled();
  });

  // ── Cross-portal protection ──────────────────────────────────────

  it('returns generic 200 + NO call when submitted role=admin but actual role=owner', async () => {
    mockSql.mockResolvedValueOnce([{ role: 'owner' }]);

    const res = await POST(
      mkReq({ email: 'owner@example.com', role: 'admin' }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(mockSupabaseServer.auth.resetPasswordForEmail).not.toHaveBeenCalled();
  });

  it('returns generic 200 + NO call when submitted role=owner but actual role=admin', async () => {
    mockSql.mockResolvedValueOnce([{ role: 'admin' }]);

    const res = await POST(
      mkReq({ email: 'admin@example.com', role: 'owner' }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(mockSupabaseServer.auth.resetPasswordForEmail).not.toHaveBeenCalled();
  });

  it('returns generic 200 + NO call when submitted role=owner but actual role=sales_partner', async () => {
    mockSql.mockResolvedValueOnce([{ role: 'sales_partner' }]);

    const res = await POST(
      mkReq({ email: 'partner@example.com', role: 'owner' }),
    );
    expect(res.status).toBe(200);
    expect(mockSupabaseServer.auth.resetPasswordForEmail).not.toHaveBeenCalled();
  });

  // ── Happy paths ──────────────────────────────────────────────────

  it('returns 200 + calls resetPasswordForEmail with owner callback redirect when owner email + role=owner match', async () => {
    mockSql.mockResolvedValueOnce([{ role: 'owner' }]);

    const res = await POST(
      mkReq({ email: 'owner@example.com', role: 'owner' }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);

    expect(mockSupabaseServer.auth.resetPasswordForEmail).toHaveBeenCalledTimes(
      1,
    );
    expect(mockSupabaseServer.auth.resetPasswordForEmail).toHaveBeenCalledWith(
      'owner@example.com',
      {
        redirectTo:
          'https://app.example.com/api/auth/callback?flow=owner&next=/reset-password',
      },
    );
  });

  it('returns 200 + calls resetPasswordForEmail with admin callback redirect when admin email + role=admin match', async () => {
    mockSql.mockResolvedValueOnce([{ role: 'admin' }]);

    const res = await POST(
      mkReq({ email: 'admin@example.com', role: 'admin' }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);

    expect(mockSupabaseServer.auth.resetPasswordForEmail).toHaveBeenCalledWith(
      'admin@example.com',
      {
        redirectTo:
          'https://app.example.com/api/auth/callback?flow=admin&next=/admin/reset-password',
      },
    );
  });

  it('returns generic 200 + NO call when submitted role=admin but actual role=sales_partner', async () => {
    mockSql.mockResolvedValueOnce([{ role: 'sales_partner' }]);

    const res = await POST(
      mkReq({ email: 'partner@example.com', role: 'admin' }),
    );
    expect(res.status).toBe(200);
    expect(mockSupabaseServer.auth.resetPasswordForEmail).not.toHaveBeenCalled();
  });

  it('returns 200 even when resetPasswordForEmail rejects (no enumeration leak, error swallowed + logged)', async () => {
    mockSql.mockResolvedValueOnce([{ role: 'owner' }]);
    mockSupabaseServer.auth.resetPasswordForEmail.mockRejectedValueOnce(
      new Error('supabase down'),
    );
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await POST(
      mkReq({ email: 'owner@example.com', role: 'owner' }),
    );
    expect(res.status).toBe(200);
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  // ── Rate limiting ────────────────────────────────────────────────

  it('returns 429 when IP rate limit is exceeded (3/hr)', async () => {
    mockCheckRateLimit.mockResolvedValueOnce({ allowed: false, remaining: 0 });

    const res = await POST(
      mkReq({ email: 'owner@example.com', role: 'owner' }),
    );
    expect(res.status).toBe(429);
    expect(mockSupabaseServer.auth.resetPasswordForEmail).not.toHaveBeenCalled();
  });

  it('returns 429 when email rate limit is exceeded (5/hr)', async () => {
    // IP allowed, email denied.
    mockCheckRateLimit.mockResolvedValueOnce({ allowed: true, remaining: 2 });
    mockCheckRateLimit.mockResolvedValueOnce({ allowed: false, remaining: 0 });

    const res = await POST(
      mkReq({ email: 'owner@example.com', role: 'owner' }),
    );
    expect(res.status).toBe(429);
    expect(mockSupabaseServer.auth.resetPasswordForEmail).not.toHaveBeenCalled();
  });

  it('uses strict:true for both IP (3/hr) and email (5/hr) rate-limit keys', async () => {
    mockSql.mockResolvedValueOnce([{ role: 'owner' }]);

    await POST(mkReq({ email: 'owner@example.com', role: 'owner' }));

    // Both calls present and both strict.
    expect(mockCheckRateLimit).toHaveBeenCalledTimes(2);
    const firstCall = mockCheckRateLimit.mock.calls[0]!;
    const secondCall = mockCheckRateLimit.mock.calls[1]!;
    // IP key: 3/hr strict
    expect(firstCall[1]).toBe(3);
    expect(firstCall[2]).toBe(3600);
    expect(firstCall[3]).toEqual({ strict: true });
    // Email key: 5/hr strict, key includes normalized email
    expect(secondCall[0]).toBe('forgot-pw:email:owner@example.com');
    expect(secondCall[1]).toBe(5);
    expect(secondCall[2]).toBe(3600);
    expect(secondCall[3]).toEqual({ strict: true });
  });

  it('returns 503 when strict rate-limit throws (Redis down)', async () => {
    mockCheckRateLimit.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const res = await POST(
      mkReq({ email: 'owner@example.com', role: 'owner' }),
    );
    expect(res.status).toBe(503);
    expect(mockSupabaseServer.auth.resetPasswordForEmail).not.toHaveBeenCalled();
  });

  // ── Email normalization ───────────────────────────────────────────

  it('normalizes email (trim + lowercase) from schema before DB lookup and reset call', async () => {
    mockSql.mockResolvedValueOnce([{ role: 'owner' }]);

    const res = await POST(
      mkReq({ email: '  Owner@Example.COM  ', role: 'owner' }),
    );
    expect(res.status).toBe(200);
    expect(mockSupabaseServer.auth.resetPasswordForEmail).toHaveBeenCalledWith(
      'owner@example.com',
      expect.any(Object),
    );
  });
});
