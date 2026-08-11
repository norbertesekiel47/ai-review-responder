// src/lib/dashboard/__tests__/aggregate-queries.review-time-anchor.test.ts
//
// SQL-SHAPE pins for the Review-time anchor on the All-Locations aggregate
// wave (#757, ADR 0019). Sibling of service.review-time-anchor.test.ts: the
// live-DB suite proves the MEANING, these two pin the SPELLING every run.
//
// The aggregate anchors exactly TWO of its queries — velocity and the rating
// breakdown. Its review counters (received_window / responded_window) feed the
// account response rate, a workflow KPI, and deliberately stay on detected_at.

import { beforeEach, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createMockSql, type MockSqlHarness } from '../../../../worker/__tests__/helpers/mock-sql';

import { fetchPerLocationAggregateSlices } from '../aggregate-queries';

let harness: MockSqlHarness;
let mockSql: Sql;
const ACCOUNT_ID = 'acc-anchor-1';

const ANCHOR = 'LEAST(r.review_date, r.detected_at)';
const countAnchors = (t: string) => t.split(ANCHOR).length - 1;
const stripAnchor = (t: string) => t.split(ANCHOR).join('«anchor»');
// Same throw-on-ambiguous-marker helper as the single-location suite — copy it
// verbatim; a plain .find() silently returns the first of several matches.
function find(needle: string): string {
  const hits = harness.sqlCalls.filter((c) => c.text.includes(needle));
  if (hits.length !== 1) {
    throw new Error(`marker ${JSON.stringify(needle)} matched ${hits.length} queries, expected 1`);
  }
  return hits[0]!.text;
}

// Wave order (aggregate-queries.test.ts pushWave): 0 baseline, 1 counters,
// 2 velocity, 3 rating, 4 ranking, 5 monthly, 6 weekly, 7 pending.
function seed() {
  harness.resetMockSql();
  harness.sqlReturnQueue.push(
    [
      {
        business_id: 'loc-A',
        name: 'Cafe A',
        created_at: new Date('2026-01-01T00:00:00Z'),
        initial_review_count: null,
        initial_responded_count: null,
        baseline_captured_at: null,
      },
    ],
    [], [], [], [], [], [], [],
  );
}

describe('fetchPerLocationAggregateSlices — Review-time anchor (#757, ADR 0019)', () => {
  beforeEach(() => {
    harness = createMockSql();
    mockSql = harness.mockSql as unknown as Sql;
  });

  it('aggregate velocity and rating-breakdown queries spell LEAST(r.review_date, r.detected_at)', async () => {
    seed();
    await fetchPerLocationAggregateSlices(mockSql, ACCOUNT_ID, '30d');
    const velocity = find('CROSS JOIN generate_series');
    const rating = find('GROUP BY b.id, r.star_rating');
    expect(countAnchors(velocity)).toBe(2);
    expect(countAnchors(rating)).toBe(1);
    expect(stripAnchor(velocity)).not.toContain('detected_at');
    expect(stripAnchor(rating)).not.toContain('detected_at');
    // Aliases renamed to r. so the fragment's '' | 'r.' union covers both sites.
    expect(velocity).not.toContain('rv.');
    expect(rating).not.toContain('rev.');
  });

  it('aggregate review-counter query never spells LEAST(', async () => {
    seed();
    await fetchPerLocationAggregateSlices(mockSql, ACCOUNT_ID, '30d');
    // NEGATIVE CONTROL — received_window/responded_window feed the account
    // response rate, a workflow KPI (ADR 0019 D2).
    const counters = find('total_received_all_time');
    expect(counters).not.toContain('LEAST(');
    expect(counters).toContain('r.detected_at >= NOW()');
  });
});
