// src/lib/admin/__tests__/overview-service.test.ts
//
// Characterization tests for getAdminOverview — written FIRST (TDD) against
// the extraction target: src/app/api/admin/overview/route.ts's GET body
// (7 queries + conditional churn-metrics CTE + churn-score/sort/
// pagination + email-health redState derivation).
//
// Those 7 queries were originally a Promise.all and now run SEQUENTIALLY (#505 —
// the fan-out exceeded the Vercel pool and wedged connections permanently). The
// shape is guarded by pool-fanout-sequential.test.ts; this suite is unaffected
// because sequential await order and Promise.all array order are identical, so
// the mock's FIFO queue is consumed in exactly the same order as before.
//
// getAdminOverview is born-injected (sql is a parameter, A+ campaign PR 2b),
// so the fragment-aware createMockSql harness (shared with worker suites)
// stands in for `sql` directly — no @/lib/db/server mocking needed.
//
// computeChurnRiskScore is NOT mocked: fixtures feed real BusinessMetrics
// inputs and assertions pin the REAL resulting score/level, so the sort and
// tiebreaker assertions exercise the actual production comparator, not a
// stand-in.
//
// Query order (matches the service's sequential dispatch order, which the
// mock's lazy-thenable FIFO queue is consumed in):
//   0: pendingOutboxRows   1: failedJobsRows   2: todayCostRows
//   3: notifFailureRows    4: emailHealthRows  5: businessRows
//   6: businessCountRows   7: metricsRows (ONLY when businessRows non-empty)

import { describe, it, expect, beforeEach } from 'vitest';
import type { Sql } from 'postgres';
import {
  createMockSql,
  type MockSqlHarness,
} from '../../../../worker/__tests__/helpers/mock-sql';
import { getAdminOverview } from '../overview-service';

interface SystemHealthFixture {
  count: number;
}

interface EmailHealthFixture {
  sent_24h: number;
  delivered_24h: number;
  bounces_7d: number;
  hard_bounces_7d: number;
  complaints_7d: number;
}

interface BusinessRowFixture {
  id: string;
  name: string;
  subscription_status: string;
  last_sync_at: Date | null;
  pending_approval_count: number;
  pending_reconnect_count: number;
  total_responses: number;
  completed_responses: number;
  avg_response_time_hours: number | null;
  last_activity: Date | null;
}

interface MetricsRowFixture {
  business_id: string;
  approval_rate: number | null;
  notified_count: number;
  pending_count: number;
  days_since_approval: number | null;
  account_age_days: number;
  avg_hours_current: number | null;
  avg_hours_prev: number | null;
}

/** Queues the 7 base Promise.all results in the exact array order the service issues them. */
function queueBaseQueries(
  harness: MockSqlHarness,
  fixtures: {
    pendingOutbox?: SystemHealthFixture[];
    failedJobs?: SystemHealthFixture[];
    todayCost?: { total: number }[];
    notifFailures?: SystemHealthFixture[];
    emailHealth?: EmailHealthFixture[];
    businessRows?: BusinessRowFixture[];
    businessCount?: { total: number }[];
  },
): void {
  harness.sqlReturnQueue.push(fixtures.pendingOutbox ?? [{ count: 0 }]);
  harness.sqlReturnQueue.push(fixtures.failedJobs ?? [{ count: 0 }]);
  harness.sqlReturnQueue.push(fixtures.todayCost ?? [{ total: 0 }]);
  harness.sqlReturnQueue.push(fixtures.notifFailures ?? [{ count: 0 }]);
  harness.sqlReturnQueue.push(
    fixtures.emailHealth ?? [
      { sent_24h: 0, delivered_24h: 0, bounces_7d: 0, hard_bounces_7d: 0, complaints_7d: 0 },
    ],
  );
  harness.sqlReturnQueue.push(fixtures.businessRows ?? []);
  harness.sqlReturnQueue.push(fixtures.businessCount ?? [{ total: fixtures.businessRows?.length ?? 0 }]);
}

let harness: MockSqlHarness;
let mockSql: Sql;

beforeEach(() => {
  harness = createMockSql();
  mockSql = harness.mockSql as unknown as Sql;
});

