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

// ── Mock Redis ────────────────────────────────────────────────────────

const { mockRedisGet } = vi.hoisted(() => ({
  mockRedisGet: vi.fn<() => Promise<string | null>>(async () => null),
}));

vi.mock('@/lib/db/redis-cache', () => ({
  getCacheRedis: () => ({ get: mockRedisGet }),
}));

// ── Mock location repo ────────────────────────────────────────────────

vi.mock('@/lib/locations/repo', () => ({
  getActiveLocationCount: vi.fn(async () => 2),
  getLocationsForAccount: vi.fn(async () => [
    { id: 'loc-1', account_id: 'acc-1', name: 'Downtown Cafe', display_label: 'Downtown', is_primary: true, archived_at: null, google_place_id: 'g1', created_at: new Date() },
    { id: 'loc-2', account_id: 'acc-1', name: 'Westside Bakery', display_label: null, is_primary: false, archived_at: null, google_place_id: 'g2', created_at: new Date() },
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
const LOCATION_ID = '01234567-0000-0000-0000-000000000001';

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

function setActiveSubRow() {
  mockSqlResults.length = 0;
  sqlCallCounter.value = 0;
  mockSqlResults.push([
    {
      name: 'Test Biz',
      subscription_status: 'active',
      subscription_tier: 'standard',
      owner_email: 'owner@test.com',
      onboarded_by: null,
      place_id_verified: true,
      google_maps_url: 'https://maps.google.com',
    },
  ]);
  // Heavy queries (for per-location path)
  mockSqlResults.push(
    [{ name: 'Test Biz', created_at: new Date(), initial_review_count: 10, initial_responded_count: 3, baseline_captured_at: new Date(), tone: 'pro', products_services: '', avoid_facts: [], sample_responses: [], owner_phone: '', owner_email: '', weekly_summary_enabled: true, monthly_impact_enabled: true, category: '', google_place_id: 'g1' }],
    [{ count: 20 }],
    [{ count: 15 }],
    [{ week_start: '2026-04-27', count: 5 }],
    [],
    [],
    [],
    [],
    [],
    [{ count: 0 }],
    [{ count: 0 }],
  );
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
        { locationId: 'loc-1', displayName: 'Downtown', isPrimary: true, totalReviewsHandled: 20, pendingApprovalCount: 3, recentReviewCount: 8 },
        { locationId: 'loc-2', displayName: 'Westside Bakery', isPrimary: false, totalReviewsHandled: 10, pendingApprovalCount: 1, recentReviewCount: 4 },
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

    expect(mockGetAggregateDashboardData).toHaveBeenCalledWith(ACCOUNT_ID);

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
});
