import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Hoisted shared state ──────────────────────────────────────────────

const { mockRequireRole, mockSqlResults, sqlCallCounter } = vi.hoisted(() => ({
  mockRequireRole: vi.fn(),
  mockSqlResults: [] as unknown[][],
  sqlCallCounter: { value: 0 },
}));

// ── Mock Auth ────────────────────────────────────────────────────────

vi.mock('@/lib/db/auth', () => {
  class AuthError extends Error {
    constructor(
      message: string,
      public readonly statusCode: number,
    ) {
      super(message);
      this.name = 'AuthError';
    }
  }
  return {
    requireRole: (...args: unknown[]) => mockRequireRole(...args),
    AuthError,
  };
});

// ── Mock DB ──────────────────────────────────────────────────────────

vi.mock('@/lib/db/server', () => ({
  sql: new Proxy(() => {}, {
    apply: () => {
      const result = mockSqlResults[sqlCallCounter.value] ?? [];
      sqlCallCounter.value++;
      return Promise.resolve(result);
    },
  }),
}));

// ── Mock aggregate service ────────────────────────────────────────────

const { mockGetAggregateDashboardData } = vi.hoisted(() => ({
  mockGetAggregateDashboardData: vi.fn(),
}));

vi.mock('@/lib/dashboard/aggregate-service', () => ({
  getAggregateDashboardData: (...args: unknown[]) => mockGetAggregateDashboardData(...args),
}));

// ── Mock active dashboard service ────────────────────────────────────

const { mockGetActiveDashboardData } = vi.hoisted(() => ({
  mockGetActiveDashboardData: vi.fn(),
}));

vi.mock('@/lib/dashboard/service', () => ({
  getActiveDashboardData: (...args: unknown[]) => mockGetActiveDashboardData(...args),
  BusinessNotFoundError: class BusinessNotFoundError extends Error {
    constructor() { super('Business not found'); this.name = 'BusinessNotFoundError'; }
  },
}));

// ── Mock Redis ────────────────────────────────────────────────────────

const { mockRedisGet } = vi.hoisted(() => ({
  mockRedisGet: vi.fn<() => Promise<string | null>>(async () => null),
}));

vi.mock('@/lib/db/redis-cache', () => ({
  getCacheRedis: () => ({ get: mockRedisGet }),
}));

// ── Mock location repo ────────────────────────────────────────────────
// The dashboard route no longer calls getLocationById — the single preflight
// SQL query (fetchLocationAccountRow) owns the ownership/archived checks — but
// ./policy still imports it and the aggregate service uses
// getLocationsForAccount, so the module stays mocked.

vi.mock('@/lib/locations/repo', () => ({
  getActiveLocationCount: vi.fn(async () => 2),
  getLocationsForAccount: vi.fn(async () => [
    { id: 'loc-1', account_id: 'acc-1', name: 'Downtown Cafe', display_label: 'Downtown', is_primary: true, archived_at: null, google_place_id: 'g1', google_place_address: null, created_at: new Date() },
    { id: 'loc-2', account_id: 'acc-1', name: 'Westside Bakery', display_label: null, is_primary: false, archived_at: null, google_place_id: 'g2', google_place_address: null, created_at: new Date() },
  ]),
  getLocationById: vi.fn(async () => null),
}));

// Import AFTER mocks are set up
import { GET } from '../route';

// ── Helpers ──────────────────────────────────────────────────────────

function makeRequest(url = 'http://localhost:3000/api/dashboard'): NextRequest {
  return new NextRequest(url);
}

const ACCOUNT_ID = 'a0000000-0000-0000-0000-000000000001';
const OTHER_ACCOUNT_ID = 'a0000000-0000-0000-0000-000000000002';
const LOCATION_ID = '01234567-0000-0000-0000-000000000001';
const PRIMARY_LOCATION_ID = '01234567-0000-0000-0000-000000000002';
const OTHER_ACCOUNT_LOCATION_ID = '01234567-0000-0000-0000-000000000003';

function ownerUser() {
  return {
    id: 'user-1',
    name: 'Test Owner',
    email: 'owner@test.com',
    role: 'owner',
    accountId: ACCOUNT_ID,
    locationId: LOCATION_ID,
  };
}

/**
 * Merged preflight row returned by fetchLocationAccountRow (SQL call 0).
 * One row now carries the account/subscription columns (IDOR + gate checks)
 * AND every DashboardBusinessRow field, because the route passes it into
 * getActiveDashboardData as opts.business.
 */
