import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Hoisted shared state ────────────────────────────────────────────

const {
  mockRequireRole,
  mockRequireCurrentAal2FromSupabase,
  mockTxCalls,
  mockInviteUserByEmail,
  mockDeleteUser,
  mockTopLevelSqlCalls,
  mockGetAdminBusinessesList,
  linkUpdateState,
} = vi.hoisted(() => ({
  mockRequireRole: vi.fn(),
  mockRequireCurrentAal2FromSupabase: vi.fn(),
  // GET delegates its two queries + row mapping to
  // src/lib/admin/businesses-list-service (admin console Phase 3). That service
  // has its own unit suite, so these route tests mock it and assert the
  // handler's OWN contract: the admin gate, query-param clamping, the response
  // envelope, and the 500 mapping.
  mockGetAdminBusinessesList: vi.fn(),
  mockTxCalls: [] as unknown[][],
  mockInviteUserByEmail: vi.fn(),
  mockDeleteUser: vi.fn(() => Promise.resolve({ data: null, error: null })),
  // Captures top-level (outside-tx) sql tagged-template calls so tests can
  // assert which SQL ran during the post-createBusinessTx provisioning steps
  // (auth_id link UPDATE + the rollback `sql.begin` block).
  mockTopLevelSqlCalls: [] as Array<{ template: string; values: unknown[] }>,
  // Test-controlled state for the auth_id link UPDATE outcome:
  //   'success' — returns [{ id: 'returned-user-id' }] (default; happy path)
  //   'zero_rows' — returns [] (simulates UPDATE matching no rows → rollback)
  //   'throws' — rejects with a synthetic error (simulates db transient)
  linkUpdateState: { mode: 'success' as 'success' | 'zero_rows' | 'throws' },
}));

// ── Mock auth ───────────────────────────────────────────────────────

vi.mock('@/lib/db/auth', () => {
  class AuthError extends Error {
    constructor(message: string, public readonly statusCode: number) {
      super(message);
      this.name = 'AuthError';
    }
  }
  return {
    requireRole: (...args: unknown[]) => mockRequireRole(...args),
    cookieBackedServerClient: () => ({ auth: { mfa: {} } }),
    AuthError,
  };
});

// ── Mock DB ─────────────────────────────────────────────────────────

vi.mock('@/lib/db/server', () => {
  const txProxy = new Proxy(() => {}, {
    apply: (_target, _thisArg, args) => {
      mockTxCalls.push(args);
      return Promise.resolve([]);
    },
  }) as unknown;

  // Top-level sql calls: route uses `sql\`UPDATE users ... RETURNING id\``
  // for the auth_id linkage step + tx-wrapped DELETE rollback if that
  // UPDATE matches 0 rows. Capture every top-level call so tests can
  // inspect the rollback shape, and route the auth-link UPDATE through
  // the test-controlled `linkUpdateState` flag.
  const sqlProxy = Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?');
      mockTopLevelSqlCalls.push({ template: text, values });
      if (/UPDATE\s+users[\s\S]*RETURNING\s+id/i.test(text)) {
        if (linkUpdateState.mode === 'throws') {
          return Promise.reject(new Error('synthetic db transient'));
        }
        if (linkUpdateState.mode === 'zero_rows') {
          return Promise.resolve([]);
        }
        return Promise.resolve([{ id: 'returned-user-id' }]);
      }
      return Promise.resolve([]);
    },
    {
      begin: async (callback: (tx: unknown) => Promise<void>) => callback(txProxy),
    },
  );
  return {
    sql: sqlProxy,
    jsonb: (v: unknown) => v,
    supabaseServer: {
      auth: {
        admin: {
          inviteUserByEmail: mockInviteUserByEmail,
          // Required for the link-failure rollback path (B17 finding #3 +
          // B18 finding #2 regression test).
          deleteUser: mockDeleteUser,
        },
      },
    },
  };
});

vi.mock('@/lib/admin/businesses-list-service', () => ({
  getAdminBusinessesList: mockGetAdminBusinessesList,
}));

vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn(() => ({ auth: { mfa: {} } })),
}));
vi.mock('@/lib/auth/mfa', () => ({
  requireCurrentAal2FromSupabase: mockRequireCurrentAal2FromSupabase,
}));

const APP_URL = 'https://app.example.com';
// inviteUserByEmail success path needs APP_URL to build redirectTo.
process.env.NEXT_PUBLIC_APP_URL = APP_URL;
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://supabase.example.com';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key';

// Import AFTER mocks + env
import { GET, POST } from '../route';
import { resetServerConfigForTests } from '@/lib/config/server';

// ── Helpers ─────────────────────────────────────────────────────────

// The whole admin payload: owner email, owner name, business name. Place,
// voice and tier moved to the invited owner's own funnel.
function makeBody(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    name: 'Test Cafe',
    ownerName: 'Jane Smith',
    ownerEmail: 'jane@testcafe.com',
    ...overrides,
  };
}

/** Flattened bound values across every inside-transaction write. */
function txValues(): unknown[] {
  return mockTxCalls.flatMap((args) => args.slice(1));
}

/** Template text of every inside-transaction write. */
function txTemplates(): string[] {
  return mockTxCalls.map((args) => (args[0] as string[]).join(''));
}

function makePostRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/admin/businesses', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', Origin: APP_URL },
  });
}

// ── Tests ────────────────────────────────────────────────────────────

