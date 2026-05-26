import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { mockCheckRateLimit } = vi.hoisted(() => ({
  mockCheckRateLimit: vi.fn(),
}));

vi.mock('@/lib/shared/rate-limit', () => ({
  checkRateLimit: mockCheckRateLimit,
}));

process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com';

import { POST } from '../login-attempt/route';

function req(body: unknown): NextRequest {
  return new NextRequest('https://app.example.com/api/auth/login-attempt', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'https://app.example.com',
      'x-forwarded-for': '203.0.113.5',
    },
    body: JSON.stringify(body),
  });
}

describe('POST /api/auth/login-attempt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 4 });
  });

  it('rate-limits by normalized email and IP before browser sign-in', async () => {
    const res = await POST(req({ email: ' Admin@Example.COM ' }));

    expect(res.status).toBe(204);
    expect(mockCheckRateLimit).toHaveBeenCalledWith(
      'login:admin@example.com:ip:203.0.113.5',
      5,
      15 * 60,
      { strict: true },
    );
  });

  it('returns 429 with Retry-After when login attempts are exhausted', async () => {
    mockCheckRateLimit.mockResolvedValueOnce({ allowed: false, remaining: 0 });

    const res = await POST(req({ email: 'admin@example.com' }));

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('900');
    expect(await res.json()).toEqual({ error: 'rate_limited' });
  });
});
