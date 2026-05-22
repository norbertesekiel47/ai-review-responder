import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Hoisted mocks ───────────────────────────────────────────────────

const {
  mockSql,
  mockGetUser,
  mockCreateServerClient,
  mockCheckRateLimit,
  mockStripeCheckoutRetrieve,
} = vi.hoisted(() => {
  const sqlFn = vi.fn();
  const getUser = vi.fn();
  return {
    mockSql: sqlFn,
    mockGetUser: getUser,
    mockCreateServerClient: vi.fn(() => ({
      auth: { getUser },
    })),
    mockCheckRateLimit: vi.fn(),
    mockStripeCheckoutRetrieve: vi.fn(),
  };
});

vi.mock('@/lib/db/server', () => ({
  sql: mockSql,
  jsonb: (v: unknown) => v,
}));

vi.mock('@supabase/ssr', () => ({
  createServerClient: mockCreateServerClient,
}));

vi.mock('@/lib/shared/rate-limit', () => ({
  checkRateLimit: mockCheckRateLimit,
}));

vi.mock('stripe', () => ({
  default: class FakeStripe {
    checkout = {
      sessions: {
        retrieve: mockStripeCheckoutRetrieve,
      },
    };
  },
}));

// Flag + env setup — must be set before importing the route.
process.env.SELF_SERVE_SIGNUP_ENABLED = 'true';
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key';

// Import AFTER mocks + env.
import { GET } from '../signup-status/route';

// ── Helpers ─────────────────────────────────────────────────────────

function mkReq(): NextRequest {
  return new NextRequest('https://app.example.com/api/auth/signup-status');
}

function pgResult(rows: unknown[], count = rows.length): unknown[] {
  const result = [...rows] as unknown[] & { count?: number };
  Object.defineProperty(result, 'count', { value: count, enumerable: false });
  return result;
}

const mockUser = {
  id: 'auth-uuid-123',
  email: 'owner@example.com',
};

beforeEach(() => {
  mockSql.mockReset();
  mockSql.mockResolvedValue([]);
  (mockSql as any).begin = vi.fn(
    async (cb: (tx: typeof mockSql) => Promise<unknown>) => cb(mockSql),
  );

  mockGetUser.mockReset();
  mockGetUser.mockResolvedValue({ data: { user: mockUser }, error: null });

  mockCreateServerClient.mockReset();
  mockCreateServerClient.mockImplementation(() => ({
    auth: { getUser: mockGetUser },
  }));

  mockCheckRateLimit.mockReset();
  mockCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 30 });

  mockStripeCheckoutRetrieve.mockReset();

  process.env.SELF_SERVE_SIGNUP_ENABLED = 'true';
  process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
});

// ── Tests ────────────────────────────────────────────────────────────

