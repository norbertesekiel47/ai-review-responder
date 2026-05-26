import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Hoisted shared state (available inside vi.mock factories) ────────

const { mockRequireRole, mockSqlResults, sqlCallCounter, capturedSqlTexts } = vi.hoisted(() => ({
  mockRequireRole: vi.fn(),
  mockSqlResults: [] as unknown[][],
  sqlCallCounter: { value: 0 },
  capturedSqlTexts: [] as string[],
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
  it('excludes source-deleted reviews from dashboard queries', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    setDbResults();

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);

    const reviewSql = capturedSqlTexts.filter((text) =>
      text.includes('FROM reviews'),
    ).join('\n');
    expect(reviewSql).toContain("status <> 'deleted'");
  });
});

// ── Mock DB ──────────────────────────────────────────────────────────

vi.mock('@/lib/db/server', () => ({
  sql: new Proxy(() => {}, {
    apply: (_target, _thisArg, argumentsList) => {
      const first = argumentsList[0];
      if (first != null && typeof first === 'object' && 'raw' in (first as object)) {
        capturedSqlTexts.push((first as TemplateStringsArray).raw.join('?'));
      }
      const result = mockSqlResults[sqlCallCounter.value] ?? [];
      sqlCallCounter.value++;
      return Promise.resolve(result);
    },
  }),
  jsonb: (v: unknown) => v,
}));

// ── Mock Redis (Zernio pending marker read) ──────────────────────────
// The dashboard service reads `connect_pending:{businessId}` from Redis to
// surface in-flight connect flows. Tests don't exercise that path so we
// always return null. Real outage handling is covered in service-level
// tests (try/catch around the .get call).

const { mockRedisGet } = vi.hoisted(() => ({
  mockRedisGet: vi.fn<() => Promise<string | null>>(async () => null),
}));

vi.mock('@/lib/db/redis-cache', () => ({
  getCacheRedis: () => ({ get: mockRedisGet }),
}));

// ── No more payment-link mock (checkout session replaces it) ───────

// ── Mock location repo (IDOR fix: route now uses getLocationById) ──

const { mockGetLocationById } = vi.hoisted(() => ({
  mockGetLocationById: vi.fn<(id: string) => Promise<import('@/lib/locations/repo').LocationRow | null>>(async () => null),
}));

vi.mock('@/lib/locations/repo', () => ({
  getActiveLocationCount: vi.fn(async () => 1),
  getLocationsForAccount: vi.fn(async () => []),
  getLocationById: (id: string) => mockGetLocationById(id),
}));

// Import AFTER mocks are set up
import { GET, type DashboardDataActive } from '../route';
import { AuthError } from '@/lib/db/auth';

// ── Helpers ──────────────────────────────────────────────────────────

