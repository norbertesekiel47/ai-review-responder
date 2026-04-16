import { describe, it, expect } from 'vitest';
import {
  computeChurnRiskScore,
  WEIGHTS,
  LEVEL_THRESHOLDS,
  type BusinessMetrics,
} from '../churn-score';

// Neutral baseline: every signal contributes 0
const neutral: BusinessMetrics = {
  approvalRate: 1,
  notifiedResponseCount30d: 10,
  pendingResponseCount: 0,
  daysSinceLastApproval: 0,
  satisfactionResponses: null,
  responseTimeTrend: 'faster_or_stable',
  accountAgeDays: 365,
};

function withOverrides(overrides: Partial<BusinessMetrics>): BusinessMetrics {
  return { ...neutral, ...overrides };
}

function contributionOf(result: ReturnType<typeof computeChurnRiskScore>, signal: string): number {
  const entry = result.breakdown.find((b) => b.signal === signal);
  if (!entry) throw new Error(`Signal "${signal}" not found in breakdown`);
  return entry.contribution;
}

// ── Individual signal tests ─────────────────────────────────────────

describe('computeChurnRiskScore', () => {
  describe('approval rate signal', () => {
    it('100% approval → 0 contribution', () => {
      const result = computeChurnRiskScore(withOverrides({ approvalRate: 1.0 }));
      expect(contributionOf(result, 'Approval rate (30d)')).toBe(0);
    });

    it('70% approval → contribution of 15 (50 * 30/100)', () => {
      const result = computeChurnRiskScore(withOverrides({ approvalRate: 0.7 }));
      expect(contributionOf(result, 'Approval rate (30d)')).toBe(15);
    });

    it('80% approval → contribution of 6 (20 * 30/100)', () => {
      const result = computeChurnRiskScore(withOverrides({ approvalRate: 0.8 }));
      expect(contributionOf(result, 'Approval rate (30d)')).toBe(6);
    });

    it('<50% approval → contribution of 30 (100 * 30/100)', () => {
      const result = computeChurnRiskScore(withOverrides({ approvalRate: 0.3 }));
      expect(contributionOf(result, 'Approval rate (30d)')).toBe(30);
    });

    it('null approval rate → 0 contribution', () => {
      const result = computeChurnRiskScore(withOverrides({ approvalRate: null }));
      expect(contributionOf(result, 'Approval rate (30d)')).toBe(0);
    });

    it('notifiedCount < 3 → 0 contribution regardless of rate', () => {
      const result = computeChurnRiskScore(
        withOverrides({ approvalRate: 0.2, notifiedResponseCount30d: 2 }),
      );
      expect(contributionOf(result, 'Approval rate (30d)')).toBe(0);
    });
  });

  describe('days since approval signal', () => {
    it('0 days → 0 contribution', () => {
      const result = computeChurnRiskScore(withOverrides({ daysSinceLastApproval: 0 }));
      expect(contributionOf(result, 'Days since approval')).toBe(0);
    });

    it('2 days → 0 contribution', () => {
      const result = computeChurnRiskScore(withOverrides({ daysSinceLastApproval: 2 }));
      expect(contributionOf(result, 'Days since approval')).toBe(0);
    });

    it('4 days → contribution of 8 (30 * 25/100)', () => {
      const result = computeChurnRiskScore(withOverrides({ daysSinceLastApproval: 4 }));
      expect(contributionOf(result, 'Days since approval')).toBe(8);
    });

    it('10 days → contribution of 15 (60 * 25/100)', () => {
      const result = computeChurnRiskScore(withOverrides({ daysSinceLastApproval: 10 }));
      expect(contributionOf(result, 'Days since approval')).toBe(15);
    });

    it('14 days → contribution of 25 (100 * 25/100)', () => {
      const result = computeChurnRiskScore(withOverrides({ daysSinceLastApproval: 14 }));
      expect(contributionOf(result, 'Days since approval')).toBe(25);
    });

    it('null + pending > 0 → contribution of 15 (60 * 25/100)', () => {
      const result = computeChurnRiskScore(
        withOverrides({ daysSinceLastApproval: null, pendingResponseCount: 3 }),
      );
      expect(contributionOf(result, 'Days since approval')).toBe(15);
    });

    it('null + pending 0 → 0 contribution', () => {
      const result = computeChurnRiskScore(
        withOverrides({ daysSinceLastApproval: null, pendingResponseCount: 0 }),
      );
      expect(contributionOf(result, 'Days since approval')).toBe(0);
    });
  });

  describe('satisfaction pulse signal', () => {
    it('null (Sprint 5B not enabled) → 0 contribution', () => {
      const result = computeChurnRiskScore(withOverrides({ satisfactionResponses: null }));
      expect(contributionOf(result, 'Satisfaction pulse')).toBe(0);
    });

    it('empty array → 0 contribution', () => {
      const result = computeChurnRiskScore(withOverrides({ satisfactionResponses: [] }));
      expect(contributionOf(result, 'Satisfaction pulse')).toBe(0);
    });

    it('all great → 0 contribution', () => {
      const result = computeChurnRiskScore(
        withOverrides({
          satisfactionResponses: [{ rating: 'great' }, { rating: 'great' }, { rating: 'great' }],
        }),
      );
      expect(contributionOf(result, 'Satisfaction pulse')).toBe(0);
    });

    it('mixed ratings → contribution of 6 (30 * 20/100)', () => {
      const result = computeChurnRiskScore(
        withOverrides({
          satisfactionResponses: [{ rating: 'great' }, { rating: 'ok' }, { rating: 'not_great' }],
        }),
      );
      expect(contributionOf(result, 'Satisfaction pulse')).toBe(6);
    });

    it('not_great streak of 2+ → contribution of 16 (80 * 20/100)', () => {
      const result = computeChurnRiskScore(
        withOverrides({
          satisfactionResponses: [
            { rating: 'great' },
            { rating: 'not_great' },
            { rating: 'not_great' },
          ],
        }),
      );
      expect(contributionOf(result, 'Satisfaction pulse')).toBe(16);
    });
  });

  describe('response time trend signal', () => {
    it('null → 0 contribution', () => {
      const result = computeChurnRiskScore(withOverrides({ responseTimeTrend: null }));
      expect(contributionOf(result, 'Response time trend')).toBe(0);
    });

    it('faster_or_stable → 0 contribution', () => {
      const result = computeChurnRiskScore(
        withOverrides({ responseTimeTrend: 'faster_or_stable' }),
      );
      expect(contributionOf(result, 'Response time trend')).toBe(0);
    });

    it('slower → contribution of 8 (50 * 15/100)', () => {
      const result = computeChurnRiskScore(withOverrides({ responseTimeTrend: 'slower' }));
      expect(contributionOf(result, 'Response time trend')).toBe(8);
    });

    it('stopped → contribution of 15 (100 * 15/100)', () => {
      const result = computeChurnRiskScore(withOverrides({ responseTimeTrend: 'stopped' }));
      expect(contributionOf(result, 'Response time trend')).toBe(15);
    });
  });

  describe('account age signal', () => {
    it('2 weeks → contribution of 2 (20 * 10/100)', () => {
      const result = computeChurnRiskScore(withOverrides({ accountAgeDays: 14 }));
      expect(contributionOf(result, 'Account age')).toBe(2);
    });

    it('4 weeks → contribution of 2 (20 * 10/100)', () => {
      const result = computeChurnRiskScore(withOverrides({ accountAgeDays: 28 }));
      expect(contributionOf(result, 'Account age')).toBe(2);
    });

    it('8 weeks → contribution of 1 (10 * 10/100)', () => {
      const result = computeChurnRiskScore(withOverrides({ accountAgeDays: 56 }));
      expect(contributionOf(result, 'Account age')).toBe(1);
    });

    it('20 weeks → 0 contribution', () => {
      const result = computeChurnRiskScore(withOverrides({ accountAgeDays: 140 }));
      expect(contributionOf(result, 'Account age')).toBe(0);
    });
  });

  // ── Edge cases ──────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('perfect engagement → score near 0, level healthy', () => {
      const result = computeChurnRiskScore(neutral);
      expect(result.score).toBe(0);
      expect(result.level).toBe('healthy');
    });

    it('completely disengaged → high score, level at_risk', () => {
      const result = computeChurnRiskScore({
        approvalRate: 0.1,
        notifiedResponseCount30d: 10,
        pendingResponseCount: 5,
        daysSinceLastApproval: 30,
        satisfactionResponses: [{ rating: 'not_great' }, { rating: 'not_great' }],
        responseTimeTrend: 'stopped',
        accountAgeDays: 14,
      });
      // 30 + 25 + 16 + 15 + 2 = 88
      expect(result.score).toBe(88);
      expect(result.level).toBe('at_risk');
    });

    it('new account with zero data → only account age contributes, healthy', () => {
      const result = computeChurnRiskScore({
        approvalRate: null,
        notifiedResponseCount30d: 0,
        pendingResponseCount: 0,
        daysSinceLastApproval: null,
        satisfactionResponses: null,
        responseTimeTrend: null,
        accountAgeDays: 7,
      });
      // Only account age (1w): raw 20 * 10 / 100 = 2
      expect(result.score).toBe(2);
      expect(result.level).toBe('healthy');
    });

    it('satisfaction null (Sprint 5B) → 0 contribution', () => {
      const result = computeChurnRiskScore(withOverrides({ satisfactionResponses: null }));
      expect(contributionOf(result, 'Satisfaction pulse')).toBe(0);
    });
  });

  // ── Boundary values ─────────────────────────────────────────────────

  describe('boundary values', () => {
    it('score exactly 30 → healthy', () => {
      // approval rate <50% = 30 contribution, everything else neutral at 0
      const result = computeChurnRiskScore(
        withOverrides({ approvalRate: 0.3, notifiedResponseCount30d: 5 }),
      );
      expect(result.score).toBe(30);
      expect(result.level).toBe('healthy');
    });

    it('score exactly 31 → watch', () => {
      // approval rate <50% = 30, account age <5w = 1 (10 * 10/100 = 1)
      const result = computeChurnRiskScore(
        withOverrides({
          approvalRate: 0.3,
          notifiedResponseCount30d: 5,
          accountAgeDays: 56, // 8 weeks: raw=10 → contribution=1
        }),
      );
      expect(result.score).toBe(31);
      expect(result.level).toBe('watch');
    });

    it('score exactly 60 → watch', () => {
      // approval rate <50% = 30, days 14+ = 25, account age 12+w = 0 → total 55
      // Need exactly 60: approval 30 + days 25 + slower trend 8 = 63 (too much)
      // approval <50% = 30, days 3-5d = 8, satisfaction mixed = 6, slower = 8, age 8w = 1 → 53
      // approval <50% = 30, days 10d = 15, slower = 8, satisfaction mixed = 6, age 8w = 1 → 60
      const result = computeChurnRiskScore(
        withOverrides({
          approvalRate: 0.3,
          notifiedResponseCount30d: 5,
          daysSinceLastApproval: 10,
          responseTimeTrend: 'slower',
          satisfactionResponses: [{ rating: 'great' }, { rating: 'ok' }],
          accountAgeDays: 56,
        }),
      );
      expect(result.score).toBe(60);
      expect(result.level).toBe('watch');
    });

    it('score exactly 61 → at_risk', () => {
      // Same as 60 scenario + bump account age to <5 weeks for +1
      const result = computeChurnRiskScore(
        withOverrides({
          approvalRate: 0.3,
          notifiedResponseCount30d: 5,
          daysSinceLastApproval: 10,
          responseTimeTrend: 'slower',
          satisfactionResponses: [{ rating: 'great' }, { rating: 'ok' }],
          accountAgeDays: 14, // 2w: raw=20 → contribution=2
        }),
      );
      expect(result.score).toBe(61);
      expect(result.level).toBe('at_risk');
    });
  });

  // ── Combined scoring ────────────────────────────────────────────────

  describe('combined scoring', () => {
    it('multiple signals contributing → correct sum', () => {
      const result = computeChurnRiskScore({
        approvalRate: 0.7,
        notifiedResponseCount30d: 10,
        pendingResponseCount: 0,
        daysSinceLastApproval: 4,
        satisfactionResponses: [{ rating: 'great' }, { rating: 'ok' }],
        responseTimeTrend: 'slower',
        accountAgeDays: 14,
      });
      // approval 70% raw=50 → 15
      // days 4d raw=30 → 8 (7.5 rounds to 8)
      // satisfaction mixed raw=30 → 6
      // trend slower raw=50 → 8 (7.5 rounds to 8)
      // age 2w raw=20 → 2
      expect(result.score).toBe(15 + 8 + 6 + 8 + 2);
      expect(result.score).toBe(39);
      expect(result.level).toBe('watch');
    });

    it('breakdown array has exactly 5 entries', () => {
      const result = computeChurnRiskScore(neutral);
      expect(result.breakdown).toHaveLength(5);
    });

    it('breakdown entries have required fields', () => {
      const result = computeChurnRiskScore(neutral);
      for (const entry of result.breakdown) {
        expect(entry).toHaveProperty('signal');
        expect(entry).toHaveProperty('value');
        expect(entry).toHaveProperty('contribution');
        expect(typeof entry.signal).toBe('string');
        expect(typeof entry.value).toBe('string');
        expect(typeof entry.contribution).toBe('number');
      }
    });
  });

  // ── Exported constants ──────────────────────────────────────────────

  describe('exported constants', () => {
    it('WEIGHTS sum to 100', () => {
      const total = Object.values(WEIGHTS).reduce((sum, w) => sum + w, 0);
      expect(total).toBe(100);
    });

    it('LEVEL_THRESHOLDS are ordered', () => {
      expect(LEVEL_THRESHOLDS.healthy).toBeLessThan(LEVEL_THRESHOLDS.watch);
    });
  });
});
