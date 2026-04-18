import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const {
  mockRequireRole,
  mockCheckRateLimit,
  mockFetchBusinessDetails,
  mockIsPlaceId,
} = vi.hoisted(() => ({
  mockRequireRole: vi.fn(),
  mockCheckRateLimit: vi.fn(),
  mockFetchBusinessDetails: vi.fn(),
  mockIsPlaceId: vi.fn(),
}));

vi.mock('@/lib/db/auth', () => {
  class AuthError extends Error {
    constructor(message: string, public readonly statusCode: number) {
      super(message);
      this.name = 'AuthError';
    }
  }
  return {
    requireRole: (...args: unknown[]) => mockRequireRole(...args),
    AuthError,
  };
});

vi.mock('@/lib/shared/rate-limit', () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
}));

vi.mock('@/lib/reviews/serpapi-prefill', () => ({
  fetchBusinessDetails: (...args: unknown[]) => mockFetchBusinessDetails(...args),
}));

vi.mock('@/lib/reviews/url-parser', () => ({
  isPlaceId: (...args: unknown[]) => mockIsPlaceId(...args),
}));

function makeRequest(url: string): NextRequest {
  return new NextRequest(`http://localhost:3000${url}`);
}

describe('GET /api/admin/businesses/prefill', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireRole.mockResolvedValue({
      id: 'admin-1',
      role: 'admin',
      businessId: null,
    });
    mockCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 10 });
    mockIsPlaceId.mockReturnValue(true);
    mockFetchBusinessDetails.mockResolvedValue({
      category: 'Restaurant',
      phone: '+1 555',
      website: 'https://example.com',
      hours: null,
      fullAddress: null,
    });
  });

  it('returns 200 with prefill JSON on happy path', async () => {
    const { GET } = await import('../route');
    const res = await GET(makeRequest('/api/admin/businesses/prefill?place_id=ChIJ_abc'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.category).toBe('Restaurant');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('returns 400 when place_id query param is missing', async () => {
    const { GET } = await import('../route');
    const res = await GET(makeRequest('/api/admin/businesses/prefill'));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/place_id/);
  });

  it('returns 400 when place_id is malformed (fails isPlaceId)', async () => {
    mockIsPlaceId.mockReturnValue(false);
    const { GET } = await import('../route');
    const res = await GET(makeRequest('/api/admin/businesses/prefill?place_id=not-a-place-id'));
    expect(res.status).toBe(400);
  });

  it('returns 401 when auth fails', async () => {
    const { AuthError } = await import('@/lib/db/auth');
    mockRequireRole.mockRejectedValue(new AuthError('Unauthenticated', 401));
    const { GET } = await import('../route');
    const res = await GET(makeRequest('/api/admin/businesses/prefill?place_id=ChIJ_abc'));
    expect(res.status).toBe(401);
  });

  it('returns 403 when user has wrong role', async () => {
    const { AuthError } = await import('@/lib/db/auth');
    mockRequireRole.mockRejectedValue(new AuthError('Forbidden', 403));
    const { GET } = await import('../route');
    const res = await GET(makeRequest('/api/admin/businesses/prefill?place_id=ChIJ_abc'));
    expect(res.status).toBe(403);
  });

  it('returns 429 when rate limit is exceeded', async () => {
    mockCheckRateLimit.mockResolvedValue({ allowed: false, remaining: 0 });
    const { GET } = await import('../route');
    const res = await GET(makeRequest('/api/admin/businesses/prefill?place_id=ChIJ_abc'));
    expect(res.status).toBe(429);
  });

  it('returns 503 when rate limiter throws (Redis unavailable in strict mode)', async () => {
    mockCheckRateLimit.mockRejectedValue(new Error('[rate-limit] REDIS_CACHE_URL not configured — cannot enforce budget in strict mode'));
    const { GET } = await import('../route');
    const res = await GET(makeRequest('/api/admin/businesses/prefill?place_id=ChIJ_abc'));
    expect(res.status).toBe(503);
  });

  it('uses rate limit key scoped per user', async () => {
    const { GET } = await import('../route');
    await GET(makeRequest('/api/admin/businesses/prefill?place_id=ChIJ_abc'));
    const callArgs = mockCheckRateLimit.mock.calls[0];
    expect(callArgs?.[0]).toBe('prefill:minute:admin-1');
    expect(callArgs?.[1]).toBe(10);
    expect(callArgs?.[2]).toBe(60);
    expect(callArgs?.[3]).toEqual({ strict: true });
  });
});
