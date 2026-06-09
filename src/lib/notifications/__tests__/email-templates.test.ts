import { describe, it, expect } from 'vitest';
import {
  buildWeeklyValueReportHtml,
  type WeeklyValueReportParams,
  buildMonthlyImpactEmailHtml,
  type MonthlyImpactEmailParams,
  buildAccountOffboardingEmailHtml,
} from '../email';

function baseWeeklyParams(overrides: Partial<WeeklyValueReportParams> = {}): WeeklyValueReportParams {
  return {
    businessName: 'Acme Bakery',
    weekStartDate: '2026-04-07',
    weekEndDate: '2026-04-13',
    totalReviews: 10,
    totalResponded: 8,
    notableReviews: [],
    intelligenceBrief: null,
    baselineResponseRate: null,
    fourWeekAvgReviews: 9,
    ranking: null,
    dashboardUrl: null,
    feedbackUrls: null,
    ...overrides,
  };
}

function baseMonthlyParams(overrides: Partial<MonthlyImpactEmailParams> = {}): MonthlyImpactEmailParams {
  return {
    businessName: 'Acme Bakery',
    monthLabel: 'March 2026',
    totalReviews: 40,
    totalResponded: 36,
    responseRate: 90,
    baselineResponseRate: null,
    timeSavedMinutes: 252,
    intelligenceBrief: null,
    ranking: null,
    bestReview: null,
    dashboardUrl: null,
    ...overrides,
  };
}

// ── buildAccountOffboardingEmailHtml ───────────────────────────────────

describe('buildAccountOffboardingEmailHtml', () => {
  it('renders delete-data confirmation with escaped keep-my-data link', () => {
    const html = buildAccountOffboardingEmailHtml({
      emailType: 'delete_data_confirmation',
      accessEndsAt: null,
      purgeAfter: '2026-07-06T00:00:00.000Z',
      keepMyDataUrl: 'https://app.repworth.com/api/account/offboarding/keep-my-data?token=abc&return=/dashboard',
    });

    expect(html).toContain('Your RepWorth data deletion is scheduled');
    expect(html).toContain('July 6, 2026');
    expect(html).toContain('Keep my data');
    expect(html).toContain('token=abc&amp;return=/dashboard');
    expect(html).toContain('does not restore product access');
  });

  it('requires a keep-my-data link for delete-data confirmation', () => {
    expect(() => buildAccountOffboardingEmailHtml({
      emailType: 'delete_data_confirmation',
      accessEndsAt: null,
      purgeAfter: '2026-07-06T00:00:00.000Z',
    })).toThrow(/keepMyDataUrl/);
  });

  it('renders keep-my-data confirmation without irreversible deletion copy', () => {
    const html = buildAccountOffboardingEmailHtml({
      emailType: 'keep_my_data_confirmation',
      accessEndsAt: null,
    });

    expect(html).toContain('Your RepWorth data will be kept');
    expect(html).toContain('Your deletion request has been cancelled');
    expect(html).toContain('RepWorth will keep your historical account data');
    expect(html).not.toContain('Your account data is scheduled for deletion');
    expect(html).not.toContain('use this secure link before deletion starts');
  });

  it('renders cancel_only access-end notice with the access-ended date (H1a)', () => {
    const html = buildAccountOffboardingEmailHtml({
      emailType: 'cancel_only_access_end',
      accessEndsAt: '2026-07-06T00:00:00.000Z',
    });

    expect(html).toContain('Your RepWorth subscription has ended');
    expect(html).toContain('July 6, 2026');
    expect(html).toContain('resubscribe and reconnect');
    expect(html).not.toContain('Keep my data');
  });

  it('renders the T-3d purge reminder with the deletion date and a last-chance warning (H1b)', () => {
    const html = buildAccountOffboardingEmailHtml({
      emailType: 'delete_data_purge_reminder',
      accessEndsAt: null,
      purgeAfter: '2026-07-06T00:00:00.000Z',
    });

    expect(html).toContain('Reminder: your RepWorth data will be deleted soon');
    expect(html).toContain('July 6, 2026');
    expect(html).toContain('cannot be undone');
    expect(html).toContain('sign in to RepWorth to keep it');
  });

  it('renders purge receipt with purge date and support-only generic copy', () => {
    const html = buildAccountOffboardingEmailHtml({
      emailType: 'purge_receipt',
      accessEndsAt: null,
      purgedAt: '2026-07-06T00:00:00.000Z',
    });

    expect(html).toContain('Your RepWorth data has been deleted');
    expect(html).toContain('July 6, 2026');
    expect(html).toContain('contact RepWorth support');
    expect(html).not.toContain('Acme');
    expect(html).not.toContain('review');
    expect(html).not.toContain('location');
    expect(html).not.toContain('zernio');
    expect(html).not.toContain('cus_');
    expect(html).not.toContain('sub_');
  });
});