describe('GET /api/auth/signup-status', () => {
  it('returns 404 when SELF_SERVE_SIGNUP_ENABLED !== "true"', async () => {
    process.env.SELF_SERVE_SIGNUP_ENABLED = 'false';
    const res = await GET(mkReq());
    expect(res.status).toBe(404);
    expect(mockGetUser).not.toHaveBeenCalled();
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('returns 401 when no session (getUser returns { user: null })', async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: null }, error: null });
    const res = await GET(mkReq());
    expect(res.status).toBe(401);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('returns 404 account_incomplete when no users row for auth_id', async () => {
    // sql returns empty array — no matching users + businesses join row.
    mockSql.mockResolvedValueOnce([]);
    const res = await GET(mkReq());
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe('account_incomplete');
  });

  it('returns 404 account_incomplete when authenticated row is not owner', async () => {
    mockSql.mockResolvedValueOnce([
      rowFor({ role: 'sales_partner', subscription_status: 'active' }),
    ]);

    const res = await GET(mkReq());

    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe('account_incomplete');
  });

  // Helper — the route now selects raw columns and computes businessOnboarded
  // in JS (instead of SQL). Tests provide the raw columns directly.
  function rowFor(opts: {
    account_id?: string;
    subscription_status?: string;
    role?: string;
    place_id_verified?: boolean;
    google_maps_url?: string | null;
    subscription_activated_at?: Date | null;
    updated_at?: Date;
  } = {}) {
    return {
      account_id: opts.account_id ?? 'acct-uuid-123',
      subscription_status: opts.subscription_status ?? 'pending_payment',
      role: opts.role ?? 'owner',
      place_id_verified: opts.place_id_verified ?? false,
      google_maps_url: opts.google_maps_url ?? null,
      subscription_activated_at: opts.subscription_activated_at ?? null,
      updated_at: opts.updated_at ?? new Date(),
    };
  }

  it('returns 200 + { subscriptionStatus, role, businessOnboarded } with no-store header on success', async () => {
    mockSql.mockResolvedValueOnce([rowFor({ subscription_status: 'pending_payment' })]);
    const res = await GET(mkReq());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.subscriptionStatus).toBe('pending_payment');
    expect(json.role).toBe('owner');
    expect(json.businessOnboarded).toBe(false);
    expect(res.headers.get('Cache-Control')).toBe('no-store, private');
  });

  it('returns subscriptionStatus "active" when Stripe has flipped the business', async () => {
    mockSql.mockResolvedValueOnce([rowFor({ subscription_status: 'active' })]);
    const res = await GET(mkReq());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.subscriptionStatus).toBe('active');
  });

  it('enqueues Checkout Session reconciliation instead of calling Stripe inline when the webhook has not updated Supabase yet', async () => {
    const accountId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    mockStripeCheckoutRetrieve.mockResolvedValueOnce({
      id: 'cs_test_paid',
      client_reference_id: accountId,
      mode: 'subscription',
      payment_status: 'paid',
      customer: 'cus_paid',
      subscription: 'sub_paid',
    });
    mockSql.mockResolvedValueOnce(
      pgResult([rowFor({ account_id: accountId, subscription_status: 'pending_payment' })]),
    );

    const res = await GET(
      new NextRequest(
        'https://app.example.com/api/auth/signup-status?session_id=cs_test_paid',
      ),
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.subscriptionStatus).toBe('pending_payment');
    expect(mockStripeCheckoutRetrieve).not.toHaveBeenCalled();

    const sqlCalls = mockSql.mock.calls.map((call: unknown[]) => ({
      text: (call[0] as TemplateStringsArray).join('?'),
      values: call.slice(1),
    }));
    expect(
      sqlCalls.some(
        (call) =>
          call.text.includes('INSERT INTO job_outbox') &&
          call.values.includes('stripe_checkout_session_reconcile') &&
          call.values.some((value) =>
            typeof value === 'object' &&
            value !== null &&
            (value as Record<string, unknown>).checkout_session_id === 'cs_test_paid' &&
            (value as Record<string, unknown>).account_id === accountId,
          ),
      ),
    ).toBe(true);
    expect(
      sqlCalls.some(
        (call) =>
          /UPDATE\s+accounts/i.test(call.text) &&
          /subscription_status\s*=\s*'active'/i.test(call.text),
      ),
    ).toBe(false);
  });

  it('legacy flow: businessOnboarded=true when place_id_verified is true (placeAutocomplete path)', async () => {
    delete process.env.ONBOARDING_DEMO_ENABLED;
    mockSql.mockResolvedValueOnce([
      rowFor({ subscription_status: 'active', place_id_verified: true }),
    ]);
    const res = await GET(mkReq());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.businessOnboarded).toBe(true);
  });

  it('legacy flow: businessOnboarded=true when google_maps_url is set (URL fallback path)', async () => {
    delete process.env.ONBOARDING_DEMO_ENABLED;
    mockSql.mockResolvedValueOnce([
      rowFor({ subscription_status: 'active', google_maps_url: 'https://maps.google.com/...' }),
    ]);
    const res = await GET(mkReq());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.businessOnboarded).toBe(true);
  });

  it('legacy flow: businessOnboarded=false when both place_id_verified=false and google_maps_url=null', async () => {
    delete process.env.ONBOARDING_DEMO_ENABLED;
    mockSql.mockResolvedValueOnce([rowFor({ subscription_status: 'pending_payment' })]);
    const res = await GET(mkReq());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.businessOnboarded).toBe(false);
  });

  it('demo flow: businessOnboarded=false when subscription active but updated_at = subscription_activated_at (Stripe just fired, wizard not yet run)', async () => {
    process.env.ONBOARDING_DEMO_ENABLED = 'true';
    const activatedAt = new Date('2026-05-04T12:00:00Z');
    mockSql.mockResolvedValueOnce([
      rowFor({
        subscription_status: 'active',
        place_id_verified: true, // /start set this BEFORE Stripe — must NOT be treated as "onboarded"
        subscription_activated_at: activatedAt,
        updated_at: activatedAt,
      }),
    ]);
    const res = await GET(mkReq());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.businessOnboarded).toBe(false);
    delete process.env.ONBOARDING_DEMO_ENABLED;
  });

  it('demo flow: businessOnboarded=true when updated_at > subscription_activated_at + 2s (post-pay wizard ran)', async () => {
    process.env.ONBOARDING_DEMO_ENABLED = 'true';
    const activatedAt = new Date('2026-05-04T12:00:00Z');
    const wizardSubmitAt = new Date(activatedAt.getTime() + 5_000); // 5s later
    mockSql.mockResolvedValueOnce([
      rowFor({
        subscription_status: 'active',
        place_id_verified: true,
        subscription_activated_at: activatedAt,
        updated_at: wizardSubmitAt,
      }),
    ]);
    const res = await GET(mkReq());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.businessOnboarded).toBe(true);
    delete process.env.ONBOARDING_DEMO_ENABLED;
  });

  it('passes the session auth_id as an interpolated value to sql (scoped query)', async () => {
    mockSql.mockResolvedValueOnce([rowFor({ subscription_status: 'active' })]);
    await GET(mkReq());
    expect(mockSql).toHaveBeenCalledTimes(1);
    // Tagged-template call: mockSql(strings, ...values).
    // The auth_id ('auth-uuid-123') must appear in the spread values (index 1+).
    const callArgs = mockSql.mock.calls[0] as unknown[];
    // values are at index 1 onward (index 0 is TemplateStringsArray).
    const interpolatedValues = callArgs.slice(1);
    expect(interpolatedValues).toContain('auth-uuid-123');
  });

  it('SQL boundary: lookup filters on u.role = owner', async () => {
    mockSql.mockResolvedValueOnce([rowFor()]);

    await GET(mkReq());

    const callArgs = mockSql.mock.calls[0] as unknown[];
    const query = (callArgs[0] as TemplateStringsArray).join('?');
    const interpolatedValues = callArgs.slice(1);
    expect(query).toContain('u.role =');
    expect(interpolatedValues).toContain('owner');
  });

  it('returns 429 when rate-limit exceeded (30/min per authId)', async () => {
    mockCheckRateLimit.mockResolvedValueOnce({ allowed: false, remaining: 0 });
    const res = await GET(mkReq());
    expect(res.status).toBe(429);
    expect(mockSql).not.toHaveBeenCalled();
    // Confirm key shape.
    const firstCall = mockCheckRateLimit.mock.calls[0]!;
    expect(firstCall[0]).toBe('signup-status:auth:auth-uuid-123');
    expect(firstCall[1]).toBe(30);
    expect(firstCall[2]).toBe(60);
  });

  it('soft-fails (allows request) when rate-limit throws (Redis down)', async () => {
    // Non-strict: Redis outage must NOT 503 the polling endpoint.
    mockCheckRateLimit.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    mockSql.mockResolvedValueOnce([
      rowFor({ subscription_status: 'active', place_id_verified: true }),
    ]);
    const res = await GET(mkReq());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.subscriptionStatus).toBe('active');
  });
});
