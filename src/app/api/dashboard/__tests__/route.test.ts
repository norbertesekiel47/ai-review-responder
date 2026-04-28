import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Hoisted shared state (available inside vi.mock factories) ────────

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
  jsonb: (v: unknown) => v,
}));

// ── Mock Redis (Zernio pending marker read) ──────────────────────────
// The dashboard service reads `connect_pending:{businessId}` from Redis to
// surface in-flight connect flows. Tests don't exercise that path so we
// always return null. Real outage handling is covered in service-level
// tests (try/catch around the .get call).

const { mockRedisGet } = vi.hoisted(() => ({
  mockRedisGet: vi.fn(async () => null),
}));

vi.mock('@/lib/db/redis-cache', () => ({
  getCacheRedis: () => ({ get: mockRedisGet }),
}));

// ── Mock payment-link ────────────────────────────────────────────────

vi.mock('@/lib/payments/payment-link', () => ({
  buildPaymentLinkUrl: vi.fn(),
}));

// Import AFTER mocks are set up
import { GET, type DashboardData, type DashboardDataActive } from '../route';
import { AuthError } from '@/lib/db/auth';
import { buildPaymentLinkUrl } from '@/lib/payments/payment-link';

const mockBuildPaymentLinkUrl = vi.mocked(buildPaymentLinkUrl);

// ── Helpers ──────────────────────────────────────────────────────────

function makeRequest(): NextRequest {
  return new NextRequest('http://localhost:3000/api/dashboard');
}

const BUSINESS_ID = '01234567-0000-0000-0000-000000000001';

function ownerUser(overrides?: { businessId?: string | null }) {
  return {
    id: 'user-1',
    name: 'Test Owner',
    email: 'owner@test.com',
    role: 'owner',
    businessId: overrides && 'businessId' in overrides ? overrides.businessId : BUSINESS_ID,
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
};

/**
 * Sets up sql query results in order.
 * Call 0 = subRow (pre-query).
 * Calls 1–8 = the Promise.all 8 queries (active path only).
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
}) {
  mockSqlResults.length = 0;
  sqlCallCounter.value = 0;

  // Call 0: pre-query (subRow — subscription status check)
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
  );
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('GET /api/dashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSqlResults.length = 0;
    sqlCallCounter.value = 0;
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

  it('returns 403 when user has no businessId', async () => {
    mockRequireRole.mockResolvedValue(ownerUser({ businessId: null }));

    const res = await GET(makeRequest());
    expect(res.status).toBe(403);

    const body = await res.json();
    expect(body.error).toBe('No business associated with this account');
  });

  it('returns 404 when pre-query finds no business', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    // subRow empty — pre-query returns no rows
    setDbResults({ subRow: [] });

    const res = await GET(makeRequest());
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.error).toBe('Business not found');
  });

  // ── pending_payment early-branch ──────────────────────────────────

  it('returns minimal payload for pending_payment, no heavy queries run', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    mockBuildPaymentLinkUrl.mockReturnValue('https://pay.stripe.com/test?client_reference_id=...');

    mockSqlResults.length = 0;
    sqlCallCounter.value = 0;
    // Only the pre-query result — Promise.all must NOT be reached
    mockSqlResults.push([
      {
        name: 'Pending Biz',
        subscription_status: 'pending_payment',
        subscription_tier: 'standard',
        owner_email: 'owner@pending.com',
        onboarded_by: null, // self-serve — owner sees the payment CTA
      },
    ]);

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.subscriptionStatus).toBe('pending_payment');
    expect(body.businessId).toBe(BUSINESS_ID);
    expect(body.businessName).toBe('Pending Biz');
    expect(body.paymentUrl).toBe('https://pay.stripe.com/test?client_reference_id=...');

    // Minimal shape — full dashboard fields must be absent
    expect(body.business).toBeUndefined();
    expect(body.valueSummary).toBeUndefined();
    expect(body.recentReviews).toBeUndefined();

    // Only 1 sql call (the pre-query). Promise.all 8 queries must not have run.
    expect(sqlCallCounter.value).toBe(1);

    // No-store header still present
    expect(res.headers.get('Cache-Control')).toBe('no-store, private');
  });

  it('calls buildPaymentLinkUrl with tier, businessId, and owner_email', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    mockBuildPaymentLinkUrl.mockReturnValue('https://pay.stripe.com/founding');

    mockSqlResults.length = 0;
    sqlCallCounter.value = 0;
    mockSqlResults.push([
      {
        name: 'Founding Biz',
        subscription_status: 'pending_payment',
        subscription_tier: 'founding',
        owner_email: 'founder@example.com',
        onboarded_by: null,
      },
    ]);

    await GET(makeRequest());

    expect(mockBuildPaymentLinkUrl).toHaveBeenCalledOnce();
    expect(mockBuildPaymentLinkUrl).toHaveBeenCalledWith(
      'founding',
      BUSINESS_ID,
      'founder@example.com',
    );
  });

  it('returns admin-handoff payload when pending_payment + onboarded_by IS NOT NULL', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    // Spy is in place but should NOT be called — admin-handoff path skips the link.
    mockBuildPaymentLinkUrl.mockReturnValue('https://pay.stripe.com/should-not-be-called');

    mockSqlResults.length = 0;
    sqlCallCounter.value = 0;
    mockSqlResults.push([
      {
        name: 'Admin Onboarded Biz',
        subscription_status: 'pending_payment',
        subscription_tier: 'founding',
        owner_email: 'owner@admin-onboarded.com',
        onboarded_by: 'admin-uuid-1',
      },
    ]);

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.subscriptionStatus).toBe('pending_payment_admin_handoff');
    expect(body.businessId).toBe(BUSINESS_ID);
    expect(body.businessName).toBe('Admin Onboarded Biz');
    // Critical: no paymentUrl in admin-handoff payload (avoids double-charge risk).
    expect(body.paymentUrl).toBeUndefined();

    // buildPaymentLinkUrl must NOT be called on the admin-handoff branch.
    expect(mockBuildPaymentLinkUrl).not.toHaveBeenCalled();

    // Pre-query only — Promise.all heavy queries skipped.
    expect(sqlCallCounter.value).toBe(1);
  });

  it('returns paymentUrl: null when buildPaymentLinkUrl returns null (env not set)', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    mockBuildPaymentLinkUrl.mockReturnValue(null);

    mockSqlResults.length = 0;
    sqlCallCounter.value = 0;
    mockSqlResults.push([
      {
        name: 'No Env Biz',
        subscription_status: 'pending_payment',
        subscription_tier: 'standard',
        owner_email: 'owner@noenv.com',
        onboarded_by: null,
      },
    ]);

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.subscriptionStatus).toBe('pending_payment');
    expect(body.paymentUrl).toBeNull();
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
});
