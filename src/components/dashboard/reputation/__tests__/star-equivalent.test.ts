import { describe, expect, it } from 'vitest';
import { sentimentToStarEquivalent } from '@/components/dashboard/reputation/star-equivalent';
import { classifySentiment } from '@/lib/reviews/sentiment';

describe('sentimentToStarEquivalent', () => {
  it('maps the −1..1 anchors to 1..5 stars', () => {
    expect(sentimentToStarEquivalent(1)).toBe(5);
    expect(sentimentToStarEquivalent(0)).toBe(3);
    expect(sentimentToStarEquivalent(-1)).toBe(1);
    expect(sentimentToStarEquivalent(0.5)).toBe(4);
    expect(sentimentToStarEquivalent(-0.5)).toBe(2);
  });

  it('clamps out-of-range scores into 1..5', () => {
    expect(sentimentToStarEquivalent(2)).toBe(5);
    expect(sentimentToStarEquivalent(-3)).toBe(1);
  });

  it('is the exact inverse of classifySentiment for every star value', () => {
    for (const star of [1, 2, 3, 4, 5]) {
      const { score } = classifySentiment(star);
      expect(sentimentToStarEquivalent(score)).toBe(star);
    }
  });
});
