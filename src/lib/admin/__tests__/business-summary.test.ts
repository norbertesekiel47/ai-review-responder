// src/lib/admin/__tests__/business-summary.test.ts
//
// Eval suite for getBusinessSummaries — written FIRST (TDD, T1) against the
// shared owner the spec creates: src/lib/admin/business-summary.ts (base query
// + metrics follow-up + buildBusinessSummary + conditional COUNT).
//
// SUBJECT: the BOUNDED-FETCH property §5.4 exists for. The metrics CTE must be
// keyed on the ids the base query ACTUALLY RETURNED — LIMIT/OFFSET first, then
// metrics for those ids — never on every business in the table. A regression
// here is INVISIBLE in the returned DTO (the extra metrics rows are simply
// unused), so it can only be caught by asserting what the metrics query is
// PARAMETERISED with. In production it surfaces as pg_stat_activity growth on
// /admin/businesses, which is the failure this suite is here to prevent.
//
// getBusinessSummaries is born-injected (`sql` is a parameter, invariant #15),
// so the fragment-aware createMockSql harness (shared with the worker suites)
// stands in for `sql` directly — no @/lib/db/server mocking needed, same as
// overview-service.test.ts. Assertions read `harness.sqlCalls`, which records
// every AWAITED query as `{ text, values }` with bound values in placeholder
// order; the base query's `${businessIds}` array is one such bound value.
//
// The row→DTO mapping (null-date handling, response-rate math, trend
// derivation, real computeChurnRiskScore fixtures) is characterized in the
// second describe below: those tests came over from overview-service.test.ts
// with `getAdminOverview` swapped for `getBusinessSummaries` and their
// ASSERTION BODIES UNCHANGED, because buildBusinessSummary now lives here
// (spec §5.2/§5.6). Fixtures in the FIRST describe are therefore minimal —
// they exist to produce ids, not to exercise the mapping.
//
// Query order (matches the module's sequential dispatch order, which the mock's
// lazy-thenable FIFO queue is consumed in — #773, at most one in flight):
//   PAGINATED   (opts supplied):  0: businessRows  1: countRows  2: metricsRows*
//   UNPAGINATED (opts omitted):   0: businessRows                1: metricsRows*
//   * ONLY when businessRows is non-empty. An empty page skips the metrics
//     query entirely rather than round-tripping an empty UNNEST.

import { describe, it, expect, beforeEach } from 'vitest';
import type { Sql } from 'postgres';
import {
  createMockSql,
  type MockSqlHarness,
} from '../../../../worker/__tests__/helpers/mock-sql';
import { getBusinessSummaries } from '../business-summary';

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

/** A base-query row with every metric at its zero/null default — see header. */
function businessRow(id: string, name: string): BusinessRowFixture {
  return {
    id,
    name,
    category: null,
    subscription_status: 'active',
    last_sync_at: null,
    pending_approval_count: 0,
    pending_reconnect_count: 0,
    total_responses: 0,
    completed_responses: 0,
    avg_response_time_hours: null,
    last_activity: null,
  };
}

let harness: MockSqlHarness;
let mockSql: Sql;

beforeEach(() => {
  harness = createMockSql();
  mockSql = harness.mockSql as unknown as Sql;
});

