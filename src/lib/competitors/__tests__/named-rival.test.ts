import { describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { __testing, loadRivalPickerViews } from '../named-rival';
import { asLocationId } from '@/lib/shared/ids';

const { selectAutoDefaultRival, selectNamedRival, parseCompetitorRating } = __testing;

/** Minimal pack row factory — every field the selector reads, nothing else. */
function packRow(overrides: Partial<Parameters<typeof selectAutoDefaultRival>[0][number]> = {}) {
  return {
    snapshot_date: '2026-07-20',
    rank_position: 1,
    place_id: 'ChIJ_rival_a',
    title: 'Joe’s Bakery',
    review_count: 400,
    is_self: false,
    ...overrides,
  };
}

describe('selectAutoDefaultRival', () => {
  it('computes the gap from review counts only, ignoring rank', () => {
    const rows = [
      packRow({ place_id: 'ChIJ_self', is_self: true, review_count: 100, rank_position: 9 }),
      packRow({ place_id: 'ChIJ_rival_a', review_count: 127, rank_position: 20 }),
    ];

    const result = selectAutoDefaultRival(rows, '2026-07-20', undefined);

    expect(result).toEqual({
      rivalName: 'Joe’s Bakery',
      gap: 27,
      reviewVelocity: null,
      source: 'auto_default',
    });
  });

  it('picks the smallest positive gap when rivals are ahead', () => {
    const rows = [
      packRow({ place_id: 'ChIJ_self', is_self: true, review_count: 100 }),
      packRow({ place_id: 'ChIJ_far', title: 'Far Ahead', review_count: 500, rank_position: 1 }),
      packRow({ place_id: 'ChIJ_near', title: 'Near Ahead', review_count: 110, rank_position: 8 }),
    ];

    expect(selectAutoDefaultRival(rows, '2026-07-20', undefined)).toMatchObject({
      rivalName: 'Near Ahead',
      gap: 10,
    });
  });

  it('breaks a gap tie by rank position, with NULL rank last', () => {
    // The place_id tier is ANTI-ALIGNED with the expectation on purpose: the
    // ranked row carries the place id that sorts LAST, so tier 3 produces the
    // OPPOSITE answer and cannot rescue a deleted rank tier. The original
    // fixture had `ChIJ_a` winning both tiers, so this test passed with the
    // rank tier removed (Pathfinder 2026-08-15 census, group D).
    const rows = [
      packRow({ place_id: 'ChIJ_self', is_self: true, review_count: 100 }),
      packRow({ place_id: 'ChIJ_a', title: 'Null Rank', review_count: 150, rank_position: null }),
      packRow({ place_id: 'ChIJ_z', title: 'Ranked', review_count: 150, rank_position: 4 }),
    ];

    expect(selectAutoDefaultRival(rows, '2026-07-20', undefined)).toMatchObject({ rivalName: 'Ranked' });
  });

  it('breaks a gap-and-rank tie by place id ascending', () => {
    // Same gap AND same rank exhausts tiers 1-2, so only the place_id tier can
    // decide. Fed id-DESCENDING, because Array.prototype.sort is stable and a
    // deleted tier would otherwise leave the input order in place unnoticed.
    const rows = [
      packRow({ place_id: 'ChIJ_self', is_self: true, review_count: 100 }),
      packRow({ place_id: 'ChIJ_b', title: 'Second By Id', review_count: 150, rank_position: 4 }),
      packRow({ place_id: 'ChIJ_a', title: 'First By Id', review_count: 150, rank_position: 4 }),
    ];

    expect(selectAutoDefaultRival(rows, '2026-07-20', undefined)).toMatchObject({
      rivalName: 'First By Id',
    });
  });

  it('returns null when no pack row is our own business', () => {
    const rows = [packRow({ review_count: 400 })];
    expect(selectAutoDefaultRival(rows, '2026-07-20', undefined)).toBeNull();
  });

  it('excludes rivals with a NULL review count from selection', () => {
    const rows = [
      packRow({ place_id: 'ChIJ_self', is_self: true, review_count: 100 }),
      packRow({ place_id: 'ChIJ_unrated', review_count: null }),
    ];
    expect(selectAutoDefaultRival(rows, '2026-07-20', undefined)).toBeNull();
  });

  it('reports velocity against the preceding snapshot for the same place id', () => {
    const rows = [
      packRow({ place_id: 'ChIJ_self', is_self: true, review_count: 100 }),
      packRow({ place_id: 'ChIJ_rival_a', review_count: 127 }),
      packRow({ snapshot_date: '2026-07-06', place_id: 'ChIJ_rival_a', review_count: 123 }),
    ];

    expect(selectAutoDefaultRival(rows, '2026-07-20', '2026-07-06')).toMatchObject({
      gap: 27,
      reviewVelocity: 4,
    });
  });
});

const SELF = { place_id: 'ChIJ_self', is_self: true, review_count: 100 };

describe('selectNamedRival', () => {
  it('returns the owner pick as the Named rival when the picked place_id is in the latest pack', () => {
    const rows = [
      packRow(SELF),
      packRow({ place_id: 'ChIJ_near', title: 'Near Ahead', review_count: 110, rank_position: 8 }),
      packRow({ place_id: 'ChIJ_picked', title: 'Old Mill Bakery', review_count: 180, rank_position: 3 }),
    ];

    const result = selectNamedRival(rows, '2026-07-20', undefined, {
      placeId: 'ChIJ_picked',
      titleSnapshot: 'Old Mill Bakery',
    });

    expect(result).toEqual({
      kind: 'rival',
      line: { rivalName: 'Old Mill Bakery', gap: 80, reviewVelocity: null, source: 'owner_pick' },
    });
  });

  it('uses the live pack title, not the stored snapshot, when the picked rival was renamed', () => {
    const rows = [
      packRow(SELF),
      packRow({ place_id: 'ChIJ_picked', title: 'Old Mill Bakehouse', review_count: 180 }),
    ];

    const result = selectNamedRival(rows, '2026-07-20', undefined, {
      placeId: 'ChIJ_picked',
      titleSnapshot: 'Old Mill Bakery',
    });

    expect(result).toMatchObject({ line: { rivalName: 'Old Mill Bakehouse' } });
  });

  it('renders the dropout note then the Auto-default line when the pick left the pack after the preceding snapshot', () => {
    const rows = [
      packRow(SELF),
      packRow({ place_id: 'ChIJ_near', title: 'Near Ahead', review_count: 110 }),
      packRow({ snapshot_date: '2026-07-06', ...SELF, review_count: 96 }),
      packRow({ snapshot_date: '2026-07-06', place_id: 'ChIJ_picked', title: 'Old Mill Bakery', review_count: 175 }),
      packRow({ snapshot_date: '2026-07-06', place_id: 'ChIJ_near', title: 'Near Ahead', review_count: 108 }),
    ];

    const result = selectNamedRival(rows, '2026-07-20', '2026-07-06', {
      placeId: 'ChIJ_picked',
      titleSnapshot: 'Old Mill Bakery',
    });

    expect(result).toEqual({
      kind: 'dropout',
      droppedName: 'Old Mill Bakery',
      fallback: { rivalName: 'Near Ahead', gap: 10, reviewVelocity: 2, source: 'auto_default' },
    });
  });

  it('renders the Auto-default line with no dropout note when the pick is absent from both snapshots', () => {
    const rows = [
      packRow(SELF),
      packRow({ place_id: 'ChIJ_near', title: 'Near Ahead', review_count: 110 }),
      packRow({ snapshot_date: '2026-07-06', ...SELF, review_count: 96 }),
      packRow({ snapshot_date: '2026-07-06', place_id: 'ChIJ_near', title: 'Near Ahead', review_count: 108 }),
    ];

    const result = selectNamedRival(rows, '2026-07-20', '2026-07-06', {
      placeId: 'ChIJ_gone', titleSnapshot: 'Vanished Cafe',
    });

    expect(result).toEqual({
      kind: 'rival',
      line: { rivalName: 'Near Ahead', gap: 10, reviewVelocity: 2, source: 'auto_default' },
    });
  });

  it('renders the Auto-default line with no dropout note when only one snapshot date exists', () => {
    const rows = [packRow(SELF), packRow({ place_id: 'ChIJ_near', title: 'Near Ahead', review_count: 110 })];

    const result = selectNamedRival(rows, '2026-07-20', undefined, {
      placeId: 'ChIJ_gone', titleSnapshot: 'Vanished Cafe',
    });

    expect(result).toMatchObject({ kind: 'rival', line: { source: 'auto_default' } });
  });

  it('falls back to the Auto-default rival when the picked rival has a NULL review count', () => {
    const rows = [
      packRow(SELF),
      packRow({ place_id: 'ChIJ_near', title: 'Near Ahead', review_count: 110 }),
      packRow({ place_id: 'ChIJ_picked', title: 'Unrated Rival', review_count: null }),
    ];

    const result = selectNamedRival(rows, '2026-07-20', undefined, {
      placeId: 'ChIJ_picked', titleSnapshot: 'Unrated Rival',
    });

    expect(result).toMatchObject({ kind: 'rival', line: { rivalName: 'Near Ahead', source: 'auto_default' } });
  });

  it('falls back to the Auto-default rival when the picked rival has a blank title in the latest pack', () => {
    // 084 stores `title = ''` when SerpAPI omits a name. The rival is still in
    // the pack, so this is present-but-unusable — same as a NULL review count:
    // the Auto-default line renders and NO dropout note fires.
    const rows = [
      packRow(SELF),
      packRow({ place_id: 'ChIJ_near', title: 'Near Ahead', review_count: 110 }),
      packRow({ place_id: 'ChIJ_picked', title: '   ', review_count: 180 }),
      packRow({ snapshot_date: '2026-07-06', ...SELF, review_count: 96 }),
      packRow({ snapshot_date: '2026-07-06', place_id: 'ChIJ_near', title: 'Near Ahead', review_count: 108 }),
      packRow({ snapshot_date: '2026-07-06', place_id: 'ChIJ_picked', title: 'Old Mill Bakery', review_count: 175 }),
    ];

    const result = selectNamedRival(rows, '2026-07-20', '2026-07-06', {
      placeId: 'ChIJ_picked', titleSnapshot: 'Old Mill Bakery',
    });

    expect(result).toEqual({
      kind: 'rival',
      line: { rivalName: 'Near Ahead', gap: 10, reviewVelocity: 2, source: 'auto_default' },
    });
  });

  it('labels the Auto-default rival source when there is no pick at all', () => {
    const rows = [packRow(SELF), packRow({ place_id: 'ChIJ_near', title: 'Near Ahead', review_count: 110 })];
    expect(selectNamedRival(rows, '2026-07-20', undefined, null)).toMatchObject({
      kind: 'rival', line: { source: 'auto_default' },
    });
  });

  it('emits no dropout note when the latest pack was persisted empty', () => {
    // Our own is_self row is missing for the current date — a recorded empty
    // pack (084). Every place_id looks "absent"; claiming the pick dropped out
    // would be a false alarm with no fallback line to soften it.
    const rows = [
      packRow({ snapshot_date: '2026-07-06', ...SELF, review_count: 96 }),
      packRow({ snapshot_date: '2026-07-06', place_id: 'ChIJ_picked', title: 'Old Mill Bakery', review_count: 175 }),
    ];

    const result = selectNamedRival(rows, '2026-07-20', '2026-07-06', {
      placeId: 'ChIJ_picked', titleSnapshot: 'Old Mill Bakery',
    });

    expect(result).toBeNull();
  });
});

describe('parseCompetitorRating', () => {
  it('parses the NUMERIC rating string from Postgres.js rather than comparing it as a string', () => {
    expect(parseCompetitorRating('4.8')).toBe(4.8);
    expect(parseCompetitorRating(null)).toBeNull();
    expect(parseCompetitorRating('   ')).toBeNull();
    expect(parseCompetitorRating('not-a-number')).toBeNull();
  });
});

const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const LOCATION_A = asLocationId('aaaaaaaa-1111-4111-8111-111111111111');
const LOCATION_B = asLocationId('bbbbbbbb-2222-4222-8222-222222222222');
const LOCATION_C = asLocationId('cccccccc-3333-4333-8333-333333333333');

/**
 * One row shape that satisfies all three reads `loadRivalPickerView` issues
 * (context → latest snapshot date → pack rows), so each location's chain runs to
 * its terminal `ready` state instead of throwing `RivalPickNotFoundError` on an
 * empty context row. `place_id: null` makes every pack row unpickable, so
 * `options` comes back empty and no fixture detail leaks into the assertions —
 * these two tests are about SEQUENCING, not about rival selection.
 */
const PICKER_STUB_ROW = {
  keyword: 'best bakery',
  search_location: '40.7,-74.0',
  rival_place_id: null,
  rival_title_snapshot: null,
  snapshot_date: '2026-08-01',
  rank_position: null,
  place_id: null,
  title: '',
  rating: null,
  review_count: null,
  is_self: false,
};

/**
 * A `sql` stand-in that reports when a query is IN FLIGHT rather than merely
 * constructed. postgres.js Queries are lazy thenables — `primaryTrackedKeywordSql`
 * builds one as a nested fragment and never awaits it — so the in-flight window
 * opens in `then`, not at call time. Otherwise the counter would measure
 * "template literals evaluated", not "concurrent round trips".
 */
function makeSequentialSpySql(onEnter: () => () => void) {
  return vi.fn(() => ({
    then(resolve: (rows: unknown[]) => void) {
      const onExit = onEnter();
      void Promise.resolve().then(() => {
        onExit();
        resolve([PICKER_STUB_ROW]);
      });
    },
  }));
}

describe('loadRivalPickerViews', () => {
  it('loads each location rival view sequentially', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const sql = makeSequentialSpySql(() => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return () => { inFlight -= 1; };
    });

    const views = await loadRivalPickerViews(sql as unknown as Sql, {
      accountId: ACCOUNT_ID,
      businessIds: [LOCATION_A, LOCATION_B, LOCATION_C],
    });

    expect(views).toHaveLength(3);
    expect(maxInFlight).toBe(1);
  });

  it('issues no rival-view queries when the account has no active locations', async () => {
    const sql = makeSequentialSpySql(() => () => {});
    const views = await loadRivalPickerViews(sql as unknown as Sql, {
      accountId: ACCOUNT_ID,
      businessIds: [],
    });

    expect(views).toEqual([]);
    expect(sql).not.toHaveBeenCalled();
  });
});
