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
// SUBJECT AS OF T4 (spec §5.1/§5.3): the base query, the churn-metrics CTE and
// buildBusinessSummary moved to src/lib/admin/business-summary.ts, which
// getAdminOverview now calls unpaginated as its 6th await. What is left here —
// and what this suite pins — is the AT-RISK LIST: filter to
// `churnScore.level !== 'healthy'`, sort with the 4-level comparator, THEN cap
// at OVERVIEW_AT_RISK_LIMIT. Filter-then-cap, never cap-then-filter: it is not
// "top 5 by score", and an all-healthy account must yield [].
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
//   6: metricsRows (ONLY when businessRows non-empty)
// There is no COUNT query any more: Overview reads every row, so
// totalBusinesses IS the row count (§5.3 "drops one query").

import { describe, it, expect, beforeEach } from 'vitest';
import type { Sql } from 'postgres';
import {
  createMockSql,
  type MockSqlHarness,
} from '../../../../worker/__tests__/helpers/mock-sql';
import { getAdminOverview, OVERVIEW_AT_RISK_LIMIT } from '../overview-service';

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
  category: string | null;
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

/** Queues the 6 base query results in the exact order the service issues them. */
function queueBaseQueries(
  harness: MockSqlHarness,
  fixtures: {
    pendingOutbox?: SystemHealthFixture[];
    failedJobs?: SystemHealthFixture[];
    todayCost?: { total: number }[];
    notifFailures?: SystemHealthFixture[];
    emailHealth?: EmailHealthFixture[];
    businessRows?: BusinessRowFixture[];
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
}

/** A base-query row; every field the at-risk selection does not care about is defaulted. */
function businessRow(
  id: string,
  name: string,
  overrides: Partial<BusinessRowFixture> = {},
): BusinessRowFixture {
  return {
    id,
    name,
    category: null,
    subscription_status: 'active',
    last_sync_at: null,
    pending_approval_count: 0,
    pending_reconnect_count: 0,
    total_responses: 10,
    completed_responses: 5,
    avg_response_time_hours: null,
    last_activity: null,
    ...overrides,
  };
}

/**
 * A churn-metrics row whose DEFAULTS score 0 → level `healthy` under the real
 * computeChurnRiskScore (perfect approval rate, approved yesterday, no
 * satisfaction pulse, no trend signal, account older than 12 weeks). Each test
 * overrides only the signals it is about, so the score it pins is readable:
 *
 *   approval_rate  0.2 → +30   0.6 → +15   0.85 → +6   1 → +0
 *   days_since_approval  >13 → +25   6-13 → +15   3-5 → +8   <=2 → +0
 *   pending_count > 0 with days > 7 and both avg_hours null → trend `stopped` → +15
 */
function metricsRow(
  businessId: string,
  overrides: Partial<MetricsRowFixture> = {},
): MetricsRowFixture {
  return {
    business_id: businessId,
    approval_rate: 1,
    notified_count: 5,
    pending_count: 0,
    days_since_approval: 1,
    account_age_days: 100,
    avg_hours_current: null,
    avg_hours_prev: null,
    ...overrides,
  };
}

let harness: MockSqlHarness;
let mockSql: Sql;

beforeEach(() => {
  harness = createMockSql();
  mockSql = harness.mockSql as unknown as Sql;
});

describe('getAdminOverview — shape', () => {
  it('returns the full OverviewData shape for a single at-risk business', async () => {
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
        businessRow('biz-shape', 'Shape Co', {
          category: 'Cafe',
          last_sync_at: lastSync,
          pending_approval_count: 2,
          pending_reconnect_count: 1,
          total_responses: 10,
          completed_responses: 7,
          avg_response_time_hours: 3.5,
          last_activity: lastActivity,
        }),
      ],
    });
    // metricsRows (7th query) — businessRows is non-empty so this WILL be consumed.
    // 0.2 approval (+30) and 20d since approval (+25) → 55, level `watch`, which
    // is what puts this business on the at-risk list at all.
    harness.sqlReturnQueue.push([
      metricsRow('biz-shape', { approval_rate: 0.2, days_since_approval: 20 }),
    ] satisfies MetricsRowFixture[]);

    const result = await getAdminOverview(mockSql);

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
      // No `responseMetricsWindowDays`: §5.3 removed Overview's window-labelled
      // columns, so the field left OverviewData with its last reader. `toEqual`
      // is exhaustive, so this object IS the assertion that it is gone.
      atRisk: [
        {
          id: 'biz-shape',
          name: 'Shape Co',
          category: 'Cafe',
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
            score: 55,
            level: 'watch',
            breakdown: expect.any(Array),
          },
        },
      ],
    });

    // Exactly 7 queries issued (5 system-health + businessRows + metricsRows).
    expect(harness.sqlCalls).toHaveLength(7);
  });

  // `maps null last_sync_at / last_activity to null (not a crash on missing
  // Date)` moved to __tests__/business-summary.test.ts in T2: it characterizes
  // buildBusinessSummary, which is now owned by src/lib/admin/business-summary.ts
  // (spec §5.2/§5.6). Its assertion bodies went over unchanged.

  it('reports totalBusinesses as the number of rows read, not a separate count query', async () => {
    // §5.3: Overview already holds every row, so the unfiltered total IS
    // rows.length and the COUNT query it used to issue is gone. Two of these
    // three are healthy, which is exactly why totalBusinesses must not be
    // derived from the at-risk list.
    queueBaseQueries(harness, {
      businessRows: [
        businessRow('biz-1', 'Alpha Co'),
        businessRow('biz-2', 'Bravo Co'),
        businessRow('biz-3', 'Charlie Co'),
      ],
    });
    harness.sqlReturnQueue.push([
      metricsRow('biz-1', { approval_rate: 0.2, days_since_approval: 20 }),
      metricsRow('biz-2'),
      metricsRow('biz-3'),
    ] satisfies MetricsRowFixture[]);

    const result = await getAdminOverview(mockSql);

    expect(result.totalBusinesses).toBe(3);
    expect(result.atRisk).toHaveLength(1);
    // 5 system-health + businessRows + metricsRows. A COUNT query would make 8.
    expect(harness.sqlCalls).toHaveLength(7);
    expect(
      harness.sqlCalls.some((call) =>
        call.text.includes('SELECT COUNT(*)::int AS total FROM businesses'),
      ),
    ).toBe(false);
  });
});