describe('getAdminOverview — shape', () => {
  it('returns the full OverviewData shape for a single business', async () => {
    const lastSync = new Date('2026-06-01T12:00:00Z');
    const lastActivity = new Date('2026-06-30T08:00:00Z');

    queueBaseQueries(harness, {
      pendingOutbox: [{ count: 3 }],
      failedJobs: [{ count: 1 }],
      todayCost: [{ total: 4.5 }],
      notifFailures: [{ count: 2 }],
      emailHealth: [
        { sent_24h: 40, delivered_24h: 38, bounces_7d: 1, hard_bounces_7d: 0, complaints_7d: 0 },
      ],
      businessRows: [
        {
          id: 'biz-shape',
          name: 'Shape Co',
          subscription_status: 'active',
          last_sync_at: lastSync,
          pending_approval_count: 2,
          pending_reconnect_count: 1,
          total_responses: 10,
          completed_responses: 7,
          avg_response_time_hours: 3.5,
          last_activity: lastActivity,
        },
      ],
      businessCount: [{ total: 1 }],
    });
    // metricsRows (8th query) — businessRows is non-empty so this WILL be consumed.
    harness.sqlReturnQueue.push([
      {
        business_id: 'biz-shape',
        approval_rate: 1,
        notified_count: 5,
        pending_count: 0,
        days_since_approval: 1,
        account_age_days: 100,
        avg_hours_current: null,
        avg_hours_prev: null,
      },
    ] satisfies MetricsRowFixture[]);

    const result = await getAdminOverview(mockSql, { limit: 20, offset: 0 });

    expect(result).toEqual({
      systemHealth: {
        pendingOutbox: 3,
        failedJobs: 1,
        todayCostUsd: 4.5,
        notificationFailures24h: 2,
        emailHealth: {
          sent24h: 40,
          delivered24h: 38,
          bounces7d: 1,
          hardBounces7d: 0,
          complaints7d: 0,
          deliveryRate24h: 95,
          redState: false,
        },
      },
      totalBusinesses: 1,
      limit: 20,
      offset: 0,
      responseMetricsWindowDays: 30,
      businesses: [
        {
          id: 'biz-shape',
          name: 'Shape Co',
          subscriptionStatus: 'active',
          lastSyncAt: lastSync.toISOString(),
          pendingApprovalCount: 2,
          pendingReconnectCount: 1,
          totalResponses: 10,
          completedResponses: 7,
          responseRate: 70,
          avgResponseTimeHours: 3.5,
          lastActivity: lastActivity.toISOString(),
          churnScore: {
            score: 0,
            level: 'healthy',
            breakdown: expect.any(Array),
          },
        },
      ],
    });

    // Exactly 8 queries issued (7 base + 1 metricsRows, since businessRows is non-empty).
    expect(harness.sqlCalls).toHaveLength(8);
  });

  // `maps null last_sync_at / last_activity to null (not a crash on missing
  // Date)` moved to __tests__/business-summary.test.ts in T2: it characterizes
  // buildBusinessSummary, which is now owned by src/lib/admin/business-summary.ts
  // (spec §5.2/§5.6). Its assertion bodies went over unchanged.

  it('pins the status literals used by the businessRows query (behavior-preservation)', async () => {
    queueBaseQueries(harness, { businessRows: [], businessCount: [{ total: 0 }] });

    await getAdminOverview(mockSql, { limit: 20, offset: 0 });

    const businessQuery = harness.sqlCalls[5]!;
    expect(businessQuery.text).toContain("resp.status = 'pending_approval'");
    expect(businessQuery.text).toContain("resp.status = 'awaiting_owner_connect'");
    expect(businessQuery.text).toContain("resp.status != 'superseded'");
  });
});

describe('getAdminOverview — empty businessRows path', () => {
  it('skips the metricsRows query entirely when there are no businesses', async () => {
    queueBaseQueries(harness, { businessRows: [], businessCount: [{ total: 0 }] });

    const result = await getAdminOverview(mockSql, { limit: 20, offset: 0 });

    expect(result.businesses).toEqual([]);
    expect(result.totalBusinesses).toBe(0);
    // Only the 7 base queries — the conditional metricsRows CTE never fires.
    expect(harness.sqlCalls).toHaveLength(7);
  });
});

