import { describe, expect, it } from 'vitest';
import {
  classifySentiment,
  SENTIMENT_SOURCE,
  type SentimentClassification,
} from '../sentiment';

describe('classifySentiment', () => {
  it.each([
    [5, 'positive', 1],
    [4, 'positive', 0.5],
    [3, 'neutral', 0],
    [2, 'negative', -0.5],
    [1, 'negative', -1],
  ] as const)('star %i → %s (score %f)', (star, label, score) => {
    const result = classifySentiment(star);
    expect(result.label).toBe(label);
    expect(result.score).toBe(score);
    expect(result.source).toBe(SENTIMENT_SOURCE);
  });

  it('treats a null star rating as neutral with score 0', () => {
    const result = classifySentiment(null);
    expect(result).toEqual<SentimentClassification>({
      score: 0,
      label: 'neutral',
      source: SENTIMENT_SOURCE,
    });
  });

  it('clamps out-of-range ratings to the 1..5 band', () => {
    expect(classifySentiment(7).label).toBe('positive');
    expect(classifySentiment(0).label).toBe('negative');
  });

  it('uses the deterministic_star_v1 source tag', () => {
    expect(SENTIMENT_SOURCE).toBe('deterministic_star_v1');
  });
});
