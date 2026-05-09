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
const PRIMARY_LOCATION_ID = '01234567-0000-0000-0000-000000000002';

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
 * Sets up SQL mock results for the per-location path.
 * The route now first checks archived_at, then fetches full data.
 * Query order:
 *   1. SELECT archived_at FROM businesses WHERE id = ${locationId}
 *   2. SELECT name, subscription_status, ... FROM businesses JOIN accounts ...
 *   3–12. Heavy queries from getActiveDashboardData
 */
function setActiveSubRow() {
  mockSqlResults.length = 0;
  sqlCallCounter.value = 0;
  // Query 1: archived_at check (returns null = not archived)
  mockSqlResults.push([{ archived_at: null }]);
  // Query 2: subscription status + onboarding check
  mockSqlResults.push([
    {
      name: 'Test Biz',
      subscription_status: 'active',
      subscription_tier: 'standard',
      owner_email: 'owner@test.com',
      onboarded_by: null,
      place_id_verified: true,
      google_maps_url: 'https://maps.google.com',
      archived_at: null,
    },
  ]);

  // Mock the active dashboard data service instead of relying on SQL mocks
  mockGetActiveDashboardData.mockResolvedValue({
    business: { name: 'Test Biz', createdAt: '2026-01-01' },
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
  });
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

  // VAL-DASH-029: Archived location fallback
  it('falls back to primary when scoped location is archived', async () => {
    const originalEnv = process.env.MULTI_LOCATION_ENABLED;
    process.env.MULTI_LOCATION_ENABLED = 'true';

    mockRequireRole.mockResolvedValue(ownerUser());

    // Query 1: archived_at check returns non-null (archived)
    mockSqlResults.length = 0;
    sqlCallCounter.value = 0;
    mockSqlResults.push([{ archived_at: new Date() }]);
    // Query 2: getPrimaryLocationId
    mockSqlResults.push([{ id: PRIMARY_LOCATION_ID }]);
    // Query 3: fetchPerLocationData — archived_at check for primary
    mockSqlResults.push([{ archived_at: null }]);
    // Query 4: fetchPerLocationData — subscription check
    mockSqlResults.push([
      {
        name: 'Primary Biz',
        subscription_status: 'active',
        subscription_tier: 'standard',
        owner_email: 'owner@test.com',
        onboarded_by: null,
        place_id_verified: true,
        google_maps_url: 'https://maps.google.com',
        archived_at: null,
      },
    ]);

    // Mock the active dashboard data service instead of relying on SQL mocks
    mockGetActiveDashboardData.mockResolvedValue({
      business: { name: 'Primary Biz', createdAt: '2026-01-01' },
      valueSummary: { totalReviewsHandled: 5, totalTimeSavedMinutes: 35, currentResponseRate: 60, baselineResponseRate: null },
      reviewVelocity: [],
      ranking: null,
      recentReviews: [],
      latestBrief: null,
      settings: {
        tone: 'professional', productsServices: '', avoidFacts: [], sampleResponses: [],
        ownerPhone: '', ownerEmail: '', weeklySummaryEnabled: true, monthlyImpactEnabled: true,
        category: '', googlePlaceId: '',
      },
      zernioConnection: { status: 'none', queuedReconnectCount: 0, hasUnresolvedIncident: false },
    });

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

  // VAL-DASH-029: Location not found fallback
  it('falls back to primary when scoped location is not found', async () => {
    const originalEnv = process.env.MULTI_LOCATION_ENABLED;
    process.env.MULTI_LOCATION_ENABLED = 'true';

    mockRequireRole.mockResolvedValue(ownerUser());

    // Query 1: archived_at check returns empty (not found)
    mockSqlResults.length = 0;
    sqlCallCounter.value = 0;
    mockSqlResults.push([]);
    // Query 2: getPrimaryLocationId
    mockSqlResults.push([{ id: PRIMARY_LOCATION_ID }]);
    // Query 3: fetchPerLocationData — archived_at check for primary
    mockSqlResults.push([{ archived_at: null }]);
    // Query 4: fetchPerLocationData — subscription check
    mockSqlResults.push([
      {
        name: 'Primary Biz',
        subscription_status: 'active',
        subscription_tier: 'standard',
        owner_email: 'owner@test.com',
        onboarded_by: null,
        place_id_verified: true,
        google_maps_url: 'https://maps.google.com',
        archived_at: null,
      },
    ]);

    // Mock the active dashboard data service
    mockGetActiveDashboardData.mockResolvedValue({
      business: { name: 'Primary Biz', createdAt: '2026-01-01' },
      valueSummary: { totalReviewsHandled: 5, totalTimeSavedMinutes: 35, currentResponseRate: 60, baselineResponseRate: null },
      reviewVelocity: [],
      ranking: null,
      recentReviews: [],
      latestBrief: null,
      settings: {
        tone: 'professional', productsServices: '', avoidFacts: [], sampleResponses: [],
        ownerPhone: '', ownerEmail: '', weeklySummaryEnabled: true, monthlyImpactEnabled: true,
        category: '', googlePlaceId: '',
      },
      zernioConnection: { status: 'none', queuedReconnectCount: 0, hasUnresolvedIncident: false },
    });

    const res = await GET(makeRequest(`http://localhost:3000/api/dashboard?scope=nonexistent-location-id`));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.scopeFallback).toBeDefined();
    expect(body.scopeFallback.reason).toBe('location_not_found');
    expect(body.scopeFallback.fallbackLocationId).toBe(PRIMARY_LOCATION_ID);

    process.env.MULTI_LOCATION_ENABLED = originalEnv;
  });
});