function preflightRow(overrides?: Record<string, unknown>) {
  return {
    account_id: ACCOUNT_ID,
    name: 'Test Biz',
    subscription_status: 'active',
    subscription_tier: 'copilot',
    owner_email: 'owner@test.com',
    onboarded_by: null,
    place_id_verified: true,
    google_maps_url: 'https://maps.google.com',
    archived_at: null,
    past_due_at: null,
    trial_ends_at: null,
    flags: {},
    stripe_customer_id: null,
    created_at: new Date('2026-01-01T00:00:00Z'),
    initial_review_count: null,
    initial_responded_count: null,
    baseline_captured_at: null,
    tone: null,
    products_services: null,
    avoid_facts: [],
    sample_responses: [],
    owner_phone: null,
    weekly_summary_enabled: true,
    monthly_impact_enabled: true,
    category: null,
    google_place_id: 'gp1',
    ...overrides,
  };
}

function activeDashboardPayload(businessName = 'Test Biz') {
  return {
    business: { name: businessName, createdAt: '2026-01-01' },
    valueSummary: { totalReviewsHandled: 10, totalTimeSavedMinutes: 70, currentResponseRate: 80, baselineResponseRate: null },
    reviewVelocity: [{ weekStart: '2026-04-27', count: 5 }],
    ranking: null,
    recentReviews: [],
    latestBrief: null,
    settings: {
      tone: 'professional', productsServices: '', avoidFacts: [], sampleResponses: [],
      ownerPhone: '', ownerEmail: '', weeklySummaryEnabled: true, monthlyImpactEnabled: true,
      category: '', googlePlaceId: '',
    },
    zernioConnection: { status: 'none', queuedReconnectCount: 0, hasUnresolvedIncident: false },
  };
}

/**
 * Sets up mocks for the per-location path where the location is owned
 * by the authenticated user, is active, and has an active subscription.
 *
 * Query order:
 *   SQL call 0: fetchLocationAccountRow(locationId) — the merged preflight row
 *     (ownership + archived + subscription checks in one query)
 *   then getActiveDashboardData(sql, locationId, { includeReputationMetrics,
 *     window, business: <the preflight row> }) — mocked here.
 */
function setActiveSubRow() {
  mockSqlResults.length = 0;
  sqlCallCounter.value = 0;

  // SQL call 0: merged preflight row
  mockSqlResults.push([preflightRow()]);

  // Mock the active dashboard data service
  mockGetActiveDashboardData.mockResolvedValue(activeDashboardPayload());
}

