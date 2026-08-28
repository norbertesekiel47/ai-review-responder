import type { ReputationSummary } from '@/lib/dashboard/types';

/**
 * Rep Pulse — RepWorth's coined 0–100 reputation score (Harbor redesign).
 *
 * The formula is deliberately TRANSPARENT and derived only from numbers the
 * dashboard already shows the owner (no hidden model, no fabricated signal):
 *
 *   score = round( (averageStar / 5) · 70 + (responseRate / 100) · 30 )
 *
 * When the response rate is unknown the rating carries the whole score
 * (weights renormalize to rating-only) rather than punishing the owner with a
 * phantom 0. No average star in the window, or a ramping account, means NO
 * score — Rep Pulse never invents a number (Console rule: no fabricated
 * trends/metrics).
 *
 * The delta compares against the prior 30-day window, reconstructed from the
 * same windowed deltas the hero band shows.
 */

const REP_PULSE_RATING_WEIGHT = 70;
const REP_PULSE_RESPONSE_WEIGHT = 30;

export type RepPulseBand = 'strong' | 'solid' | 'building' | 'low';

export interface RepPulse {
  /** 0–100, rounded. */
  score: number;
  band: RepPulseBand;
  bandLabel: string;
  /** Score change vs the prior 30-day window; null when no prior sample. */
  delta: number | null;
}

const BAND_LABELS: Record<RepPulseBand, string> = {
  strong: 'Strong',
  solid: 'Solid',
  building: 'Building',
  low: 'Needs work',
};

export function repPulseBand(score: number): RepPulseBand {
  if (score >= 85) return 'strong';
  if (score >= 70) return 'solid';
  if (score >= 50) return 'building';
  return 'low';
}

/** The raw score for one window. Null without a rating. */
export function repPulseScore(
  averageStar: number | null,
  responseRate: number | null,
): number | null {
  if (averageStar == null) return null;
  const rating = clamp(averageStar, 0, 5) / 5;
  if (responseRate == null) {
    return Math.round(rating * 100);
  }
  const response = clamp(responseRate, 0, 100) / 100;
  return Math.round(
    rating * REP_PULSE_RATING_WEIGHT + response * REP_PULSE_RESPONSE_WEIGHT,
  );
}

/** The dashboard card's input: the same windowed summary the hero band shows. */
export function computeRepPulse(summary: ReputationSummary): RepPulse | null {
  if (summary.isRamping) return null;
  const { averageStar, responseRate } = summary;
  const score = repPulseScore(averageStar.current, responseRate.current);
  if (score == null) return null;

  // Prior-window score, rebuilt from the deltas. A missing rating delta means
  // no prior sample, so the score has no honest comparison to offer.
  let delta: number | null = null;
  if (averageStar.delta != null && averageStar.current != null) {
    const priorStar = averageStar.current - averageStar.delta;
    const priorResponse =
      responseRate.current != null && responseRate.delta != null
        ? responseRate.current - responseRate.delta
        : responseRate.current;
    const priorScore = repPulseScore(priorStar, priorResponse);
    if (priorScore != null) delta = score - priorScore;
  }

  const band = repPulseBand(score);
  return { score, band, bandLabel: BAND_LABELS[band], delta };
}

/** Deterministic one-line interpretation shown under the gauge. */
export function repPulseNote(pulse: RepPulse): string {
  if (pulse.delta == null) {
    return 'Your first scored month. The baseline builds from here.';
  }
  if (pulse.delta > 0) {
    return `Up ${pulse.delta} point${pulse.delta === 1 ? '' : 's'} vs the prior 30 days.`;
  }
  if (pulse.delta < 0) {
    const magnitude = Math.abs(pulse.delta);
    return `Down ${magnitude} point${magnitude === 1 ? '' : 's'} vs the prior 30 days.`;
  }
  return 'Holding steady vs the prior 30 days.';
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