describe('getAdminOverview — empty businessRows path', () => {
  it('returns an empty at-risk list and zero totalBusinesses when the account has no businesses', async () => {
    queueBaseQueries(harness, { businessRows: [] });

    const result = await getAdminOverview(mockSql);

    expect(result.atRisk).toEqual([]);
    expect(result.totalBusinesses).toBe(0);
    // Only the 5 system-health queries + businessRows — the conditional
    // metricsRows CTE never fires (business-summary.ts skips it for zero ids).
    expect(harness.sqlCalls).toHaveLength(6);
  });
});

describe('getAdminOverview — email-health redState derivation', () => {
  it('is false when delivery rate is healthy and there are no bounces/complaints', async () => {
    queueBaseQueries(harness, {
      emailHealth: [
        { sent_24h: 100, delivered_24h: 100, bounces_7d: 0, hard_bounces_7d: 0, complaints_7d: 0 },
      ],
      businessRows: [],
    });

    const result = await getAdminOverview(mockSql);

    expect(result.systemHealth.emailHealth.deliveryRate24h).toBe(100);
    expect(result.systemHealth.emailHealth.redState).toBe(false);
  });

  it('trigger 1: is true when delivery rate < 95% AND sent24h >= 5', async () => {
    queueBaseQueries(harness, {
      emailHealth: [
        { sent_24h: 10, delivered_24h: 9, bounces_7d: 0, hard_bounces_7d: 0, complaints_7d: 0 },
      ],
      businessRows: [],
    });

    const result = await getAdminOverview(mockSql);

    expect(result.systemHealth.emailHealth.deliveryRate24h).toBe(90);
    expect(result.systemHealth.emailHealth.redState).toBe(true);
  });

  it('trigger 1 does NOT fire below the 5-send volume floor, even at very low delivery rate', async () => {
    queueBaseQueries(harness, {
      emailHealth: [
        { sent_24h: 3, delivered_24h: 1, bounces_7d: 0, hard_bounces_7d: 0, complaints_7d: 0 },
      ],
      businessRows: [],
    });

    const result = await getAdminOverview(mockSql);

    expect(result.systemHealth.emailHealth.redState).toBe(false);
  });

  it('trigger 2: is true on any 7d complaint, even with perfect delivery', async () => {
    queueBaseQueries(harness, {
      emailHealth: [
        { sent_24h: 100, delivered_24h: 100, bounces_7d: 0, hard_bounces_7d: 0, complaints_7d: 1 },
      ],
      businessRows: [],
    });

    const result = await getAdminOverview(mockSql);

    expect(result.systemHealth.emailHealth.deliveryRate24h).toBe(100);
    expect(result.systemHealth.emailHealth.redState).toBe(true);
  });

  it('trigger 3: is true on any 7d hard bounce, even with perfect delivery', async () => {
    queueBaseQueries(harness, {
      emailHealth: [
        { sent_24h: 100, delivered_24h: 100, bounces_7d: 1, hard_bounces_7d: 1, complaints_7d: 0 },
      ],
      businessRows: [],
    });

    const result = await getAdminOverview(mockSql);

    expect(result.systemHealth.emailHealth.redState).toBe(true);
  });

  it('defaults deliveryRate24h to 100 (not NaN) when there is no email-health row at all', async () => {
    queueBaseQueries(harness, { emailHealth: [], businessRows: [] });

    const result = await getAdminOverview(mockSql);

    expect(result.systemHealth.emailHealth.sent24h).toBe(0);
    expect(result.systemHealth.emailHealth.deliveryRate24h).toBe(100);
    expect(result.systemHealth.emailHealth.redState).toBe(false);
  });
});

