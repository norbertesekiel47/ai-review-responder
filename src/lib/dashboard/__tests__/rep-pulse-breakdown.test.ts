import { describe, expect, it } from 'vitest';
import {
  computeRepPulse,
  repPulseBreakdown,
  REP_PULSE_WEIGHTS,
} from '@/lib/dashboard/rep-pulse';
import type { ReputationSummary } from '@/lib/dashboard/types';

function summary(overrides: {
  star?: number | null;
  starDelta?: number | null;
  rate?: number | null;
  rateDelta?: number | null;
  isRamping?: boolean;
}): ReputationSummary {
  return {
    averageStar: {
      // `??` would swallow an explicit null and silently score a 4.6 instead,
      // which is precisely the case this fixture has to be able to express.
      current: overrides.star === undefined ? 4.6 : overrides.star,
      delta: overrides.starDelta ?? null,
      priorSampleSize: 8,
    },
    responseRate: {
      current: overrides.rate === undefined ? 92 : overrides.rate,
      delta: overrides.rateDelta ?? null,
      priorSampleSize: 8,
    },
    timeSavedMinutes: { current: 60, delta: null, priorSampleSize: 8 },
    pendingApprovalCount: 0,
    trend: [],
    isRamping: overrides.isRamping ?? false,
  };
}

describe('repPulseBreakdown', () => {
  it('splits the score into rating and replies, at the published weights', () => {
    const parts = repPulseBreakdown(summary({ star: 4.6, rate: 92 }))!;

    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatchObject({
      label: 'Rating',
      valueLabel: '4.6 / 5',
      maxPoints: REP_PULSE_WEIGHTS.rating,
    });
    expect(parts[1]).toMatchObject({
      label: 'Replies',
      valueLabel: '92%',
      maxPoints: REP_PULSE_WEIGHTS.response,
    });
  });

  it('always sums to the score the card is showing', () => {
    // Independently rounding each part lets them miss the whole by a point.
    // Sweep the space rather than trusting one happy case.
    for (let star = 0; star <= 50; star += 1) {
      for (let rate = 0; rate <= 100; rate += 7) {
        const input = summary({ star: star / 10, rate });
        const pulse = computeRepPulse(input)!;
        const parts = repPulseBreakdown(input)!;
        const summed = parts.reduce((total, part) => total + part.points, 0);

        expect(summed, `star=${star / 10} rate=${rate}`).toBe(pulse.score);
      }
    }
  });

  it('never lets a part exceed its own maximum', () => {
    const parts = repPulseBreakdown(summary({ star: 5, rate: 100 }))!;

    for (const part of parts) {
      expect(part.points).toBeLessThanOrEqual(part.maxPoints);
      expect(part.points).toBeGreaterThanOrEqual(0);
    }
  });

  it('collapses to one contribution worth 100 when the reply rate is unknown', () => {
    // The weights renormalize rather than punishing the owner with a phantom 0,
    // so the breakdown must not claim a 30-point input that is not being scored.
    const input = summary({ star: 4, rate: null });
    const parts = repPulseBreakdown(input)!;

    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ label: 'Rating', maxPoints: 100 });
    expect(parts[0]!.points).toBe(computeRepPulse(input)!.score);
  });

  it('returns null in exactly the cases the score does', () => {
    expect(repPulseBreakdown(summary({ isRamping: true }))).toBeNull();
    expect(repPulseBreakdown(summary({ star: null }))).toBeNull();

    // …and is non-null whenever the score is.
    const scored = summary({ star: 3.2, rate: 40 });
    expect(computeRepPulse(scored)).not.toBeNull();
    expect(repPulseBreakdown(scored)).not.toBeNull();
  });

  it('rounds the reply rate for display without changing the arithmetic', () => {
    const input = summary({ star: 4, rate: 66.6 });
    const parts = repPulseBreakdown(input)!;

    expect(parts[1]!.valueLabel).toBe('67%');
    expect(parts.reduce((t, p) => t + p.points, 0)).toBe(computeRepPulse(input)!.score);
  });
});
