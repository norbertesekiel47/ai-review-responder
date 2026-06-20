import type { ReputationSummary, DashboardDataActive } from '@/lib/dashboard/types';
import type { RankingSourceSeries } from '@/components/dashboard/kpi/RankingChart.helpers';

/**
 * Deterministic plain-English chart headlines computed purely from data already
 * on the /api/dashboard payload (deltas + current value). These are templates,
 * NOT LLM output — the holistic intelligence brief is the only LLM surface
 * (design spec 2026-06-19). Each chart on the Analytics page leads with one of
 * these so the owner never has to decode the chart to learn the takeaway.
 */

export type ChartHeadlineDirection = 'up' | 'down' | 'flat';

export interface ChartHeadline {
  direction: ChartHeadlineDirection;
  /** The takeaway, e.g. "Up 2 spots this month". */
  headline: string;
  /** One supporting sentence, e.g. 'You\'re #3 for "cafe near me".' */
  detail: string;
}

/** A rating delta under this threshold reads as "holding steady". */
const FLAT_STAR_EPSILON = 0.05;

/** Star-equivalent reputation trend → climbing / slipping / steady. */
export function computeTrendHeadline(trend: ReputationSummary['trend']): ChartHeadline | null {
  const stars = trend
    .map((week) => week.starEquivalent)
    .filter((star): star is number => star != null);

  if (stars.length === 0) return null;

  const last = stars[stars.length - 1]!;
  if (stars.length < 2) {
    return {
      direction: 'flat',
      headline: `Averaging ${last.toFixed(1)}★`,
      detail: 'Not enough history yet to show a trend.',
    };
  }

  const first = stars[0]!;
  const delta = last - first;
  const magnitude = Math.abs(delta);

  if (magnitude < FLAT_STAR_EPSILON) {
    return {
      direction: 'flat',
      headline: `Rating holding steady at ${last.toFixed(1)}★`,
      detail: 'Your star-equivalent rating has barely moved across the window.',
    };
  }

  const direction: ChartHeadlineDirection = delta > 0 ? 'up' : 'down';
  const verb = delta > 0 ? 'climbing' : 'slipping';
  return {
    direction,
    headline: `Rating ${verb} — ${delta > 0 ? 'up' : 'down'} ${magnitude.toFixed(1)}★`,
    detail: `Now averaging ${last.toFixed(1)} stars (was ${first.toFixed(1)}).`,
  };
}

/** Weekly review volume → up/down % this week vs last, with totals as support. */
export function computeVelocityHeadline(
  velocity: DashboardDataActive['reviewVelocity'],
): ChartHeadline | null {
  if (velocity.length === 0) return null;

  const counts = velocity.map((week) => week.count);
  const total = counts.reduce((sum, count) => sum + count, 0);
  const weeks = counts.length;
  const thisWeek = counts[weeks - 1] ?? 0;
  const prevWeek = counts[weeks - 2] ?? 0;
  const totalDetail = `${total} review${total === 1 ? '' : 's'} over the last ${weeks} weeks.`;

  // No comparable prior week (single week, or last week had zero reviews → a
  // percentage would divide by zero). State the absolute count instead.
  if (weeks < 2 || prevWeek === 0) {
    if (thisWeek === 0) {
      return { direction: 'flat', headline: 'No new reviews this week', detail: totalDetail };
    }
    return {
      direction: 'up',
      headline: `${thisWeek} new review${thisWeek === 1 ? '' : 's'} this week`,
      detail: totalDetail,
    };
  }

  const delta = thisWeek - prevWeek;
  if (delta === 0) {
    return {
      direction: 'flat',
      headline: `Steady at ${thisWeek} review${thisWeek === 1 ? '' : 's'} this week`,
      detail: totalDetail,
    };
  }

  const pct = Math.round((delta / prevWeek) * 100);
  const direction: ChartHeadlineDirection = delta > 0 ? 'up' : 'down';
  return {
    direction,
    headline: `${delta > 0 ? 'Up' : 'Down'} ${Math.abs(pct)}% in new reviews this week`,
    detail: `${thisWeek} this week vs ${prevWeek} last week.`,
  };
}

/** Local-pack ranking → "Up/down N spots this month" for the primary keyword. */
export function computeRankingHeadline(
  ranking: RankingSourceSeries[] | null,
): ChartHeadline | null {
  if (!ranking || ranking.length === 0) return null;

  const primary = ranking[0]!;
  const snapshots = [...primary.snapshots].sort((a, b) => a.date.localeCompare(b.date));
  if (snapshots.length === 0) return null;

  const last = snapshots[snapshots.length - 1]!;
  const keyword = primary.keyword;
  if (snapshots.length < 2) {
    return {
      direction: 'flat',
      headline: `You're #${last.position} for "${keyword}"`,
      detail: 'Not enough history yet to show movement.',
    };
  }

  // Lower position number = better rank, so a drop in position is an improvement.
  const improvement = snapshots[0]!.position - last.position;
  const spots = Math.abs(improvement);
  if (improvement === 0) {
    return {
      direction: 'flat',
      headline: `Holding at #${last.position} for "${keyword}"`,
      detail: 'No change in local-pack position this month.',
    };
  }

  const direction: ChartHeadlineDirection = improvement > 0 ? 'up' : 'down';
  return {
    direction,
    headline: `${improvement > 0 ? 'Up' : 'Down'} ${spots} spot${spots === 1 ? '' : 's'} this month`,
    detail: `You're #${last.position} for "${keyword}".`,
  };
}
