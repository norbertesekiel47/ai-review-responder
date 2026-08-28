import { describe, expect, it } from 'vitest';
import { computeHeroHeadline } from '@/components/dashboard/kpi/hero-headline';
import type { ReputationSummary } from '@/lib/dashboard/types';

function summary(overrides: Partial<ReputationSummary> = {}): ReputationSummary {
  return {
    averageStar: { current: 4.6, delta: 0, priorSampleSize: 12 },
    responseRate: { current: 92, delta: 6, priorSampleSize: 12 },
    timeSavedMinutes: { current: 840, delta: 180, priorSampleSize: 12 },
    pendingApprovalCount: 0,
    trend: [],
    isRamping: false,
    ...overrides,
  };
}

describe('computeHeroHeadline', () => {
  it('holds, climbs, and dips follow the rating delta', () => {
    expect(computeHeroHeadline(summary())).toBe(
      'Your rating held at 4.6 while 92% of reviews got an answer.',
    );
    expect(
      computeHeroHeadline(summary({ averageStar: { current: 4.8, delta: 0.2, priorSampleSize: 12 } })),
    ).toBe('Your rating climbed to 4.8 while 92% of reviews got an answer.');
    expect(
      computeHeroHeadline(summary({ averageStar: { current: 4.1, delta: -0.3, priorSampleSize: 12 } })),
    ).toBe('Your rating dipped to 4.1 while 92% of reviews got an answer.');
  });

  it('drops the response clause when the response rate is unknown', () => {
    expect(
      computeHeroHeadline(summary({ responseRate: { current: null, delta: null, priorSampleSize: 0 } })),
    ).toBe('Your rating held at 4.6 over the last 30 days.');
  });

  it('states the empty and ramping cases without inventing numbers', () => {
    expect(
      computeHeroHeadline(summary({ averageStar: { current: null, delta: null, priorSampleSize: 0 } })),
    ).toBe('No new ratings in the last 30 days. Your agents are standing by.');
    expect(computeHeroHeadline(summary({ isRamping: true }))).toBe(
      'Your agents are on the job — the baseline is still building.',
    );
  });
});
