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
}));

// Import AFTER mocks are set up
import { GET, type DashboardData } from '../route';
import { AuthError } from '@/lib/db/auth';

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

/** Sets up the 8 sql query results in order matching the Promise.all */
function setDbResults(overrides?: {
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
        status: 'processed',
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

  it('returns 404 when business not found', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    setDbResults({ businessRows: [] });

    const res = await GET(makeRequest());
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.error).toBe('Business not found');
  });

  it('returns full dashboard data for valid owner', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    setDbResults();

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);

    const body: DashboardData = await res.json();
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

    const body: DashboardData = await res.json();
    expect(body.ranking).toBeNull();
  });

  it('returns null latestBrief when no summaries exist', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    setDbResults({ monthlyBriefRows: [], weeklyBriefRows: [] });

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);

    const body: DashboardData = await res.json();
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

    const body: DashboardData = await res.json();
    expect(body.reviewVelocity).toEqual([
      { weekStart: '2025-03-03', count: 0 },
      { weekStart: '2025-03-10', count: 0 },
    ]);
  });

  it('prefers weekly brief when it is more recent than monthly', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    setDbResults({
      monthlyBriefRows: [
        { summary_text: 'Monthly summary', month_start_date: '2025-02-01' },
      ],
      weeklyBriefRows: [
        { summary_text: 'Weekly summary', week_start_date: '2025-03-10' },
      ],
    });

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);

    const body: DashboardData = await res.json();
    expect(body.latestBrief).not.toBeNull();
    expect(body.latestBrief!.type).toBe('weekly');
    expect(body.latestBrief!.text).toBe('Weekly summary');
    expect(body.latestBrief!.periodLabel).toBe('Week of 2025-03-10');
  });
});
