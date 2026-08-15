// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { computeChurnRiskScore, LEVEL_THRESHOLDS } from '@/lib/shared/churn-score';
import { HealthBadge } from '../HealthBadge';

// HealthBadge is the SINGLE owner of churn-level presentation for both
// /admin/overview's at-risk list and /admin/businesses' Health column. Spec §5.1
// names the two disagreeing as a real failure mode, so these tests pin the
// mapping itself, not either page's markup.

describe('HealthBadge', () => {
  it('renders a distinct label and style for every churn level', () => {
    const seen = new Map<string, string>();

    for (const level of ['healthy', 'watch', 'at_risk'] as const) {
      const { unmount } = render(<HealthBadge level={level} score={42} />);
      const badge = screen.getByText(/Healthy|Watch|At Risk/);
      seen.set(level, badge.className);
      unmount();
    }

    expect([...seen.keys()]).toEqual(['healthy', 'watch', 'at_risk']);
    // Three levels, three styles — a duplicate would make two levels
    // indistinguishable on screen.
    expect(new Set(seen.values()).size).toBe(3);
  });

  it('renders the score alongside the label', () => {
    render(<HealthBadge level="at_risk" score={74} />);
    expect(screen.getByText('At Risk')).toBeInTheDocument();
    expect(screen.getByText('74')).toBeInTheDocument();
  });

  it('agrees with computeChurnRiskScore about which level a score is', () => {
    // The badge must not carry its own thresholds. A score just past the
    // healthy boundary is a real 'watch', and the badge must label it so.
    const watch = computeChurnRiskScore({
      approvalRate: 0.4,
      notifiedResponseCount30d: 5,
      pendingResponseCount: 2,
      daysSinceLastApproval: 4,
      satisfactionResponses: null,
      responseTimeTrend: null,
      accountAgeDays: 400,
    });

    expect(watch.score).toBeGreaterThan(LEVEL_THRESHOLDS.healthy);
    expect(watch.score).toBeLessThanOrEqual(LEVEL_THRESHOLDS.watch);
    expect(watch.level).toBe('watch');

    render(<HealthBadge level={watch.level} score={watch.score} />);
    expect(screen.getByText('Watch')).toBeInTheDocument();
  });
});