describe('POST /api/admin/businesses — channel enrollment insert', () => {
  beforeEach(() => {
    mockRequireRole.mockReset();
    mockRequireCurrentAal2FromSupabase.mockReset();
    mockTxCalls.length = 0;
    mockTopLevelSqlCalls.length = 0;
    linkUpdateState.mode = 'success';
    mockRequireRole.mockResolvedValue({
      id: '01890000-0000-7000-8000-000000000001',
      name: 'Admin User',
      email: 'admin@repworth.com',
      role: 'admin',
      accountId: null,
      locationId: null,
    });
    mockRequireCurrentAal2FromSupabase.mockResolvedValue({ ok: true });
    mockInviteUserByEmail.mockReset();
    mockInviteUserByEmail.mockResolvedValue({
      data: { user: { id: 'invited-auth-uuid-123' } },
      error: null,
    });
    mockDeleteUser.mockReset();
    mockDeleteUser.mockResolvedValue({ data: null, error: null });
    process.env.NEXT_PUBLIC_APP_URL = APP_URL;
    // Cleared per-test: one case below flips them, and process.env survives
    // across cases in a file.
    delete process.env.AUTOPILOT_PURCHASABLE;
    delete process.env.AUTO_APPROVAL_ENABLED;
    process.env.FOUNDING_DEADLINE = '2027-01-01T00:00:00Z';
    process.env.STRIPE_PRICE_COPILOT_LIST = 'price_copilot_list';
    process.env.STRIPE_PRICE_COPILOT_FOUNDING = 'price_copilot_founding';
    process.env.STRIPE_PRICE_AUTOPILOT_LIST = 'price_autopilot_list';
    process.env.STRIPE_PRICE_AUTOPILOT_FOUNDING = 'price_autopilot_founding';
    process.env.STRIPE_PRICE_COPILOT_OVERAGE = 'price_copilot_overage';
    process.env.STRIPE_PRICE_AUTOPILOT_OVERAGE = 'price_autopilot_overage';
    resetServerConfigForTests();
  });

  it('returns 403 when MFA step-up is not satisfied (AAL2)', async () => {
    mockRequireCurrentAal2FromSupabase.mockResolvedValueOnce({ ok: false, reason: 'aal2_required' });
    const res = await POST(makePostRequest(makeBody()));
    expect(res.status).toBe(403);
  });

  it('inserts business + email enrollment inside a single sql.begin transaction', async () => {
    const req = makePostRequest(makeBody());
    const res = await POST(req);

    expect(res.status).toBeLessThan(400);

    const strings = (args: unknown[]) => args[0] as string[];

    const businessInsert = mockTxCalls.find((args) =>
      strings(args).join('').includes('INSERT INTO businesses'),
    );
    const enrollmentInsert = mockTxCalls.find((args) =>
      strings(args).join('').includes('INSERT INTO channel_enrollments'),
    );

    expect(businessInsert).toBeDefined();
    expect(enrollmentInsert).toBeDefined();
  });

  it('returns 201 with the business id and nothing else', async () => {
    const req = makePostRequest(makeBody());
    const res = await POST(req);

    expect(res.status).toBe(201);
    const json = await res.json() as { id: string };
    expect(typeof json.id).toBe('string');
    expect(json.id).toHaveLength(36); // UUIDv7
    // The dead `paymentUrl: null` is gone — the invited owner reaches Stripe
    // through /onboarding/pay, not through a link handed to the admin.
    expect(Object.keys(json)).toEqual(['id']);
  });

  // ── Admin onboarding contract: three fields, nothing else ──────────
  //
  // These four pin the whole point of the shrink. The admin types owner
  // email, owner name and business name; the invited owner supplies place
  // (/onboarding/start), tier (/onboarding/pay) and voice (post-payment
  // wizard) themselves, so none of that may be accepted, persisted, or
  // enqueued here.

  it('admin onboarding accepts only owner email, owner name and business name', async () => {
    const res = await POST(makePostRequest(makeBody()));
    expect(res.status).toBe(201);

    const values = txValues();
    expect(values).toContain('Test Cafe');
    expect(values).toContain('Jane Smith');
    expect(values).toContain('jane@testcafe.com');

    // Each of the three is individually required — drop any one and the
    // schema 400s before a single write.
    for (const field of ['name', 'ownerName', 'ownerEmail']) {
      mockTxCalls.length = 0;
      const body = makeBody();
      delete body[field];
      const missing = await POST(makePostRequest(body));
      expect(missing.status, `${field} must be required`).toBe(400);
      expect(mockTxCalls).toHaveLength(0);
    }
  });

  it('admin onboarding rejects a payload carrying place, voice or tier fields', async () => {
    // OnboardBusinessSchema STRIPS unknown keys (Zod's object default, and
    // the uniform posture of every schema in @/lib/shared/schemas) rather
    // than 400-ing, so a stale admin bundle still onboards its owner. The
    // rejection that matters is therefore at the persistence boundary: none
    // of these values may reach a DB write.
    const contraband = {
      googlePlaceId: 'ChIJgUbEo8cfqokR5lP9Wh_DaM',
      googlePlaceAddress: '1 Contraband Way',
      googleMapsUrl: 'https://www.google.com/maps/place/Test+Cafe/@40.7,-74.0,15z',
      website: 'https://contraband.example',
      ownerPhone: '+1 555 000 0000',
      category: 'Cafe',
      tone: 'aggressively contraband',
      productsServices: 'contraband espresso',
      staffNames: 'Contraband Carol',
      highlightFacts: 'contraband fact',
      avoidFacts: 'contraband avoid',
      sampleResponses: 'contraband sample',
      subscriptionTier: 'autopilot',
    };

    const res = await POST(makePostRequest(makeBody(contraband)));
    expect(res.status).toBe(201);

    const values = txValues();
    for (const smuggled of Object.values(contraband)) {
      expect(values, `${smuggled} must never reach a DB write`).not.toContain(smuggled);
    }
  });

  it('admin onboarding creates the business on the copilot default tier', async () => {
    // Even when the payload asks for autopilot: the tier is not the admin's
    // to choose any more, and the row is created on the safe Copilot pending
    // snapshot exactly like a self-serve signup.
    const res = await POST(
      makePostRequest(makeBody({ subscriptionTier: 'autopilot' })),
    );
    expect(res.status).toBe(201);

    const accountsInsert = mockTxCalls.find((args) =>
      (args[0] as string[]).join('').includes('INSERT INTO accounts'),
    )!;
    expect(accountsInsert).toBeDefined();
    expect(accountsInsert.slice(1)).toContain('copilot');
    expect(txValues()).not.toContain('autopilot');
  });

  it('admin onboarding enqueues no validate_place_id row', async () => {
    const res = await POST(makePostRequest(makeBody()));
    expect(res.status).toBe(201);

    expect(txTemplates().some((t) => /INSERT INTO job_outbox/i.test(t))).toBe(false);
    expect(txValues()).not.toContain('validate_place_id');
  });

  it('returns 401 when requireRole rejects', async () => {
    const { AuthError } = await import('@/lib/db/auth');
    mockRequireRole.mockRejectedValue(new AuthError('Unauthorized', 401));

    const req = makePostRequest(makeBody());
    const res = await POST(req);

    expect(res.status).toBe(401);
    expect(mockTxCalls).toHaveLength(0);
  });

  it('returns 400 for missing required fields', async () => {
    const req = makePostRequest({ name: 'Incomplete Biz' });
    const res = await POST(req);

    expect(res.status).toBe(400);
    expect(mockTxCalls).toHaveLength(0);
  });

  it('returns 400 for a malformed owner email', async () => {
    const req = makePostRequest(makeBody({ ownerEmail: 'not-an-email' }));
    const res = await POST(req);

    expect(res.status).toBe(400);
    expect(mockTxCalls).toHaveLength(0);
  });

  it('a closed Autopilot launch no longer blocks admin creation', async () => {
    // Pre-shrink this 409'd, because admin provisioning WAS a tier choice.
    // The tier decision now belongs to the owner at /onboarding/pay, so the
    // gate has nothing to say about creating the invited account.
    process.env.AUTOPILOT_PURCHASABLE = 'false';
    process.env.AUTO_APPROVAL_ENABLED = 'true';
    resetServerConfigForTests();

    const res = await POST(makePostRequest(makeBody()));

    expect(res.status).toBe(201);
    expect(mockInviteUserByEmail).toHaveBeenCalledTimes(1);
  });

  it('enrollment insert uses same ownerEmail as business insert', async () => {
    const email = 'owner@example.com';
    const req = makePostRequest(makeBody({ ownerEmail: email }));
    await POST(req);

    const enrollmentInsert = mockTxCalls.find((args) =>
      (args[0] as string[]).join('').includes('INSERT INTO channel_enrollments'),
    );
    expect(enrollmentInsert).toBeDefined();
    // The email value should appear in the interpolated args
    expect(enrollmentInsert).toContain(email);
  });

  it('calls inviteUserByEmail with lowercased email + redirectTo /reset-password', async () => {
    const req = makePostRequest(makeBody({ ownerEmail: 'OWNER@Example.COM' }));
    const res = await POST(req);
    expect(res.status).toBe(201);
    expect(mockInviteUserByEmail).toHaveBeenCalledTimes(1);
    expect(mockInviteUserByEmail).toHaveBeenCalledWith(
      'owner@example.com',
      expect.objectContaining({
        redirectTo: 'https://app.example.com/api/auth/callback?flow=owner&next=/reset-password',
      }),
    );
  });

  it('returns 500 + does NOT mention business id when invite fails (compensating delete fires)', async () => {
    mockInviteUserByEmail.mockResolvedValueOnce({
      data: { user: null },
      error: { message: 'rate-limited', status: 429 },
    });
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const req = makePostRequest(makeBody());
    const res = await POST(req);

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/owner invite/i);
    expect(body).not.toHaveProperty('id');
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('returns 403 when NEXT_PUBLIC_APP_URL is missing', async () => {
    delete process.env.NEXT_PUBLIC_APP_URL;

    const req = makePostRequest(makeBody());
    const res = await POST(req);

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('forbidden');
    expect(mockInviteUserByEmail).not.toHaveBeenCalled();
  });

  // B18 finding #2 — regression guard for the auth_id link UPDATE
  // matching 0 rows. Without the rollback the route would have returned
  // soft 201-with-warning that the UI silently ignored, leaving an
  // invited owner unable to log in. This test pins the hard-fail behavior:
  // 500 response, auth.admin.deleteUser called for the orphan invite,
  // tx-wrapped DELETEs of job_outbox + users + businesses.
  it('UPDATE auth_id matches 0 rows → 500 + auth.admin.deleteUser + tx-wrapped DB rollback', async () => {
    linkUpdateState.mode = 'zero_rows';
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const req = makePostRequest(makeBody());
    const res = await POST(req);

    // Hard-fail surfaces the problem to the admin instead of redirecting
    // them to Stripe (the previous soft-success behavior).
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/link the invited owner|rolled back/i);
    expect(body).not.toHaveProperty('id');
    expect(body).not.toHaveProperty('paymentUrl');
    expect(body).not.toHaveProperty('warning');

    // The orphan auth user gets cleaned up so the next admin retry doesn't
    // hit a Supabase 422 collision.
    expect(mockDeleteUser).toHaveBeenCalledTimes(1);
    expect(mockDeleteUser).toHaveBeenCalledWith('invited-auth-uuid-123');

    // The DB rollback runs inside `sql.begin` (so the 3 deletes commit
    // atomically). We capture the inside-tx writes via mockTxCalls.
    // Expect the rollback to issue DELETE FROM job_outbox, users, businesses
    // — in that order so FK constraints don't trip.
    const txTemplates = mockTxCalls.map((args) =>
      (args[0] as string[]).join(''),
    );
    const outboxDelete = txTemplates.findIndex((t) =>
      /DELETE FROM job_outbox/i.test(t),
    );
    const usersDelete = txTemplates.findIndex((t) =>
      /DELETE FROM users/i.test(t),
    );
    const businessesDelete = txTemplates.findIndex((t) =>
      /DELETE FROM businesses/i.test(t),
    );
    expect(outboxDelete).toBeGreaterThanOrEqual(0);
    expect(usersDelete).toBeGreaterThanOrEqual(0);
    expect(businessesDelete).toBeGreaterThanOrEqual(0);
    // FK-aware ordering — no FK CASCADE from businesses to job_outbox,
    // and users.business_id has no CASCADE either.
    expect(outboxDelete).toBeLessThan(usersDelete);
    expect(usersDelete).toBeLessThan(businessesDelete);

    consoleSpy.mockRestore();
  });

  it('UPDATE auth_id throws → same 500 + rollback path (defensive coverage)', async () => {
    linkUpdateState.mode = 'throws';
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const req = makePostRequest(makeBody());
    const res = await POST(req);

    expect(res.status).toBe(500);
    expect(mockDeleteUser).toHaveBeenCalledWith('invited-auth-uuid-123');
    consoleSpy.mockRestore();
  });
});