describe('getAdminOverview — at-risk selection (filter → sort → cap)', () => {
  it('excludes every healthy business from the at-risk list', async () => {
    // Eligibility is `churnScore.level !== 'healthy'`, evaluated on the REAL
    // score. `biz-watch` (55) and `biz-risk` (70) qualify; the three healthy
    // rows do not, however many of them there are.
    queueBaseQueries(harness, {
      businessRows: [
        businessRow('biz-ok-1', 'Alpha Co'),
        businessRow('biz-watch', 'Bravo Co'),
        businessRow('biz-ok-2', 'Charlie Co'),
        businessRow('biz-risk', 'Delta Co'),
        businessRow('biz-ok-3', 'Echo Co'),
      ],
    });
    harness.sqlReturnQueue.push([
      metricsRow('biz-ok-1'),
      metricsRow('biz-watch', { approval_rate: 0.2, days_since_approval: 20 }),
      metricsRow('biz-ok-2', { approval_rate: 0.9 }),
      metricsRow('biz-risk', { approval_rate: 0.2, days_since_approval: 20, pending_count: 3 }),
      metricsRow('biz-ok-3'),
    ] satisfies MetricsRowFixture[]);

    const result = await getAdminOverview(mockSql);

    expect(result.atRisk.map((b) => b.id)).toEqual(['biz-risk', 'biz-watch']);
    expect(result.atRisk.every((b) => b.churnScore.level !== 'healthy')).toBe(true);
    // The healthy rows were read (they count) but not listed.
    expect(result.totalBusinesses).toBe(5);
  });

  it('orders the at-risk list by churn score descending', async () => {
    // Fed in a SCRAMBLED order to prove the service re-sorts rather than
    // passing the base query's `ORDER BY b.name ASC` through. All four
    // qualify, with distinct real scores 70 / 55 / 45 / 38.
    queueBaseQueries(harness, {
      businessRows: [
        businessRow('biz-38', 'Alpha Co'),
        businessRow('biz-70', 'Bravo Co'),
        businessRow('biz-45', 'Charlie Co'),
        businessRow('biz-55', 'Delta Co'),
      ],
    });
    harness.sqlReturnQueue.push([
      metricsRow('biz-38', { approval_rate: 0.2, days_since_approval: 4 }),
      metricsRow('biz-70', { approval_rate: 0.2, days_since_approval: 20, pending_count: 3 }),
      metricsRow('biz-45', { approval_rate: 0.2, days_since_approval: 10 }),
      metricsRow('biz-55', { approval_rate: 0.2, days_since_approval: 20 }),
    ] satisfies MetricsRowFixture[]);

    const result = await getAdminOverview(mockSql);

    expect(result.atRisk.map((b) => b.id)).toEqual(['biz-70', 'biz-55', 'biz-45', 'biz-38']);
    // Pin the actual (real, un-mocked) churn scores driving the order.
    expect(result.atRisk.map((b) => b.churnScore.score)).toEqual([70, 55, 45, 38]);
    expect(result.atRisk[0]!.churnScore.level).toBe('at_risk');
    expect(result.atRisk[1]!.churnScore.level).toBe('watch');
  });

  it('breaks a score tie on pendingApprovalCount descending, ahead of the name tier', async () => {
    // TIER 2 of the 4-level comparator, which no other test in this suite can
    // separate (intake invariant 8). Both rows score 55, so tier 1 is
    // exhausted; `pendingApprovalCount` 7 vs 2 must decide.
    //
    // Name and id are deliberately ANTI-CORRELATED with the expected order —
    // the high-pending row is named LAST alphabetically and carries the id that
    // sorts LAST — so tiers 3 and 4 both produce the OPPOSITE order. Deleting
    // `b.pendingApprovalCount - a.pendingApprovalCount` therefore fails here
    // instead of being rescued by a later tier.
    queueBaseQueries(harness, {
      businessRows: [
        businessRow('01991000-0000-7000-8000-000000000001', 'Alpha Co', {
          pending_approval_count: 2,
        }),
        businessRow('01991000-0000-7000-8000-000000000002', 'Zulu Co', {
          pending_approval_count: 7,
        }),
      ],
    });
    harness.sqlReturnQueue.push([
      metricsRow('01991000-0000-7000-8000-000000000001', {
        approval_rate: 0.2,
        days_since_approval: 20,
      }),
      metricsRow('01991000-0000-7000-8000-000000000002', {
        approval_rate: 0.2,
        days_since_approval: 20,
      }),
    ] satisfies MetricsRowFixture[]);

    const result = await getAdminOverview(mockSql);

    expect(result.atRisk.map((b) => b.name)).toEqual(['Zulu Co', 'Alpha Co']);
    expect(result.atRisk.map((b) => b.pendingApprovalCount)).toEqual([7, 2]);
    // Guards the guard: tier 1 deciding this would make the test lie.
    expect(result.atRisk[0]!.churnScore.score).toBe(result.atRisk[1]!.churnScore.score);
  });

  it('breaks a score-and-pending tie on business name ascending', async () => {
    // Both rows carry the SAME metrics (→ same real score, 55) AND the same
    // pendingApprovalCount (2), so tiers 1 and 2 of the comparator are
    // exhausted and the NAME tier is what decides. Fed name-descending.
    //
    // The ids are UUIDv7-shaped and ANTI-CORRELATED with the names — 'Alpha Co',
    // which must sort FIRST, carries the id that sorts LAST — so the id tier
    // would produce the opposite order and cannot rescue a deleted name tier.
    // Production ids are UUIDv7 and uncorrelated with name, so this is the
    // honest fixture; `biz-a`/`biz-z` were not.
    queueBaseQueries(harness, {
      businessRows: [
        businessRow('01991000-0000-7000-8000-00000000000a', 'Zulu Co', {
          pending_approval_count: 2,
        }),
        businessRow('01991000-0000-7000-8000-00000000000b', 'Alpha Co', {
          pending_approval_count: 2,
        }),
      ],
    });
    harness.sqlReturnQueue.push([
      metricsRow('01991000-0000-7000-8000-00000000000a', {
        approval_rate: 0.2,
        days_since_approval: 20,
      }),
      metricsRow('01991000-0000-7000-8000-00000000000b', {
        approval_rate: 0.2,
        days_since_approval: 20,
      }),
    ] satisfies MetricsRowFixture[]);

    const result = await getAdminOverview(mockSql);

    expect(result.atRisk.map((b) => b.name)).toEqual(['Alpha Co', 'Zulu Co']);
    // Guards the guard: an earlier tier deciding this would make the test lie.
    expect(result.atRisk[0]!.churnScore.score).toBe(result.atRisk[1]!.churnScore.score);
    expect(result.atRisk[0]!.pendingApprovalCount).toBe(result.atRisk[1]!.pendingApprovalCount);
    // …and a LATER tier deciding it would too: the id tier orders these the
    // other way round, so only the name tier can produce the expectation above.
    expect(result.atRisk.map((b) => b.id)).toEqual([
      '01991000-0000-7000-8000-00000000000b',
      '01991000-0000-7000-8000-00000000000a',
    ]);
  });

  it('caps the at-risk list at OVERVIEW_AT_RISK_LIMIT even when more businesses qualify', async () => {
    // Six qualifying businesses with distinct real scores 70/55/45/40/38/31.
    // The cap keeps the top five and drops the 31.
    queueBaseQueries(harness, {
      businessRows: [
        businessRow('biz-70', 'Alpha Co'),
        businessRow('biz-55', 'Bravo Co'),
        businessRow('biz-45', 'Charlie Co'),
        businessRow('biz-40', 'Delta Co'),
        businessRow('biz-38', 'Echo Co'),
        businessRow('biz-31', 'Foxtrot Co'),
      ],
    });
    harness.sqlReturnQueue.push([
      metricsRow('biz-70', { approval_rate: 0.2, days_since_approval: 20, pending_count: 3 }),
      metricsRow('biz-55', { approval_rate: 0.2, days_since_approval: 20 }),
      metricsRow('biz-45', { approval_rate: 0.2, days_since_approval: 10 }),
      metricsRow('biz-40', { approval_rate: 0.6, days_since_approval: 20 }),
      metricsRow('biz-38', { approval_rate: 0.2, days_since_approval: 4 }),
      metricsRow('biz-31', { approval_rate: 0.85, days_since_approval: 20 }),
    ] satisfies MetricsRowFixture[]);

    const result = await getAdminOverview(mockSql);

    expect(result.atRisk).toHaveLength(OVERVIEW_AT_RISK_LIMIT);
    expect(result.atRisk.map((b) => b.id)).toEqual([
      'biz-70',
      'biz-55',
      'biz-45',
      'biz-40',
      'biz-38',
    ]);
    // Capped, not filtered away: all six were eligible and all six still count.
    expect(result.totalBusinesses).toBe(6);
  });

  it('returns an empty at-risk list when every business is healthy', async () => {
    // The filter-then-cap ordering IS this test: a cap-then-filter
    // implementation would surface five healthy rows under an "At risk"
    // heading (spec §5.1).
    queueBaseQueries(harness, {
      businessRows: [
        businessRow('biz-1', 'Alpha Co'),
        businessRow('biz-2', 'Bravo Co'),
        businessRow('biz-3', 'Charlie Co'),
        businessRow('biz-4', 'Delta Co'),
        businessRow('biz-5', 'Echo Co'),
        businessRow('biz-6', 'Foxtrot Co'),
      ],
    });
    harness.sqlReturnQueue.push([
      metricsRow('biz-1'),
      metricsRow('biz-2', { approval_rate: 0.9 }),
      metricsRow('biz-3', { days_since_approval: 2 }),
      metricsRow('biz-4', { approval_rate: 0.85 }),
      metricsRow('biz-5'),
      metricsRow('biz-6', { days_since_approval: null }),
    ] satisfies MetricsRowFixture[]);

    const result = await getAdminOverview(mockSql);

    expect(result.atRisk).toEqual([]);
    expect(result.totalBusinesses).toBe(6);
  });
});

// The `— response-metric windowing (SQL contract)` describe that used to close
// this file MOVED to __tests__/business-summary.test.ts. It asserted against
// `harness.sqlCalls[5]` — business-summary.ts's base query, reached transitively
// through getAdminOverview — so editing that module's windowing broke a test
// named for THIS one. Single ownership of the query means single ownership of
// its contract; the assertions went over unchanged, re-anchored on that suite's
// own `sqlCalls[0]`. Nothing in this file reaches across the module boundary any
// more.
