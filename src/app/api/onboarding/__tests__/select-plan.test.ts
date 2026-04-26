import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Hoisted mocks ───────────────────────────────────────────────────

const {
  mockCheckRateLimit,
  mockCreateServerClient,
  mockGetUser,
  mockBuildPaymentLinkUrl,
  mockSql,
} = vi.hoisted(() => {
  const sqlFn: any = vi.fn();
  sqlFn.begin = vi.fn(async (cb: (tx: any) => Promise<unknown>) => cb(sqlFn));
  return {
    mockCheckRateLimit: vi.fn(),
    mockCreateServerClient: vi.fn(),
    mockGetUser: vi.fn(),
    mockBuildPaymentLinkUrl: vi.fn(),
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

vi.mock('@/lib/payments/payment-link', () => ({
  buildPaymentLinkUrl: mockBuildPaymentLinkUrl,
}));

process.env.SELF_SERVE_SIGNUP_ENABLED = 'true';
process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com';
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key';

import { POST } from '../select-plan/route';

function mkReq(
  body: unknown,
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest('https://app.example.com/api/onboarding/select-plan', {
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

const validBody = { tier: 'founding' as const };

beforeEach(() => {
  mockCheckRateLimit.mockReset();
  mockCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 9 });

  mockGetUser.mockReset();
  mockGetUser.mockResolvedValue({
    data: { user: { id: 'auth-uuid-1' } },
  });

  mockCreateServerClient.mockReset();
  mockCreateServerClient.mockImplementation(() => ({
    auth: { getUser: mockGetUser },
  }));

  mockSql.mockReset();
  // The route now runs:
  //   1. Outside-tx lookup: SELECT b.id, b.owner_email FROM users JOIN businesses ...
  //   2. Inside-tx lock: pg_advisory_xact_lock(...)
  //   3. Inside-tx FOR UPDATE: SELECT subscription_status FROM businesses ...
  //   4. Inside-tx UPDATE: UPDATE businesses SET subscription_tier = ... — must return { count: > 0 }
  // Dispatch by template substring so individual tests can override
  // specific calls via mockResolvedValueOnce without needing to know the
  // exact ordering.
  // Postgres.js returns an Array that ALSO has a `count` property — when
  // you `await` the tagged-template, the resolved VALUE has `.count`.
  // `Object.assign(Promise.resolve(...), { count })` attaches count to the
  // promise itself, which doesn't survive `await`. Build the array first,
  // attach .count, THEN wrap in Promise.resolve.
  function pgResult(rows: unknown[], count = rows.length): Promise<unknown[]> {
    const arr = [...rows] as unknown[] & { count?: number };
    Object.defineProperty(arr, 'count', { value: count, enumerable: false });
    return Promise.resolve(arr);
  }
  mockSql.mockImplementation((tpl: TemplateStringsArray) => {
    const text = tpl.join('?');
    if (/SELECT\s+b\.id,\s*b\.owner_email/i.test(text)) {
      return pgResult([{ id: 'biz-1', owner_email: 'owner@example.com' }]);
    }
    if (text.includes('pg_advisory_xact_lock')) {
      return pgResult([{}]);
    }
    if (/SELECT\s+subscription_status[\s\S]*FOR UPDATE/i.test(text)) {
      return pgResult([{ subscription_status: 'pending_payment' }]);
    }
    if (/UPDATE\s+businesses/i.test(text)) {
      return pgResult([], 1);
    }
    return pgResult([]);
  });
  mockSql.begin = vi.fn(async (cb: (tx: any) => Promise<unknown>) => cb(mockSql));

  mockBuildPaymentLinkUrl.mockReset();
  mockBuildPaymentLinkUrl.mockReturnValue(
    'https://buy.stripe.com/test?ref=biz-1',
  );

  process.env.SELF_SERVE_SIGNUP_ENABLED = 'true';
});

describe('POST /api/onboarding/select-plan', () => {
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
    expect(mockGetUser).not.toHaveBeenCalled();
  });

  it('returns 400 on invalid JSON', async () => {
    const req = new NextRequest(
      'https://app.example.com/api/onboarding/select-plan',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'https://app.example.com',
          host: 'app.example.com',
        },
        body: 'not-json',
      },
    );
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('returns 400 on bad tier', async () => {
    const res = await POST(mkReq({ tier: 'premium' }));
    expect(res.status).toBe(400);
  });

  it('returns 401 when no Supabase session', async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: null } });
    const res = await POST(mkReq(validBody));
    expect(res.status).toBe(401);
  });

  it('returns 429 on per-auth rate-limit hit', async () => {
    mockCheckRateLimit.mockResolvedValueOnce({ allowed: false, remaining: 0 });
    const res = await POST(mkReq(validBody));
    expect(res.status).toBe(429);
  });

  it('returns 503 on Redis-down (strict)', async () => {
    mockCheckRateLimit.mockRejectedValueOnce(new Error('redis down'));
    const res = await POST(mkReq(validBody));
    expect(res.status).toBe(503);
  });

  it('returns 404 when no business attached to auth user', async () => {
    // Outside-tx lookup returns empty.
    mockSql.mockImplementationOnce(() => Promise.resolve([]));
    const res = await POST(mkReq(validBody));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('account_incomplete');
  });

  it('SQL boundary: lookup query filters on u.role = \'owner\' (admins/sales_partners get 404)', async () => {
    // The B17 #1 fix scopes the lookup to owner role. This test pins that
    // by asserting the exact filter appears in the issued SQL template —
    // even when the route returns 200 (the real defense), the SQL shape
    // is the authorization invariant.
    const res = await POST(mkReq(validBody));
    expect(res.status).toBe(200);

    const lookupCall = mockSql.mock.calls.find((c: unknown[]) => {
      const text = (c[0] as TemplateStringsArray).join('?');
      return /SELECT\s+b\.id,\s*b\.owner_email/i.test(text);
    });
    expect(lookupCall).toBeDefined();
    const lookupText = (lookupCall![0] as TemplateStringsArray).join('?');
    expect(lookupText).toMatch(/u\.role\s*=\s*'owner'/);
  });

  it('non-owner session: lookup returns empty (admin business_id wouldn\'t survive role filter) → 404', async () => {
    // Simulate an admin session reaching the route directly. The lookup
    // returns empty because the SQL filter `u.role = 'owner'` excludes
    // their row.
    mockSql.mockImplementationOnce(() => Promise.resolve([]));
    const res = await POST(mkReq(validBody));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('account_incomplete');
  });

  it('returns 409 when business is not pending_payment', async () => {
    // Lookup returns a row, then the FOR UPDATE inside tx returns active status.
    mockSql.mockImplementationOnce(() =>
      Promise.resolve([{ id: 'biz-1', owner_email: 'owner@example.com' }]),
    );
    // Override the in-tx FOR UPDATE to return 'active'.
    let calledOnce = false;
    const originalImpl = mockSql.getMockImplementation()!;
    mockSql.mockImplementation((tpl: TemplateStringsArray) => {
      const text = tpl.join('?');
      if (
        !calledOnce &&
        /SELECT\s+subscription_status[\s\S]*FOR UPDATE/i.test(text)
      ) {
        calledOnce = true;
        return Promise.resolve([{ subscription_status: 'active' }]);
      }
      return originalImpl(tpl);
    });
    const res = await POST(mkReq(validBody));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.subscriptionStatus).toBe('active');
  });

  it('returns 409 race_lost when UPDATE matches 0 rows despite pending_payment check', async () => {
    // Lookup ok, FOR UPDATE returns pending_payment, but UPDATE.count = 0 —
    // simulates the impossible-but-defended race the new code logs.
    let calledOnce = false;
    const originalImpl = mockSql.getMockImplementation()!;
    mockSql.mockImplementation((tpl: TemplateStringsArray) => {
      const text = tpl.join('?');
      if (!calledOnce && /UPDATE\s+businesses/i.test(text)) {
        calledOnce = true;
        const arr = [] as unknown[] & { count?: number };
        Object.defineProperty(arr, 'count', { value: 0, enumerable: false });
        return Promise.resolve(arr);
      }
      return originalImpl(tpl);
    });
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await POST(mkReq(validBody));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.subscriptionStatus).toBe('active');
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('returns 500 payment_link_unavailable when env var missing', async () => {
    mockBuildPaymentLinkUrl.mockReturnValueOnce(null);
    const res = await POST(mkReq(validBody));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('payment_link_unavailable');
  });

  it('returns 200 with founding payment URL on success', async () => {
    const res = await POST(mkReq({ tier: 'founding' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.paymentUrl).toBe('https://buy.stripe.com/test?ref=biz-1');
    expect(mockBuildPaymentLinkUrl).toHaveBeenCalledWith(
      'founding',
      'biz-1',
      'owner@example.com',
    );
    // UPDATE template fired with 'founding' tier bound
    const updateCall = mockSql.mock.calls.find((c: unknown[]) =>
      (c[0] as TemplateStringsArray).join('?').includes('UPDATE businesses'),
    );
    expect(updateCall).toBeDefined();
    expect(updateCall!.some((a: unknown) => a === 'founding')).toBe(true);
  });

  it('returns 200 with standard payment URL on success', async () => {
    mockBuildPaymentLinkUrl.mockReturnValueOnce(
      'https://buy.stripe.com/std?ref=biz-1',
    );
    const res = await POST(mkReq({ tier: 'standard' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.paymentUrl).toBe('https://buy.stripe.com/std?ref=biz-1');
    expect(mockBuildPaymentLinkUrl).toHaveBeenCalledWith(
      'standard',
      'biz-1',
      'owner@example.com',
    );
  });

  it('writes Cache-Control: no-store, private on every response', async () => {
    const res = await POST(mkReq(validBody));
    expect(res.headers.get('cache-control')).toBe('no-store, private');
  });
});
