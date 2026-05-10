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
  account_id: 'acct-1',
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
    // Outer pre-tx SELECT.
    mockSql.mockResolvedValueOnce([pendingBizRow]);

    // Inside the tx callback we need:
    //  1. advisory lock → []
    //  2. FOR UPDATE re-read → row with NO place data (eligible to proceed)
    //  3+ subsequent UPDATE / INSERT queries → []
    mockSql.begin = vi.fn(async (cb: any) => {
      const tx: any = vi.fn(async () => []);
      tx.mockResolvedValueOnce([]); // advisory lock
      tx.mockResolvedValueOnce([pendingBizRow]); // FOR UPDATE — eligible
      return cb(tx);
    });

    const res = await POST(mkReq(validBody));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.redirectTo).toBe('/onboarding/demo');
    expect(json.demoQueued).toBe(true);
  });

  it('updates placeholder account display_name when start captures the business name', async () => {
    mockSql.mockResolvedValueOnce([pendingBizRow]);

    const txCalls: string[] = [];
    mockSql.begin = vi.fn(async (cb: any) => {
      const tx: any = vi.fn(async (strings: TemplateStringsArray) => {
        const text = strings.join('?');
        txCalls.push(text);
        if (text.includes('FOR UPDATE')) return [pendingBizRow];
        return [];
      });
      return cb(tx);
    });

    const res = await POST(mkReq(validBody));

    expect(res.status).toBe(200);
    expect(txCalls.some((text) => text.includes('UPDATE accounts'))).toBe(true);
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

  it('idempotency loser inside tx: releases reservation and reports demoQueued:false', async () => {
    // Outer pre-tx SELECT: pending_payment, no place data → eligible.
    mockSql.mockResolvedValueOnce([pendingBizRow]);

    // Track tx behavior: simulate the FOR UPDATE returning a row that
    // ALREADY has place_id_verified=true (concurrent /start won the race).
    // The route should hit the early-return inside the tx callback, commit
    // the empty tx, then post-tx detect demoInserted=false and release the
    // reservation.
    const releaseSpy = vi.fn().mockResolvedValue(undefined);
    mockReserveBudget.mockResolvedValueOnce({ release: releaseSpy, date: '2026-05-04' });

    mockSql.begin = vi.fn(async (cb: any) => {
      // Inside the tx callback the route runs:
      //  1. advisory lock → []
      //  2. FOR UPDATE re-read → returns row with place_id_verified=true
      //     (loser path) → callback returns early.
      const tx: any = vi.fn(async () => []);
      tx.mockResolvedValueOnce([]);
      tx.mockResolvedValueOnce([{ ...pendingBizRow, place_id_verified: true }]);
      return cb(tx);
    });

    const res = await POST(mkReq(validBody));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.demoQueued).toBe(false);
    expect(releaseSpy).toHaveBeenCalledTimes(1);
  });
});
