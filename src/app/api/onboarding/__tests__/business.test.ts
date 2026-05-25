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
  account_id: 'acct-1',
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

  it('SQL boundary: lookup query filters on u.role = \'owner\' (B17 #1 - proxy does NOT gate /api/onboarding/*)', async () => {
    mockSql.mockResolvedValueOnce([activeBizRow]);
    mockSql.mockResolvedValueOnce([]); // pg_advisory_xact_lock
    mockSql.mockResolvedValueOnce([activeBizRow]); // FOR UPDATE
    mockSql.mockResolvedValueOnce([]); // UPDATE businesses (no outbox INSERT on verified path)
    const res = await POST(mkReq(validBody));
    expect(res.status).toBe(200);

    const lookupCall = mockSql.mock.calls.find((c: any[]) => {
      const text = (c[0] as TemplateStringsArray).join('?');
      return text.includes('SELECT b.id, a.id AS account_id') &&
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

  it('returns 200 + UPDATEs businesses + does NOT insert outbox on verified placeId path', async () => {
    // PlaceAutocomplete-verified path no longer enqueues sync_reviews —
    // review ingestion is webhook-driven via Zernio.
    mockSql.mockResolvedValueOnce([activeBizRow]); // initial JOIN read
    mockSql.mockResolvedValueOnce([]); // pg_advisory_xact_lock
    mockSql.mockResolvedValueOnce([activeBizRow]); // FOR UPDATE re-read
    mockSql.mockResolvedValueOnce([]); // UPDATE businesses

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

    // No outbox INSERT on the verified-placeId path.
    const outboxCall = mockSql.mock.calls.find((c: any[]) =>
      (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO job_outbox'),
    );
    expect(outboxCall).toBeUndefined();

    // Confirm sync_reviews is never referenced.
    const allArgs = mockSql.mock.calls.flat();
    expect(allArgs.some((v: unknown) => v === 'sync_reviews')).toBe(false);
  });

  it('updates placeholder account display_name on the profile wizard path', async () => {
    mockSql.mockResolvedValueOnce([activeBizRow]); // initial JOIN read

    const txCalls: string[] = [];
    mockSql.begin = vi.fn(async (cb: any) => {
      const tx: any = vi.fn(async (strings: TemplateStringsArray) => {
        const text = strings.join('?');
        txCalls.push(text);
        if (text.includes('FOR UPDATE')) return [activeBizRow];
        return [];
      });
      return cb(tx);
    });

    const res = await POST(mkReq(validBody));

    expect(res.status).toBe(200);
    expect(txCalls.some((text) => text.includes('UPDATE accounts'))).toBe(true);
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
    // 'validate_place_id' is now a SQL literal in the template, not a bound value.
    expect((outboxCall![0] as TemplateStringsArray).join('?')).toContain("'validate_place_id'");
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

  // ── Demo-flow bifurcation regressions (Task 10) ─────────────────────

  it('flag-off: legacy schema accepts googlePlaceId on the location-capture path', async () => {
    delete process.env.ONBOARDING_DEMO_ENABLED;
    mockSql.mockResolvedValueOnce([activeBizRow]); // initial JOIN read
    mockSql.mockResolvedValueOnce([]); // pg_advisory_xact_lock
    mockSql.mockResolvedValueOnce([activeBizRow]); // FOR UPDATE re-read
    mockSql.mockResolvedValueOnce([]); // UPDATE businesses

    const res = await POST(mkReq(validBody));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.redirectTo).toBe('/dashboard');
  });

  it('flag-on: post-pay schema rejects googlePlaceId (set during /start, never resubmitted)', async () => {
    process.env.ONBOARDING_DEMO_ENABLED = 'true';
    // Post-pay precondition: place_id_verified is true (location captured at /start).
    const postPayBizRow = { ...activeBizRow, place_id_verified: true };
    mockSql.mockResolvedValueOnce([postPayBizRow]);

    const res = await POST(mkReq(validBody)); // validBody contains googlePlaceId
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('invalid_body');
    delete process.env.ONBOARDING_DEMO_ENABLED;
  });

  it('flag-on: returns 409 onboarding_not_started when /start was skipped', async () => {
    process.env.ONBOARDING_DEMO_ENABLED = 'true';
    mockSql.mockResolvedValueOnce([activeBizRow]); // place_id_verified=false, google_maps_url=null

    const res = await POST(mkReq({ tone: 'casual' }));
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe('onboarding_not_started');
    expect(json.redirectTo).toBe('/onboarding/start');
    delete process.env.ONBOARDING_DEMO_ENABLED;
  });
});
