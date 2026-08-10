import { describe, it, expect, beforeEach } from 'vitest';
import type { Sql } from 'postgres';
import { createMockSql, type MockSqlHarness } from '../../../../worker/__tests__/helpers/mock-sql';

// The set-based aggregate module is born-injected (sql is a parameter, invariant
// #15), so the fragment-aware createMockSql harness stands in for `sql` directly.
import {
  fetchPerLocationAggregateSlices,
  type PerLocationAggregateSlice,
} from '../aggregate-queries';
import { getPendingApprovalCountsForAccount } from '../pending-count';

let harness: MockSqlHarness;
let mockSql: Sql;

beforeEach(() => {
  harness = createMockSql();
  mockSql = harness.mockSql as unknown as Sql;
});

/**
 * Load the aggregate wave's return values in the deterministic order the mock
 * consumes them. `getPendingApprovalCountsForAccount` awaits its `sql` inside an
 * async function during Promise.all construction, so its query resolves FIRST;
 * the six lazy `sql``` fragments then resolve in their array order.
 */
function pushWave(rows: {
  pending: Array<{ business_id: string; count: number }>;
  baseline: unknown[];
  counters: unknown[];
  velocity: unknown[];
  rating: unknown[];
  ranking: unknown[];
  monthly: unknown[];
  weekly: unknown[];
}): void {
  harness.sqlReturnQueue.push(
    rows.pending,
    rows.baseline,
    rows.counters,
    rows.velocity,
    rows.rating,
    rows.ranking,
    rows.monthly,
    rows.weekly,
  );
}