// ── buildWeeklyValueReportHtml ──────────────────────────────────────────

describe('buildWeeklyValueReportHtml', () => {
  it('includes value-delivered header with time saved', () => {
    const html = buildWeeklyValueReportHtml(baseWeeklyParams({ totalReviews: 12, totalResponded: 10 }));
    // 10 responded * 7 = 70 minutes
    expect(html).toContain('saving you approximately 70 minutes');
    expect(html).toContain('handled 10 reviews');
  });

  it('includes intelligence brief section when provided', () => {
    const html = buildWeeklyValueReportHtml(baseWeeklyParams({
      intelligenceBrief: 'Customers frequently mention slow service on weekends.',
    }));
    expect(html).toContain('AI Intelligence Brief');
    expect(html).toContain('Customers frequently mention slow service on weekends.');
    expect(html).toContain('border-left:3px solid #3b82f6');
  });

  it('omits intelligence brief section when null', () => {
    const html = buildWeeklyValueReportHtml(baseWeeklyParams({ intelligenceBrief: null }));
    expect(html).not.toContain('AI Intelligence Brief');
  });

  it('shows response rate lift with baseline comparison when provided', () => {
    const html = buildWeeklyValueReportHtml(baseWeeklyParams({ baselineResponseRate: 25 }));
    expect(html).toContain('was 25% before RepWorth');
  });

  it('omits baseline comparison when null', () => {
    const html = buildWeeklyValueReportHtml(baseWeeklyParams({ baselineResponseRate: null }));
    expect(html).not.toContain('before RepWorth');
  });

  it('includes review velocity with 4-week average', () => {
    const html = buildWeeklyValueReportHtml(baseWeeklyParams({
      totalReviews: 14,
      fourWeekAvgReviews: 11,
    }));
    expect(html).toContain('New reviews this week:');
    expect(html).toContain('<strong>14</strong>');
    expect(html).toContain('4-week average:');
    expect(html).toContain('<strong>11</strong>');
  });

  it('includes ranking section when provided', () => {
    const html = buildWeeklyValueReportHtml(baseWeeklyParams({
      ranking: { keyword: 'best bakery', currentRank: 3, initialRank: 8 },
    }));
    expect(html).toContain('best bakery');
    expect(html).toContain('#3');
    expect(html).toContain('was #8 when you joined');
  });

  it('omits ranking section when null', () => {
    const html = buildWeeklyValueReportHtml(baseWeeklyParams({ ranking: null }));
    expect(html).not.toContain('Your ranking for');
  });

  it('includes dashboard link when provided', () => {
    const html = buildWeeklyValueReportHtml(baseWeeklyParams({
      dashboardUrl: 'https://app.repworth.com/dashboard/abc',
    }));
    expect(html).toContain('See your full dashboard');
    expect(html).toContain('https://app.repworth.com/dashboard/abc');
  });

  it('omits dashboard link when null', () => {
    const html = buildWeeklyValueReportHtml(baseWeeklyParams({ dashboardUrl: null }));
    expect(html).not.toContain('See your full dashboard');
  });

  it('escapes HTML in user content', () => {
    const html = buildWeeklyValueReportHtml(baseWeeklyParams({
      businessName: '<script>alert("xss")</script>',
      intelligenceBrief: '<img src=x onerror=alert(1)>',
      ranking: { keyword: '"><script>hack</script>', currentRank: 1, initialRank: 5 },
      notableReviews: [
        { reviewerName: '<b>Evil</b>', starRating: 1, reviewText: '<script>bad</script>' },
      ],
    }));
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<b>Evil</b>');
    expect(html).toContain('&lt;script&gt;');
  });
});

// ── buildMonthlyImpactEmailHtml ─────────────────────────────────────────

