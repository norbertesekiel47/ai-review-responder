import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Hoisted mocks ───────────────────────────────────────────────────

const {
  mockCheckRateLimit,
  mockSupabaseServer,
} = vi.hoisted(() => {
  return {
    mockCheckRateLimit: vi.fn(),
    mockSupabaseServer: {
      auth: {
        resend: vi.fn(),
      },
    },
  };
});

vi.mock('@/lib/shared/rate-limit', () => ({
  checkRateLimit: mockCheckRateLimit,
}));

vi.mock('@/lib/db/server', () => ({
  sql: vi.fn(),
  jsonb: (v: unknown) => v,
  supabaseServer: mockSupabaseServer,
}));

// Flag + env setup — must be set before importing the route.
process.env.SELF_SERVE_SIGNUP_ENABLED = 'true';
process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com';

// Import AFTER mocks + env.
import { POST } from '../resend-confirmation/route';

// ── Helpers ─────────────────────────────────────────────────────────

function mkReq(
  body: unknown,
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest(
    'https://app.example.com/api/auth/resend-confirmation',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    },
  );
}

beforeEach(() => {
  mockCheckRateLimit.mockReset();
  mockCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 4 });

  mockSupabaseServer.auth.resend.mockReset();
  mockSupabaseServer.auth.resend.mockResolvedValue({ data: {}, error: null });

  process.env.SELF_SERVE_SIGNUP_ENABLED = 'true';
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com';
});

// ── Tests ────────────────────────────────────────────────────────────

describe('POST /api/auth/resend-confirmation', () => {
  // ── Validation ───────────────────────────────────────────────────

  it('returns 400 when email is missing', async () => {
    const res = await POST(mkReq({ flow: 'owner' }));
    expect(res.status).toBe(400);
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
    expect(mockSupabaseServer.auth.resend).not.toHaveBeenCalled();
  });

  it('returns 400 when flow is missing', async () => {
    const res = await POST(mkReq({ email: 'owner@example.com' }));
    expect(res.status).toBe(400);
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
    expect(mockSupabaseServer.auth.resend).not.toHaveBeenCalled();
  });

  it('returns 400 when flow is an unknown value', async () => {
    const res = await POST(
      mkReq({ email: 'owner@example.com', flow: 'hacker' }),
    );
    expect(res.status).toBe(400);
    expect(mockSupabaseServer.auth.resend).not.toHaveBeenCalled();
  });

  it('returns 400 when body is not valid JSON', async () => {
    const req = new NextRequest(
      'https://app.example.com/api/auth/resend-confirmation',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not-json',
      },
    );
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  // ── Flag gating ──────────────────────────────────────────────────

  it('returns 404 when SELF_SERVE_SIGNUP_ENABLED !== "true" AND flow=owner', async () => {
    process.env.SELF_SERVE_SIGNUP_ENABLED = 'false';
    const res = await POST(
      mkReq({ email: 'owner@example.com', flow: 'owner' }),
    );
    expect(res.status).toBe(404);
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
    expect(mockSupabaseServer.auth.resend).not.toHaveBeenCalled();
  });

  it('returns 400 when flow=admin (schema now restricts to owner-only)', async () => {
    // Admin identities are manually provisioned and never use the
    // confirmation-email flow. Allowing flow=admin here would be a
    // phishing-adjacent primitive — anyone could trigger confirmation
    // emails to arbitrary admin addresses. Schema enforces literal 'owner'.
    const res = await POST(
      mkReq({ email: 'admin@example.com', flow: 'admin' }),
    );
    expect(res.status).toBe(400);
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
    expect(mockSupabaseServer.auth.resend).not.toHaveBeenCalled();
  });

  // ── Happy paths ──────────────────────────────────────────────────

  it('returns 200 generic + calls auth.resend with correct emailRedirectTo when flag on + owner', async () => {
    const res = await POST(
      mkReq({ email: 'owner@example.com', flow: 'owner' }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);

    expect(mockSupabaseServer.auth.resend).toHaveBeenCalledTimes(1);
    expect(mockSupabaseServer.auth.resend).toHaveBeenCalledWith({
      type: 'signup',
      email: 'owner@example.com',
      options: {
        emailRedirectTo:
          'https://app.example.com/api/auth/callback?flow=owner&next=/onboarding/pay',
      },
    });
  });

  it('returns 200 + logs when auth.resend rejects (swallowed — no enumeration leak)', async () => {
    mockSupabaseServer.auth.resend.mockRejectedValueOnce(
      new Error('supabase down'),
    );
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await POST(
      mkReq({ email: 'owner@example.com', flow: 'owner' }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  // ── Rate limiting ────────────────────────────────────────────────

  it('returns 429 when email rate-limit (2/hr) is exceeded', async () => {
    // First call (email RL) → denied.
    mockCheckRateLimit.mockResolvedValueOnce({ allowed: false, remaining: 0 });

    const res = await POST(
      mkReq({ email: 'owner@example.com', flow: 'owner' }),
    );
    expect(res.status).toBe(429);
    expect(mockSupabaseServer.auth.resend).not.toHaveBeenCalled();
  });

  it('returns 429 when IP rate-limit (5/hr) is exceeded', async () => {
    // Email allowed, IP denied.
    mockCheckRateLimit.mockResolvedValueOnce({ allowed: true, remaining: 1 });
    mockCheckRateLimit.mockResolvedValueOnce({ allowed: false, remaining: 0 });

    const res = await POST(
      mkReq({ email: 'owner@example.com', flow: 'owner' }),
    );
    expect(res.status).toBe(429);
    expect(mockSupabaseServer.auth.resend).not.toHaveBeenCalled();
  });

  it('returns 503 when strict rate-limit throws (Redis down)', async () => {
    mockCheckRateLimit.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const res = await POST(
      mkReq({ email: 'owner@example.com', flow: 'owner' }),
    );
    expect(res.status).toBe(503);
    expect(mockSupabaseServer.auth.resend).not.toHaveBeenCalled();
  });

  // ── Email normalization ───────────────────────────────────────────

  it('normalizes email (trim + lowercase) before rate-limit key and resend call', async () => {
    const res = await POST(
      mkReq({ email: '  Owner@X.COM  ', flow: 'owner' }),
    );
    expect(res.status).toBe(200);

    // Rate-limit key must use normalized email.
    const emailRlCall = mockCheckRateLimit.mock.calls.find((c) =>
      (c[0] as string).startsWith('resend-conf:email:'),
    );
    expect(emailRlCall?.[0]).toBe('resend-conf:email:owner@x.com');

    // Resend must use normalized email.
    expect(mockSupabaseServer.auth.resend).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'owner@x.com' }),
    );
  });
});
