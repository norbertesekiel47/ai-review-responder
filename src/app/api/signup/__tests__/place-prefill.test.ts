import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Hoisted mocks ───────────────────────────────────────────────────

const { mockCheckRateLimit, mockFetchBusinessDetails } = vi.hoisted(() => ({
  mockCheckRateLimit: vi.fn(),
  mockFetchBusinessDetails: vi.fn(),
}));

vi.mock('@/lib/shared/rate-limit', () => ({
  checkRateLimit: mockCheckRateLimit,
}));

vi.mock('@/lib/reviews/serpapi-prefill', () => ({
  fetchBusinessDetails: mockFetchBusinessDetails,
}));

// Flag setup before importing the route.
process.env.SELF_SERVE_SIGNUP_ENABLED = 'true';

import { GET } from '../place-prefill/route';

function mkReq(placeId?: string, ip = '203.0.113.5'): NextRequest {
  const url = placeId
    ? `https://app.example.com/api/signup/place-prefill?place_id=${encodeURIComponent(placeId)}`
    : 'https://app.example.com/api/signup/place-prefill';
  return new NextRequest(url, {
    method: 'GET',
    headers: { 'x-forwarded-for': ip },
  });
}

beforeEach(() => {
  mockCheckRateLimit.mockReset();
  mockCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 9 });

  mockFetchBusinessDetails.mockReset();
  mockFetchBusinessDetails.mockResolvedValue({
    category: 'Restaurant',
    phone: '+1 408-555-0100',
    website: 'https://example.com',
    hours: 'monday: 9am-5pm',
    fullAddress: '123 Main St',
  });

  process.env.SELF_SERVE_SIGNUP_ENABLED = 'true';
});

describe('GET /api/signup/place-prefill', () => {
  it('returns 404 when SELF_SERVE_SIGNUP_ENABLED !== "true"', async () => {
    process.env.SELF_SERVE_SIGNUP_ENABLED = 'false';
    const res = await GET(mkReq('ChIJtest1234567890ab'));
    expect(res.status).toBe(404);
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
    expect(mockFetchBusinessDetails).not.toHaveBeenCalled();
  });

  it('returns 400 when place_id query param is missing', async () => {
    const res = await GET(mkReq());
    expect(res.status).toBe(400);
    expect(mockFetchBusinessDetails).not.toHaveBeenCalled();
  });

  it('returns 400 when place_id is not a valid Google Place ID format', async () => {
    const res = await GET(mkReq('garbage'));
    expect(res.status).toBe(400);
    expect(mockFetchBusinessDetails).not.toHaveBeenCalled();
  });

  it('returns 429 when rate-limit exceeded (per-IP 10/min strict)', async () => {
    mockCheckRateLimit.mockResolvedValueOnce({ allowed: false, remaining: 0 });
    const res = await GET(mkReq('ChIJtest1234567890ab'));
    expect(res.status).toBe(429);
    expect(mockFetchBusinessDetails).not.toHaveBeenCalled();
    // Confirm key shape — IP-based.
    const firstCall = mockCheckRateLimit.mock.calls[0]!;
    expect(firstCall[0]).toBe('signup-prefill:ip:203.0.113.5');
    expect(firstCall[1]).toBe(10);
    expect(firstCall[2]).toBe(60);
    expect(firstCall[3]).toEqual({ strict: true });
  });

  it('returns 503 when rate-limit throws in strict mode (Redis down)', async () => {
    mockCheckRateLimit.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const res = await GET(mkReq('ChIJtest1234567890ab'));
    expect(res.status).toBe(503);
    expect(mockFetchBusinessDetails).not.toHaveBeenCalled();
  });

  it('returns 200 + prefill data on happy path', async () => {
    const res = await GET(mkReq('ChIJtest1234567890ab'));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.category).toBe('Restaurant');
    expect(json.website).toBe('https://example.com');
    expect(mockFetchBusinessDetails).toHaveBeenCalledWith('ChIJtest1234567890ab');
  });
});
