// src/lib/reviews/zernio-field-match.ts
//
// Canonical field-match logic for identifying a Zernio review as "the same"
// as a local serpapi_poll row.
//
// Two implementations must stay in sync:
//   1. JS predicate here  — used by zernio-publisher.ts and zernio-ingest-shared.ts
//   2. SQL WHERE fragment  — in zernio-ingest-shared.ts (comment points here)
//
// A unit test in __tests__/zernio-field-match.test.ts runs both on a fixed
// corpus and asserts they agree.

import type { ZernioReview } from '@/lib/zernio/types';

/** ±24h tolerance for createTime vs review_date comparison. */
export const MATCH_WINDOW_MS = 86_400_000;

/**
 * The canonical shape both sides reduce to before comparing.
 * Matches what the SQL fragment compares against:
 *   reviewer_name, star_rating, trimmed review_text, epoch milliseconds.
 */
export interface ZernioFieldMatchTarget {
  reviewer_name: string;
  star_rating: number;
  review_text_trimmed: string;
  created_at_ms: number;
}

/**
 * Reduce a Zernio review to the canonical match target.
 * Mirrors the SQL projection in reconcileExternallyAnsweredReview:
 *   (target.reviewer.displayName ?? '').trim() || 'Anonymous'
 *   target.rating
 *   (target.comment ?? '').trim()
 *   new Date(target.createTime).getTime()
 */
export function fromZernioReview(z: ZernioReview): ZernioFieldMatchTarget {
  return {
    reviewer_name: (z.reviewer.displayName ?? '').trim() || 'Anonymous',
    star_rating: z.rating,
    review_text_trimmed: (z.comment ?? '').trim(),
    created_at_ms: new Date(z.createTime).getTime(),
  };
}

/**
 * JS-side predicate: does the Zernio field-match target correspond to this
 * local review row?
 *
 * Mirrors the SQL predicate in reconcileExternallyAnsweredReview:
 *   reviewer_name = ${targetReviewerName}
 *   AND star_rating = ${target.rating}
 *   AND COALESCE(NULLIF(trim(review_text), ''), '') = ${targetComment}
 *   AND ABS(EXTRACT(EPOCH FROM (review_date - to_timestamp(${targetCreatedAtMs}/1000.0)))) < 86400
 *
 * NOTE: if either side changes this predicate, the SQL fragment in
 * zernio-ingest-shared.ts MUST be updated to match.
 */
export function matchesLocalRow(
  target: ZernioFieldMatchTarget,
  localRow: {
    reviewer_name: string;
    star_rating: number;
    review_text: string | null;
    review_date: Date | string;
  },
): boolean {
  const localText = (localRow.review_text ?? '').trim();
  const localMs = new Date(localRow.review_date).getTime();

  return (
    target.reviewer_name === localRow.reviewer_name &&
    target.star_rating === localRow.star_rating &&
    target.review_text_trimmed === localText &&
    Math.abs(target.created_at_ms - localMs) < MATCH_WINDOW_MS
  );
}