function setActiveAccountRow() {
  mockSqlResults.length = 0;
  sqlCallCounter.value = 0;
  // For aggregate path, the first query is the account check
  mockSqlResults.push([
    { subscription_status: 'active' },
  ]);
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('GET /api/dashboard scope parameter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSqlResults.length = 0;
    sqlCallCounter.value = 0;
  });

  // VAL-DASH-024: /api/dashboard accepts scope query parameter
  it('scope=all returns aggregate data when MULTI_LOCATION_ENABLED', async () => {
    const originalEnv = process.env.MULTI_LOCATION_ENABLED;
    process.env.MULTI_LOCATION_ENABLED = 'true';

    mockRequireRole.mockResolvedValue(ownerUser());
    setActiveAccountRow();

    const aggregateData = {
      scope: 'aggregate',
      valueSummary: { totalReviewsHandled: 30, totalTimeSavedMinutes: 210, currentResponseRate: 75, baselineResponseRate: 30 },
      reviewVelocity: [],
      perLocationVelocity: [],
      ranking: null,
      perLocationRanking: [],
      recentReviews: [],
      perLocationBriefs: [],
      locationKpis: [
        { locationId: 'loc-1', displayName: 'Downtown', isPrimary: true, totalReviewsHandled: 20, pendingApprovalCount: 3, recentReviewCount: 8, billingPending: false },
        { locationId: 'loc-2', displayName: 'Westside Bakery', isPrimary: false, totalReviewsHandled: 10, pendingApprovalCount: 1, recentReviewCount: 4, billingPending: false },
      ],
      activeLocationCount: 2,
    };
    mockGetAggregateDashboardData.mockResolvedValue(aggregateData);

    const res = await GET(makeRequest('http://localhost:3000/api/dashboard?scope=all'));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.scope).toBe('aggregate');
    expect(body.activeLocationCount).toBe(2);
    expect(body.locationKpis).toHaveLength(2);

    // #403: the route resolves + passes the validated window (default here).
    expect(mockGetAggregateDashboardData).toHaveBeenCalledWith(expect.any(Function), ACCOUNT_ID, '30d');

    process.env.MULTI_LOCATION_ENABLED = originalEnv;
  });

  it('scope=<locationId> returns per-location data', async () => {
    const originalEnv = process.env.MULTI_LOCATION_ENABLED;
    process.env.MULTI_LOCATION_ENABLED = 'true';

    mockRequireRole.mockResolvedValue(ownerUser());
    setActiveSubRow();

    const res = await GET(makeRequest(`http://localhost:3000/api/dashboard?scope=${LOCATION_ID}`));
    expect(res.status).toBe(200);

    const body = await res.json();
    // Per-location data has business field, no scope field
    expect(body.business).toBeDefined();
    expect(body.scope).toBeUndefined();

    // Regression guard: the active landing MUST request reputation metrics so
    // DashboardContent renders the 4-zone hero, not the legacy KPI fallback.
    // (A missing flag here is invisible to the CSS/component tests.)
    // The options object also carries the preflight row as `business` (the
    // service skips its own business query), hence objectContaining.
    expect(mockGetActiveDashboardData).toHaveBeenCalledWith(
      expect.any(Function),
      LOCATION_ID,
      expect.objectContaining({ includeReputationMetrics: true, window: '30d' }),
    );

    process.env.MULTI_LOCATION_ENABLED = originalEnv;
  });

  it('no scope parameter defaults to user current location', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    setActiveSubRow();

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.business).toBeDefined();
    expect(body.scope).toBeUndefined();
  });

  it('scope=all ignored when MULTI_LOCATION_ENABLED is false', async () => {
    const originalEnv = process.env.MULTI_LOCATION_ENABLED;
    process.env.MULTI_LOCATION_ENABLED = 'false';

    mockRequireRole.mockResolvedValue(ownerUser());
    setActiveSubRow();

    const res = await GET(makeRequest('http://localhost:3000/api/dashboard?scope=all'));
    expect(res.status).toBe(200);

    // Falls through to per-location path
    const body = await res.json();
    expect(body.business).toBeDefined();
    expect(body.scope).toBeUndefined();

    process.env.MULTI_LOCATION_ENABLED = originalEnv;
  });

  it('returns 403 when user has no accountId', async () => {
    mockRequireRole.mockResolvedValue({
      id: 'user-1',
      name: 'Test',
      email: 'test@test.com',
      role: 'owner',
      accountId: null,
      locationId: null,
    });

    const res = await GET(makeRequest());
    expect(res.status).toBe(403);
  });

  // VAL-DASH-029: Archived location fallback (owned location)
  it('falls back to primary when scoped location is archived but owned', async () => {
    const originalEnv = process.env.MULTI_LOCATION_ENABLED;
    process.env.MULTI_LOCATION_ENABLED = 'true';

    mockRequireRole.mockResolvedValue(ownerUser());

    // SQL call 0: preflight row — owned but archived
    mockSqlResults.push([preflightRow({ archived_at: new Date() })]);
    // SQL call 1: getPrimaryLocationId
    mockSqlResults.push([{ id: PRIMARY_LOCATION_ID }]);
    // SQL call 2: the primary's merged preflight row
    mockSqlResults.push([preflightRow({ name: 'Primary Biz' })]);

    // Mock the active dashboard data service
    mockGetActiveDashboardData.mockResolvedValue(activeDashboardPayload('Primary Biz'));

    const res = await GET(makeRequest(`http://localhost:3000/api/dashboard?scope=${LOCATION_ID}`));
    expect(res.status).toBe(200);

    const body = await res.json();
    // Response should contain the scopeFallback indicator
    expect(body.scopeFallback).toBeDefined();
    expect(body.scopeFallback.reason).toBe('location_archived');
    expect(body.scopeFallback.fallbackLocationId).toBe(PRIMARY_LOCATION_ID);
    // Business data should be from the primary location
    expect(body.business).toBeDefined();
    expect(body.business.name).toBe('Primary Biz');

    process.env.MULTI_LOCATION_ENABLED = originalEnv;
  });

  // VAL-DASH-029: Location not found fallback (preflight row query returns nothing)
  it('falls back to primary when scoped location is not found', async () => {
    const originalEnv = process.env.MULTI_LOCATION_ENABLED;
    process.env.MULTI_LOCATION_ENABLED = 'true';

    mockRequireRole.mockResolvedValue(ownerUser());

    // SQL call 0: preflight row query finds nothing (not found)
    mockSqlResults.push([]);
    // SQL call 1: getPrimaryLocationId
    mockSqlResults.push([{ id: PRIMARY_LOCATION_ID }]);
    // SQL call 2: the primary's merged preflight row
    mockSqlResults.push([preflightRow({ name: 'Primary Biz' })]);

    // Mock the active dashboard data service
    mockGetActiveDashboardData.mockResolvedValue(activeDashboardPayload('Primary Biz'));

    // Use a valid-format UUID that doesn't exist in the DB — tests the "not found"
    // fallback path without triggering the malformed-UUID 400 guard (#103).
    const res = await GET(makeRequest('http://localhost:3000/api/dashboard?scope=00000000-0000-0000-0000-000000000000'));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.scopeFallback).toBeDefined();
    expect(body.scopeFallback.reason).toBe('location_not_found');
    expect(body.scopeFallback.fallbackLocationId).toBe(PRIMARY_LOCATION_ID);

    process.env.MULTI_LOCATION_ENABLED = originalEnv;
  });

  // ── IDOR ownership check tests ─────────────────────────────────────

  it('returns 403 when scope locationId belongs to a different account', async () => {
    const originalEnv = process.env.MULTI_LOCATION_ENABLED;
    process.env.MULTI_LOCATION_ENABLED = 'true';

    mockRequireRole.mockResolvedValue(ownerUser());

    // SQL call 0: preflight row — location exists but belongs to a DIFFERENT account
    mockSqlResults.push([
      preflightRow({ account_id: OTHER_ACCOUNT_ID, name: 'Rival Biz', google_place_id: 'gp3' }),
    ]);

    const res = await GET(makeRequest(`http://localhost:3000/api/dashboard?scope=${OTHER_ACCOUNT_LOCATION_ID}`));
    expect(res.status).toBe(403);

    const body = await res.json();
    expect(body.error).toMatch(/not authorized|forbidden|ownership/i);

    // No dashboard data should be fetched for the other account's location
    expect(mockGetActiveDashboardData).not.toHaveBeenCalled();

    process.env.MULTI_LOCATION_ENABLED = originalEnv;
  });

  it('returns 403 when scope locationId belongs to a different account even if archived', async () => {
    const originalEnv = process.env.MULTI_LOCATION_ENABLED;
    process.env.MULTI_LOCATION_ENABLED = 'true';

    mockRequireRole.mockResolvedValue(ownerUser());

    // SQL call 0: preflight row — archived location belonging to a DIFFERENT
    // account. The IDOR check must win over the archived fallback.
    mockSqlResults.push([
      preflightRow({
        account_id: OTHER_ACCOUNT_ID,
        name: 'Rival Biz',
        archived_at: new Date(),
        google_place_id: 'gp3',
      }),
    ]);

    const res = await GET(makeRequest(`http://localhost:3000/api/dashboard?scope=${OTHER_ACCOUNT_LOCATION_ID}`));
    expect(res.status).toBe(403);

    const body = await res.json();
    expect(body.error).toMatch(/not authorized|forbidden|ownership/i);

    expect(mockGetActiveDashboardData).not.toHaveBeenCalled();

    process.env.MULTI_LOCATION_ENABLED = originalEnv;
  });

  it('returns data when scope locationId belongs to the authenticated user\'s account', async () => {
    const originalEnv = process.env.MULTI_LOCATION_ENABLED;
    process.env.MULTI_LOCATION_ENABLED = 'true';

    mockRequireRole.mockResolvedValue(ownerUser());
    setActiveSubRow();

    const res = await GET(makeRequest(`http://localhost:3000/api/dashboard?scope=${LOCATION_ID}`));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.business).toBeDefined();

    process.env.MULTI_LOCATION_ENABLED = originalEnv;
  });

  // VAL-DASH-103: malformed ?scope= value → 400 (not 500 from Postgres ::uuid cast)
  it('malformed scope (not a UUID) → 400 Invalid scope; no preflight query runs', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());

    const res = await GET(makeRequest('http://localhost:3000/api/dashboard?scope=not-a-uuid'));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toContain('Invalid scope');

    // The malformed id must be rejected BEFORE any SQL runs.
    expect(sqlCallCounter.value).toBe(0);
    expect(mockGetActiveDashboardData).not.toHaveBeenCalled();
  });

  it('returns 403 when default user.locationId belongs to a different account', async () => {
    // Even without scope parameter, the user's own locationId should be
    // verified against their account. This covers session hijacking or
    // stale cookie scenarios.
    const originalEnv = process.env.MULTI_LOCATION_ENABLED;
    process.env.MULTI_LOCATION_ENABLED = 'true';

    mockRequireRole.mockResolvedValue(ownerUser());

    // SQL call 0: preflight row — the user's default locationId resolves to a
    // location owned by a DIFFERENT account
    mockSqlResults.push([
      preflightRow({ account_id: OTHER_ACCOUNT_ID, name: 'Hijacked Biz', google_place_id: 'gp4' }),
    ]);

    const res = await GET(makeRequest());
    expect(res.status).toBe(403);

    const body = await res.json();
    expect(body.error).toMatch(/not authorized|forbidden|ownership/i);

    expect(mockGetActiveDashboardData).not.toHaveBeenCalled();

    process.env.MULTI_LOCATION_ENABLED = originalEnv;
  });
});
