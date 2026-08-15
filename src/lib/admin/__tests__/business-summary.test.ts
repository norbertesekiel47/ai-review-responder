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
// derivation, real computeChurnRiskScore fixtures) is deliberately NOT asserted
// here: those characterization tests move over from overview-service.test.ts in
// T2 with their assertion bodies unchanged. Fixtures below are therefore
// minimal — they exist to produce ids, not to exercise the mapping.
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
