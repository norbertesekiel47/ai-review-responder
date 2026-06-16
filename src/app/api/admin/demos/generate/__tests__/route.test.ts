import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// ── Hoisted mocks ───────────────────────────────────────────────────

const {
  mockRequireRole,
  mockRequireCurrentAal2FromSupabase,
  mockCheckRateLimit,
  mockSql,
  mockTx,
  txCalls,
} = vi.hoisted(() => {
  const txCalls: { text: string; values: unknown[] }[] = [];
  const mockTx = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    txCalls.push({ text: strings.join('?'), values });
    return Promise.resolve(Object.assign([], { count: 1 }));
  });
  const mockSql: any = vi.fn(() => Promise.resolve([]));
  mockSql.begin = vi.fn(async (cb: (tx: typeof mockTx) => Promise<unknown>) => cb(mockTx));
  return {
    mockRequireRole: vi.fn(),
    mockRequireCurrentAal2FromSupabase: vi.fn(),
    mockCheckRateLimit: vi.fn(),
    mockSql,
    mockTx,
    txCalls,
  };
});

vi.mock('@/lib/db/auth', () => ({
  requireRole: mockRequireRole,
  cookieBackedServerClient: () => ({ auth: { mfa: {} } }),
  AuthError: class AuthError extends Error {
    constructor(message: string, public readonly statusCode: number) {
      super(message);
    }
  },
}));

vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn(() => ({ auth: { mfa: {} } })),
}));
vi.mock('@/lib/auth/mfa', () => ({
  requireCurrentAal2FromSupabase: mockRequireCurrentAal2FromSupabase,
}));

vi.mock('@/lib/shared/rate-limit', () => ({
  checkRateLimit: mockCheckRateLimit,
}));

vi.mock('@/lib/db/server', () => ({
  sql: mockSql,
  jsonb: (v: unknown) => ({ __jsonb: v }),
}));

// Stub out modules that have side effects or are not relevant to unit tests
vi.mock('@/lib/reviews/url-parser', () => ({
  isPlaceId: (s: string) => s.startsWith('ChIJ'),
  extractPlaceId: () => null,
}));

vi.mock('@/lib/shared/report-caught-error', () => ({
  reportCaughtError: vi.fn(),
}));

process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com';
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://supabase.example.com';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key';
process.env.REDIS_CACHE_URL = 'redis://localhost:6379';

import { POST } from '../route';

function makeRequest(body: unknown): NextRequest {
  return new NextRequest('https://app.example.com/api/admin/demos/generate', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'https://app.example.com',
      'x-forwarded-for': '203.0.113.5',
    },
    body: JSON.stringify(body),
  });
}

const VALID_BODY = {
  googlePlaceId: 'ChIJabc123',
  businessName: 'Test Bistro',
};

describe('POST /api/admin/demos/generate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    txCalls.length = 0;
    mockRequireRole.mockResolvedValue({ id: 'admin-1', role: 'admin', accountId: null, locationId: null });
    mockRequireCurrentAal2FromSupabase.mockResolvedValue({ ok: true });
    // Rate limiter allows by default
    mockCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 49 });
  });

  it('returns 403 when MFA step-up is not satisfied (AAL2)', async () => {
    mockRequireCurrentAal2FromSupabase.mockResolvedValueOnce({ ok: false, reason: 'aal2_required' });
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(403);
    // Gate rejects BEFORE the rate-limiter — no rate-limit call must have occurred
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
    // Gate rejects BEFORE any outbox/LLM path — no DB transaction must have occurred
    expect(mockSql.begin).not.toHaveBeenCalled();
  });

  it('returns 403 for non-admin callers', async () => {
    const { AuthError } = await import('@/lib/db/auth');
    mockRequireRole.mockRejectedValueOnce(new AuthError('Forbidden', 403));
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(403);
  });

  it('returns 503 when REDIS_CACHE_URL is not set', async () => {
    const saved = process.env.REDIS_CACHE_URL;
    delete process.env.REDIS_CACHE_URL;
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(503);
    process.env.REDIS_CACHE_URL = saved;
  });

  it('returns 429 when the daily rate limit is exhausted', async () => {
    mockCheckRateLimit.mockResolvedValueOnce({ allowed: false, remaining: 0 });
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(429);
  });

  it('returns 429 when the per-admin daily quota is exhausted (F-20)', async () => {
    mockCheckRateLimit
      .mockResolvedValueOnce({ allowed: true, remaining: 49 }) // global daily OK
      .mockResolvedValueOnce({ allowed: false, remaining: 0 }); // per-admin exhausted
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(429);
    // The per-admin cap is keyed on the authenticated admin's user id.
    expect(mockCheckRateLimit).toHaveBeenCalledWith(
      'demo:generate:daily:admin:admin-1',
      20,
      86400,
      { strict: true },
    );
  });

  it('returns 429 when the per-IP minute rate limit is exhausted', async () => {
    mockCheckRateLimit
      .mockResolvedValueOnce({ allowed: true, remaining: 49 }) // global daily OK
      .mockResolvedValueOnce({ allowed: true, remaining: 19 }) // per-admin OK
      .mockResolvedValueOnce({ allowed: false, remaining: 0 }); // per-IP exhausted
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(429);
  });

  it('uses strict (fail-closed) mode on every demo-generation rate-limit check', async () => {
    await POST(makeRequest(VALID_BODY));
    expect(mockCheckRateLimit.mock.calls.length).toBeGreaterThanOrEqual(3);
    for (const call of mockCheckRateLimit.mock.calls) {
      expect(call[3]).toEqual({ strict: true });
    }
  });

  it('returns 503 (not uncapped) when a Redis runtime error propagates from the limiter', async () => {
    // Strict mode makes checkRateLimit re-throw on a Redis failure; the route must
    // map that to 503 rather than allowing uncapped, cost-sensitive generation.
    mockCheckRateLimit.mockReset();
    mockCheckRateLimit.mockRejectedValueOnce(new Error('redis connection lost'));
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(503);
    expect(mockSql.begin).not.toHaveBeenCalled();
  });

  it('returns 400 for missing required fields', async () => {
    const res = await POST(makeRequest({ businessName: 'Test' }));
    expect(res.status).toBe(400);
  });

  it('returns 201 and enqueues a generate_demo outbox job on success', async () => {
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(201);
    const body = await res.json() as { id: string; slug: string; status: string };
    expect(body.status).toBe('queued');
    expect(body.id).toBeTruthy();
    expect(body.slug).toBeTruthy();
    // Outbox transaction must have been committed
    expect(mockSql.begin).toHaveBeenCalledOnce();
    // Two inserts: prospect_demos + job_outbox
    expect(txCalls).toHaveLength(2);
    expect(txCalls[0]?.text).toMatch(/INSERT INTO prospect_demos/);
    expect(txCalls[1]?.text).toMatch(/INSERT INTO job_outbox/);
    const outboxPayloads = txCalls
      .flatMap((c) => c.values)
      .filter(
        (v): v is { __jsonb: Record<string, unknown> } =>
          !!v && typeof v === 'object' && '__jsonb' in (v as Record<string, unknown>),
      )
      .map((v) => v.__jsonb);
    expect(outboxPayloads).toHaveLength(1);
    expect(outboxPayloads[0]).toMatchObject({ googlePlaceId: 'ChIJabc123', businessName: 'Test Bistro' });
  });
});
