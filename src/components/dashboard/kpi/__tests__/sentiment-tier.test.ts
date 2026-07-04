import { describe, it, expect } from 'vitest';
import { tierForStars, TIER_BY_SENTIMENT } from '../sentiment-tier';

describe('sentiment tier derives from the ONE domain rule', () => {
  it('matches the previous inline thresholds exactly', () => {
    expect(tierForStars(5)).toBe('good');
    expect(tierForStars(4)).toBe('good');
    expect(tierForStars(3)).toBe('mid');
    expect(tierForStars(2)).toBe('low');
    expect(tierForStars(1)).toBe('low');
  });
  it('covers every sentiment label', () => {
    expect(Object.keys(TIER_BY_SENTIMENT).sort()).toEqual(['negative', 'neutral', 'positive']);
  });
});
