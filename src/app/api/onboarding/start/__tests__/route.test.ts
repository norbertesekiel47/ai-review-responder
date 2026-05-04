import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const {
  mockCheckRateLimit,
  mockSql,
  mockGetUser,
  mockCreateServerClient,
  mockReserveBudget,
} = vi.hoisted(() => ({
  mockCheckRateLimit: vi.fn(),
  mockSql: Object.assign(vi.fn(), { begin: vi.fn(async (cb: any) => cb(mockSql)) }),
  mockGetUser: vi.fn(),
  mockCreateServerClient: vi.fn(() => ({ auth: { getUser: mockGetUser } })),
  mockReserveBudget: vi.fn(),
}));

vi.mock('@/lib/shared/rate-limit', () => ({ checkRateLimit: mockCheckRateLimit }));
vi.mock('@/lib/db/server', () => ({ sql: mockSql, jsonb: (v: unknown) => v }));
vi.mock('@supabase/ssr', () => ({ createServerClient: mockCreateServerClient }));
vi.mock('@/lib/costs/onboarding-demo-cost-guard', () => ({
  reserveOnboardingDemoBudget: mockReserveBudget,
  CostCeilingExceeded: class CostCeilingExceeded extends Error {},
}));
vi.mock('uuid', () => ({ v7: vi.fn(() => 'test-uuid-v7') }));

process.env.ONBOARDING_DEMO_ENABLED = 'true';
process.env.SELF_SERVE_SIGNUP_ENABLED = 'true';
process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com';
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key';

import { POST } from '../route';

function mkReq(body: unknown): NextRequest {
  return new NextRequest('https://app.example.com/api/onboarding/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://app.example.com' },
    body: JSON.stringify(body),
  });
}

const validBody = {
  inputMode: 'autocomplete',
  googlePlaceId: 'ChIJN1t_tDeuEmsRUsoyG83frY4',
  businessName: 'Acme Cafe',
  prefilledCategory: 'Restaurant',
};

const mockUser = { id: 'auth-uuid-123', email: 'owner@example.com' };
const pendingBizRow = {
  id: 'biz-1',
  subscription_status: 'pending_payment',
  place_id_verified: false,
  google_maps_url: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 9 });
  mockSql.mockResolvedValue([]);
  mockSql.begin = vi.fn(async (cb: any) => cb(mockSql));
  mockGetUser.mockResolvedValue({ data: { user: mockUser }, error: null });
  mockCreateServerClient.mockImplementation(() => ({ auth: { getUser: mockGetUser } }));
  mockReserveBudget.mockResolvedValue({ release: vi.fn(), date: '2026-05-03' });
  process.env.ONBOARDING_DEMO_ENABLED = 'true';
});

describe('POST /api/onboarding/start', () => {
  it('returns 404 when ONBOARDING_DEMO_ENABLED != true', async () => {
    process.env.ONBOARDING_DEMO_ENABLED = 'false';
    const res = await POST(mkReq(validBody));
    expect(res.status).toBe(404);
  });

  it('returns 200 + demoQueued=true on happy path', async () => {
    mockSql.mockResolvedValueOnce([pendingBizRow]);
    const res = await POST(mkReq(validBody));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.redirectTo).toBe('/onboarding/demo');
    expect(json.demoQueued).toBe(true);
  });

  it('returns 200 + demoQueued=false reason=cost_ceiling when cost guard trips', async () => {
    mockSql.mockResolvedValueOnce([pendingBizRow]);
    mockReserveBudget.mockRejectedValueOnce(new (await import('@/lib/costs/onboarding-demo-cost-guard')).CostCeilingExceeded('2026-05-03'));
    const res = await POST(mkReq(validBody));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.demoQueued).toBe(false);
    expect(json.reason).toBe('cost_ceiling');
  });

  it('returns 409 when subscription_status != pending_payment', async () => {
    mockSql.mockResolvedValueOnce([{ ...pendingBizRow, subscription_status: 'active' }]);
    const res = await POST(mkReq(validBody));
    expect(res.status).toBe(409);
  });

  it('returns 429 when outer rate-limit exceeded', async () => {
    mockSql.mockResolvedValueOnce([pendingBizRow]);
    mockCheckRateLimit.mockResolvedValueOnce({ allowed: false, remaining: 0 });
    const res = await POST(mkReq(validBody));
    expect(res.status).toBe(429);
  });
});