describe('buildMonthlyImpactEmailHtml', () => {
  it('includes monthly intelligence brief when provided', () => {
    const html = buildMonthlyImpactEmailHtml(baseMonthlyParams({
      intelligenceBrief: 'Positive trend in 5-star reviews this month.',
    }));
    expect(html).toContain('Monthly Intelligence Brief');
    expect(html).toContain('Positive trend in 5-star reviews this month.');
    expect(html).toContain('border-left:3px solid #3b82f6');
  });

  it('omits intelligence brief when null', () => {
    const html = buildMonthlyImpactEmailHtml(baseMonthlyParams({ intelligenceBrief: null }));
    expect(html).not.toContain('Intelligence Brief');
  });

  it('includes time saved in hours with one decimal', () => {
    // 252 minutes / 60 = 4.2 hours
    const html = buildMonthlyImpactEmailHtml(baseMonthlyParams({ timeSavedMinutes: 252 }));
    expect(html).toContain('4.2 hours');
  });

  it('handles exact hour values', () => {
    // 120 minutes / 60 = 2.0 hours
    const html = buildMonthlyImpactEmailHtml(baseMonthlyParams({ timeSavedMinutes: 120 }));
    expect(html).toContain('2.0 hours');
  });

  it('includes response rate with baseline comparison', () => {
    const html = buildMonthlyImpactEmailHtml(baseMonthlyParams({
      responseRate: 92,
      baselineResponseRate: 30,
    }));
    expect(html).toContain('<strong>92%</strong>');
    expect(html).toContain('was 30% before RepWorth');
  });

  it('omits baseline when null', () => {
    const html = buildMonthlyImpactEmailHtml(baseMonthlyParams({
      responseRate: 90,
      baselineResponseRate: null,
    }));
    expect(html).toContain('<strong>90%</strong>');
    expect(html).not.toContain('before RepWorth');
  });

  it('includes best review when provided', () => {
    const html = buildMonthlyImpactEmailHtml(baseMonthlyParams({
      bestReview: {
        reviewerName: 'Jane Doe',
        starRating: 5,
        reviewText: 'Absolutely loved the croissants!',
        responseText: 'Thank you Jane, we appreciate your kind words!',
      },
    }));
    expect(html).toContain('Best Review of the Month');
    expect(html).toContain('Jane Doe');
    expect(html).toContain('Absolutely loved the croissants!');
    expect(html).toContain('Thank you Jane, we appreciate your kind words!');
    expect(html).toContain('★★★★★');
  });

  it('includes best review without response text', () => {
    const html = buildMonthlyImpactEmailHtml(baseMonthlyParams({
      bestReview: {
        reviewerName: 'Bob',
        starRating: 4,
        reviewText: 'Great service.',
        responseText: null,
      },
    }));
    expect(html).toContain('Best Review of the Month');
    expect(html).toContain('Great service.');
    expect(html).not.toContain('&ldquo;');
  });

  it('omits best review when null', () => {
    const html = buildMonthlyImpactEmailHtml(baseMonthlyParams({ bestReview: null }));
    expect(html).not.toContain('Best Review of the Month');
  });

  it('includes ranking when provided', () => {
    const html = buildMonthlyImpactEmailHtml(baseMonthlyParams({
      ranking: { keyword: 'pizza near me', currentRank: 2, initialRank: 7 },
    }));
    expect(html).toContain('pizza near me');
    expect(html).toContain('#2');
    expect(html).toContain('was #7 when you joined');
  });

  it('omits ranking when null', () => {
    const html = buildMonthlyImpactEmailHtml(baseMonthlyParams({ ranking: null }));
    expect(html).not.toContain('Your ranking for');
  });

  it('includes dashboard link when provided', () => {
    const html = buildMonthlyImpactEmailHtml(baseMonthlyParams({
      dashboardUrl: 'https://app.repworth.com/dashboard/xyz',
    }));
    expect(html).toContain('See your full dashboard');
    expect(html).toContain('https://app.repworth.com/dashboard/xyz');
  });

  it('omits dashboard link when null', () => {
    const html = buildMonthlyImpactEmailHtml(baseMonthlyParams({ dashboardUrl: null }));
    expect(html).not.toContain('See your full dashboard');
  });

  it('escapes HTML in user content', () => {
    const html = buildMonthlyImpactEmailHtml(baseMonthlyParams({
      businessName: '<script>xss</script>',
      intelligenceBrief: '<img onerror=alert(1)>',
      ranking: { keyword: '"><b>hack</b>', currentRank: 1, initialRank: 3 },
      bestReview: {
        reviewerName: '<em>Attacker</em>',
        starRating: 5,
        reviewText: '<script>steal()</script>',
        responseText: '<img src=x>',
      },
    }));
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img onerror');
    expect(html).not.toContain('<em>Attacker</em>');
    expect(html).not.toContain('<img src=x>');
    expect(html).toContain('&lt;script&gt;');
  });
});
