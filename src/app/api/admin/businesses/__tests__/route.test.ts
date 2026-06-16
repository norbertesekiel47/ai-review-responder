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
  linkUpdateState,
} = vi.hoisted(() => ({
  mockRequireRole: vi.fn(),
  mockRequireCurrentAal2FromSupabase: vi.fn(),
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
import { POST } from '../route';

// ── Helpers ─────────────────────────────────────────────────────────

// Minimum valid Place ID: starts with letter, 20+ base64url chars
const VALID_PLACE_ID = 'ChIJgUbEo8cfqokR5lP9Wh_DaM';

function makeBody(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    name: 'Test Cafe',
    ownerName: 'Jane Smith',
    ownerEmail: 'jane@testcafe.com',
    googlePlaceId: VALID_PLACE_ID,
    ...overrides,
  };
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

  it('returns 201 with id and paymentUrl on success', async () => {
    const req = makePostRequest(makeBody());
    const res = await POST(req);

    expect(res.status).toBe(201);
    const json = await res.json() as { id: string; paymentUrl: string | null };
    expect(typeof json.id).toBe('string');
    expect(json.id).toHaveLength(36); // UUIDv7
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

  it('returns 400 for invalid Place ID format', async () => {
    const req = makePostRequest(makeBody({ googlePlaceId: 'bad-id' }));
    const res = await POST(req);

    expect(res.status).toBe(400);
    expect(mockTxCalls).toHaveLength(0);
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
