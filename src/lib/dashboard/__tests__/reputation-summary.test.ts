import { describe, it, expect } from 'vitest';
import {
  buildReputationSummary,
  RAMPING_AGE_DAYS,
  type RateWindowRow,
  type StarWindowRow,
  type TimeSavedWindowRow,
  type SentimentTrendRow,
} from '../reputation-summary';

const ZERO_RATE: RateWindowRow = {
  received_current: 0,
  handled_current: 0,
  received_prior: 0,
  handled_prior: 0,
};
const ZERO_STAR: StarWindowRow = {
  star_current: null,
  star_n_current: 0,
  star_prior: null,
  star_n_prior: 0,
};
const ZERO_TS: TimeSavedWindowRow = { handled_current: 0, handled_prior: 0 };

function build(overrides: {
  rate?: Partial<RateWindowRow>;
  star?: Partial<StarWindowRow>;
  timeSaved?: Partial<TimeSavedWindowRow>;
  trend?: SentimentTrendRow[];
  pendingApprovalCount?: number;
  accountAgeDays?: number;
} = {}) {
  return buildReputationSummary({
    rate: { ...ZERO_RATE, ...overrides.rate },
    star: { ...ZERO_STAR, ...overrides.star },
    timeSaved: { ...ZERO_TS, ...overrides.timeSaved },
    trend: overrides.trend ?? [],
    pendingApprovalCount: overrides.pendingApprovalCount ?? 0,
    accountAgeDays: overrides.accountAgeDays ?? 365,
  });
}

describe('buildReputationSummary', () => {
  it('computes average star and its delta in rating points', () => {
    const s = build({
      star: { star_current: 4.8, star_n_current: 40, star_prior: 4.6, star_n_prior: 30 },
    });
    expect(s.averageStar.current).toBe(4.8);
    expect(s.averageStar.delta).toBe(0.2);
    expect(s.averageStar.priorSampleSize).toBe(30);
  });

  it('computes response rate (percent) and delta in percentage points', () => {
    const s = build({
      rate: { received_current: 50, handled_current: 47, received_prior: 40, handled_prior: 35 },
    });
    // 47/50 = 94%, prior 35/40 = 87.5% -> rounds to 94 and 88, delta 6
    expect(s.responseRate.current).toBe(94);
    expect(s.responseRate.delta).toBe(6);
    expect(s.responseRate.priorSampleSize).toBe(40);
  });

  it('computes time saved in minutes (handled x 7) and minute delta', () => {
    const s = build({ timeSaved: { handled_current: 18, handled_prior: 9 } });
    expect(s.timeSavedMinutes.current).toBe(126); // 18 * 7
    expect(s.timeSavedMinutes.delta).toBe(63); // (18 - 9) * 7
    expect(s.timeSavedMinutes.priorSampleSize).toBe(9);
  });

  it('suppresses the delta when the prior window has zero sample', () => {
    const s = build({
      star: { star_current: 4.9, star_n_current: 12, star_prior: null, star_n_prior: 0 },
      rate: { received_current: 12, handled_current: 11, received_prior: 0, handled_prior: 0 },
      timeSaved: { handled_current: 11, handled_prior: 0 },
    });
    expect(s.averageStar.current).toBe(4.9);
    expect(s.averageStar.delta).toBeNull();
    expect(s.responseRate.delta).toBeNull();
    expect(s.timeSavedMinutes.current).toBe(77);
    expect(s.timeSavedMinutes.delta).toBeNull();
  });

  it('returns null current when the current window has no sample', () => {
    const s = build();
    expect(s.averageStar.current).toBeNull();
    expect(s.responseRate.current).toBeNull();
    expect(s.timeSavedMinutes.current).toBe(0);
  });

  it('maps sentiment trend to clamped star-equivalent (3 + 2·score), null for empty weeks', () => {
    const trend: SentimentTrendRow[] = [
      { week_start: '2026-05-01', avg_score: 0.5, cnt: 4 }, // 3 + 1.0 = 4.0
      { week_start: '2026-05-08', avg_score: 1, cnt: 2 }, // clamp -> 5
      { week_start: '2026-05-15', avg_score: -2, cnt: 1 }, // clamp -> 1
      { week_start: '2026-05-22', avg_score: null, cnt: 0 }, // gap
    ];
    const s = build({ trend });
    expect(s.trend[0]).toEqual({ weekStart: '2026-05-01', starEquivalent: 4, reviewCount: 4 });
    expect(s.trend[1]?.starEquivalent).toBe(5);
    expect(s.trend[2]?.starEquivalent).toBe(1);
    expect(s.trend[3]?.starEquivalent).toBeNull();
  });

  // #791: production hands this mapper a postgres.js-decoded Date, not the ISO
  // strings the fixture above uses. `String(date)` yielded "Fri May 01 2026 …".
  it('maps a postgres.js-decoded Date week_start to the ISO calendar day', () => {
    const trend: SentimentTrendRow[] = [
      { week_start: new Date('2026-05-01'), avg_score: 0.5, cnt: 4 },
    ];
    expect(build({ trend }).trend[0]?.weekStart).toBe('2026-05-01');
  });

  it('flags ramping strictly below the age threshold', () => {
    expect(build({ accountAgeDays: RAMPING_AGE_DAYS - 1 }).isRamping).toBe(true);
    expect(build({ accountAgeDays: RAMPING_AGE_DAYS }).isRamping).toBe(false);
    expect(build({ accountAgeDays: RAMPING_AGE_DAYS + 30 }).isRamping).toBe(false);
  });

  it('passes through the pending approval count', () => {
    expect(build({ pendingApprovalCount: 3 }).pendingApprovalCount).toBe(3);
  });
});
