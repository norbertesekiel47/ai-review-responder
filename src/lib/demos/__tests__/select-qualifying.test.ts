import { describe, it, expect } from 'vitest';
import type { NormalizedReview } from '@/lib/reviews/types';
import { selectQualifyingReviews } from '../select-qualifying';

function makeReview(overrides: Partial<NormalizedReview> = {}): NormalizedReview {
  return {
    reviewerName: 'X',
    starRating: 5,
    reviewText: 'Good',
    reviewDate: '2026-01-01T00:00:00Z',
    detectedLanguage: 'en',
    ...overrides,
  };
}

const SUBSTANCE_BODY = 'a'.repeat(60); // > 50 chars

describe('selectQualifyingReviews', () => {
  describe("rule: 'newest'", () => {
    it('returns the first 3 reviews when given 4+ inputs', () => {
      const r1 = makeReview({ reviewerName: 'A' });
      const r2 = makeReview({ reviewerName: 'B' });
      const r3 = makeReview({ reviewerName: 'C' });
      const r4 = makeReview({ reviewerName: 'D' });
      const r5 = makeReview({ reviewerName: 'E' });

      const result = selectQualifyingReviews([r1, r2, r3, r4, r5], {
        rule: 'newest',
      });

      expect(result).toEqual([r1, r2, r3]);
    });

    it('returns all reviews when fewer than 3 are given', () => {
      const r1 = makeReview({ reviewerName: 'A' });
      const r2 = makeReview({ reviewerName: 'B' });

      const result = selectQualifyingReviews([r1, r2], { rule: 'newest' });

      expect(result).toEqual([r1, r2]);
    });

    it('returns [] for empty input', () => {
      const result = selectQualifyingReviews([], { rule: 'newest' });
      expect(result).toEqual([]);
    });
  });

  describe("rule: 'positive-with-moderate-tail'", () => {
    it('prefers a 5-star with substance (>50 chars) as the first anchor', () => {
      const fiveShort = makeReview({
        reviewerName: 'fiveShort',
        starRating: 5,
        reviewText: 'Great',
      });
      const fiveSubstance = makeReview({
        reviewerName: 'fiveSubstance',
        starRating: 5,
        reviewText: SUBSTANCE_BODY,
      });
      const four = makeReview({ reviewerName: 'four', starRating: 4 });

      const result = selectQualifyingReviews(
        [fiveShort, fiveSubstance, four],
        { rule: 'positive-with-moderate-tail' },
      );

      expect(result[0]).toBe(fiveSubstance);
      expect(result).toHaveLength(3);
    });

    it('appends ONE 3-star at the end when a >=4 anchor exists and there are remaining slots', () => {
      const fiveSubstance = makeReview({
        reviewerName: 'fiveSubstance',
        starRating: 5,
        reviewText: SUBSTANCE_BODY,
      });
      const four = makeReview({ reviewerName: 'four', starRating: 4 });
      const threeA = makeReview({ reviewerName: 'threeA', starRating: 3 });
      const threeB = makeReview({ reviewerName: 'threeB', starRating: 3 });

      const result = selectQualifyingReviews(
        [fiveSubstance, four, threeA, threeB],
        { rule: 'positive-with-moderate-tail' },
      );

      expect(result).toHaveLength(3);
      expect(result[result.length - 1]).toBe(threeA); // ONE three-star, at the end
      expect(result.filter((r) => r.starRating === 3)).toHaveLength(1);
    });

    it('returns [] when there are zero >=4 reviews (only 3-stars)', () => {
      const threeA = makeReview({ reviewerName: 'threeA', starRating: 3 });
      const threeB = makeReview({ reviewerName: 'threeB', starRating: 3 });
      const threeC = makeReview({ reviewerName: 'threeC', starRating: 3 });

      const result = selectQualifyingReviews([threeA, threeB, threeC], {
        rule: 'positive-with-moderate-tail',
      });

      expect(result).toEqual([]);
    });

    it('returns [] when input has only 1- and 2-star reviews', () => {
      const oneStar = makeReview({ reviewerName: 'one', starRating: 1 });
      const twoStar = makeReview({ reviewerName: 'two', starRating: 2 });

      const result = selectQualifyingReviews([oneStar, twoStar], {
        rule: 'positive-with-moderate-tail',
      });

      expect(result).toEqual([]);
    });

    it('treats a short-body 5-star as a >=4 anchor (substance is preference, not a gate)', () => {
      const fiveShort = makeReview({
        reviewerName: 'fiveShort',
        starRating: 5,
        reviewText: 'Great',
      });
      const three = makeReview({ reviewerName: 'three', starRating: 3 });

      const result = selectQualifyingReviews([fiveShort, three], {
        rule: 'positive-with-moderate-tail',
      });

      expect(result).not.toEqual([]);
      expect(result).toContain(fiveShort);
      expect(result[result.length - 1]).toBe(three);
    });

    it('never returns more than 3 reviews even with abundant input', () => {
      const reviews: NormalizedReview[] = [
        makeReview({
          reviewerName: 'fiveSubstance',
          starRating: 5,
          reviewText: SUBSTANCE_BODY,
        }),
        makeReview({ reviewerName: 'four1', starRating: 4 }),
        makeReview({ reviewerName: 'four2', starRating: 4 }),
        makeReview({ reviewerName: 'four3', starRating: 4 }),
        makeReview({ reviewerName: 'five2', starRating: 5 }),
        makeReview({ reviewerName: 'three1', starRating: 3 }),
        makeReview({ reviewerName: 'three2', starRating: 3 }),
      ];

      const result = selectQualifyingReviews(reviews, {
        rule: 'positive-with-moderate-tail',
      });

      expect(result).toHaveLength(3);
    });

    it('deduplicates — the same review object never appears twice in the result', () => {
      // A 5-star with substance is also the only "any 5-star" — make sure the
      // substance-anchor path and the fallback five-star fill don't double-add it.
      const fiveSubstance = makeReview({
        reviewerName: 'fiveSubstance',
        starRating: 5,
        reviewText: SUBSTANCE_BODY,
      });
      const three = makeReview({ reviewerName: 'three', starRating: 3 });

      const result = selectQualifyingReviews([fiveSubstance, three], {
        rule: 'positive-with-moderate-tail',
      });

      const occurrences = result.filter((r) => r === fiveSubstance).length;
      expect(occurrences).toBe(1);
    });

    it('uses 4-stars to fill remaining slots after a substance anchor (recent-first by input order)', () => {
      const fiveSubstance = makeReview({
        reviewerName: 'fiveSubstance',
        starRating: 5,
        reviewText: SUBSTANCE_BODY,
      });
      const four1 = makeReview({ reviewerName: 'four1', starRating: 4 });
      const four2 = makeReview({ reviewerName: 'four2', starRating: 4 });
      const four3 = makeReview({ reviewerName: 'four3', starRating: 4 });

      const result = selectQualifyingReviews(
        [fiveSubstance, four1, four2, four3],
        { rule: 'positive-with-moderate-tail' },
      );

      expect(result).toEqual([fiveSubstance, four1, four2]);
    });

    it('falls back to any 5-star anchor when none has substance, and no 4-stars exist', () => {
      const fiveShort1 = makeReview({
        reviewerName: 'fiveShort1',
        starRating: 5,
        reviewText: 'Great',
      });
      const fiveShort2 = makeReview({
        reviewerName: 'fiveShort2',
        starRating: 5,
        reviewText: null,
      });
      const three = makeReview({ reviewerName: 'three', starRating: 3 });

      const result = selectQualifyingReviews(
        [fiveShort1, fiveShort2, three],
        { rule: 'positive-with-moderate-tail' },
      );

      expect(result).toHaveLength(3);
      expect(result.filter((r) => r.starRating === 5)).toHaveLength(2);
      expect(result[result.length - 1]).toBe(three);
    });

    it('omits the 3-star tail when the portfolio is already full with >=4 reviews', () => {
      const fiveSubstance = makeReview({
        reviewerName: 'fiveSubstance',
        starRating: 5,
        reviewText: SUBSTANCE_BODY,
      });
      const four1 = makeReview({ reviewerName: 'four1', starRating: 4 });
      const four2 = makeReview({ reviewerName: 'four2', starRating: 4 });
      const three = makeReview({ reviewerName: 'three', starRating: 3 });

      const result = selectQualifyingReviews(
        [fiveSubstance, four1, four2, three],
        { rule: 'positive-with-moderate-tail' },
      );

      expect(result).toHaveLength(3);
      expect(result.some((r) => r.starRating === 3)).toBe(false);
    });
  });
});
