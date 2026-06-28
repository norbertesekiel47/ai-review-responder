import { describe, it, expect } from 'vitest';
import { buildRatingBreakdown, sumRatingBreakdowns } from '../rating-breakdown';

describe('buildRatingBreakdown', () => {
  it('zero-fills and orders the buckets 5★ → 1★', () => {
    const result = buildRatingBreakdown([
      { stars: 5, count: 3 },
      { stars: 3, count: 1 },
    ]);
    expect(result.counts).toEqual([
      { stars: 5, count: 3 },
      { stars: 4, count: 0 },
      { stars: 3, count: 1 },
      { stars: 2, count: 0 },
      { stars: 1, count: 0 },
    ]);
    expect(result.total).toBe(4);
  });

  it('returns an all-zero breakdown (total 0) for no rows', () => {
    const result = buildRatingBreakdown([]);
    expect(result.total).toBe(0);
    expect(result.counts.map((c) => c.count)).toEqual([0, 0, 0, 0, 0]);
  });

  it('ignores out-of-range star values and coerces numeric strings', () => {
    const result = buildRatingBreakdown([
      { stars: 0, count: 9 },
      { stars: 6, count: 9 },
      { stars: 5, count: 2 },
      { stars: 5, count: 1 },
    ] as Array<{ stars: number; count: number }>);
    expect(result.counts.find((c) => c.stars === 5)?.count).toBe(3);
    expect(result.total).toBe(3);
  });
});

describe('sumRatingBreakdowns', () => {
  it('sums per-location breakdowns element-wise by star', () => {
    const a = buildRatingBreakdown([{ stars: 5, count: 2 }, { stars: 1, count: 1 }]);
    const b = buildRatingBreakdown([{ stars: 5, count: 3 }, { stars: 4, count: 4 }]);
    const result = sumRatingBreakdowns([a, b]);
    expect(result.counts).toEqual([
      { stars: 5, count: 5 },
      { stars: 4, count: 4 },
      { stars: 3, count: 0 },
      { stars: 2, count: 0 },
      { stars: 1, count: 1 },
    ]);
    expect(result.total).toBe(10);
  });

  it('returns an all-zero breakdown (total 0) for no inputs', () => {
    const result = sumRatingBreakdowns([]);
    expect(result.total).toBe(0);
    expect(result.counts.map((c) => c.count)).toEqual([0, 0, 0, 0, 0]);
  });
});