describe('getBusinessSummaries — bounded metrics fetch', () => {
  it('requests metrics only for the ids on the current page', async () => {
    // 5 businesses exist; the caller asks for page 2 of size 2, so the base
    // query returns exactly two rows and metrics must cover exactly those two.
    harness.sqlReturnQueue.push([businessRow('biz-3', 'Cafe Three'), businessRow('biz-4', 'Cafe Four')]);
    harness.sqlReturnQueue.push([{ total: 5 }]);
    harness.sqlReturnQueue.push([]);

    const result = await getBusinessSummaries(mockSql, { limit: 2, offset: 2 });

    expect(harness.sqlCalls).toHaveLength(3);

    // The page is taken in SQL, not sliced in TS after reading everything.
    const [rowsCall, countCall, metricsCall] = harness.sqlCalls;
    expect(rowsCall!.text).toContain('LIMIT');
    expect(rowsCall!.text).toContain('OFFSET');
    expect(rowsCall!.values.slice(-2)).toEqual([2, 2]);

    expect(countCall!.text).toContain('SELECT COUNT(*)::int AS total FROM businesses');

    // THE assertion this suite exists for: the metrics CTE is bound to the two
    // page ids, not to all five. `values[0]` is the `${businessIds}` array the
    // UNNEST is keyed on.
    expect(metricsCall!.text).toContain('UNNEST');
    expect(metricsCall!.values[0]).toEqual(['biz-3', 'biz-4']);
    expect(metricsCall!.values[0]).toEqual(result.businesses.map((b) => b.id));

    expect(result.total).toBe(5);
  });

  it('requests metrics for every row when called unpaginated', async () => {
    // Overview's path: no page, so no COUNT query either — `total` is the row
    // count the caller already holds (spec §5.3, "drops one query").
    harness.sqlReturnQueue.push([
      businessRow('biz-1', 'Cafe One'),
      businessRow('biz-2', 'Cafe Two'),
      businessRow('biz-3', 'Cafe Three'),
    ]);
    harness.sqlReturnQueue.push([]);

    const result = await getBusinessSummaries(mockSql);

    expect(harness.sqlCalls).toHaveLength(2);

    const [rowsCall, metricsCall] = harness.sqlCalls;
    expect(rowsCall!.text).not.toContain('LIMIT');
    expect(rowsCall!.text).not.toContain('OFFSET');

    expect(metricsCall!.text).toContain('UNNEST');
    expect(metricsCall!.values[0]).toEqual(['biz-1', 'biz-2', 'biz-3']);

    // No COUNT query ran, so the total can only have come from the rows read.
    expect(harness.sqlCalls.some((call) => call.text.includes('COUNT(*)::int AS total'))).toBe(false);
    expect(result.total).toBe(3);
  });

  it('skips the metrics query entirely when the page has no rows', async () => {
    // A page past the end of the list. An empty id array would make the CTE a
    // pointless round trip (`UNNEST('{}'::uuid[])`), and the total must still
    // reflect the unfiltered COUNT.
    harness.sqlReturnQueue.push([]);
    harness.sqlReturnQueue.push([{ total: 7 }]);

    const result = await getBusinessSummaries(mockSql, { limit: 20, offset: 100 });

    expect(harness.sqlCalls).toHaveLength(2);
    expect(harness.sqlCalls.some((call) => call.text.includes('UNNEST'))).toBe(false);

    expect(result.businesses).toEqual([]);
    expect(result.total).toBe(7);
  });
});

// Folded in from the deleted src/lib/admin/__tests__/businesses-list-service.test.ts
// (T2 deletes businesses-list-service.ts — business-summary.ts is now the single
// owner of its query). The query-contract and COUNT assertions carry over
// verbatim; the DTO assertions widened from AdminBusinessListItem to the
// superset BusinessSummary, which is the whole point of the merge.
describe('getBusinessSummaries — page mapping (folded from getAdminBusinessesList)', () => {
  it('maps the list page + total, converting last_sync_at to an ISO string', async () => {
    harness.sqlReturnQueue.push([
      {
        id: 'biz-1',
        name: 'Test Cafe',
        category: 'restaurant',
        subscription_status: 'active',
        // A real Date, exactly what Postgres.js decodes a timestamptz into.
        // The RSC boundary preserves Date instances, so a DTO field typed
        // `string` holding a Date breaks the server page on first paint.
        last_sync_at: new Date('2026-08-01T12:30:00.000Z'),
        pending_approval_count: 3,
        pending_reconnect_count: 0,
        total_responses: 0,
        completed_responses: 0,
        avg_response_time_hours: null,
        last_activity: null,
      },
      {
        id: 'biz-2',
        name: 'Never Synced',
        category: null,
        subscription_status: 'past_due',
        last_sync_at: null,
        pending_approval_count: 0,
        pending_reconnect_count: 0,
        total_responses: 0,
        completed_responses: 0,
        avg_response_time_hours: null,
        last_activity: null,
      },
    ] satisfies BusinessRowFixture[]);
    harness.sqlReturnQueue.push([{ total: 42 }]);
    harness.sqlReturnQueue.push([] satisfies MetricsRowFixture[]);

    const result = await getBusinessSummaries(mockSql, { limit: 20, offset: 0 });

    // Score 2 / 'healthy' is the REAL computeChurnRiskScore output for a row
    // with no metrics companion: every signal reads "no data" except account
    // age, which defaults to 0 days → the <5-week bucket → 2 points.
    expect(result.businesses).toEqual([
      {
        id: 'biz-1',
        name: 'Test Cafe',
        category: 'restaurant',
        subscriptionStatus: 'active',
        lastSyncAt: '2026-08-01T12:30:00.000Z',
        pendingApprovalCount: 3,
        pendingReconnectCount: 0,
        totalResponses: 0,
        completedResponses: 0,
        responseRate: 0,
        avgResponseTimeHours: null,
        lastActivity: null,
        churnScore: { score: 2, level: 'healthy', breakdown: expect.any(Array) },
      },
      {
        id: 'biz-2',
        name: 'Never Synced',
        category: null,
        subscriptionStatus: 'past_due',
        lastSyncAt: null,
        pendingApprovalCount: 0,
        pendingReconnectCount: 0,
        totalResponses: 0,
        completedResponses: 0,
        responseRate: 0,
        avgResponseTimeHours: null,
        lastActivity: null,
        churnScore: { score: 2, level: 'healthy', breakdown: expect.any(Array) },
      },
    ]);
    expect(result.total).toBe(42);

    // The trap guard: `toEqual` above would pass for a Date whose ISO string
    // matches, so assert the runtime type explicitly.
    expect(typeof result.businesses[0]!.lastSyncAt).toBe('string');

    expect(harness.sqlCalls[0]!.text).toContain('FROM businesses b');
    expect(harness.sqlCalls[0]!.text).toContain('JOIN accounts a ON a.id = b.account_id');
    expect(harness.sqlCalls[0]!.text).toContain('LEFT JOIN responses resp');
    expect(harness.sqlCalls[0]!.text).toContain("resp.status != 'superseded'");
    expect(harness.sqlCalls[0]!.text).toContain("resp.status = 'pending_approval'");
    expect(harness.sqlCalls[0]!.text).toContain('ORDER BY b.name ASC');
    // LIMIT/OFFSET are the last two binds; the leading binds are the response
    // window + handled-status array the merged base query adds.
    expect(harness.sqlCalls[0]!.values.slice(-2)).toEqual([20, 0]);

    expect(harness.sqlCalls[1]!.text).toContain('SELECT COUNT(*)::int AS total FROM businesses');
  });

  it('returns an empty list and a zero total for empty results', async () => {
    harness.sqlReturnQueue.push([]);
    harness.sqlReturnQueue.push([]);

    const result = await getBusinessSummaries(mockSql, { limit: 20, offset: 40 });

    expect(result).toEqual({ businesses: [], total: 0, responseMetricsWindowDays: 30 });
    expect(harness.sqlCalls[0]!.values.slice(-2)).toEqual([20, 40]);
  });
});

