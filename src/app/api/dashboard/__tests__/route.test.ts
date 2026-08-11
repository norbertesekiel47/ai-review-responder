import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Hoisted shared state (available inside vi.mock factories) ────────

const { mockRequireRole, mockSqlResults, sqlCallCounter, capturedSqlTexts, capturedSqlValues } = vi.hoisted(() => ({
  mockRequireRole: vi.fn(),
  mockSqlResults: [] as unknown[][],
  sqlCallCounter: { value: 0 },
  capturedSqlTexts: [] as string[],
  // Bound (interpolated) values per query — proves the analytics window reaches
  // SQL as bound make_interval params, never as interpolated text (#403).
  capturedSqlValues: [] as unknown[][],
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

vi.mock('@/lib/db/server', () => {
  const isExecutedStatement = (text: string) =>
    /^\s*(select|insert|update|delete|with)\b/i.test(text);

  return {
    sql: new Proxy(() => {}, {
      apply: (_target, _thisArg, argumentsList) => {
        const first = argumentsList[0];
        const isTemplate = first != null && typeof first === 'object' && 'raw' in (first as object);
        if (isTemplate) {
          const text = (first as TemplateStringsArray).raw.join('?');
          // Fragment builds (the dashboard-service's openFlagExistsSql
          // `EXISTS (…)` + its `responses.id` ref, #730 T5) are returned as
          // inert fragment objects: they must NOT consume a ledger position
          // — mockSqlResults/sqlCallCounter and the captured texts/values
          // account for EXECUTED statements only.
          if (!isExecutedStatement(text)) {
            return { fragmentText: text, values: argumentsList.slice(1) };
          }
          capturedSqlTexts.push(text);
          capturedSqlValues.push(argumentsList.slice(1));
        }
        const result = mockSqlResults[sqlCallCounter.value] ?? [];
        sqlCallCounter.value++;
        return Promise.resolve(result);
      },
    }),
    jsonb: (v: unknown) => v,
  };
});

// ── Mock Redis (Zernio pending marker read) ──────────────────────────
// The dashboard service reads `connect_pending:{businessId}` from Redis to
// surface in-flight connect flows. Tests don't exercise that path so we
// always return null. Real outage handling is covered in service-level
// tests (try/catch around the .get call).

const { mockRedisGet } = vi.hoisted(() => ({
  mockRedisGet: vi.fn<(key?: string) => Promise<string | null>>(async () => null),
}));

// getActiveDashboardData now also does a read-through cache GET/SET on its own
// `dashboard:location:…` key (ticket #478). That key is distinct from the
// pending marker in production; here the mock is key-aware so the dashboard
// cache is always a clean miss (null) — the pending-marker tests keep driving
// `mockRedisGet` — and SET is a no-op.
vi.mock('@/lib/db/redis-cache', () => ({
  getCacheRedis: () => ({
    get: (key: string) =>
      key.startsWith('dashboard:') ? Promise.resolve(null) : mockRedisGet(key),
    set: async () => 'OK',
  }),
}));

// ── No more payment-link mock (checkout session replaces it) ───────

// ── Mock location repo ───────────────────────────────────────────────
// The dashboard route no longer calls getLocationById (the single preflight
// SQL query owns the IDOR/archived checks now), but ./policy still imports it
// and the aggregate path uses getLocationsForAccount, so the module stays
// mocked to keep those imports off the real DB client.

vi.mock('@/lib/locations/repo', () => ({
  getActiveLocationCount: vi.fn(async () => 1),
  getLocationsForAccount: vi.fn(async () => []),
  getLocationById: vi.fn(async () => null),
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
 * Default merged preflight row returned by fetchLocationAccountRow (call 0).
 * One row now carries BOTH the account/subscription columns (IDOR + gate
 * checks) AND every DashboardBusinessRow field, because the route passes it
 * into getActiveDashboardData as opts.business (the service skips its own
 * business query). account_id MUST match the authenticated owner and
 * archived_at MUST be null or the route 403s / falls back to primary.
 */
const DEFAULT_SUB_ROW = {
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
  // DashboardBusinessRow fields (the preflight row doubles as the service's
  // business row).
  created_at: new Date('2025-01-15T00:00:00Z'),
  initial_review_count: 10,
  initial_responded_count: 3,
  baseline_captured_at: new Date('2025-01-15T00:00:00Z'),
  tone: null,
  products_services: null,
  avoid_facts: [],
  sample_responses: [],
  owner_phone: null,
  weekly_summary_enabled: true,
  monthly_impact_enabled: true,
  category: null,
  google_place_id: 'gp1',
};

/**
 * Sets up sql query results in order for the active per-location path.
 *
 * Call 0: fetchLocationAccountRow — the merged preflight row (IDOR/archived
 *   checks + DashboardBusinessRow fields; the service's business query is
 *   SKIPPED because the route passes this row in as opts.business).
 * Calls 1–7: the Promise.all heavy queries (totals/velocity/ranking/reviews/briefs).
 * Calls 8–10: the Zernio banner queries (zernio_connections, queued reconnects,
 *   unresolved incidents).
 * Call 11: the windowed reviews-by-rating breakdown GROUP BY (#405).
 * Calls 12–15: the reputation windows (rate/star/timeSaved/sentiment trend) —
 *   these run in the SAME Promise.all wave; the queue leaves them unset so they
 *   fall back to [] (fetchReputationRows substitutes zeroed defaults).
 * Call 16: pendingApprovalCount (src/lib/dashboard/pending-count.ts) — also []
 *   by default → 0.
 *
 * The Promise.all also includes the Redis pending-marker read, but that
 * resolves through `mockRedisGet`, not through the sql proxy.
 *
 * `subRow` / `businessRows` overrides are both merged into call 0 (an
 * explicitly empty `subRow: []` simulates "location not found").
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
  ratingBreakdownRows?: unknown[];
}) {
  mockSqlResults.length = 0;
  sqlCallCounter.value = 0;

  // Call 0: merged preflight row (fetchLocationAccountRow)
  if (overrides?.subRow && overrides.subRow.length === 0) {
    mockSqlResults.push([]);
  } else {
    mockSqlResults.push([
      {
        ...DEFAULT_SUB_ROW,
        ...((overrides?.subRow?.[0] as object | undefined) ?? {}),
        ...((overrides?.businessRows?.[0] as object | undefined) ?? {}),
      },
    ]);
  }

  // Calls 1–11 (only reached when the preflight row passes all gates)
  mockSqlResults.push(
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
    // Calls 8–10: Zernio banner queries. Default to "no Zernio state" so
    // tests that don't care about banner precedence keep their existing
    // behaviour (status resolves to 'none').
    overrides?.zernioConnectionRows ?? [],
    overrides?.queuedReconnectRows ?? [{ count: 0 }],
    overrides?.unresolvedIncidentRows ?? [{ count: 0 }],
    // Call 11: windowed reviews-by-rating breakdown (#405). Empty by default.
    overrides?.ratingBreakdownRows ?? [],
  );
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('GET /api/dashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSqlResults.length = 0;
    sqlCallCounter.value = 0;
    capturedSqlTexts.length = 0;
    capturedSqlValues.length = 0;
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

  it('returns 404 when the preflight row query finds no business and no primary exists', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());

    mockSqlResults.length = 0;
    sqlCallCounter.value = 0;
    // Call 0: preflight row query finds nothing (location not found)
    mockSqlResults.push([]);
    // Call 1: getPrimaryLocationId — no usable primary → 404
    mockSqlResults.push([]);

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

    // Call 0: preflight row (owned, active location, pending_payment sub)
    mockSqlResults.push([
      {
        ...DEFAULT_SUB_ROW,
        name: 'Pending Biz',
        subscription_status: 'pending_payment',
        owner_email: 'owner@pending.com',
        onboarded_by: null, // self-serve — owner sees the payment CTA
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

    // Only 1 sql call (the preflight row query). Promise.all heavy queries must not have run.
    expect(sqlCallCounter.value).toBe(1);

    // No-store header still present
    expect(res.headers.get('Cache-Control')).toBe('no-store, private');
  });

  it('returns paymentUrl pointing to /onboarding/pay for self-serve pending_payment', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());

    mockSqlResults.length = 0;
    sqlCallCounter.value = 0;

    // Call 0: preflight row
    mockSqlResults.push([
      {
        ...DEFAULT_SUB_ROW,
        name: 'Founding Biz',
        subscription_status: 'pending_payment',
        owner_email: 'founder@example.com',
        onboarded_by: null,
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

    // Call 0: preflight row (admin-onboarded)
    mockSqlResults.push([
      {
        ...DEFAULT_SUB_ROW,
        name: 'Admin Onboarded Biz',
        subscription_status: 'pending_payment',
        owner_email: 'owner@admin-onboarded.com',
        onboarded_by: 'admin-uuid-1',
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

    // Preflight query only — Promise.all heavy queries skipped.
    expect(sqlCallCounter.value).toBe(1);
  });

  it('returns paymentUrl pointing to /onboarding/pay even when env vars are unset', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());

    mockSqlResults.length = 0;
    sqlCallCounter.value = 0;

    // Call 0: preflight row
    mockSqlResults.push([
      {
        ...DEFAULT_SUB_ROW,
        name: 'No Env Biz',
        subscription_status: 'pending_payment',
        owner_email: 'owner@noenv.com',
        onboarded_by: null,
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

  it('returns the windowed reviews-by-rating breakdown in the active payload (#405)', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    setDbResults({
      ratingBreakdownRows: [
        { stars: 5, count: 4 },
        { stars: 4, count: 1 },
        { stars: 2, count: 3 },
      ],
    });

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);

    const body: DashboardDataActive = await res.json();
    // Zero-filled, ordered 5★→1★, summed total — the true aggregate, not the sample.
    expect(body.ratingBreakdown.counts).toEqual([
      { stars: 5, count: 4 },
      { stars: 4, count: 1 },
      { stars: 3, count: 0 },
      { stars: 2, count: 3 },
      { stars: 1, count: 0 },
    ]);
    expect(body.ratingBreakdown.total).toBe(8);

    // The breakdown is windowed: windowDays reaches SQL as a BOUND INTEGER (#403).
    // Since #757 the interval text lives inside the composed Review-time anchor
    // fragment (reviewTimeWindowFilter, src/lib/kpi/fragments.ts), and THIS file's
    // sql mock is not fragment-aware — it renders any nested fragment as a bare
    // `?`, so the inner `make_interval(days => ?)` is invisible here. Assert the
    // bound value instead, which is what the #403 invariant actually claims; the
    // text-level proof lives in service.rating-breakdown.test.ts and
    // service.review-time-anchor.test.ts, both on the fragment-aware
    // createMockSql harness.
    // This mock returns a nested fragment as an inert { fragmentText, values }
    // object, so both halves of the claim are still recoverable one level down.
    const breakdownIdx = capturedSqlTexts.findIndex((t) => t.includes('GROUP BY star_rating'));
    expect(breakdownIdx).toBeGreaterThanOrEqual(0);
    expect(capturedSqlTexts[breakdownIdx]).toContain('business_id = ?');

    const captured = capturedSqlValues[breakdownIdx] ?? [];
    const isFragment = (v: unknown): v is { fragmentText: string; values: unknown[] } =>
      typeof v === 'object' && v !== null && 'fragmentText' in v;
    const fragmentText = captured.filter(isFragment).map((f) => f.fragmentText).join(' ');
    const boundValues = captured.flatMap((v) => (isFragment(v) ? v.values : [v]));

    // Interval text: still make_interval(...), never an interpolated literal.
    expect(fragmentText).toContain('make_interval(days => ?)');
    expect(fragmentText).not.toMatch(/INTERVAL\s+'\d+\s+days'/i);
    // …and windowDays reaches SQL as the bound integer 30.
    expect(boundValues).toContain(30);
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

    // Call 0: preflight row (cancelled)
    mockSqlResults.push([
      {
        ...DEFAULT_SUB_ROW,
        name: 'Cancelled Biz',
        subscription_status: 'cancelled',
        owner_email: 'owner@cancelled.com',
      },
    ]);

    // Call 1: grace period query — should query cancelled_at.
    // Relative to now so the 30-day grace window stays in the future no matter
    // when CI runs; a hard-coded cancelled_at previously expired once the
    // calendar crossed grace end and flipped readAccess to false.
    const cancelledAt = new Date(Date.now() - 5 * 86_400_000); // 5 days ago
    const activatedAt = new Date('2025-11-01T00:00:00Z'); // activated months ago
    mockSqlResults.push([
      { cancelled_at: cancelledAt, subscription_activated_at: activatedAt },
    ]);

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.subscriptionStatus).toBe('cancelled');
    expect(body.readAccess).toBe(true);

    // Grace period end should be cancelled_at + 30 days.
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

    // Call 0: preflight row (cancelled)
    mockSqlResults.push([
      {
        ...DEFAULT_SUB_ROW,
        name: 'Long Sub Biz',
        subscription_status: 'cancelled',
        owner_email: 'owner@longsub.com',
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

    // Call 0: preflight row (cancelled)
    mockSqlResults.push([
      {
        ...DEFAULT_SUB_ROW,
        name: 'Legacy Cancelled Biz',
        subscription_status: 'cancelled',
        owner_email: 'owner@legacy.com',
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

    setDbResults({ subRow: [
      {
        name: 'Past Due Biz',
        subscription_status: 'past_due',
        owner_email: 'owner@pastdue.com',
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
      // The preflight row doubles as the service's business row now, so the
      // rendered business name comes from the same merged row.
      business: { name: 'Past Due Biz' },
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

    // Call 0: preflight row (cancelled)
    mockSqlResults.push([
      {
        ...DEFAULT_SUB_ROW,
        name: 'No Dates Biz',
        subscription_status: 'cancelled',
        owner_email: 'owner@nodates.com',
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

  // ── Analytics time-range window (#403) ─────────────────────────────────

  // Numeric bound values across every windowed query (proves intervals reach
  // SQL as bound make_interval params, not interpolated text).
  const numericBoundValues = (): number[] =>
    capturedSqlValues.flat().filter((v): v is number => typeof v === 'number');

  it('default (no window param) keeps the 30-day / 60-day reputation buckets and 8-week trend', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    setDbResults();

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);

    // Behavior unchanged — the active payload is identical to the legacy path.
    const body: DashboardDataActive = await res.json();
    expect(body.business.name).toBe('Test Biz');

    // windowDays=30, priorEndDays=60 reach the reputation queries as bound ints.
    const values = numericBoundValues();
    expect(values).toContain(30);
    expect(values).toContain(60);
    expect(values).not.toContain(14);

    // No interval is ever interpolated as raw SQL text; every windowed query
    // uses make_interval(...).
    for (const text of capturedSqlTexts) {
      expect(text).not.toMatch(/INTERVAL\s+'\d+\s+(days|weeks)'/i);
    }
    const joined = capturedSqlTexts.join('\n');
    expect(joined).toContain('make_interval(days => ?)');
    expect(joined).toContain('make_interval(weeks => ?)');
  });

  it('?window=7d threads windowDays=7 / priorEndDays=14 through to the SQL as bound params', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    setDbResults();

    const res = await GET(makeRequest('/api/dashboard?window=7d'));
    expect(res.status).toBe(200);

    const values = numericBoundValues();
    expect(values).toContain(7);
    expect(values).toContain(14);
    expect(values).not.toContain(60);
  });

  it('?window=90d threads windowDays=90 / priorEndDays=180', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    setDbResults();

    const res = await GET(makeRequest('/api/dashboard?window=90d'));
    expect(res.status).toBe(200);

    const values = numericBoundValues();
    expect(values).toContain(90);
    expect(values).toContain(180);
  });

  it('invalid ?window= clamps to the default window (30/60 buckets), never reaching SQL untrusted', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    setDbResults();

    const res = await GET(makeRequest('/api/dashboard?window=999d-or-injection'));
    expect(res.status).toBe(200);

    const values = numericBoundValues();
    expect(values).toContain(30);
    expect(values).toContain(60);
    expect(values).not.toContain(14);
  });
});