describe('fetchPerLocationAggregateSlices — byte-identical per-location slices', () => {
  beforeEach(() => {
    pushWave({
      pending: [
        { business_id: 'loc-A', count: 25 },
        { business_id: 'loc-B', count: 13 },
      ],
      baseline: [
        {
          business_id: 'loc-A',
          name: 'Cafe A',
          created_at: new Date('2026-01-01'),
          initial_review_count: 100,
          initial_responded_count: 30,
          baseline_captured_at: new Date('2026-01-01'),
        },
        {
          business_id: 'loc-B',
          name: 'Bakery B',
          created_at: new Date('2026-01-02'),
          initial_review_count: null,
          initial_responded_count: null,
          baseline_captured_at: null,
        },
      ],
      counters: [
        { business_id: 'loc-A', total_received_all_time: 50, total_responded_all_time: 40, received_window: 12, responded_window: 9 },
        { business_id: 'loc-B', total_received_all_time: 3, total_responded_all_time: 2, received_window: 1, responded_window: 1 },
      ],
      velocity: [
        { business_id: 'loc-A', week_start: '2026-06-01', count: 2 },
        { business_id: 'loc-A', week_start: '2026-06-08', count: 3 },
        { business_id: 'loc-B', week_start: '2026-06-01', count: 1 },
      ],
      rating: [
        { business_id: 'loc-A', stars: 5, count: 20 },
        { business_id: 'loc-A', stars: 4, count: 5 },
        { business_id: 'loc-B', stars: 5, count: 1 },
      ],
      ranking: [
        { business_id: 'loc-A', keyword: 'coffee', snapshot_date: '2026-06-01', rank_position: 3 },
        { business_id: 'loc-A', keyword: 'coffee', snapshot_date: '2026-06-08', rank_position: 2 },
      ],
      monthly: [
        { business_id: 'loc-A', summary_text: 'Monthly A', month_start_date: '2026-06-01', sent_at: '2026-07-01T00:00:00Z' },
      ],
      weekly: [
        { business_id: 'loc-B', summary_text: 'Weekly B', week_start_date: '2026-06-30', sent_at: '2026-07-05T00:00:00Z' },
      ],
    });
  });

  it('reproduces every retained field per location via the existing mappers', async () => {
    const slices = await fetchPerLocationAggregateSlices(mockSql, 'acc-1', '30d');

    const a = slices.get('loc-A')!;
    expect(a.valueSummary).toEqual({
      totalReviewsHandled: 40,
      totalTimeSavedMinutes: 280, // 40 × MINUTES_SAVED_PER_RESPONSE (7)
      currentResponseRate: 80, // round(40/50 × 100)
      baselineResponseRate: 30, // round(30/100 × 100)
    });
    expect(a.reviewVelocity).toEqual([
      { weekStart: '2026-06-01', count: 2 },
      { weekStart: '2026-06-08', count: 3 },
    ]);
    expect(a.ranking).toEqual([
      { keyword: 'coffee', snapshots: [
        { date: '2026-06-01', position: 3 },
        { date: '2026-06-08', position: 2 },
      ] },
    ]);
    expect(a.ratingBreakdown.counts).toEqual([
      { stars: 5, count: 20 },
      { stars: 4, count: 5 },
      { stars: 3, count: 0 },
      { stars: 2, count: 0 },
      { stars: 1, count: 0 },
    ]);
    expect(a.ratingBreakdown.total).toBe(25);
    expect(a.latestBrief).toEqual({ text: 'Monthly A', type: 'monthly', periodLabel: 'June 2026' });
    expect(a.recentReviewCount).toBe(10); // LEAST(50, 10)
    expect(a.pendingApprovalCount).toBe(25);
    expect(a.windowedReceived).toBe(12);
    expect(a.windowedResponded).toBe(9);

    const b = slices.get('loc-B')!;
    expect(b.valueSummary).toEqual({
      totalReviewsHandled: 2,
      totalTimeSavedMinutes: 14,
      currentResponseRate: 67, // round(2/3 × 100)
      baselineResponseRate: null, // no baseline captured
    });
    expect(b.reviewVelocity).toEqual([{ weekStart: '2026-06-01', count: 1 }]);
    expect(b.ranking).toBeNull(); // no ranking rows for loc-B
    expect(b.ratingBreakdown.total).toBe(1);
    expect(b.latestBrief).toEqual({ text: 'Weekly B', type: 'weekly', periodLabel: 'Week of 2026-06-30' });
    expect(b.recentReviewCount).toBe(3); // LEAST(3, 10)
    expect(b.pendingApprovalCount).toBe(13);
  });

  it('scopes every query by account_id (tenant isolation)', async () => {
    await fetchPerLocationAggregateSlices(mockSql, 'acc-1', '30d');

    expect(harness.sqlCalls).toHaveLength(8);
    for (const call of harness.sqlCalls) {
      expect(call.text).toContain('account_id');
      expect(call.values).toContain('acc-1');
    }
  });
});

describe('fetchPerLocationAggregateSlices — tenant/anchor gating', () => {
  it('never emits a bucket for a business_id absent from the baseline (active-location) set', async () => {
    // A stray counters row for a location NOT in the baseline anchor set (as
    // could only happen via a leak) must never surface — output is gated by the
    // account-scoped baseline set.
    pushWave({
      pending: [{ business_id: 'loc-FOREIGN', count: 99 }],
      baseline: [
        { business_id: 'loc-A', name: 'A', created_at: new Date('2026-01-01'), initial_review_count: null, initial_responded_count: null, baseline_captured_at: null },
      ],
      counters: [
        { business_id: 'loc-A', total_received_all_time: 1, total_responded_all_time: 0, received_window: 0, responded_window: 0 },
        { business_id: 'loc-FOREIGN', total_received_all_time: 500, total_responded_all_time: 500, received_window: 5, responded_window: 5 },
      ],
      velocity: [], rating: [], ranking: [], monthly: [], weekly: [],
    });

    const slices = await fetchPerLocationAggregateSlices(mockSql, 'acc-1', '30d');

    expect([...slices.keys()]).toEqual(['loc-A']);
    expect(slices.has('loc-FOREIGN')).toBe(false);
  });
});

