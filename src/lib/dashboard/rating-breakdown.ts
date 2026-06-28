// src/lib/dashboard/rating-breakdown.ts
//
// Single owner of the reviews-by-rating bucketing knowledge (#405): the 1–5★
// tiers, zero-fill, ordering, and total. Used by the per-location service
// (build from a GROUP BY) and the aggregate service (sum per-location rollups),
// so neither re-implements the shape.

import type { RatingBreakdown } from './types';

/** Star buckets, highest first — the order the breakdown card renders. */
const RATING_TIERS = [5, 4, 3, 2, 1] as const;

/** Materialize a normalized breakdown (5 entries, 5★→1★, with total) from a
 *  star→count map, zero-filling any missing tier. */
function fromStarCounts(byStar: Map<number, number>): RatingBreakdown {
  const counts = RATING_TIERS.map((stars) => ({ stars, count: byStar.get(stars) ?? 0 }));
  return { counts, total: counts.reduce((sum, c) => sum + c.count, 0) };
}

/**
 * Build a breakdown from `GROUP BY star_rating` rows. Out-of-range stars are
 * dropped (the column is `INTEGER CHECK (1..5)`, but the guard keeps the shape
 * honest regardless of upstream changes). Values are coerced because Postgres.js
 * can surface counts as strings.
 */
export function buildRatingBreakdown(
  rows: ReadonlyArray<{ stars: number; count: number }>,
): RatingBreakdown {
  const byStar = new Map<number, number>();
  for (const row of rows) {
    const stars = Number(row.stars);
    if (stars >= 1 && stars <= 5) {
      byStar.set(stars, (byStar.get(stars) ?? 0) + Number(row.count));
    }
  }
  return fromStarCounts(byStar);
}

/** Element-wise sum of per-location breakdowns into one account-wide breakdown. */
export function sumRatingBreakdowns(
  breakdowns: ReadonlyArray<RatingBreakdown>,
): RatingBreakdown {
  const byStar = new Map<number, number>();
  for (const breakdown of breakdowns) {
    for (const { stars, count } of breakdown.counts) {
      byStar.set(stars, (byStar.get(stars) ?? 0) + count);
    }
  }
  return fromStarCounts(byStar);
}
