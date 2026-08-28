import { describe, expect, it } from 'vitest';
import {
  computeRepPulse,
  repPulseBand,
  repPulseNote,
  repPulseScore,
} from '@/lib/dashboard/rep-pulse';
import type { ReputationSummary } from '@/lib/dashboard/types';

function summary(overrides: Partial<ReputationSummary> = {}): ReputationSummary {
  return {
    averageStar: { current: 4.6, delta: 0.2, priorSampleSize: 12 },
    responseRate: { current: 92, delta: 6, priorSampleSize: 12 },
    timeSavedMinutes: { current: 840, delta: 180, priorSampleSize: 12 },
    pendingApprovalCount: 0,
    trend: [],
    isRamping: false,
    ...overrides,
  };
}

describe('repPulseScore', () => {
  it('blends rating (70) and response rate (30)', () => {
    // 4.6/5 = 0.92 → 64.4; 92/100 = 0.92 → 27.6; total 92.
    expect(repPulseScore(4.6, 92)).toBe(92);
  });

  it('is rating-only when the response rate is unknown', () => {
    expect(repPulseScore(4.0, null)).toBe(80);
  });

  it('returns null without a rating — a score is never invented', () => {
    expect(repPulseScore(null, 92)).toBeNull();
  });

  it('clamps out-of-range inputs into [0, 100]', () => {
    expect(repPulseScore(9, 250)).toBe(100);
    expect(repPulseScore(0, 0)).toBe(0);
  });
});

describe('repPulseBand', () => {
  it('maps the four bands at their documented thresholds', () => {
    expect(repPulseBand(85)).toBe('strong');
    expect(repPulseBand(84)).toBe('solid');
    expect(repPulseBand(70)).toBe('solid');
    expect(repPulseBand(69)).toBe('building');
    expect(repPulseBand(50)).toBe('building');
    expect(repPulseBand(49)).toBe('low');
  });
});

describe('computeRepPulse', () => {
  it('returns the score, band, and prior-window delta', () => {
    const pulse = computeRepPulse(summary());
    expect(pulse).not.toBeNull();
    expect(pulse!.score).toBe(92);
    expect(pulse!.band).toBe('strong');
    // Prior window: star 4.4, response 86 → round(61.6 + 25.8) = 87 → delta +5.
    expect(pulse!.delta).toBe(5);
  });

  it('returns null while ramping', () => {
    expect(computeRepPulse(summary({ isRamping: true }))).toBeNull();
  });

  it('returns null when the window has no average rating', () => {
    expect(
      computeRepPulse(summary({ averageStar: { current: null, delta: null, priorSampleSize: 0 } })),
    ).toBeNull();
  });

  it('omits the delta when there is no prior sample', () => {
    const pulse = computeRepPulse(
      summary({
        averageStar: { current: 4.6, delta: null, priorSampleSize: 0 },
        responseRate: { current: 92, delta: null, priorSampleSize: 0 },
      }),
    );
    expect(pulse!.delta).toBeNull();
  });
});

describe('repPulseNote', () => {
  it('states each movement direction deterministically', () => {
    expect(repPulseNote({ score: 90, band: 'strong', bandLabel: 'Strong', delta: 4 }))
      .toBe('Up 4 points vs the prior 30 days.');
    expect(repPulseNote({ score: 90, band: 'strong', bandLabel: 'Strong', delta: -1 }))
      .toBe('Down 1 point vs the prior 30 days.');
    expect(repPulseNote({ score: 90, band: 'strong', bandLabel: 'Strong', delta: 0 }))
      .toBe('Holding steady vs the prior 30 days.');
    expect(repPulseNote({ score: 90, band: 'strong', bandLabel: 'Strong', delta: null }))
      .toBe('Your first scored month. The baseline builds from here.');
  });
});
