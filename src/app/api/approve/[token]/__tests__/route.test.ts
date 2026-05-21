import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { mockCheckRateLimit } = vi.hoisted(() => ({
  mockCheckRateLimit: vi.fn(),
}));

vi.mock('@/lib/shared/rate-limit', () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
}));

vi.mock('@/lib/db/server', () => ({
  sql: vi.fn(),
}));

function requestWithLegacyIp(): NextRequest {
  const req = new NextRequest('http://localhost:3000/api/approve/raw-token', {
    method: 'GET',
  });
  Object.defineProperty(req, 'ip', {
    value: '203.0.113.42',
    configurable: true,
  });
  return req;
}

describe('GET /api/approve/[token]', () => {
  it('rate-limits by legacy request.ip when x-forwarded-for is absent', async () => {
    mockCheckRateLimit.mockResolvedValueOnce({ allowed: false });

    const { GET } = await import('../route');
    const res = await GET(requestWithLegacyIp(), {
      params: Promise.resolve({ token: 'raw-token' }),
    });

    expect(mockCheckRateLimit).toHaveBeenCalledWith('approve:get:ip:203.0.113.42', 10, 60);
    expect(res.status).toBe(429);
  });
});
