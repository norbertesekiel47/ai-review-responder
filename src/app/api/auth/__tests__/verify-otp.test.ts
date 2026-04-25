import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Hoisted mocks ───────────────────────────────────────────────────

const {
  mockCheckRateLimit,
  mockVerifyOtp,
  mockSignOut,
  mockCreateServerClient,
  mockSql,
} = vi.hoisted(() => {
  const sqlFn = vi.fn();
  return {
    mockCheckRateLimit: vi.fn(),
    mockVerifyOtp: vi.fn(),
    mockSignOut: vi.fn(),
    mockCreateServerClient: vi.fn(),
    mockSql: sqlFn,
  };
});

vi.mock('@/lib/shared/rate-limit', () => ({
  checkRateLimit: mockCheckRateLimit,
}));

vi.mock('@/lib/db/server', () => ({
  sql: mockSql,
  jsonb: (v: unknown) => v,
}));

vi.mock('@supabase/ssr', () => ({
  createServerClient: mockCreateServerClient,
}));

process.env.SELF_SERVE_SIGNUP_ENABLED = 'true';
process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com';
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key';

import { POST } from '../verify-otp/route';

function mkReq(
  body: unknown,
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest('https://app.example.com/api/auth/verify-otp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'https://app.example.com',
      host: 'app.example.com',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

const validBody = {
  email: 'owner@example.com',
  token: '123456',
};

beforeEach(() => {
  mockCheckRateLimit.mockReset();
  mockCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 7 });

  mockVerifyOtp.mockReset();
  mockVerifyOtp.mockResolvedValue({
    data: { user: { id: 'auth-uuid-1' } },
    error: null,
  });

  mockSignOut.mockReset();
  mockSignOut.mockResolvedValue({ error: null });

  mockSql.mockReset();
  mockSql.mockResolvedValue([{ role: 'owner' }]);

  mockCreateServerClient.mockReset();
  mockCreateServerClient.mockImplementation(() => ({
    auth: {
      verifyOtp: mockVerifyOtp,
      signOut: mockSignOut,
    },
  }));

  process.env.SELF_SERVE_SIGNUP_ENABLED = 'true';
});

describe('POST /api/auth/verify-otp', () => {
  it('returns 404 when SELF_SERVE_SIGNUP_ENABLED !== "true"', async () => {
    process.env.SELF_SERVE_SIGNUP_ENABLED = 'false';
    const res = await POST(mkReq(validBody));
    expect(res.status).toBe(404);
    expect(mockCreateServerClient).not.toHaveBeenCalled();
  });

  it('rejects cross-origin POST with 403', async () => {
    const res = await POST(
      mkReq(validBody, { origin: 'https://attacker.example.com' }),
    );
    expect(res.status).toBe(403);
    expect(mockVerifyOtp).not.toHaveBeenCalled();
  });

  it('returns 400 on invalid JSON', async () => {
    const req = new NextRequest('https://app.example.com/api/auth/verify-otp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://app.example.com',
        host: 'app.example.com',
      },
      body: 'not-json',
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_json');
  });

  it('returns 400 on bad email', async () => {
    const res = await POST(mkReq({ email: 'not-an-email', token: '123456' }));
    expect(res.status).toBe(400);
  });

  it('returns 400 on too-short token', async () => {
    const res = await POST(mkReq({ email: 'owner@example.com', token: '12' }));
    expect(res.status).toBe(400);
  });

  it('returns 400 on token with non-alphanumeric chars', async () => {
    const res = await POST(
      mkReq({ email: 'owner@example.com', token: 'abc!@#' }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 429 when per-email rate limit exhausted', async () => {
    mockCheckRateLimit.mockResolvedValueOnce({ allowed: false, remaining: 0 });
    const res = await POST(mkReq(validBody));
    expect(res.status).toBe(429);
  });

  it('returns 429 when per-IP rate limit exhausted', async () => {
    mockCheckRateLimit
      .mockResolvedValueOnce({ allowed: true, remaining: 7 }) // email pass
      .mockResolvedValueOnce({ allowed: false, remaining: 0 }); // ip fail
    const res = await POST(mkReq(validBody));
    expect(res.status).toBe(429);
  });

  it('returns 503 when rate-limit lookup throws (Redis down)', async () => {
    mockCheckRateLimit.mockRejectedValueOnce(new Error('redis down'));
    const res = await POST(mkReq(validBody));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe('rate_limit_unavailable');
  });

  it('returns 400 invalid_or_expired_code on verifyOtp error', async () => {
    mockVerifyOtp.mockResolvedValueOnce({
      data: { user: null, session: null },
      error: { message: 'Token has expired or is invalid' },
    });
    const res = await POST(mkReq(validBody));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_or_expired_code');
  });

  it('returns 500 account_incomplete + signOut when no users row', async () => {
    mockSql.mockResolvedValueOnce([]); // no users row
    const res = await POST(mkReq(validBody));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('account_incomplete');
    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });

  it('returns 500 account_incomplete + signOut when role is not owner', async () => {
    mockSql.mockResolvedValueOnce([{ role: 'admin' }]);
    const res = await POST(mkReq(validBody));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('account_incomplete');
    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });

  it('returns 200 with /onboarding/pay redirect on owner success', async () => {
    const res = await POST(mkReq(validBody));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.redirectTo).toBe('/onboarding/pay');
    expect(mockVerifyOtp).toHaveBeenCalledWith({
      email: 'owner@example.com',
      token: '123456',
      type: 'email',
    });
    expect(mockSignOut).not.toHaveBeenCalled();
  });

  it('lowercases the email passed to verifyOtp (normalizedEmailSchema)', async () => {
    const res = await POST(
      mkReq({ email: 'OWNER@Example.COM', token: '654321' }),
    );
    expect(res.status).toBe(200);
    expect(mockVerifyOtp).toHaveBeenCalledWith({
      email: 'owner@example.com',
      token: '654321',
      type: 'email',
    });
  });
});
