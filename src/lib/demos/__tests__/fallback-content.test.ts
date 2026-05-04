import { describe, it, expect } from 'vitest';
import { getFallbackDemo } from '../fallback-content';

describe('getFallbackDemo', () => {
  it('returns demo for known category prefix', () => {
    const demo = getFallbackDemo('Italian Restaurant');
    expect(demo.reviews).toHaveLength(3);
    expect(demo.responses).toHaveLength(3);
  });

  it('returns general-business for unknown category', () => {
    const demo = getFallbackDemo('Quantum Physics Lab');
    expect(demo.reviews).toHaveLength(3);
  });

  it('returns general-business for null category', () => {
    const demo = getFallbackDemo(null);
    expect(demo.reviews).toHaveLength(3);
  });

  it('review shapes are valid NormalizedReview', () => {
    const demo = getFallbackDemo('cafe');
    for (const r of demo.reviews) {
      expect(r).toHaveProperty('reviewerName');
      expect(r).toHaveProperty('starRating');
      expect(r).toHaveProperty('reviewText');
      expect(r).toHaveProperty('reviewDate');
      expect(r).toHaveProperty('detectedLanguage');
    }
  });
});
