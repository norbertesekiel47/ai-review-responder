import { describe, expect, it } from 'vitest';
import type { NormalizedReview } from '../types';
import { getNormalizedReviewKey, getNormalizedReviewRows } from '../stable-key';

const baseReview: NormalizedReview = {
  reviewerName: 'Ari',
  starRating: 5,
  reviewText: 'Great service',
  reviewDate: '2026-05-01T00:00:00.000Z',
  detectedLanguage: 'en',
};

describe('stable review keys', () => {
  it('returns the same key for the same review content', () => {
    expect(getNormalizedReviewKey(baseReview)).toBe(getNormalizedReviewKey({ ...baseReview }));
  });

  it('adds an occurrence suffix so identical sibling reviews remain unique', () => {
    const rows = getNormalizedReviewRows([baseReview, { ...baseReview }]);

    expect(rows.map((row) => row.key)).toHaveLength(2);
    expect(new Set(rows.map((row) => row.key)).size).toBe(2);
  });
});