// ── GET /api/admin/businesses ───────────────────────────────────────
//
// The handler is thin by design (Phase 3 moved the SQL into
// businesses-list-service so the /admin/businesses server page can read the
// same data without an HTTP hop), but it still owns three things nothing else
// covers: the plain-admin gate (no AAL2 — reads are not control-plane
// mutations), the limit/offset parse+clamp, and the `{...data, limit, offset}`
// envelope the client pager depends on.

function makeGetRequest(query = ''): NextRequest {
  return new NextRequest(`http://localhost/api/admin/businesses${query}`, {
    method: 'GET',
  });
}

const LIST_FIXTURE = {
  businesses: [
    {
      id: '01890000-0000-7000-8000-0000000000aa',
      name: 'Test Cafe',
      category: 'Cafe',
      subscriptionStatus: 'active',
      lastSyncAt: '2026-08-01T10:00:00.000Z',
      pendingCount: 2,
    },
  ],
  total: 1,
};

describe('GET /api/admin/businesses', () => {
  beforeEach(() => {
    mockRequireRole.mockReset();
    mockGetAdminBusinessesList.mockReset();
    mockRequireRole.mockResolvedValue({
      id: '01890000-0000-7000-8000-000000000001',
      name: 'Admin User',
      email: 'admin@repworth.com',
      role: 'admin',
      accountId: null,
      locationId: null,
    });
    mockGetAdminBusinessesList.mockResolvedValue(LIST_FIXTURE);
  });

  it('gates on the admin role and returns 401 without querying', async () => {
    const { AuthError } = await import('@/lib/db/auth');
    mockRequireRole.mockRejectedValue(new AuthError('Unauthorized', 401));

    const res = await GET(makeGetRequest());

    expect(res.status).toBe(401);
    expect(mockGetAdminBusinessesList).not.toHaveBeenCalled();
  });

  it('returns 403 when the caller is authenticated but not an admin', async () => {
    const { AuthError } = await import('@/lib/db/auth');
    mockRequireRole.mockRejectedValue(new AuthError('Forbidden', 403));

    const res = await GET(makeGetRequest());

    expect(res.status).toBe(403);
    expect(mockGetAdminBusinessesList).not.toHaveBeenCalled();
  });

  it('requires the "admin" role specifically (not owner)', async () => {
    await GET(makeGetRequest());
    expect(mockRequireRole).toHaveBeenCalledWith(expect.anything(), 'admin');
  });

  it('returns the service payload plus the echoed limit/offset — and nothing else', async () => {
    const res = await GET(makeGetRequest());

    expect(res.status).toBe(200);
    const body = await res.json();

    // Pin the envelope: the pager reads limit/offset back off the response, so
    // an accidental extra/renamed key is a client-visible break.
    expect(Object.keys(body).sort()).toEqual(
      ['businesses', 'limit', 'offset', 'total'].sort(),
    );
    expect(body.businesses).toEqual(LIST_FIXTURE.businesses);
    expect(body.total).toBe(1);
    expect(body.limit).toBe(20);
    expect(body.offset).toBe(0);
  });

  it('defaults to limit=20 offset=0 when no query params are supplied', async () => {
    await GET(makeGetRequest());
    expect(mockGetAdminBusinessesList).toHaveBeenCalledWith(expect.anything(), {
      limit: 20,
      offset: 0,
    });
  });

  it('passes through in-range limit/offset', async () => {
    const res = await GET(makeGetRequest('?limit=50&offset=100'));

    expect(mockGetAdminBusinessesList).toHaveBeenCalledWith(expect.anything(), {
      limit: 50,
      offset: 100,
    });
    const body = await res.json();
    expect(body.limit).toBe(50);
    expect(body.offset).toBe(100);
  });

  it.each([
    // [query, expectedLimit, why]
    ['?limit=500', 100, 'clamps above the 100 ceiling'],
    ['?limit=-5', 1, 'clamps negatives to the floor of 1'],
    ['?limit=abc', 20, 'NaN falls back to the 20 default'],
    ['?limit=', 20, 'empty string falls back to the 20 default'],
  ])('limit %s → %i (%s)', async (query, expected) => {
    await GET(makeGetRequest(query));
    expect(mockGetAdminBusinessesList).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ limit: expected }),
    );
  });

  it('limit=0 resolves to 20, not 1 — parseInt yields 0 which is falsy', async () => {
    // Documents the exact operator order in the handler:
    //   (parseInt('0') || 20) === 20, then max(20,1) → 20, then min(20,100) → 20.
    // A future refactor to `?? 20` would change this to 1; pin it either way.
    await GET(makeGetRequest('?limit=0'));
    const call = mockGetAdminBusinessesList.mock.calls[0]?.[1] as { limit: number };
    expect(call.limit).toBe(20);
  });

  it.each([
    ['?offset=-10', 0, 'clamps negatives to 0'],
    ['?offset=abc', 0, 'NaN falls back to 0'],
    ['?offset=250', 250, 'has no upper bound'],
  ])('offset %s → %i (%s)', async (query, expected) => {
    await GET(makeGetRequest(query));
    expect(mockGetAdminBusinessesList).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ offset: expected }),
    );
  });

  it('echoes the CLAMPED values, not the raw query params', async () => {
    const res = await GET(makeGetRequest('?limit=9999&offset=-1'));
    const body = await res.json();
    expect(body.limit).toBe(100);
    expect(body.offset).toBe(0);
  });

  it('maps a service throw to a 500 without leaking the error message', async () => {
    mockGetAdminBusinessesList.mockRejectedValue(new Error('connection terminated'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await GET(makeGetRequest());

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: 'Failed to fetch businesses' });
    expect(JSON.stringify(body)).not.toContain('connection terminated');

    consoleSpy.mockRestore();
  });

  it('serialises an empty result set without special-casing', async () => {
    mockGetAdminBusinessesList.mockResolvedValue({ businesses: [], total: 0 });

    const res = await GET(makeGetRequest());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ businesses: [], total: 0, limit: 20, offset: 0 });
  });
});
