// src/lib/dashboard/__tests__/service.review-time-anchor.test.ts
//
// SQL-SHAPE pins for the Review-time anchor on the single-location dashboard
// payload (#757, ADR 0019). The live-DB suite
// (review-time-anchor.integration.test.ts) proves the bucketing MEANS what the
// ADR decided; this suite pins the SPELLING on every run, with no database.
//
// Follows service.rating-breakdown.test.ts: same createMockSql harness, same
// always-miss Redis stub, same seed pattern. The harness flattens nested
// fragments into `call.text`, so a composed fragment is visible as literal SQL;
// `sqlCalls` records on `await` only.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { createMockSql, type MockSqlHarness } from '../../../../worker/__tests__/helpers/mock-sql';

vi.mock('@/lib/db/redis-cache', () => ({
  getCacheRedis: () => ({ get: async () => null, set: async () => 'OK' }),
}));

import { getActiveDashboardData } from '../service';

let harness: MockSqlHarness;
let mockSql: Sql;
const BUSINESS_ID = 'biz-anchor-1';
const ANCHOR = 'LEAST(review_date, detected_at)';

// Sequential settledInOrder order: 0 business, 1 totalReviews, 2 totalResponded,
// 3 velocity, 4 ranking, 5 recentReviews, 6 monthlyBrief, 7 weeklyBrief,
// 8 zernioConn, 9 queuedReconnect, 10 unresolvedIncident, 11 ratingBreakdown,
// (readPendingMarker is Redis — it does NOT consume the queue), then the
// reputation batch: 12 rate, 13 star, 14 timeSaved, 15 trend, 16 pendingCount.
function seed() {
  harness.resetMockSql();
  harness.sqlReturnQueue.push(
    [{ name: 'Biz', created_at: new Date('2026-01-01T00:00:00Z') }],
    [{ count: 0 }], [{ count: 0 }], [], [], [], [], [], [], [], [], [],
    [{ received_current: 0, handled_current: 0, received_prior: 0, handled_prior: 0 }],
    [{ star_current: null, star_n_current: 0, star_prior: null, star_n_prior: 0 }],
    [{ handled_current: 0, handled_prior: 0 }],
    [],
    [{ count: 0 }],
  );
}

/**
 * Find by a marker that must match EXACTLY ONE query in the wave. Throwing on an
 * ambiguous marker is the point: a plain `.find()` silently returns the first
 * match, which is how an earlier draft asserted timeSaved's properties against
 * the response-rate query and would have passed forever.
 */
function find(needle: string): string {
  const hits = harness.sqlCalls.filter((c) => c.text.includes(needle));
  if (hits.length !== 1) {
    throw new Error(`marker ${JSON.stringify(needle)} matched ${hits.length} queries, expected 1`);
  }
  return hits[0]!.text;
}
const countAnchors = (text: string) => text.split(ANCHOR).length - 1;
/** Blank out the approved anchor so any REMAINING detected_at is a bare one. */
const stripAnchor = (text: string) => text.split(ANCHOR).join('«anchor»');

describe('getActiveDashboardData — Review-time anchor (#757, ADR 0019)', () => {
  beforeEach(() => {
    harness = createMockSql();
    mockSql = harness.mockSql as unknown as Sql;
  });

  it('velocity, avg star, sentiment trend and rating breakdown queries all spell LEAST(review_date, detected_at)', async () => {
    seed();
    await getActiveDashboardData(mockSql, BUSINESS_ID, { includeReputationMetrics: true });
    const queries = {
      velocity: find('COALESCE(r.cnt, 0)'),
      star: find('star_n_current'),
      trend: find('AVG(sentiment_score)'),
      rating: find('GROUP BY star_rating'),
    };
    // Exact occurrence counts — a partially re-anchored query (say, the FILTER
    // predicates moved but the outer WHERE left behind) passes a bare
    // `toContain` and fails here.
    const expected = { velocity: 3, star: 7, trend: 3, rating: 1 };
    for (const [name, text] of Object.entries(queries)) {
      expect(countAnchors(text), `${name} anchor occurrences`).toBe(
        expected[name as keyof typeof expected],
      );
      // Nothing but the anchor may reference detected_at in these four queries.
      expect(stripAnchor(text), `${name} must have no bare detected_at`).not.toContain('detected_at');
    }
  });

  it('response-rate and timeSaved queries never spell LEAST(', async () => {
    seed();
    await getActiveDashboardData(mockSql, BUSINESS_ID, { includeReputationMetrics: true });
    // NEGATIVE CONTROL. `handled_prior` appears in BOTH the rate and timeSaved
    // queries, and `FROM responses resp` appears THREE times (twice inside the
    // rate query's EXISTS subqueries, service.ts:488,502, before timeSaved's own
    // at :546) — so timeSaved is selected by the one marker unique to it, and
    // findOnly throws if that ever stops being true.
    const rate = find('received_current');
    const timeSaved = find('JOIN reviews r ON r.id = resp.review_id');
    expect(timeSaved).toContain('handled_prior');
    expect(rate).not.toContain('LEAST(');
    expect(timeSaved).not.toContain('LEAST(');
    expect(rate).toContain('r.detected_at >= NOW()');
    expect(timeSaved).toContain('resp.approved_at >= NOW()');
  });
});
