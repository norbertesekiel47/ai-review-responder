import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Hoisted mocks ───────────────────────────────────────────────────

const {
  mockCheckRateLimit,
  mockFetchBusinessDetails,
  mockSql,
  mockGetUser,
  mockCreateServerClient,
} = vi.hoisted(() => {
  const getUser = vi.fn();
  return {
    mockCheckRateLimit: vi.fn(),
    mockFetchBusinessDetails: vi.fn(),
    mockSql: vi.fn(),
    mockGetUser: getUser,
    mockCreateServerClient: vi.fn(() => ({ auth: { getUser } })),
  };
});

vi.mock('@/lib/shared/rate-limit', () => ({
  checkRateLimit: mockCheckRateLimit,
}));

vi.mock('@/lib/reviews/serpapi-prefill', () => ({
  fetchBusinessDetails: mockFetchBusinessDetails,
}));

vi.mock('@/lib/db/server', () => ({ sql: mockSql }));

vi.mock('@supabase/ssr', () => ({ createServerClient: mockCreateServerClient }));

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key';

import { GET } from '../place-prefill/route';

const AUTH_ID = 'auth-uuid-123';

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

  mockSql.mockReset();
  // Default fixture: an owner still walking the funnel (pre-activation).
  mockSql.mockResolvedValue([
    { role: 'owner', subscription_status: 'pending_payment' },
  ]);

  mockGetUser.mockReset();
  mockGetUser.mockResolvedValue({ data: { user: { id: AUTH_ID } }, error: null });

  mockCreateServerClient.mockReset();
  mockCreateServerClient.mockImplementation(() => ({ auth: { getUser: mockGetUser } }));
});

describe('GET /api/signup/place-prefill', () => {
  // ── Auth (replaced the SELF_SERVE_SIGNUP_ENABLED gate) ─────────────

  it('place-prefill rejects an anonymous GET', async () => {
    // This route was deliberately unauthenticated, gated only by the flag +
    // a per-IP limit. The flag now means "strangers may mint accounts", so
    // dropping it without adding auth would have left a SerpAPI-billed
    // endpoint permanently public. The session IS the gate.
    mockGetUser.mockResolvedValueOnce({ data: { user: null }, error: null });

    const res = await GET(mkReq('ChIJtest1234567890ab'));

    expect(res.status).toBe(401);
    expect(mockSql).not.toHaveBeenCalled();
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
    expect(mockFetchBusinessDetails).not.toHaveBeenCalled();
  });

  it('returns 404 when the session is not an owner', async () => {
    // Owner-only filter at the SQL boundary → an admin/sales_partner session
    // reads as "no row".
    mockSql.mockResolvedValueOnce([]);

    const res = await GET(mkReq('ChIJtest1234567890ab'));

    expect(res.status).toBe(404);
    expect(mockFetchBusinessDetails).not.toHaveBeenCalled();

    const callArgs = mockSql.mock.calls[0] as unknown[];
    const query = (callArgs[0] as TemplateStringsArray).join('?');
    expect(query).toContain("u.role = 'owner'");
    expect(callArgs.slice(1)).toContain(AUTH_ID);
  });

  it('place-prefill rejects an owner whose account is not in a pre-activation state', async () => {
    // An activated owner has no business calling a signup-funnel prefill;
    // keeping the SerpAPI spend scoped to accounts actually walking the funnel
    // is the point of the state half of the guard.
    mockSql.mockResolvedValueOnce([
      { role: 'owner', subscription_status: 'active' },
    ]);

    const res = await GET(mkReq('ChIJtest1234567890ab'));

    expect(res.status).toBe(403);
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
    expect(mockFetchBusinessDetails).not.toHaveBeenCalled();
  });

  // ── Query validation ───────────────────────────────────────────────

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

  // ── Rate limits ────────────────────────────────────────────────────

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

  it('place-prefill enforces a per-auth-id rate limit', async () => {
    // The per-IP cap alone lets one owner behind rotating egress IPs (mobile
    // NAT, VPN) spend uncapped. The identity-scoped ceiling mirrors the admin
    // prefill route.
    mockCheckRateLimit
      .mockResolvedValueOnce({ allowed: true, remaining: 9 }) // per-IP passes
      .mockResolvedValueOnce({ allowed: false, remaining: 0 }); // per-auth-id trips

    const res = await GET(mkReq('ChIJtest1234567890ab'));

    expect(res.status).toBe(429);
    expect(mockFetchBusinessDetails).not.toHaveBeenCalled();
    expect(mockCheckRateLimit).toHaveBeenCalledTimes(2);
    const authCall = mockCheckRateLimit.mock.calls[1]!;
    expect(authCall[0]).toBe(`prefill:minute:${AUTH_ID}`);
    expect(authCall[1]).toBe(10);
    expect(authCall[2]).toBe(60);
    expect(authCall[3]).toEqual({ strict: true });
  });

  it('returns 503 when rate-limit throws in strict mode (Redis down)', async () => {
    mockCheckRateLimit.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const res = await GET(mkReq('ChIJtest1234567890ab'));
    expect(res.status).toBe(503);
    expect(mockFetchBusinessDetails).not.toHaveBeenCalled();
  });

  it('returns 503 when the per-auth-id limit throws in strict mode (Redis down)', async () => {
    mockCheckRateLimit
      .mockResolvedValueOnce({ allowed: true, remaining: 9 })
      .mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const res = await GET(mkReq('ChIJtest1234567890ab'));
    expect(res.status).toBe(503);
    expect(mockFetchBusinessDetails).not.toHaveBeenCalled();
  });

  // ── Happy path ─────────────────────────────────────────────────────

  it('returns 200 + prefill data on happy path', async () => {
    const res = await GET(mkReq('ChIJtest1234567890ab'));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.category).toBe('Restaurant');
    expect(json.website).toBe('https://example.com');
    expect(mockFetchBusinessDetails).toHaveBeenCalledWith(expect.anything(), 'ChIJtest1234567890ab');
  });

  it('serves a pre-activation owner when SELF_SERVE_SIGNUP_ENABLED is off', async () => {
    // The flag no longer gates this route at all — auth + role + state do.
    process.env.SELF_SERVE_SIGNUP_ENABLED = 'false';
    const res = await GET(mkReq('ChIJtest1234567890ab'));
    expect(res.status).toBe(200);
    expect(mockFetchBusinessDetails).toHaveBeenCalledTimes(1);
  });
});