describe('getAdminOverview — email-health redState derivation', () => {
  it('is false when delivery rate is healthy and there are no bounces/complaints', async () => {
    queueBaseQueries(harness, {
      emailHealth: [
        { sent_24h: 100, delivered_24h: 100, bounces_7d: 0, hard_bounces_7d: 0, complaints_7d: 0 },
      ],
      businessRows: [],
      businessCount: [{ total: 0 }],
    });

    const result = await getAdminOverview(mockSql, { limit: 20, offset: 0 });

    expect(result.systemHealth.emailHealth.deliveryRate24h).toBe(100);
    expect(result.systemHealth.emailHealth.redState).toBe(false);
  });

  it('trigger 1: is true when delivery rate < 95% AND sent24h >= 5', async () => {
    queueBaseQueries(harness, {
      emailHealth: [
        { sent_24h: 10, delivered_24h: 9, bounces_7d: 0, hard_bounces_7d: 0, complaints_7d: 0 },
      ],
      businessRows: [],
      businessCount: [{ total: 0 }],
    });

    const result = await getAdminOverview(mockSql, { limit: 20, offset: 0 });

    expect(result.systemHealth.emailHealth.deliveryRate24h).toBe(90);
    expect(result.systemHealth.emailHealth.redState).toBe(true);
  });

  it('trigger 1 does NOT fire below the 5-send volume floor, even at very low delivery rate', async () => {
    queueBaseQueries(harness, {
      emailHealth: [
        { sent_24h: 3, delivered_24h: 1, bounces_7d: 0, hard_bounces_7d: 0, complaints_7d: 0 },
      ],
      businessRows: [],
      businessCount: [{ total: 0 }],
    });

    const result = await getAdminOverview(mockSql, { limit: 20, offset: 0 });

    expect(result.systemHealth.emailHealth.redState).toBe(false);
  });

  it('trigger 2: is true on any 7d complaint, even with perfect delivery', async () => {
    queueBaseQueries(harness, {
      emailHealth: [
        { sent_24h: 100, delivered_24h: 100, bounces_7d: 0, hard_bounces_7d: 0, complaints_7d: 1 },
      ],
      businessRows: [],
      businessCount: [{ total: 0 }],
    });

    const result = await getAdminOverview(mockSql, { limit: 20, offset: 0 });

    expect(result.systemHealth.emailHealth.deliveryRate24h).toBe(100);
    expect(result.systemHealth.emailHealth.redState).toBe(true);
  });

  it('trigger 3: is true on any 7d hard bounce, even with perfect delivery', async () => {
    queueBaseQueries(harness, {
      emailHealth: [
        { sent_24h: 100, delivered_24h: 100, bounces_7d: 1, hard_bounces_7d: 1, complaints_7d: 0 },
      ],
      businessRows: [],
      businessCount: [{ total: 0 }],
    });

    const result = await getAdminOverview(mockSql, { limit: 20, offset: 0 });

    expect(result.systemHealth.emailHealth.redState).toBe(true);
  });

  it('defaults deliveryRate24h to 100 (not NaN) when there is no email-health row at all', async () => {
    queueBaseQueries(harness, { emailHealth: [], businessRows: [], businessCount: [{ total: 0 }] });

    const result = await getAdminOverview(mockSql, { limit: 20, offset: 0 });

    expect(result.systemHealth.emailHealth.sent24h).toBe(0);
    expect(result.systemHealth.emailHealth.deliveryRate24h).toBe(100);
    expect(result.systemHealth.emailHealth.redState).toBe(false);
  });
});

