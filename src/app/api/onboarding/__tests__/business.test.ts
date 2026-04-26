import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Hoisted mocks ───────────────────────────────────────────────────

const {
  mockCheckRateLimit,
  mockSql,
  mockGetUser,
  mockCreateServerClient,
} = vi.hoisted(() => {
  const sqlFn: any = vi.fn();
  sqlFn.begin = vi.fn(async (cb: (tx: any) => Promise<unknown>) => cb(sqlFn));
  const getUser = vi.fn();
  return {
    mockCheckRateLimit: vi.fn(),
    mockSql: sqlFn,
    mockGetUser: getUser,
    mockCreateServerClient: vi.fn(() => ({
      auth: { getUser },
    })),
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

vi.mock('uuid', () => ({ v7: vi.fn(() => 'test-uuid-v7') }));

// Flag + env setup — must be set before importing the route.
process.env.SELF_SERVE_SIGNUP_ENABLED = 'true';
process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com';
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key';

import { POST } from '../business/route';

function mkReq(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('https://app.example.com/api/onboarding/business', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'https://app.example.com',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

const validBody = {
  businessName: 'Acme Cafe',
  googlePlaceId: 'ChIJtest1234567890ab',
  category: 'Restaurant',
  productsServices: 'Coffee, pastries',
  staffNames: 'Jane, John',
  highlightFacts: 'Open 24/7',
  avoidFacts: 'No parking',
  sampleResponses: 'Thank you for visiting!',
  website: 'https://example.com',
  tone: 'casual',
};

const mockUser = { id: 'auth-uuid-123', email: 'owner@example.com' };

const activeBizRow = {
  id: 'biz-1',
  subscription_status: 'active',
  place_id_verified: false,
  google_maps_url: null,
};

beforeEach(() => {
  mockCheckRateLimit.mockReset();
  mockCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 9 });

  mockSql.mockReset();
  mockSql.mockResolvedValue([]);
  mockSql.begin = vi.fn(async (cb: (tx: any) => Promise<unknown>) => cb(mockSql));

  mockGetUser.mockReset();
  mockGetUser.mockResolvedValue({ data: { user: mockUser }, error: null });

  mockCreateServerClient.mockReset();
  mockCreateServerClient.mockImplementation(() => ({
    auth: { getUser: mockGetUser },
  }));

  process.env.SELF_SERVE_SIGNUP_ENABLED = 'true';
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com';
});

describe('POST /api/onboarding/business', () => {
  it('returns 404 when SELF_SERVE_SIGNUP_ENABLED !== "true"', async () => {
    process.env.SELF_SERVE_SIGNUP_ENABLED = 'false';
    const res = await POST(mkReq(validBody));
    expect(res.status).toBe(404);
    expect(mockGetUser).not.toHaveBeenCalled();
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
  });

  it('returns 403 when Origin header mismatches NEXT_PUBLIC_APP_URL', async () => {
    const res = await POST(mkReq(validBody, { origin: 'https://evil.example.com' }));
    expect(res.status).toBe(403);
    expect(mockGetUser).not.toHaveBeenCalled();
  });

  it('returns 401 when no session cookie (getUser returns { user: null })', async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: null }, error: null });
    const res = await POST(mkReq(validBody));
    expect(res.status).toBe(401);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('returns 404 account_incomplete when no users row exists for auth_id', async () => {
    mockSql.mockResolvedValueOnce([]); // SELECT u JOIN b returns nothing
    const res = await POST(mkReq(validBody));
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe('account_incomplete');
  });

  it('SQL boundary: lookup query filters on u.role = \'owner\' (B17 #1 — middleware does NOT gate /api/onboarding/*)', async () => {
    mockSql.mockResolvedValueOnce([activeBizRow]);
    mockSql.mockResolvedValueOnce([]); // pg_advisory_xact_lock
    mockSql.mockResolvedValueOnce([activeBizRow]); // FOR UPDATE
    mockSql.mockResolvedValueOnce([]); // UPDATE
    mockSql.mockResolvedValueOnce([]); // INSERT outbox
    const res = await POST(mkReq(validBody));
    expect(res.status).toBe(200);

    const lookupCall = mockSql.mock.calls.find((c: any[]) => {
      const text = (c[0] as TemplateStringsArray).join('?');
      return text.includes('SELECT b.id, b.subscription_status') &&
        text.includes('FROM users u');
    });
    expect(lookupCall).toBeDefined();
    const lookupText = (lookupCall![0] as TemplateStringsArray).join('?');
    expect(lookupText).toMatch(/u\.role\s*=\s*'owner'/);
  });

  it('non-owner session: lookup returns empty (filter excludes admin/sales_partner rows) → 404', async () => {
    // The SQL filter `u.role = 'owner'` would return empty for an admin/
    // sales_partner session. We simulate that by returning [] from the lookup.
    mockSql.mockResolvedValueOnce([]);
    const res = await POST(mkReq(validBody));
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe('account_incomplete');
  });

  it('returns 409 subscription_inactive when business is pending_payment', async () => {
    mockSql.mockResolvedValueOnce([
      { ...activeBizRow, subscription_status: 'pending_payment' },
    ]);
    const res = await POST(mkReq(validBody));
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe('subscription_inactive');
    expect(json.subscriptionStatus).toBe('pending_payment');
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
  });

  it('returns 409 already_onboarded when place_id_verified=true', async () => {
    mockSql.mockResolvedValueOnce([
      { ...activeBizRow, place_id_verified: true },
    ]);
    const res = await POST(mkReq(validBody));
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe('already_onboarded');
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
  });

  it('returns 409 already_onboarded when google_maps_url is set', async () => {
    mockSql.mockResolvedValueOnce([
      { ...activeBizRow, google_maps_url: 'https://maps.google.com/?cid=1' },
    ]);
    const res = await POST(mkReq(validBody));
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe('already_onboarded');
  });

  it('returns 400 invalid_body when body fails BusinessOnboardingSchema XOR refine', async () => {
    mockSql.mockResolvedValueOnce([activeBizRow]);
    const { businessName, googlePlaceId: _drop, ...rest } = validBody;
    void _drop;
    const res = await POST(mkReq({ businessName, ...rest })); // neither placeId nor mapsUrl
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('invalid_body');
  });

  it('returns 200 + UPDATEs businesses + INSERTs sync_reviews outbox on verified placeId path', async () => {
    mockSql.mockResolvedValueOnce([activeBizRow]); // initial JOIN read
    mockSql.mockResolvedValueOnce([]); // pg_advisory_xact_lock
    mockSql.mockResolvedValueOnce([activeBizRow]); // FOR UPDATE re-read
    mockSql.mockResolvedValueOnce([]); // UPDATE businesses
    mockSql.mockResolvedValueOnce([]); // INSERT job_outbox

    const res = await POST(mkReq(validBody));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.redirectTo).toBe('/dashboard');

    const calls = mockSql.mock.calls.map(
      (c: any[]) => (c[0] as TemplateStringsArray).join('?'),
    );
    const updateCall = calls.find((t: string) =>
      t.includes('UPDATE') && t.includes('businesses'),
    );
    expect(updateCall).toBeDefined();
    const outboxCall = mockSql.mock.calls.find((c: any[]) =>
      (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO job_outbox'),
    );
    expect(outboxCall).toBeDefined();
    // sync_reviews + 'business' aggregate_type are bound values for placeholders.
    expect((outboxCall as unknown[]).some((v) => v === 'sync_reviews')).toBe(true);
    // Dedup predicate is a SQL literal in the template.
    const outboxText = (outboxCall![0] as TemplateStringsArray).join('?');
    expect(outboxText).toContain('NOT EXISTS');
    expect(outboxText).toContain("topic IN ('sync_reviews', 'validate_place_id')");
    expect(outboxText).toContain("status IN ('pending', 'dispatching', 'dispatched')");
  });

  it('returns 200 + INSERTs validate_place_id outbox on googleMapsUrl path', async () => {
    mockSql.mockResolvedValueOnce([activeBizRow]); // initial JOIN read
    mockSql.mockResolvedValueOnce([]); // pg_advisory_xact_lock
    mockSql.mockResolvedValueOnce([activeBizRow]); // FOR UPDATE re-read
    mockSql.mockResolvedValueOnce([]); // UPDATE businesses
    mockSql.mockResolvedValueOnce([]); // INSERT job_outbox

    const mapsBody = {
      businessName: 'Acme Cafe',
      // Resolver-ready URL: /place/<name>/@<lat>,<lng> shape so the schema's
      // urlIsResolverReady refine accepts it (B18 finding #1).
      googleMapsUrl:
        'https://www.google.com/maps/place/Acme+Cafe/@40.7128,-74.0060,15z',
      tone: 'casual',
    };
    const res = await POST(mkReq(mapsBody));
    expect(res.status).toBe(200);
    const outboxCall = mockSql.mock.calls.find((c: any[]) =>
      (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO job_outbox'),
    );
    expect(outboxCall).toBeDefined();
    expect((outboxCall as unknown[]).some((v) => v === 'validate_place_id')).toBe(true);
  });

  it('idempotency: silent no-op when FOR UPDATE re-read finds row already onboarded', async () => {
    mockSql.mockResolvedValueOnce([activeBizRow]); // initial JOIN read
    mockSql.mockResolvedValueOnce([]); // pg_advisory_xact_lock
    // FOR UPDATE shows another submit already won.
    mockSql.mockResolvedValueOnce([
      { ...activeBizRow, place_id_verified: true },
    ]);

    const res = await POST(mkReq(validBody));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.redirectTo).toBe('/dashboard');
    // Critical: no UPDATE or INSERT INTO job_outbox call must follow the
    // already-onboarded re-read.
    const calls = mockSql.mock.calls.map(
      (c: any[]) => (c[0] as TemplateStringsArray).join('?'),
    );
    const updateBiz = calls.find(
      (t: string) =>
        t.includes('UPDATE') && t.includes('businesses') && !t.includes('SELECT'),
    );
    expect(updateBiz).toBeUndefined();
    const outboxInsert = calls.find((t: string) => t.includes('INSERT INTO job_outbox'));
    expect(outboxInsert).toBeUndefined();
  });

  it('returns 429 when rate-limit exceeded (per-authId 10/hour strict)', async () => {
    mockSql.mockResolvedValueOnce([activeBizRow]); // initial JOIN read
    mockCheckRateLimit.mockResolvedValueOnce({ allowed: false, remaining: 0 });
    const res = await POST(mkReq(validBody));
    expect(res.status).toBe(429);
    // Confirm rate-limit key shape.
    const firstCall = mockCheckRateLimit.mock.calls[0]!;
    expect(firstCall[0]).toBe('onboarding-business:auth:auth-uuid-123');
    expect(firstCall[1]).toBe(10);
    expect(firstCall[2]).toBe(3600);
    expect(firstCall[3]).toEqual({ strict: true });
  });

  it('returns 503 when rate-limit throws in strict mode (Redis down)', async () => {
    mockSql.mockResolvedValueOnce([activeBizRow]); // initial JOIN read
    mockCheckRateLimit.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const res = await POST(mkReq(validBody));
    expect(res.status).toBe(503);
  });
});