describe('fetchPerLocationAggregateSlices — empty-bucket parity', () => {
  it('zero-fills a location absent from every GROUP BY result', async () => {
    pushWave({
      pending: [],
      baseline: [
        { business_id: 'loc-EMPTY', name: 'Empty', created_at: new Date('2026-01-01'), initial_review_count: null, initial_responded_count: null, baseline_captured_at: null },
      ],
      counters: [], velocity: [], rating: [], ranking: [], monthly: [], weekly: [],
    });

    const slices = await fetchPerLocationAggregateSlices(mockSql, 'acc-1', '30d');
    const empty = slices.get('loc-EMPTY')!;

    expect(empty.valueSummary).toEqual({
      totalReviewsHandled: 0,
      totalTimeSavedMinutes: 0,
      currentResponseRate: 0,
      baselineResponseRate: null,
    });
    expect(empty.reviewVelocity).toEqual([]);
    expect(empty.ranking).toBeNull();
    expect(empty.ratingBreakdown.total).toBe(0);
    expect(empty.ratingBreakdown.counts.map((c) => c.count)).toEqual([0, 0, 0, 0, 0]);
    expect(empty.latestBrief).toBeNull();
    expect(empty.recentReviewCount).toBe(0);
    expect(empty.pendingApprovalCount).toBe(0);
    expect(empty.windowedReceived).toBe(0);
    expect(empty.windowedResponded).toBe(0);
  });
});

describe('fetchPerLocationAggregateSlices — query count is constant in N', () => {
  function emptyWave(locationCount: number): void {
    const baseline = Array.from({ length: locationCount }, (_, i) => ({
      business_id: `loc-${i}`,
      name: `L${i}`,
      created_at: new Date('2026-01-01'),
      initial_review_count: null,
      initial_responded_count: null,
      baseline_captured_at: null,
    }));
    pushWave({ pending: [], baseline, counters: [], velocity: [], rating: [], ranking: [], monthly: [], weekly: [] });
  }

  it('issues the same number of SQL statements for 2 and 5 locations', async () => {
    emptyWave(2);
    await fetchPerLocationAggregateSlices(mockSql, 'acc-2', '30d');
    const twoLocationQueries = harness.sqlCalls.length;

    harness.resetMockSql();
    emptyWave(5);
    await fetchPerLocationAggregateSlices(mockSql, 'acc-5', '30d');
    const fiveLocationQueries = harness.sqlCalls.length;

    expect(twoLocationQueries).toBe(8);
    expect(fiveLocationQueries).toBe(twoLocationQueries);
  });
});

describe('getPendingApprovalCountsForAccount', () => {
  it('buckets the authoritative pending count per business_id, account-scoped', async () => {
    harness.sqlReturnQueue.push([
      { business_id: 'loc-A', count: 25 },
      { business_id: 'loc-B', count: 13 },
    ]);

    const counts = await getPendingApprovalCountsForAccount(mockSql, 'acc-1');

    expect(counts.get('loc-A')).toBe(25);
    expect(counts.get('loc-B')).toBe(13);
    expect(counts.get('loc-absent')).toBeUndefined();

    const call = harness.sqlCalls[0]!;
    expect(call.text).toContain('account_id');
    expect(call.text).toContain('GROUP BY resp.business_id');
    expect(call.text).toContain("resp.status = 'pending_approval'");
    // #730: the held-exclusion is composed via openFlagExistsSql; the
    // fragment-aware harness flattens the fragment's text into this same
    // captured call, so the predicate (and its NEGATED polarity + correlated
    // ref) stays observable right here.
    expect(call.text).toContain('flagged_responses');
    expect(call.text).toContain('AND NOT EXISTS');
    expect(call.text).toContain('fr.response_id = resp.id');
    expect(call.values).toContain('acc-1');
  });
});

// Type-level guard: the exported slice shape stays in sync with what the service
// consumes (compile-time only; keeps the contract honest for the rewire).
const _sliceShape: PerLocationAggregateSlice | undefined = undefined;
void _sliceShape;
