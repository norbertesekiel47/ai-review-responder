import { describe, expect, it } from 'vitest';
import { __testing } from '../named-rival';

const { selectAutoDefaultRival, parseCompetitorRating } = __testing;

/** Minimal pack row factory — every field the selector reads, nothing else. */
function packRow(overrides: Partial<Parameters<typeof selectAutoDefaultRival>[0][number]> = {}) {
  return {
    snapshot_date: '2026-07-20',
    rank_position: 1,
    place_id: 'ChIJ_rival_a',
    title: 'Joe’s Bakery',
    rating: 4.7,
    review_count: 400,
    is_self: false,
    ...overrides,
  };
}

describe('selectAutoDefaultRival', () => {
  it('computes the gap from review counts only, ignoring rating and rank', () => {
    const rows = [
      packRow({ place_id: 'ChIJ_self', is_self: true, review_count: 100, rating: 5.0, rank_position: 9 }),
      packRow({ place_id: 'ChIJ_rival_a', review_count: 127, rating: 2.1, rank_position: 20 }),
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

  it('breaks ties by rank position with NULL rank last, then place id', () => {
    const rows = [
      packRow({ place_id: 'ChIJ_self', is_self: true, review_count: 100 }),
      packRow({ place_id: 'ChIJ_b', title: 'Null Rank', review_count: 150, rank_position: null }),
      packRow({ place_id: 'ChIJ_a', title: 'Ranked', review_count: 150, rank_position: 4 }),
    ];

    expect(selectAutoDefaultRival(rows, '2026-07-20', undefined)).toMatchObject({ rivalName: 'Ranked' });
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

describe('parseCompetitorRating', () => {
  it('parses the NUMERIC rating string from Postgres.js rather than comparing it as a string', () => {
    expect(parseCompetitorRating('4.8')).toBe(4.8);
    expect(parseCompetitorRating(null)).toBeNull();
    expect(parseCompetitorRating('   ')).toBeNull();
    expect(parseCompetitorRating('not-a-number')).toBeNull();
  });
});
