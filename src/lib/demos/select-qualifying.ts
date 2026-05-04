import type { NormalizedReview } from '@/lib/reviews/types';
import type { SelectQualifyingOptions } from './types';

const MAX_REVIEWS = 3;
const SUBSTANCE_BODY_MIN_CHARS = 50;

/**
 * Selects at most 3 reviews from a SerpAPI result set for demo display.
 *
 * Rules:
 *   'newest' (pre-existing prospect path):
 *     - Returns the first 3 reviews in input order (assumed newest-first
 *       from SerpAPI).
 *
 *   'positive-with-moderate-tail' (onboarding demo path, spec §3.3):
 *     1. Filter to rating >= 3.
 *     2. Build a 3-review portfolio with this preference order:
 *        a. >=1 5-star with body length > 50 chars (substance signal) —
 *           preferred anchor.
 *        b. Up to two 4-star reviews (recent-first by input order).
 *        c. ONE representative 3-star review at the END, only if we already
 *           have a >=4 anchor.
 *     3. If after filtering there are zero >=4 reviews, return [] so the
 *        caller falls through to curated fallback. (5-stars with short bodies
 *        still count as >=4 anchors — the body>50 check is a *preference*,
 *        not a gate.)
 *     4. Return at most 3 reviews.
 */
export function selectQualifyingReviews(
  reviews: NormalizedReview[],
  opts: SelectQualifyingOptions,
): NormalizedReview[] {
  if (opts.rule === 'newest') {
    return reviews.slice(0, MAX_REVIEWS);
  }

  return selectPositiveWithModerateTail(reviews);
}

function selectPositiveWithModerateTail(
  reviews: NormalizedReview[],
): NormalizedReview[] {
  const qualifying = reviews.filter((review) => review.starRating >= 3);

  const fiveStars = qualifying.filter((review) => review.starRating === 5);
  const fourStars = qualifying.filter((review) => review.starRating === 4);
  const threeStars = qualifying.filter((review) => review.starRating === 3);

  const fiveStarWithSubstance = fiveStars.find(
    (review) => bodyLength(review) > SUBSTANCE_BODY_MIN_CHARS,
  );

  const portfolio: NormalizedReview[] = [];
  const seen = new Set<NormalizedReview>();

  const tryAdd = (review: NormalizedReview | undefined): boolean => {
    if (!review || seen.has(review)) return false;
    if (portfolio.length >= MAX_REVIEWS) return false;
    portfolio.push(review);
    seen.add(review);
    return true;
  };

  // a. Preferred anchor: 5-star with substance.
  tryAdd(fiveStarWithSubstance);

  // b. Up to two 4-star reviews (recent-first by input order).
  for (const review of fourStars) {
    if (portfolio.length >= MAX_REVIEWS) break;
    tryAdd(review);
  }

  // If we still have room and haven't yet added a 5-star (substance fallback),
  // pull in any remaining 5-stars to fill out the >=4 portfolio.
  for (const review of fiveStars) {
    if (portfolio.length >= MAX_REVIEWS) break;
    tryAdd(review);
  }

  // Determine whether we have any >=4 anchor at all. Without one, fall through
  // to caller's curated fallback.
  const hasHighAnchor = portfolio.some((review) => review.starRating >= 4);
  if (!hasHighAnchor) {
    return [];
  }

  // c. ONE representative 3-star review at the END, only if there's room.
  if (portfolio.length < MAX_REVIEWS && threeStars.length > 0) {
    tryAdd(threeStars[0]);
  }

  return portfolio;
}

function bodyLength(review: NormalizedReview): number {
  return review.reviewText?.length ?? 0;
}
