// src/lib/dashboard/reputation-summary.ts
//
// Pure mapper from windowed reputation SQL rows -> ReputationSummary.
// Kept side-effect-free (no DB) so the delta math, units, sample-size
// suppression, star-equivalent mapping, and ramping rule are unit-testable
// without a database. The SQL that produces these rows lives in service.ts.
// See PLAN.md (PR2) sections A–C.

import type { ReputationMetric, ReputationSummary } from './types';
import { MINUTES_SAVED_PER_RESPONSE } from './constants';

/**
 * Below this location age (days), 30-day deltas aren't trustworthy and the
 * hero renders compact (current values, no delta arrows). PLAN.md leaves the
 * exact threshold open; 21 days (~3 weeks) is the working value.
 */
export const RAMPING_AGE_DAYS = 21;

export interface RateWindowRow {
  received_current: number;
  handled_current: number;
  received_prior: number;
  handled_prior: number;
}

export interface StarWindowRow {
  star_current: number | null;
  star_n_current: number;
  star_prior: number | null;
  star_n_prior: number;
}

export interface TimeSavedWindowRow {
  handled_current: number;
  handled_prior: number;
}

export interface SentimentTrendRow {
  week_start: unknown;
  avg_score: unknown;
  cnt: unknown;
}

function round(value: number | null, decimals: number): number | null {
  if (value == null || Number.isNaN(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * Build a metric, suppressing the delta when the prior window had no sample.
 * `current` and `prior` are in the same unit; `delta = current − prior`.
 */
function buildMetric(
  current: number | null,
  prior: number | null,
  priorSampleSize: number,
  decimals: number,
): ReputationMetric {
  const roundedCurrent = round(current, decimals);
  const roundedPrior = round(prior, decimals);
  // Delta compares the *displayed* (rounded) values so the arrow always
  // matches what the owner sees (e.g. 94% − 88% = +6, not +6.5 → +7).
  const delta =
    priorSampleSize > 0 && roundedCurrent != null && roundedPrior != null
      ? round(roundedCurrent - roundedPrior, decimals)
      : null;
  return { current: roundedCurrent, delta, priorSampleSize };
}

/** Inverse of classifySentiment's deterministic_star_v1: −1..1 score -> 1..5 stars. */
function starEquivalent(avgScore: number | null): number | null {
  if (avgScore == null || Number.isNaN(avgScore)) return null;
  return round(Math.min(5, Math.max(1, 3 + 2 * avgScore)), 2);
}

export function buildReputationSummary(input: {
  rate: RateWindowRow;
  star: StarWindowRow;
  timeSaved: TimeSavedWindowRow;
  trend: SentimentTrendRow[];
  pendingApprovalCount: number;
  /** Location age in whole days; drives the ramping rule. */
  accountAgeDays: number;
}): ReputationSummary {
  const { rate, star, timeSaved, trend, pendingApprovalCount, accountAgeDays } = input;

  const responseRateCurrent =
    rate.received_current > 0
      ? (rate.handled_current / rate.received_current) * 100
      : null;
  const responseRatePrior =
    rate.received_prior > 0 ? (rate.handled_prior / rate.received_prior) * 100 : null;

  const timeSavedCurrent = timeSaved.handled_current * MINUTES_SAVED_PER_RESPONSE;
  const timeSavedPrior = timeSaved.handled_prior * MINUTES_SAVED_PER_RESPONSE;

  return {
    averageStar: buildMetric(star.star_current, star.star_prior, star.star_n_prior, 2),
    responseRate: buildMetric(responseRateCurrent, responseRatePrior, rate.received_prior, 0),
    timeSavedMinutes: buildMetric(timeSavedCurrent, timeSavedPrior, timeSaved.handled_prior, 0),
    pendingApprovalCount,
    trend: trend.map((row) => ({
      weekStart: String(row.week_start),
      starEquivalent: starEquivalent(row.avg_score == null ? null : Number(row.avg_score)),
      reviewCount: Number(row.cnt ?? 0),
    })),
    isRamping: accountAgeDays < RAMPING_AGE_DAYS,
  };
}
