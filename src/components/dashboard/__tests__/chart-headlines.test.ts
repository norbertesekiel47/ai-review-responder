import { describe, expect, it } from 'vitest';
import {
  computeTrendHeadline,
  computeVelocityHeadline,
  computeRankingHeadline,
} from '@/components/dashboard/kpi/chart-headlines';
import type { ReputationSummary } from '@/lib/dashboard/types';

const trendWith = (stars: Array<number | null>): ReputationSummary['trend'] =>
  stars.map((starEquivalent, i) => ({
    weekStart: `2026-04-${String(i + 1).padStart(2, '0')}`,
    starEquivalent,
    reviewCount: starEquivalent == null ? 0 : 4,
  }));

const velocityWith = (counts: number[]) =>
  counts.map((count, i) => ({ weekStart: `2026-04-${String(i + 1).padStart(2, '0')}`, count }));

describe('computeTrendHeadline', () => {
  it('returns null when there is no data', () => {
    expect(computeTrendHeadline(trendWith([null, null]))).toBeNull();
  });

  it('reports a rising rating from first to last non-null week', () => {
    const result = computeTrendHeadline(trendWith([4.3, 4.4, null, 4.6, 4.8]));
    expect(result).toMatchObject({ direction: 'up' });
    expect(result?.headline).toContain('up 0.5★');
    expect(result?.detail).toBe('Now averaging 4.8 stars (was 4.3).');
  });

  it('reports a slipping rating', () => {
    const result = computeTrendHeadline(trendWith([4.8, 4.5, 4.2]));
    expect(result).toMatchObject({ direction: 'down' });
    expect(result?.headline).toContain('down 0.6★');
  });

  it('reads a sub-epsilon move as holding steady', () => {
    const result = computeTrendHeadline(trendWith([4.5, 4.51]));
    expect(result).toMatchObject({ direction: 'flat' });
    expect(result?.headline).toMatch(/holding steady/i);
  });

  it('states the current value when only one week has data', () => {
    const result = computeTrendHeadline(trendWith([null, 4.5]));
    expect(result).toMatchObject({ direction: 'flat' });
    expect(result?.headline).toContain('4.5★');
  });
});

describe('computeVelocityHeadline', () => {
  it('returns null for an empty series', () => {
    expect(computeVelocityHeadline([])).toBeNull();
  });

  it('reports a week-over-week increase as a percentage', () => {
    const result = computeVelocityHeadline(velocityWith([2, 5]));
    expect(result).toMatchObject({ direction: 'up' });
    expect(result?.headline).toBe('Up 150% in new reviews this week');
    expect(result?.detail).toBe('5 this week vs 2 last week.');
  });

  it('reports a decrease', () => {
    const result = computeVelocityHeadline(velocityWith([8, 4]));
    expect(result).toMatchObject({ direction: 'down' });
    expect(result?.headline).toBe('Down 50% in new reviews this week');
  });

  it('states the absolute count when the prior week was zero (no % possible)', () => {
    const result = computeVelocityHeadline(velocityWith([0, 3]));
    expect(result?.headline).toBe('3 new reviews this week');
  });

  it('reports steady volume', () => {
    const result = computeVelocityHeadline(velocityWith([5, 5]));
    expect(result).toMatchObject({ direction: 'flat' });
    expect(result?.headline).toMatch(/steady at 5 reviews/i);
  });
});

describe('computeRankingHeadline', () => {
  it('returns null when there is no ranking', () => {
    expect(computeRankingHeadline(null)).toBeNull();
    expect(computeRankingHeadline([])).toBeNull();
  });

  it('reports spots gained for the primary keyword', () => {
    const result = computeRankingHeadline([
      {
        keyword: 'cafe near me',
        snapshots: [
          { date: '2026-05-01', position: 5 },
          { date: '2026-06-01', position: 3 },
        ],
      },
    ]);
    expect(result).toMatchObject({ direction: 'up' });
    expect(result?.headline).toBe('Up 2 spots this month');
    expect(result?.detail).toBe('You\'re #3 for "cafe near me".');
  });

  it('reports spots lost', () => {
    const result = computeRankingHeadline([
      {
        keyword: 'cafe near me',
        snapshots: [
          { date: '2026-05-01', position: 2 },
          { date: '2026-06-01', position: 4 },
        ],
      },
    ]);
    expect(result).toMatchObject({ direction: 'down' });
    expect(result?.headline).toBe('Down 2 spots this month');
  });

  it('reports holding position when unchanged', () => {
    const result = computeRankingHeadline([
      {
        keyword: 'cafe near me',
        snapshots: [
          { date: '2026-05-01', position: 3 },
          { date: '2026-06-01', position: 3 },
        ],
      },
    ]);
    expect(result).toMatchObject({ direction: 'flat' });
    expect(result?.headline).toContain('#3');
  });

  it('falls back to current position with only one snapshot', () => {
    const result = computeRankingHeadline([
      { keyword: 'cafe near me', snapshots: [{ date: '2026-06-01', position: 3 }] },
    ]);
    expect(result?.headline).toBe('You\'re #3 for "cafe near me"');
  });
});
