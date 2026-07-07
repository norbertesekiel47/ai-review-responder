import { describe, expect, it } from 'vitest';
import { buildEscalationNoticeEmailHtml, escalationNoticeSubject } from '../escalation-notice';

const baseParams = {
  to: 'owner@example.com',
  from: 'noreply@repworth.com',
  locationLabel: 'Main St',
  businessName: 'Acme Diner',
  reviewerName: 'Jane D',
  starRating: 1 as number | null,
  reviewText: 'Terrible experience, found a hair in my food.',
  severity: 'high' as const,
  issues: ['safety_or_health' as const],
  isFallback: false,
  dashboardUrl: 'https://app.repworth.com/dashboard/reviews',
};

describe('escalation notice email', () => {
  it('renders severity, humanized issues, review text, and the dashboard CTA', () => {
    const html = buildEscalationNoticeEmailHtml(baseParams);
    expect(html).toContain('High severity');
    expect(html).toContain('Safety or health');
    expect(html).toContain('Terrible experience');
    expect(html).toContain('https://app.repworth.com/dashboard/reviews');
  });

  it('uses needs-a-look copy and NO severity claim for fallback-sourced escalations', () => {
    const html = buildEscalationNoticeEmailHtml({ ...baseParams, isFallback: true, issues: [] });
    expect(html).not.toContain('High severity');
    expect(html).toContain("couldn&#39;t assess this review automatically");
  });

  it('escapes reviewer-controlled text', () => {
    const html = buildEscalationNoticeEmailHtml({
      ...baseParams,
      reviewText: '<script>alert(1)</script>',
    });
    expect(html).not.toContain('<script>');
  });

  it('subject flags urgency and carries the location label', () => {
    expect(escalationNoticeSubject(baseParams)).toBe('[Main St] 🚨 A review needs your attention');
    expect(escalationNoticeSubject({ ...baseParams, isFallback: true }))
      .toBe('[Main St] ⚠️ A review needs a look');
  });

  it('handles rating-less reviews without rendering stars', () => {
    const html = buildEscalationNoticeEmailHtml({ ...baseParams, starRating: null });
    expect(html).toContain('No star rating');
  });

  it('shows severity but omits the Flagged-for fragment when issues are empty (non-fallback)', () => {
    const html = buildEscalationNoticeEmailHtml({ ...baseParams, issues: [] });
    expect(html).toContain('High severity');
    expect(html).not.toContain('Flagged for:');
  });

  it('renders the no-review-text placeholder when review text is null', () => {
    const html = buildEscalationNoticeEmailHtml({ ...baseParams, reviewText: null });
    expect(html).toContain('(no review text)');
  });
});
