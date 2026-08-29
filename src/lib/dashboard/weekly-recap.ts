import type { ReputationSummary } from '@/lib/dashboard/types';

/**
 * "Your week" — the glance dashboard's weekly recap.
 *
 * Every string here is derived deterministically from the SAME weekly series
 * the reputation trend plots (`ReputationSummary['trend']`), so the card and the
 * Analytics chart can never disagree about a week. Nothing is projected,
 * averaged into an adjective, or compared against a baseline the ramping rule
 * withholds — the headline states a count, and the "why" line states an
 * observation about the plotted weeks.
 *
 * `trend` is the only series used on purpose. `reviewVelocity` carries the same
 * per-week counts from a second query; reading both would put two numbers for
 * one fact on one screen, with nothing keeping them equal.
 *
 * The covered week is the LAST bucket, which `generate_series` always fills up
 * to now — so it is the current, partial week. The card says "so far" rather
 * than implying a closed week.
 */

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

export interface RecapWeek {
  weekStart: string;
  reviewCount: number;
  /** True for the last bucket — the week still running. */
  isCurrent: boolean;
}

export interface WeeklyRecap {
  /** "24–30 Aug", or "28 Sep – 4 Oct" when the week straddles a month. */
  rangeLabel: string;
  newReviews: number;
  /**
   * Reviews across the whole plotted run — the second stat.
   *
   * Deliberately a COUNT and not the week's star-equivalent. The hero sitting
   * directly above already shows an "Average rating" figure, and a
   * sentiment-derived star-equivalent renders as the same number in the same
   * place meaning something else. Two 5.0s on one screen with two meanings is
   * the precise failure a glance surface cannot afford. The star-equivalent
   * still drives the Analytics trend, where it is labelled and alone.
   */
  runTotal: number;
  /** The whole plotted run, oldest first — the sparkline's data. */
  series: RecapWeek[];
  /** The conclusion, stated before the numbers. */
  headline: string;
  /** The in-place answer to "why does this week look like that?" — null when
   *  the series supports no honest observation. */
  why: string | null;
}

/**
 * Format a `YYYY-MM-DD` week start as its inclusive 7-day range.
 * Parsed field-by-field and stepped in UTC, so no local timezone can shift the
 * day and no locale can reorder the output — the label is byte-identical on the
 * server and in the browser.
 */
export function formatWeekRange(weekStart: string): string {
  const [year, month, day] = weekStart.split('-').map(Number);
  if (!year || !month || !day) return weekStart;
  const start = new Date(Date.UTC(year, month - 1, day));
  const end = new Date(Date.UTC(year, month - 1, day + 6));

  const startMonth = MONTHS[start.getUTCMonth()];
  const endMonth = MONTHS[end.getUTCMonth()];
  if (startMonth === endMonth) {
    return `${start.getUTCDate()}–${end.getUTCDate()} ${endMonth}`;
  }
  return `${start.getUTCDate()} ${startMonth} – ${end.getUTCDate()} ${endMonth}`;
}

/** Just the "week of" phrase, for the why line. */
export function formatWeekOf(weekStart: string): string {
  const [year, month, day] = weekStart.split('-').map(Number);
  if (!year || !month || !day) return weekStart;
  const date = new Date(Date.UTC(year, month - 1, day));
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
}

function headlineFor(count: number): string {
  if (count === 0) return 'No new reviews yet this week.';
  if (count === 1) return 'One new review this week.';
  return `${count} new reviews this week.`;
}

/**
 * The "why" line, by a fixed priority ladder. Each arm is an observation about
 * weeks that are visible in the sparkline directly beneath it, so the owner can
 * check the sentence against the picture.
 */
function whyFor(series: RecapWeek[]): string | null {
  const current = series[series.length - 1];
  if (!current) return null;
  const earlier = series.slice(0, -1);

  // 1. Nothing this week: name when the last one actually arrived.
  if (current.reviewCount === 0) {
    const last = [...earlier].reverse().find((week) => week.reviewCount > 0);
    return last ? `Your last review arrived the week of ${formatWeekOf(last.weekStart)}.` : null;
  }

  // 2. Something this week after a gap: name the length of the gap.
  let quiet = 0;
  for (let i = earlier.length - 1; i >= 0 && earlier[i]!.reviewCount === 0; i -= 1) quiet += 1;
  if (quiet >= 2) {
    return `The ${quiet} weeks before this one were quiet.`;
  }
  if (quiet === 1) {
    return 'Last week was quiet.';
  }

  // 3. Otherwise, place this week against the busiest one in the run.
  const busiest = earlier.reduce<RecapWeek | null>(
    (best, week) => (best === null || week.reviewCount > best.reviewCount ? week : best),
    null,
  );
  if (busiest && busiest.reviewCount > current.reviewCount) {
    return `Your busiest week here was ${formatWeekOf(busiest.weekStart)}, with ${busiest.reviewCount}.`;
  }
  return null;
}

/**
 * Build the recap, or null when there is no series to recap at all — the hero
 * already carries the "still building" message, and a second empty card beside
 * it would say the same thing twice.
 *
 * A series that EXISTS but holds no reviews is a different case: that renders,
 * as designed content, because "a quiet eight weeks" is a real answer.
 */
export function computeWeeklyRecap(trend: ReputationSummary['trend']): WeeklyRecap | null {
  if (trend.length === 0) return null;

  const series: RecapWeek[] = trend.map((week, index) => ({
    weekStart: week.weekStart,
    reviewCount: week.reviewCount,
    isCurrent: index === trend.length - 1,
  }));

  const current = series[series.length - 1]!;
  const total = series.reduce((sum, week) => sum + week.reviewCount, 0);

  if (total === 0) {
    return {
      rangeLabel: formatWeekRange(current.weekStart),
      newReviews: 0,
      runTotal: 0,
      series,
      headline: `No reviews in the last ${series.length} weeks.`,
      why: 'New reviews appear here as they arrive.',
    };
  }

  return {
    rangeLabel: formatWeekRange(current.weekStart),
    newReviews: current.reviewCount,
    runTotal: total,
    series,
    headline: headlineFor(current.reviewCount),
    why: whyFor(series),
  };
}
