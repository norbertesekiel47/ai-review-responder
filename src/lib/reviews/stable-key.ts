import type { NormalizedReview } from './types';

const SEPARATOR = '\u001f';

function hashString(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 33) ^ input.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}

function reviewIdentityInput(review: NormalizedReview): string {
  return [
    review.reviewerName,
    review.starRating,
    review.reviewText ?? '',
    review.reviewDate,
    review.detectedLanguage,
  ].join(SEPARATOR);
}

export function getNormalizedReviewKey(review: NormalizedReview, occurrence = 0): string {
  const base = `review-${hashString(reviewIdentityInput(review))}`;
  return occurrence === 0 ? base : `${base}-${occurrence}`;
}

export function getNormalizedReviewRows<T extends NormalizedReview>(
  reviews: T[],
): Array<{ key: string; review: T; index: number }> {
  const seen = new Map<string, number>();
  return reviews.map((review, index) => {
    const base = getNormalizedReviewKey(review);
    const occurrence = seen.get(base) ?? 0;
    seen.set(base, occurrence + 1);
    return {
      key: occurrence === 0 ? base : `${base}-${occurrence}`,
      review,
      index,
    };
  });
}