describe('getAdminOverview — churn-descending sort + tiebreakers', () => {
  it('sorts by churnScore.score desc, then pendingApprovalCount desc, then name asc, then id asc', async () => {
    // Four businesses fed in a SCRAMBLED order to prove the service actually
    // re-sorts rather than passing DB row order through:
    //
    //   biz-risky  ('Delta Co'):  low approval rate + stale approval + slower
    //                             trend + young account → highest risk, score 65
    //   biz-tie-hi ('Alpha Co'):  same 6-point profile as the two below, but
    //                             pendingApprovalCount=5 (tiebreak #1 winner)
    //   biz-tie-b  ('Bravo Co'):  same score+pending as tie-lo, wins tiebreak #2 (name)
    //   biz-tie-lo ('Charlie Co'): same score+pending as tie-b, loses tiebreak #2
    //
    // Expected order: biz-risky, biz-tie-hi, biz-tie-b, biz-tie-lo.
    const commonBusinessFields = {
      subscription_status: 'active',
      last_sync_at: null,
      pending_reconnect_count: 0,
      total_responses: 10,
      completed_responses: 5,
      avg_response_time_hours: null,
      last_activity: null,
    };

    queueBaseQueries(harness, {
      businessRows: [
        { id: 'biz-tie-lo', name: 'Charlie Co', pending_approval_count: 2, ...commonBusinessFields },
        { id: 'biz-risky', name: 'Delta Co', pending_approval_count: 3, ...commonBusinessFields },
        { id: 'biz-tie-b', name: 'Bravo Co', pending_approval_count: 2, ...commonBusinessFields },
        { id: 'biz-tie-hi', name: 'Alpha Co', pending_approval_count: 5, ...commonBusinessFields },
      ],
      businessCount: [{ total: 4 }],
    });
    harness.sqlReturnQueue.push([
      {
        business_id: 'biz-tie-lo',
        approval_rate: 0.9,
        notified_count: 5,
        pending_count: 0,
        days_since_approval: 1,
        account_age_days: 100,
        avg_hours_current: null,
        avg_hours_prev: null,
      },
      {
        business_id: 'biz-tie-b',
        approval_rate: 0.9,
        notified_count: 5,
        pending_count: 0,
        days_since_approval: 1,
        account_age_days: 100,
        avg_hours_current: null,
        avg_hours_prev: null,
      },
      {
        business_id: 'biz-tie-hi',
        approval_rate: 0.9,
        notified_count: 5,
        pending_count: 0,
        days_since_approval: 1,
        account_age_days: 100,
        avg_hours_current: null,
        avg_hours_prev: null,
      },
      {
        business_id: 'biz-risky',
        approval_rate: 0.2,
        notified_count: 5,
        pending_count: 3,
        days_since_approval: 20,
        account_age_days: 14,
        avg_hours_current: 10,
        avg_hours_prev: 2,
      },
    ] satisfies MetricsRowFixture[]);

    const result = await getAdminOverview(mockSql, { limit: 20, offset: 0 });

    expect(result.businesses.map((b) => b.id)).toEqual([
      'biz-risky',
      'biz-tie-hi',
      'biz-tie-b',
      'biz-tie-lo',
    ]);
    // Pin the actual (real, un-mocked) churn scores driving the order.
    expect(result.businesses[0]!.churnScore.score).toBe(65);
    expect(result.businesses[0]!.churnScore.level).toBe('at_risk');
    expect(result.businesses[1]!.churnScore.score).toBe(6);
    expect(result.businesses[1]!.churnScore.level).toBe('healthy');
    expect(result.businesses[2]!.churnScore.score).toBe(6);
    expect(result.businesses[3]!.churnScore.score).toBe(6);
  });
});