function makeRequest(path = '/api/dashboard'): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`);
}

const BUSINESS_ID = '01234567-0000-0000-0000-000000000001';
const ACCOUNT_ID = 'a0000000-0000-0000-0000-000000000001';

function ownerUser(overrides?: { locationId?: string | null }) {
  return {
    id: 'user-1',
    name: 'Test Owner',
    email: 'owner@test.com',
    role: 'owner',
    accountId: ACCOUNT_ID,
    locationId: overrides && 'locationId' in overrides ? overrides.locationId : BUSINESS_ID,
  };
}

/**
 * Default subRow returned by the pre-query (call 0).
 * For the active path, subscription_status is 'active'.
 */
const DEFAULT_SUB_ROW = {
  name: 'Test Biz',
  subscription_status: 'active',
  subscription_tier: 'standard',
  owner_email: 'owner@test.com',
  archived_at: null,
};

/**
 * Sets up sql query results in order.
 * The route now uses getLocationById for ownership/archived checks,
 * so the first SQL call is the subscription status check (with account_id filter).
 * Calls 0 = subRow (subscription status check).
 * Calls 1–8 = the Promise.all heavy queries (business/totals/velocity/ranking/reviews/briefs).
 * Calls 9–11 = the Zernio banner queries (zernio_connections, queued reconnects, unresolved incidents).
 *
 * The Promise.all includes a 12th entry (the Redis pending-marker read) but that
 * resolves through `mockRedisGet`, not through the sql proxy.
 */
function setDbResults(overrides?: {
  subRow?: unknown[];
  businessRows?: unknown[];
  totalReviewRows?: unknown[];
  totalRespondedRows?: unknown[];
  velocityRows?: unknown[];
  rankingRows?: unknown[];
  recentReviewRows?: unknown[];
  monthlyBriefRows?: unknown[];
  weeklyBriefRows?: unknown[];
  zernioConnectionRows?: unknown[];
  queuedReconnectRows?: unknown[];
  unresolvedIncidentRows?: unknown[];
}) {
  mockSqlResults.length = 0;
  sqlCallCounter.value = 0;

  // getLocationById returns an active, owned location (IDOR fix)
  mockGetLocationById.mockResolvedValue({
    id: BUSINESS_ID,
    account_id: ACCOUNT_ID,
    name: 'Test Biz',
    display_label: null,
    is_primary: true,
    archived_at: null,
    google_place_id: 'gp1',
    google_place_address: null,
    created_at: new Date(),
  });

  // Call 0: pre-query (subRow — subscription status check with account_id filter)
  mockSqlResults.push(overrides?.subRow ?? [DEFAULT_SUB_ROW]);

  // Calls 1–8: Promise.all heavy queries (only reached when status !== 'pending_payment')
  mockSqlResults.push(
    overrides?.businessRows ?? [
      {
        name: 'Test Biz',
        created_at: new Date('2025-01-15T00:00:00Z'),
        initial_review_count: 10,
        initial_responded_count: 3,
        baseline_captured_at: new Date('2025-01-15T00:00:00Z'),
      },
    ],
    overrides?.totalReviewRows ?? [{ count: 20 }],
    overrides?.totalRespondedRows ?? [{ count: 15 }],
    overrides?.velocityRows ?? [
      { week_start: '2025-03-03', count: 4 },
      { week_start: '2025-03-10', count: 0 },
    ],
    overrides?.rankingRows ?? [
      { keyword: 'pizza', snapshot_date: '2025-03-01', rank_position: 3 },
      { keyword: 'pizza', snapshot_date: '2025-03-08', rank_position: 2 },
    ],
    overrides?.recentReviewRows ?? [
      {
        id: 'rev-1',
        reviewer_name: 'Alice',
        star_rating: 5,
        review_text: 'Great!',
        review_date: new Date('2025-03-10T00:00:00Z'),
        status: 'new',
        response_text: 'Thanks Alice!',
        response_status: 'posted',
      },
    ],
    overrides?.monthlyBriefRows ?? [],
    overrides?.weeklyBriefRows ?? [],
    // Calls 9–11: Zernio banner queries. Default to "no Zernio state" so
    // tests that don't care about banner precedence keep their existing
    // behaviour (status resolves to 'none').
    overrides?.zernioConnectionRows ?? [],
    overrides?.queuedReconnectRows ?? [{ count: 0 }],
    overrides?.unresolvedIncidentRows ?? [{ count: 0 }],
  );
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('GET /api/dashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSqlResults.length = 0;
    sqlCallCounter.value = 0;
    capturedSqlTexts.length = 0;
  });

  it('returns 401 when requireRole throws AuthError(401)', async () => {
    mockRequireRole.mockRejectedValue(new AuthError('Unauthorized', 401));

    const res = await GET(makeRequest());
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.error).toBe('Unauthorized');
  });

  it('returns 403 when requireRole throws AuthError(403)', async () => {
    mockRequireRole.mockRejectedValue(new AuthError('Forbidden', 403));

    const res = await GET(makeRequest());
    expect(res.status).toBe(403);

    const body = await res.json();
    expect(body.error).toBe('Forbidden');
  });

  it('returns 403 when user has no locationId', async () => {
    mockRequireRole.mockResolvedValue(ownerUser({ locationId: null }));

    const res = await GET(makeRequest());
    expect(res.status).toBe(403);

    const body = await res.json();
    expect(body.error).toBe('No business associated with this account');
  });

  it('returns 404 when pre-query finds no business', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());

    // getLocationById returns an owned location, but the subscription
    // check query returns empty rows → "Business not found"
    mockGetLocationById.mockResolvedValue({
      id: BUSINESS_ID,
      account_id: ACCOUNT_ID,
      name: 'Test Biz',
      display_label: null,
      is_primary: true,
      archived_at: null,
      google_place_id: 'gp1',
      google_place_address: null,
      created_at: new Date(),
    });

    // subRow empty — subscription check returns no rows (defense-in-depth)
    setDbResults({ subRow: [] });
    // Override the getLocationById that setDbResults sets (already done above)

    const res = await GET(makeRequest());
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.error).toBe('Business not found');
  });

  // ── pending_payment early-branch ──────────────────────────────────

  it('returns minimal payload for pending_payment, no heavy queries run', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());

    mockSqlResults.length = 0;
    sqlCallCounter.value = 0;

    // getLocationById returns an active, owned location
    mockGetLocationById.mockResolvedValue({
      id: BUSINESS_ID,
      account_id: ACCOUNT_ID,
      name: 'Pending Biz',
      display_label: null,
      is_primary: true,
      archived_at: null,
      google_place_id: 'gp1',
      google_place_address: null,
      created_at: new Date(),
    });

    // Call 0: subscription status check (with account_id filter)
    mockSqlResults.push([
      {
        name: 'Pending Biz',
        subscription_status: 'pending_payment',
        subscription_tier: 'standard',
        owner_email: 'owner@pending.com',
        onboarded_by: null, // self-serve — owner sees the payment CTA
        archived_at: null,
      },
    ]);

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.subscriptionStatus).toBe('pending_payment');
    expect(body.locationId).toBe(BUSINESS_ID);
    expect(body.businessName).toBe('Pending Biz');
    // The dashboard now redirects to /onboarding/pay instead of a Stripe Payment Link.
    // The PlanPickerClient on that page creates a Checkout Session.
    expect(body.paymentUrl).toMatch(/\/onboarding\/pay$/);

    // Minimal shape — full dashboard fields must be absent
    expect(body.business).toBeUndefined();
    expect(body.valueSummary).toBeUndefined();
    expect(body.recentReviews).toBeUndefined();

    // Only 1 sql call (the subscription check). Promise.all 8 queries must not have run.
    expect(sqlCallCounter.value).toBe(1);

    // No-store header still present
    expect(res.headers.get('Cache-Control')).toBe('no-store, private');
  });

  it('returns paymentUrl pointing to /onboarding/pay for self-serve pending_payment', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());

    mockSqlResults.length = 0;
    sqlCallCounter.value = 0;

    mockGetLocationById.mockResolvedValue({
      id: BUSINESS_ID,
      account_id: ACCOUNT_ID,
      name: 'Founding Biz',
      display_label: null,
      is_primary: true,
      archived_at: null,
      google_place_id: 'gp1',
      google_place_address: null,
      created_at: new Date(),
    });

    // Call 0: subscription status check
    mockSqlResults.push([
      {
        name: 'Founding Biz',
        subscription_status: 'pending_payment',
        subscription_tier: 'founders',
        owner_email: 'founder@example.com',
        onboarded_by: null,
        archived_at: null,
      },
    ]);

    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body.paymentUrl).toMatch(/\/onboarding\/pay$/);
  });

  it('returns admin-handoff payload when pending_payment + onboarded_by IS NOT NULL', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());

    mockSqlResults.length = 0;
    sqlCallCounter.value = 0;

    mockGetLocationById.mockResolvedValue({
      id: BUSINESS_ID,
      account_id: ACCOUNT_ID,
      name: 'Admin Onboarded Biz',
      display_label: null,
      is_primary: true,
      archived_at: null,
      google_place_id: 'gp1',
      google_place_address: null,
      created_at: new Date(),
    });

    // Call 0: subscription status check
    mockSqlResults.push([
      {
        name: 'Admin Onboarded Biz',
        subscription_status: 'pending_payment',
        subscription_tier: 'founders',
        owner_email: 'owner@admin-onboarded.com',
        onboarded_by: 'admin-uuid-1',
        archived_at: null,
      },
    ]);

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.subscriptionStatus).toBe('pending_payment_admin_handoff');
    expect(body.locationId).toBe(BUSINESS_ID);
    expect(body.businessName).toBe('Admin Onboarded Biz');
    // Critical: no paymentUrl in admin-handoff payload (avoids double-charge risk).
    expect(body.paymentUrl).toBeUndefined();

    // Subscription check only — Promise.all heavy queries skipped.
    expect(sqlCallCounter.value).toBe(1);
  });

  it('returns paymentUrl pointing to /onboarding/pay even when env vars are unset', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());

    mockSqlResults.length = 0;
    sqlCallCounter.value = 0;

    mockGetLocationById.mockResolvedValue({
      id: BUSINESS_ID,
      account_id: ACCOUNT_ID,
      name: 'No Env Biz',
      display_label: null,
      is_primary: true,
      archived_at: null,
      google_place_id: 'gp1',
      google_place_address: null,
      created_at: new Date(),
    });

    // Call 0: subscription status check
    mockSqlResults.push([
      {
        name: 'No Env Biz',
        subscription_status: 'pending_payment',
        subscription_tier: 'standard',
        owner_email: 'owner@noenv.com',
        onboarded_by: null,
        archived_at: null,
      },
    ]);

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.subscriptionStatus).toBe('pending_payment');
    // Even without Stripe env vars, the dashboard still redirects to /onboarding/pay
    expect(body.paymentUrl).toMatch(/\/onboarding\/pay$/);
  });

  // ── active path — existing behaviour preserved ─────────────────────

  it('returns full dashboard data for active owner', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    setDbResults();

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);

    const body: DashboardDataActive = await res.json();
    expect(body.business.name).toBe('Test Biz');
    expect(body.valueSummary.totalReviewsHandled).toBe(15);
    expect(body.valueSummary.totalTimeSavedMinutes).toBe(105);
    expect(body.valueSummary.currentResponseRate).toBe(75);
    expect(body.valueSummary.baselineResponseRate).toBe(30);
    expect(body.reviewVelocity).toHaveLength(2);

    const ranking = body.ranking;
    expect(ranking).not.toBeNull();
    expect(ranking!).toHaveLength(1);
    expect(ranking![0]!.keyword).toBe('pizza');
    expect(ranking![0]!.snapshots).toHaveLength(2);

    expect(body.recentReviews).toHaveLength(1);
    expect(body.recentReviews[0]!.reviewerName).toBe('Alice');
    expect(body.recentReviews[0]!.responseText).toBe('Thanks Alice!');

    // Verify no-store header
    expect(res.headers.get('Cache-Control')).toBe('no-store, private');
  });

  it('returns null ranking when no snapshots exist', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    setDbResults({ rankingRows: [] });

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);

    const body: DashboardDataActive = await res.json();
    expect(body.ranking).toBeNull();
  });

  it('returns null latestBrief when no summaries exist', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    setDbResults({ monthlyBriefRows: [], weeklyBriefRows: [] });

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);

    const body: DashboardDataActive = await res.json();
    expect(body.latestBrief).toBeNull();
  });

  it('handles empty review velocity (all zero-count weeks)', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    setDbResults({
      velocityRows: [
        { week_start: '2025-03-03', count: 0 },
        { week_start: '2025-03-10', count: 0 },
      ],
    });

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);

    const body: DashboardDataActive = await res.json();
    expect(body.reviewVelocity).toEqual([
      { weekStart: '2025-03-03', count: 0 },
      { weekStart: '2025-03-10', count: 0 },
    ]);
  });

  it('prefers weekly brief when it was sent more recently than monthly', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    setDbResults({
      monthlyBriefRows: [
        { summary_text: 'Monthly summary', month_start_date: '2025-03-01', sent_at: '2025-04-01T09:00:00Z' },
      ],
      weeklyBriefRows: [
        { summary_text: 'Weekly summary', week_start_date: '2025-04-07', sent_at: '2025-04-07T08:30:00Z' },
      ],
    });

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);

    const body: DashboardDataActive = await res.json();
    expect(body.latestBrief).not.toBeNull();
    expect(body.latestBrief!.type).toBe('weekly');
    expect(body.latestBrief!.text).toBe('Weekly summary');
  });

  it('shows pending_approval responses in recent reviews', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    setDbResults({
      recentReviewRows: [
        {
          id: 'rev-pending',
          reviewer_name: 'Bob',
          star_rating: 4,
          review_text: 'Pretty good',
          review_date: new Date('2025-03-12T00:00:00Z'),
          status: 'new',
          response_text: 'Thank you Bob!',
          response_status: 'pending_approval',
        },
      ],
    });

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);

    const body: DashboardDataActive = await res.json();
    expect(body.recentReviews).toHaveLength(1);
    expect(body.recentReviews[0]!.responseStatus).toBe('pending_approval');
    expect(body.recentReviews[0]!.responseText).toBe('Thank you Bob!');
  });

  // ── Zernio banner precedence ──────────────────────────────────────────

  it('active DB connection beats stale non-finalize pending marker (transient Redis cleanup failure)', async () => {
    // Scenario: select-location committed `zernio_connections.status='active'`
    // but the best-effort Redis cleanup (luaDeletePendingByFlowIdAnyStatus)
    // failed silently. The pending marker lingers until its 15-min TTL
    // expires. The dashboard must show 'active' — not 'pending' — and must
    // NOT leak the stale flow into pendingFlow.
    mockRequireRole.mockResolvedValue(ownerUser());
    setDbResults({
      zernioConnectionRows: [{ status: 'active', disconnect_reason: null }],
      queuedReconnectRows: [{ count: 0 }],
      unresolvedIncidentRows: [{ count: 0 }],
    });
    mockRedisGet.mockResolvedValueOnce(
      JSON.stringify({
        flowId: 'stale-flow',
        userId: 'user-1',
        started_at: Date.now() - 5 * 60 * 1000, // 5 min old
        status: 'oauth_in_progress',
        profileId: 'mock-profile',
        state: 'mock-state',
      }),
    );

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);

    const body: DashboardDataActive = await res.json();
    expect(body.zernioConnection.status).toBe('active');
    expect(body.zernioConnection.pendingFlow).toBeUndefined();
    expect(body.zernioConnection.hasUnresolvedIncident).toBe(false);
  });

  it('non-finalize pending marker without active conn → status=pending (existing behaviour preserved)', async () => {
    // Regression guard: before the fix, ANY pending marker beat the DB
    // status. We only re-ordered the precedence so 'active' specifically
    // beats stale markers — a pending marker without an active DB row
    // must still surface as 'pending'.
    mockRequireRole.mockResolvedValue(ownerUser());
    setDbResults({
      zernioConnectionRows: [],
      queuedReconnectRows: [{ count: 0 }],
      unresolvedIncidentRows: [{ count: 0 }],
    });
    const startedAt = Date.now();
    mockRedisGet.mockResolvedValueOnce(
      JSON.stringify({
        flowId: 'flow-1',
        userId: 'user-1',
        started_at: startedAt,
        status: 'oauth_in_progress',
        profileId: 'mock-profile',
        state: 'mock-state',
      }),
    );

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);

    const body: DashboardDataActive = await res.json();
    expect(body.zernioConnection.status).toBe('pending');
    expect(body.zernioConnection.pendingFlow?.status).toBe('oauth_in_progress');
    expect(body.zernioConnection.pendingFlow?.started_at).toBe(startedAt);
  });

  it('unresolved incident beats active DB connection → status=finalize_unknown', async () => {
    // Even with an active DB row, a still-unresolved finalize incident
    // means the owner needs to know "we're not sure what happened on
    // Zernio's side". Surface finalize_unknown.
    mockRequireRole.mockResolvedValue(ownerUser());
    setDbResults({
      zernioConnectionRows: [{ status: 'active', disconnect_reason: null }],
      queuedReconnectRows: [{ count: 0 }],
      unresolvedIncidentRows: [{ count: 1 }],
    });
    mockRedisGet.mockResolvedValueOnce(null);

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);

    const body: DashboardDataActive = await res.json();
    expect(body.zernioConnection.status).toBe('finalize_unknown');
    expect(body.zernioConnection.hasUnresolvedIncident).toBe(true);
    // No marker → no leaked flow data.
    expect(body.zernioConnection.pendingFlow).toBeUndefined();
  });

  // ── Cancelled account grace period (cancelled_at) ──────────────────────

  it('cancelled account uses cancelled_at for grace period calculation', async () => {
    // Scenario: account was activated months ago but just cancelled.
    // Grace period should be cancelled_at + 30 days (future), not
    // subscription_activated_at + 30 days (which would be in the past).
    mockRequireRole.mockResolvedValue(ownerUser());

    mockSqlResults.length = 0;
    sqlCallCounter.value = 0;

    mockGetLocationById.mockResolvedValue({
      id: BUSINESS_ID,
      account_id: ACCOUNT_ID,
      name: 'Cancelled Biz',
      display_label: null,
      is_primary: true,
      archived_at: null,
      google_place_id: 'gp1',
      google_place_address: null,
      created_at: new Date(),
    });

    // Call 0: subscription status check (cancelled)
    mockSqlResults.push([
      {
        name: 'Cancelled Biz',
        subscription_status: 'cancelled',
        subscription_tier: 'standard',
        owner_email: 'owner@cancelled.com',
        archived_at: null,
      },
    ]);

    // Call 1: grace period query — should query cancelled_at
    const cancelledAt = new Date('2026-05-05T00:00:00Z');
    const activatedAt = new Date('2025-11-01T00:00:00Z'); // activated months ago
    mockSqlResults.push([
      { cancelled_at: cancelledAt, subscription_activated_at: activatedAt },
    ]);

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.subscriptionStatus).toBe('cancelled');
    expect(body.readAccess).toBe(true);

    // Grace period end should be cancelled_at + 30 days = 2026-06-04
    const graceEnd = new Date(body.gracePeriodEndDate);
    const expectedEnd = new Date(cancelledAt.getTime() + 30 * 86_400_000);
    expect(graceEnd.getTime()).toBe(expectedEnd.getTime());

    // Verify the SQL query selected cancelled_at (not just subscription_activated_at)
    // The second SQL call should be the grace period query
    const graceSql = capturedSqlTexts[1];
    expect(graceSql).toMatch(/SELECT\s+cancelled_at\s*,\s*subscription_activated_at\s+FROM\s+accounts/i);
  });

  it('cancelled account shows correct future date when cancelled months after activation', async () => {
    // This is the key bug fix scenario:
    // - subscription_activated_at = 6 months ago
    // - cancelled_at = just now
    // - Old bug: grace period = activated_at + 30 days = 6 months ago (expired!)
    // - New behavior: grace period = cancelled_at + 30 days = 30 days from now (active!)
    mockRequireRole.mockResolvedValue(ownerUser());

    mockSqlResults.length = 0;
    sqlCallCounter.value = 0;

    mockGetLocationById.mockResolvedValue({
      id: BUSINESS_ID,
      account_id: ACCOUNT_ID,
      name: 'Long Sub Biz',
      display_label: null,
      is_primary: true,
      archived_at: null,
      google_place_id: 'gp1',
      google_place_address: null,
      created_at: new Date(),
    });

    // Call 0: subscription status check (cancelled)
    mockSqlResults.push([
      {
        name: 'Long Sub Biz',
        subscription_status: 'cancelled',
        subscription_tier: 'standard',
        owner_email: 'owner@longsub.com',
        archived_at: null,
      },
    ]);

    // Call 1: grace period query — cancelled just now, activated long ago
    const now = new Date();
    const sixMonthsAgo = new Date(now.getTime() - 180 * 86_400_000);
    mockSqlResults.push([
      { cancelled_at: now, subscription_activated_at: sixMonthsAgo },
    ]);

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.subscriptionStatus).toBe('cancelled');
    expect(body.readAccess).toBe(true);

    // Grace period end should be ~30 days from now (cancelled_at + 30)
    // NOT ~30 days from 6 months ago (which would be in the past)
    const graceEnd = new Date(body.gracePeriodEndDate);
    const expectedEnd = new Date(now.getTime() + 30 * 86_400_000);

    // Allow 5-second tolerance for test execution time
    expect(Math.abs(graceEnd.getTime() - expectedEnd.getTime())).toBeLessThan(5000);

    // Grace period must be in the future
    expect(graceEnd.getTime()).toBeGreaterThan(Date.now() - 5000);
  });

  it('legacy row with null cancelled_at falls back to subscription_activated_at', async () => {
    // Legacy rows created before migration 037 may have cancelled_at = NULL.
    // In this case, fall back to subscription_activated_at for grace period.
    mockRequireRole.mockResolvedValue(ownerUser());

    mockSqlResults.length = 0;
    sqlCallCounter.value = 0;

    mockGetLocationById.mockResolvedValue({
      id: BUSINESS_ID,
      account_id: ACCOUNT_ID,
      name: 'Legacy Cancelled Biz',
      display_label: null,
      is_primary: true,
      archived_at: null,
      google_place_id: 'gp1',
      google_place_address: null,
      created_at: new Date(),
    });

    // Call 0: subscription status check (cancelled)
    mockSqlResults.push([
      {
        name: 'Legacy Cancelled Biz',
        subscription_status: 'cancelled',
        subscription_tier: 'standard',
        owner_email: 'owner@legacy.com',
        archived_at: null,
      },
    ]);

    // Call 1: grace period query — cancelled_at is null, activated_at is recent
    const activatedAt = new Date('2026-04-20T00:00:00Z');
    mockSqlResults.push([
      { cancelled_at: null, subscription_activated_at: activatedAt },
    ]);

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.subscriptionStatus).toBe('cancelled');

    // Grace period should fall back to activated_at + 30 days
    const graceEnd = new Date(body.gracePeriodEndDate);
    const expectedEnd = new Date(activatedAt.getTime() + 30 * 86_400_000);
    expect(graceEnd.getTime()).toBe(expectedEnd.getTime());
  });

  it('returns past-due recovery fields for a per-location dashboard response', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-25T12:00:00.000Z'));
    mockRequireRole.mockResolvedValue(ownerUser());

    mockSqlResults.length = 0;
    sqlCallCounter.value = 0;

    mockGetLocationById.mockResolvedValue({
      id: BUSINESS_ID,
      account_id: ACCOUNT_ID,
      name: 'Past Due Biz',
      display_label: null,
      is_primary: true,
      archived_at: null,
      google_place_id: 'gp1',
      google_place_address: null,
      created_at: new Date(),
    });

    setDbResults({ subRow: [
      {
        name: 'Past Due Biz',
        subscription_status: 'past_due',
        subscription_tier: 'standard',
        owner_email: 'owner@pastdue.com',
        onboarded_by: null,
        place_id_verified: true,
        google_maps_url: 'https://maps.example.com',
        archived_at: null,
        past_due_at: new Date('2026-05-20T12:00:00.000Z'),
        flags: {},
        stripe_customer_id: 'cus_123',
      },
    ] });

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data).toMatchObject({
      subscriptionStatus: 'past_due',
      accountId: ACCOUNT_ID,
      pastDueAt: '2026-05-20T12:00:00.000Z',
      pastDueDeadline: '2026-05-27T12:00:00.000Z',
      daysRemaining: 2,
      isReadOnly: false,
      billingPortalUrl: '/api/billing/portal',
      business: { name: 'Test Biz' },
    });
    vi.useRealTimers();
  });

  it('returns past-due recovery fields for aggregate dashboard response', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-25T12:00:00.000Z'));
    const previousMultiLocation = process.env.MULTI_LOCATION_ENABLED;
    process.env.MULTI_LOCATION_ENABLED = 'true';
    mockRequireRole.mockResolvedValue(ownerUser());

    mockSqlResults.length = 0;
    sqlCallCounter.value = 0;
    mockSqlResults.push([
      {
        subscription_status: 'past_due',
        past_due_at: new Date('2026-05-20T12:00:00.000Z'),
        flags: JSON.stringify({}),
        stripe_customer_id: 'cus_123',
      },
    ]);
    mockSqlResults.push([{ locations_included: 1, locations_paid: 0 }]);

    const res = await GET(makeRequest('/api/dashboard?scope=all'));
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data).toMatchObject({
      subscriptionStatus: 'past_due',
      businessName: 'Account',
      accountId: ACCOUNT_ID,
      pastDueAt: '2026-05-20T12:00:00.000Z',
      pastDueDeadline: '2026-05-27T12:00:00.000Z',
      daysRemaining: 2,
      isReadOnly: false,
      billingPortalUrl: '/api/billing/portal',
      scope: 'aggregate',
      activeLocationCount: 0,
    });
    process.env.MULTI_LOCATION_ENABLED = previousMultiLocation;
    vi.useRealTimers();
  });

  it('cancelled account with no cancelled_at and no activated_at defaults to read access', async () => {
    // Edge case: both cancelled_at and subscription_activated_at are null.
    // Should default to readAccess=true (defensive — don't lock out without evidence).
    mockRequireRole.mockResolvedValue(ownerUser());

    mockSqlResults.length = 0;
    sqlCallCounter.value = 0;

    mockGetLocationById.mockResolvedValue({
      id: BUSINESS_ID,
      account_id: ACCOUNT_ID,
      name: 'No Dates Biz',
      display_label: null,
      is_primary: true,
      archived_at: null,
      google_place_id: 'gp1',
      google_place_address: null,
      created_at: new Date(),
    });

    // Call 0: subscription status check (cancelled)
    mockSqlResults.push([
      {
        name: 'No Dates Biz',
        subscription_status: 'cancelled',
        subscription_tier: 'standard',
        owner_email: 'owner@nodates.com',
        archived_at: null,
      },
    ]);

    // Call 1: grace period query — both dates null
    mockSqlResults.push([
      { cancelled_at: null, subscription_activated_at: null },
    ]);

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.subscriptionStatus).toBe('cancelled');
    expect(body.gracePeriodEndDate).toBeNull();
    expect(body.readAccess).toBe(true);
  });

  it('pending marker with status=finalize_unknown → status=finalize_unknown, marker is surfaced', async () => {
    // The pending marker itself can carry the finalize_unknown signal —
    // mirroring the DB incident path. The marker should be surfaced so
    // the UI can render the same banner with the flow timestamp.
    mockRequireRole.mockResolvedValue(ownerUser());
    setDbResults({
      zernioConnectionRows: [],
      queuedReconnectRows: [{ count: 0 }],
      unresolvedIncidentRows: [{ count: 0 }],
    });
    const startedAt = Date.now() - 60_000;
    mockRedisGet.mockResolvedValueOnce(
      JSON.stringify({
        flowId: 'flow-finalize',
        userId: 'user-1',
        started_at: startedAt,
        status: 'finalize_unknown',
        profileId: 'mock-profile',
        state: 'mock-state',
      }),
    );

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);

    const body: DashboardDataActive = await res.json();
    expect(body.zernioConnection.status).toBe('finalize_unknown');
    expect(body.zernioConnection.pendingFlow?.status).toBe('finalize_unknown');
    expect(body.zernioConnection.pendingFlow?.started_at).toBe(startedAt);
  });
});
