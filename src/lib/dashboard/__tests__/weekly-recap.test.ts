import { describe, expect, it } from 'vitest';
import {
  computeWeeklyRecap,
  formatWeekOf,
  formatWeekRange,
} from '@/lib/dashboard/weekly-recap';
import type { ReputationSummary } from '@/lib/dashboard/types';

type TrendPoint = ReputationSummary['trend'][number];

/**
 * Weekly buckets, oldest first, from Monday 6 July 2026 — the shape
 * generate_series produces. Stepped through Date.UTC rather than by adding to
 * the day number, which would emit "2026-07-34" past the fourth week.
 */
function series(counts: Array<[count: number, star: number | null]>): TrendPoint[] {
  return counts.map(([count, star], index) => {
    const monday = new Date(Date.UTC(2026, 6, 6 + index * 7));
    return {
      weekStart: monday.toISOString().slice(0, 10),
      reviewCount: count,
      starEquivalent: star,
    };
  });
}

describe('formatWeekRange', () => {
  it('renders a within-month week as one month name', () => {
    expect(formatWeekRange('2026-08-24')).toBe('24–30 Aug');
  });

  it('names both months when the week straddles them', () => {
    expect(formatWeekRange('2026-09-28')).toBe('28 Sep – 4 Oct');
  });

  it('steps in UTC, so no local timezone can shift the day', () => {
    // A date that is the previous day in every timezone west of UTC.
    expect(formatWeekRange('2026-01-01')).toBe('1–7 Jan');
    expect(formatWeekOf('2026-01-01')).toBe('1 Jan');
  });

  it('crosses a year boundary without inventing a month', () => {
    expect(formatWeekRange('2026-12-28')).toBe('28 Dec – 3 Jan');
  });

  it('returns the input unchanged when it is not a date', () => {
    expect(formatWeekRange('not-a-date')).toBe('not-a-date');
  });
});

describe('computeWeeklyRecap', () => {
  it('returns null with no series — the hero already carries that message', () => {
    expect(computeWeeklyRecap([])).toBeNull();
  });

  it('covers the LAST bucket, which is the week still running', () => {
    const recap = computeWeeklyRecap(series([[0, null], [2, 2.5], [1, 5]]))!;

    expect(recap.newReviews).toBe(1);
    expect(recap.runTotal).toBe(3);
    expect(recap.series[recap.series.length - 1]!.isCurrent).toBe(true);
    expect(recap.series[0]!.isCurrent).toBe(false);
  });

  it('states the count as the headline, without an adjective', () => {
    expect(computeWeeklyRecap(series([[3, 4]]))!.headline).toBe('3 new reviews this week.');
    expect(computeWeeklyRecap(series([[1, 5]]))!.headline).toBe('One new review this week.');
    expect(computeWeeklyRecap(series([[2, 4], [0, null]]))!.headline).toBe(
      'No new reviews yet this week.',
    );
  });

  it('designs the all-quiet run as content, not as an absence', () => {
    const recap = computeWeeklyRecap(series([[0, null], [0, null], [0, null]]))!;

    expect(recap.headline).toBe('No reviews in the last 3 weeks.');
    expect(recap.why).toBe('New reviews appear here as they arrive.');
    expect(recap.runTotal).toBe(0);
  });

  describe('the "why" line', () => {
    it('names when the last review actually arrived, on an empty week', () => {
      const recap = computeWeeklyRecap(series([[2, 4], [0, null], [0, null]]))!;

      expect(recap.why).toBe('Your last review arrived the week of 6 Jul.');
    });

    it('measures the gap when reviews return after quiet weeks', () => {
      const recap = computeWeeklyRecap(
        series([[2, 4], [0, null], [0, null], [0, null], [1, 5]]),
      )!;

      expect(recap.why).toBe('The 3 weeks before this one were quiet.');
    });

    it('says so in the singular after exactly one quiet week', () => {
      const recap = computeWeeklyRecap(series([[2, 4], [0, null], [1, 5]]))!;

      expect(recap.why).toBe('Last week was quiet.');
    });

    it('places a busy run against its own peak', () => {
      const recap = computeWeeklyRecap(series([[5, 4], [3, 4], [1, 5]]))!;

      expect(recap.why).toBe('Your busiest week here was 6 Jul, with 5.');
    });

    it('offers nothing rather than an empty observation when this week IS the peak', () => {
      const recap = computeWeeklyRecap(series([[1, 4], [2, 4], [4, 5]]))!;

      expect(recap.why).toBeNull();
    });
  });

  it('reproduces the live staging series', () => {
    // The real payload on 2026-08-28: seven reviews across eight weeks, with
    // three quiet weeks before the current one.
    const recap = computeWeeklyRecap(
      series([
        [0, null], [2, 2.5], [2, 5], [2, 5],
        [0, null], [0, null], [0, null], [1, 5],
      ]),
    )!;

    expect(recap.headline).toBe('One new review this week.');
    expect(recap.why).toBe('The 3 weeks before this one were quiet.');
    expect(recap.runTotal).toBe(7);
    expect(recap.series).toHaveLength(8);
  });
});