describe('getAdminOverview — pagination', () => {
  it('slices the churn-sorted list by limit/offset and preserves totalBusinesses as the full count', async () => {
    // 5 businesses with distinct, hand-computed churn scores (all satisfaction
    // pulse and response-time-trend signals neutral, so score is driven
    // entirely by approvalRate + daysSinceApproval):
    //   biz-1: score 55 (approvalRate 0.2 → +30, days 20 → +25)
    //   biz-2: score 30 (approvalRate 0.6 → +15, days 10 → +15)
    //   biz-3: score 15 (approvalRate 0.6 → +15, days  1 →  +0)
    //   biz-4: score 14 (approvalRate 0.85 → +6, days  4 →  +8)
    //   biz-5: score  0 (approvalRate 1.0 →  +0, days  1 →  +0)
    const commonBusinessFields = {
      subscription_status: 'active',
      last_sync_at: null,
      pending_approval_count: 0,
      pending_reconnect_count: 0,
      total_responses: 10,
      completed_responses: 5,
      avg_response_time_hours: null,
      last_activity: null,
    };

    queueBaseQueries(harness, {
      businessRows: [
        { id: 'biz-1', name: 'One Co', ...commonBusinessFields },
        { id: 'biz-2', name: 'Two Co', ...commonBusinessFields },
        { id: 'biz-3', name: 'Three Co', ...commonBusinessFields },
        { id: 'biz-4', name: 'Four Co', ...commonBusinessFields },
        { id: 'biz-5', name: 'Five Co', ...commonBusinessFields },
      ],
      businessCount: [{ total: 5 }],
    });
    harness.sqlReturnQueue.push([
      { business_id: 'biz-1', approval_rate: 0.2, notified_count: 5, pending_count: 0, days_since_approval: 20, account_age_days: 100, avg_hours_current: null, avg_hours_prev: null },
      { business_id: 'biz-2', approval_rate: 0.6, notified_count: 5, pending_count: 0, days_since_approval: 10, account_age_days: 100, avg_hours_current: null, avg_hours_prev: null },
      { business_id: 'biz-3', approval_rate: 0.6, notified_count: 5, pending_count: 0, days_since_approval: 1, account_age_days: 100, avg_hours_current: null, avg_hours_prev: null },
      { business_id: 'biz-4', approval_rate: 0.85, notified_count: 5, pending_count: 0, days_since_approval: 4, account_age_days: 100, avg_hours_current: null, avg_hours_prev: null },
      { business_id: 'biz-5', approval_rate: 1, notified_count: 5, pending_count: 0, days_since_approval: 1, account_age_days: 100, avg_hours_current: null, avg_hours_prev: null },
    ] satisfies MetricsRowFixture[]);

    const result = await getAdminOverview(mockSql, { limit: 2, offset: 1 });

    // Full sorted order is [biz-1(55), biz-2(30), biz-3(15), biz-4(14), biz-5(0)].
    // offset=1, limit=2 → the 2nd and 3rd ranked businesses.
    expect(result.businesses.map((b) => b.id)).toEqual(['biz-2', 'biz-3']);
    expect(result.businesses[0]!.churnScore.score).toBe(30);
    expect(result.businesses[1]!.churnScore.score).toBe(15);
    // Pagination metadata reflects the REQUEST, not the slice length.
    expect(result.limit).toBe(2);
    expect(result.offset).toBe(1);
    expect(result.totalBusinesses).toBe(5);
  });

  it('returns an empty slice when offset is past the end of the list', async () => {
    queueBaseQueries(harness, {
      businessRows: [
        {
          id: 'biz-only',
          name: 'Only Co',
          subscription_status: 'active',
          last_sync_at: null,
          pending_approval_count: 0,
          pending_reconnect_count: 0,
          total_responses: 0,
          completed_responses: 0,
          avg_response_time_hours: null,
          last_activity: null,
        },
      ],
      businessCount: [{ total: 1 }],
    });
    harness.sqlReturnQueue.push([] satisfies MetricsRowFixture[]);

    const result = await getAdminOverview(mockSql, { limit: 20, offset: 10 });

    expect(result.businesses).toEqual([]);
    expect(result.totalBusinesses).toBe(1);
  });
});

describe('getAdminOverview — response-metric windowing (SQL contract)', () => {
  // The mock does not execute SQL, so windowing is verified as a query contract:
  // the trailing-window FILTER on created_at is exactly what excludes >window
  // rows from the rate/avg aggregates. Behavioral exclusion IS this pinned FILTER.
  it('windows total/completed/avg-time by created_at, leaving pending/reconnect/last-activity all-time', async () => {
    queueBaseQueries(harness, { businessRows: [], businessCount: [{ total: 0 }] });

    await getAdminOverview(mockSql, { limit: 20, offset: 0 });
    const businessQuery = harness.sqlCalls[5]!;

    // Windowed aggregates carry the trailing-window FILTER on created_at, with the
    // window value bound (the ? placeholder) rather than hard-coded — single owner.
    expect(businessQuery.text).toContain('resp.created_at >= CURRENT_DATE - ?::int');
    expect(businessQuery.text).toContain('AS total_responses');
    expect(businessQuery.text).toContain('AS completed_responses');
    expect(businessQuery.text).toContain('AS avg_response_time_hours');
    expect(businessQuery.values).toContain(30);

    // Current-state / all-time aggregates must NOT be windowed — old still-pending
    // items and a dormant business's last activity are the churn signals.
    expect(businessQuery.text).toContain(
      "COUNT(CASE WHEN resp.status = 'pending_approval' THEN 1 END)::int AS pending_approval_count",
    );
    expect(businessQuery.text).toContain(
      "COUNT(CASE WHEN resp.status = 'awaiting_owner_connect' THEN 1 END)::int AS pending_reconnect_count",
    );
    expect(businessQuery.text).toContain(
      'MAX(GREATEST(resp.created_at, resp.approved_at, resp.posted_at)) AS last_activity',
    );
  });

  it('surfaces responseMetricsWindowDays and binds the same value into the businessRows query', async () => {
    queueBaseQueries(harness, { businessRows: [], businessCount: [{ total: 0 }] });

    const result = await getAdminOverview(mockSql, { limit: 20, offset: 0 });

    expect(result.responseMetricsWindowDays).toBe(30);
    // Single owner: the DTO field and the SQL window derive from one constant.
    expect(harness.sqlCalls[5]!.values).toContain(result.responseMetricsWindowDays);
  });
});