// Relocated from src/lib/admin/__tests__/overview-service.test.ts, where it
// asserted against `harness.sqlCalls[5]` — THIS module's base query, reached
// transitively through getAdminOverview. That inverted the ownership this spec
// establishes: editing business-summary.ts's windowing broke a test named
// `getAdminOverview — response-metric windowing`. The assertions came over
// unchanged, re-anchored on this suite's own `sqlCalls[0]`.
describe('getBusinessSummaries — response-metric windowing (SQL contract)', () => {
  // The mock does not execute SQL, so windowing is verified as a query contract:
  // the trailing-window FILTER on created_at is exactly what excludes >window
  // rows from the rate/avg aggregates. Behavioral exclusion IS this pinned FILTER.
  it('windows total/completed/avg-time by created_at, leaving pending/reconnect/last-activity all-time', async () => {
    // Unpaginated with no rows: one query, so the base query IS sqlCalls[0].
    harness.sqlReturnQueue.push([]);

    await getBusinessSummaries(mockSql);
    const businessQuery = harness.sqlCalls[0]!;

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
    // The half of this test that survives §5.3: Overview's copy of the field is
    // gone (nothing labels a window there any more), but BusinessSummariesResult
    // still carries it for /admin/businesses' two column headers — and it must
    // be the SAME constant the SQL window is bound from, not a second literal.
    harness.sqlReturnQueue.push([]);

    const result = await getBusinessSummaries(mockSql);

    expect(result.responseMetricsWindowDays).toBe(30);
    expect(harness.sqlCalls[0]!.values).toContain(result.responseMetricsWindowDays);
  });
});

