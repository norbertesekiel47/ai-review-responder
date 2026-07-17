import fc from 'fast-check';
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

// Property tests (fast-check): the house style for invariant-level coverage —
// /feature requires at least one per declared invariant on billing/approval/
// escalation logic (feature.md step 5).
describe('classifySentiment invariants', () => {
  const anyRating = fc.option(fc.double({ noNaN: true }), { nil: null });

  it('is deterministic and always tagged with the v1 source', () => {
    fc.assert(
      fc.property(anyRating, (stars) => {
        const first = classifySentiment(stars);
        expect(classifySentiment(stars)).toEqual(first);
        expect(first.source).toBe(SENTIMENT_SOURCE);
      }),
    );
  });

  it('score stays in [-1, 1] and agrees with the label band', () => {
    fc.assert(
      fc.property(anyRating, (stars) => {
        const { score, label } = classifySentiment(stars);
        expect(score).toBeGreaterThanOrEqual(-1);
        expect(score).toBeLessThanOrEqual(1);
        if (label === 'positive') {
          expect(score).toBeGreaterThanOrEqual(0.5);
        } else if (label === 'negative') {
          expect(score).toBeLessThanOrEqual(-0.5);
        } else {
          expect(Math.abs(score)).toBeLessThan(0.5);
        }
      }),
    );
  });

  it('clamps: any rating ≥ 5 classifies like 5, any ≤ 1 like 1', () => {
    fc.assert(
      fc.property(fc.double({ min: 5, noNaN: true }), (stars) => {
        expect(classifySentiment(stars)).toEqual(classifySentiment(5));
      }),
    );
    fc.assert(
      fc.property(fc.double({ max: 1, noNaN: true }), (stars) => {
        expect(classifySentiment(stars)).toEqual(classifySentiment(1));
      }),
    );
  });
});