// Relocated from src/lib/admin/__tests__/overview-service.test.ts: these are
// buildBusinessSummary's row→DTO characterization tests, and buildBusinessSummary
// now lives in business-summary.ts (spec §5.2, §5.6 "the existing overview
// characterization tests follow buildBusinessSummary into the shared module").
// The ASSERTION BODIES are unchanged — only the arrange/act swapped
// `getAdminOverview` for `getBusinessSummaries`, which is possible because both
// return a `businesses` array of the same DTO.
//
// computeChurnRiskScore is NOT mocked: fixtures feed real BusinessMetrics inputs
// and the assertions pin the REAL resulting score/level.
describe('getBusinessSummaries — row→DTO mapping (buildBusinessSummary)', () => {
  it('maps null last_sync_at / last_activity to null (not a crash on missing Date)', async () => {
    harness.sqlReturnQueue.push([
      {
        id: 'biz-null-dates',
        name: 'No Sync Co',
        category: null,
        subscription_status: 'trialing',
        last_sync_at: null,
        pending_approval_count: 0,
        pending_reconnect_count: 0,
        total_responses: 0,
        completed_responses: 0,
        avg_response_time_hours: null,
        last_activity: null,
      },
    ] satisfies BusinessRowFixture[]);
    harness.sqlReturnQueue.push([] satisfies MetricsRowFixture[]);

    const result = await getBusinessSummaries(mockSql);

    expect(result.businesses[0]!.lastSyncAt).toBeNull();
    expect(result.businesses[0]!.lastActivity).toBeNull();
    expect(result.businesses[0]!.avgResponseTimeHours).toBeNull();
    // total_responses=0 → responseRate falls back to 0, not NaN/Infinity.
    expect(result.businesses[0]!.responseRate).toBe(0);
  });

  it('maps the populated row: response-rate math and ISO dates', async () => {
    // Fixture + expectations lifted from overview-service.test.ts's `— shape`
    // case (10 windowed responses, 7 handled → 70%), whose getAdminOverview-level
    // subject §5 replaces.
    const lastSync = new Date('2026-06-01T12:00:00Z');
    const lastActivity = new Date('2026-06-30T08:00:00Z');

    harness.sqlReturnQueue.push([
      {
        id: 'biz-shape',
        name: 'Shape Co',
        category: 'Cafe',
        subscription_status: 'active',
        last_sync_at: lastSync,
        pending_approval_count: 2,
        pending_reconnect_count: 1,
        total_responses: 10,
        completed_responses: 7,
        avg_response_time_hours: 3.5,
        last_activity: lastActivity,
      },
    ] satisfies BusinessRowFixture[]);
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

    const result = await getBusinessSummaries(mockSql);

    expect(result.businesses).toEqual([
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
          score: 0,
          level: 'healthy',
          breakdown: expect.any(Array),
        },
      },
    ]);
    expect(result.responseMetricsWindowDays).toBe(30);
  });

  it('derives responseTimeTrend and pins the real churn scores it feeds', async () => {
    // The four metrics fixtures from overview-service.test.ts's
    // `— churn-descending sort` case, whose SORT subject moves to Overview's
    // at-risk selection. What belongs to buildBusinessSummary is what is kept
    // here: biz-risky's avg_hours_current 10 vs avg_hours_prev 2 (> 1.5×) is
    // the ONLY input that derives responseTimeTrend='slower', worth 8 of its
    // 65 points. Rows are queued in already-ranked order because this module
    // does not sort — `ORDER BY b.name ASC` is the DB's, ranking is Overview's.
    const commonBusinessFields = {
      category: null,
      subscription_status: 'active',
      last_sync_at: null,
      pending_reconnect_count: 0,
      total_responses: 10,
      completed_responses: 5,
      avg_response_time_hours: null,
      last_activity: null,
    };

    harness.sqlReturnQueue.push([
      { id: 'biz-risky', name: 'Delta Co', pending_approval_count: 3, ...commonBusinessFields },
      { id: 'biz-tie-hi', name: 'Alpha Co', pending_approval_count: 5, ...commonBusinessFields },
      { id: 'biz-tie-b', name: 'Bravo Co', pending_approval_count: 2, ...commonBusinessFields },
      { id: 'biz-tie-lo', name: 'Charlie Co', pending_approval_count: 2, ...commonBusinessFields },
    ] satisfies BusinessRowFixture[]);
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

    const result = await getBusinessSummaries(mockSql);

    // Pin the actual (real, un-mocked) churn scores driving the order.
    expect(result.businesses[0]!.churnScore.score).toBe(65);
    expect(result.businesses[0]!.churnScore.level).toBe('at_risk');
    expect(result.businesses[1]!.churnScore.score).toBe(6);
    expect(result.businesses[1]!.churnScore.level).toBe('healthy');
    expect(result.businesses[2]!.churnScore.score).toBe(6);
    expect(result.businesses[3]!.churnScore.score).toBe(6);
    // The 'slower' trend contributes 8 of biz-risky's 65 — the mapping branch
    // no other fixture in this suite reaches.
    expect(
      result.businesses[0]!.churnScore.breakdown.find((b) => b.signal === 'Response time trend'),
    ).toEqual({ signal: 'Response time trend', value: 'slower', contribution: 8 });
  });
});
