import { describe, it, expect } from 'vitest';
import {
  buildOwnerNudgeEmailHtml,
  type OwnerNudgeEmailParams,
  buildPartnerEngagementAlertHtml,
  buildPartnerEscalationAlertHtml,
  type PartnerEngagementAlertParams,
  buildPartnerLowEngagementAlertHtml,
  type PartnerLowEngagementParams,
} from '../email';

function baseNudgeParams(overrides: Partial<OwnerNudgeEmailParams> = {}): OwnerNudgeEmailParams {
  return {
    businessName: 'Acme Bakery',
    pendingReviews: [
      {
        reviewerName: 'Alice Johnson',
        starRating: 5,
        reviewText: 'Absolutely wonderful croissants and friendly staff!',
        approvalUrl: 'https://app.repworth.com/approve/abc-123',
      },
      {
        reviewerName: 'Bob Smith',
        starRating: 3,
        reviewText: null,
        approvalUrl: 'https://app.repworth.com/approve/def-456',
      },
    ],
    ...overrides,
  };
}

function baseEngagementParams(overrides: Partial<PartnerEngagementAlertParams> = {}): PartnerEngagementAlertParams {
  return {
    businessName: 'Acme Bakery',
    daysSinceApproval: 5,
    activityAgeDays: overrides.activityAgeDays ?? overrides.daysSinceApproval ?? 5,
    pendingCount: 3,
    approvalRate: 60,
    ownerEmail: 'owner@acme.com',
    ownerPhone: '+1 555-0100',
    ...overrides,
  };
}

function baseLowEngagementParams(overrides: Partial<PartnerLowEngagementParams> = {}): PartnerLowEngagementParams {
  return {
    businessName: 'Acme Bakery',
    approvalRate: 35,
    pendingCount: 7,
    ownerEmail: 'owner@acme.com',
    ownerPhone: '+1 555-0100',
    ...overrides,
  };
}

// ── buildOwnerNudgeEmailHtml ──────────────────────────────────────────

describe('buildOwnerNudgeEmailHtml', () => {
  it('includes pending count in header', () => {
    const html = buildOwnerNudgeEmailHtml(baseNudgeParams());
    expect(html).toContain('2 reviews waiting for your approval');
  });

  it('uses singular when one review pending', () => {
    const html = buildOwnerNudgeEmailHtml(baseNudgeParams({
      pendingReviews: [{
        reviewerName: 'Alice',
        starRating: 4,
        reviewText: 'Great!',
        approvalUrl: 'https://app.repworth.com/approve/abc',
      }],
    }));
    expect(html).toContain('1 review waiting for your approval');
  });

  it('renders star ratings for each review', () => {
    const html = buildOwnerNudgeEmailHtml(baseNudgeParams());
    expect(html).toContain('★★★★★'); // 5 stars for Alice
    expect(html).toContain('★★★☆☆'); // 3 stars for Bob
  });

  it('includes reviewer names', () => {
    const html = buildOwnerNudgeEmailHtml(baseNudgeParams());
    expect(html).toContain('Alice Johnson');
    expect(html).toContain('Bob Smith');
  });

  it('truncates review text to 50 chars', () => {
    const html = buildOwnerNudgeEmailHtml(baseNudgeParams({
      pendingReviews: [{
        reviewerName: 'Verbose',
        starRating: 4,
        reviewText: 'This is a very long review text that definitely exceeds the fifty character truncation limit set for nudge emails',
        approvalUrl: 'https://app.repworth.com/approve/xyz',
      }],
    }));
    expect(html).toContain('...');
    expect(html).not.toContain('truncation limit set for nudge emails');
  });

  it('shows "Rating only" when review text is null', () => {
    const html = buildOwnerNudgeEmailHtml(baseNudgeParams());
    expect(html).toContain('Rating only');
  });

  it('includes approval URLs as links', () => {
    const html = buildOwnerNudgeEmailHtml(baseNudgeParams());
    expect(html).toContain('https://app.repworth.com/approve/abc-123');
    expect(html).toContain('https://app.repworth.com/approve/def-456');
    expect(html).toContain('Review &amp; Approve');
  });

  it('includes business name in body', () => {
    const html = buildOwnerNudgeEmailHtml(baseNudgeParams());
    expect(html).toContain('Acme Bakery');
  });

  it('includes powered-by footer', () => {
    const html = buildOwnerNudgeEmailHtml(baseNudgeParams());
    expect(html).toContain('Powered by RepWorth');
  });

  it('uses 600px card chrome', () => {
    const html = buildOwnerNudgeEmailHtml(baseNudgeParams());
    expect(html).toContain('width="600"');
    expect(html).toContain('border-radius:8px');
    expect(html).toContain('background:#f5f5f5');
  });

  it('escapes HTML in user content', () => {
    const html = buildOwnerNudgeEmailHtml(baseNudgeParams({
      businessName: '<script>alert("xss")</script>',
      pendingReviews: [{
        reviewerName: '<img onerror=alert(1)>',
        starRating: 1,
        reviewText: '<b>bold injection</b>',
        approvalUrl: 'https://app.repworth.com/approve/safe',
      }],
    }));
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img onerror');
    expect(html).not.toContain('<b>bold injection</b>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;img onerror=alert(1)&gt;');
  });
});

// ── buildPartnerEngagementAlertHtml ───────────────────────────────────

describe('buildPartnerEngagementAlertHtml', () => {
  it('includes business name in header', () => {
    const html = buildPartnerEngagementAlertHtml(baseEngagementParams());
    expect(html).toContain('Acme Bakery');
    expect(html).toContain("hasn&#39;t engaged in 5 days");
  });

  it('shows days since last approval', () => {
    const html = buildPartnerEngagementAlertHtml(baseEngagementParams({ daysSinceApproval: 10 }));
    expect(html).toContain('10 days');
  });

  it('uses singular for 1 day', () => {
    const html = buildPartnerEngagementAlertHtml(baseEngagementParams({ daysSinceApproval: 1 }));
    expect(html).toContain('1 day');
    expect(html).not.toContain('1 days');
  });

  it('shows "unknown" when activityAgeDays is null', () => {
    const html = buildPartnerEngagementAlertHtml(baseEngagementParams({ daysSinceApproval: null, activityAgeDays: null }));
    expect(html).toContain('unknown');
  });

  it('includes pending count', () => {
    const html = buildPartnerEngagementAlertHtml(baseEngagementParams({ pendingCount: 8 }));
    expect(html).toContain('<strong>8</strong>');
  });

  it('includes approval rate when provided', () => {
    const html = buildPartnerEngagementAlertHtml(baseEngagementParams({ approvalRate: 45 }));
    expect(html).toContain('<strong>45%</strong>');
  });

  it('omits approval rate when null', () => {
    const html = buildPartnerEngagementAlertHtml(baseEngagementParams({ approvalRate: null }));
    expect(html).not.toContain('Approval rate');
  });

  it('includes owner email', () => {
    const html = buildPartnerEngagementAlertHtml(baseEngagementParams());
    expect(html).toContain('owner@acme.com');
  });

  it('includes owner phone when provided', () => {
    const html = buildPartnerEngagementAlertHtml(baseEngagementParams({ ownerPhone: '+1 555-9999' }));
    expect(html).toContain('+1 555-9999');
  });

  it('omits phone when null', () => {
    const html = buildPartnerEngagementAlertHtml(baseEngagementParams({ ownerPhone: null }));
    expect(html).not.toContain('Phone:');
  });

  it('includes suggested action text', () => {
    const html = buildPartnerEngagementAlertHtml(baseEngagementParams());
    expect(html).toContain('Consider sending a check-in message');
  });

  it('escapes HTML in user content', () => {
    const html = buildPartnerEngagementAlertHtml(baseEngagementParams({
      businessName: '<script>alert("xss")</script>',
      ownerEmail: 'owner@acme.com',
      ownerPhone: '<img src=x>',
    }));
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img src=x>');
    expect(html).toContain('&lt;script&gt;');
  });
});

// ── buildPartnerEscalationAlertHtml ──────────────────────────────────

describe('buildPartnerEscalationAlertHtml', () => {
  it('contains urgency text about customer being at risk', () => {
    const html = buildPartnerEscalationAlertHtml(baseEngagementParams());
    expect(html).toContain('may be at risk');
    expect(html).toContain('No engagement in 2+ weeks');
  });

  it('has red accent via border-left', () => {
    const html = buildPartnerEscalationAlertHtml(baseEngagementParams());
    expect(html).toContain('border-left:4px solid #dc2626');
  });

  it('uses red color for header text', () => {
    const html = buildPartnerEscalationAlertHtml(baseEngagementParams());
    expect(html).toContain('color:#dc2626');
  });

  it('includes business name', () => {
    const html = buildPartnerEscalationAlertHtml(baseEngagementParams({ businessName: 'Pizza Palace' }));
    expect(html).toContain('Pizza Palace');
  });

  it('includes days since approval', () => {
    const html = buildPartnerEscalationAlertHtml(baseEngagementParams({ daysSinceApproval: 21 }));
    expect(html).toContain('21 days');
  });

  it('includes pending count', () => {
    const html = buildPartnerEscalationAlertHtml(baseEngagementParams({ pendingCount: 12 }));
    expect(html).toContain('<strong>12</strong>');
  });

  it('includes approval rate when provided', () => {
    const html = buildPartnerEscalationAlertHtml(baseEngagementParams({ approvalRate: 20 }));
    expect(html).toContain('<strong>20%</strong>');
  });

  it('includes owner contact info', () => {
    const html = buildPartnerEscalationAlertHtml(baseEngagementParams());
    expect(html).toContain('owner@acme.com');
    expect(html).toContain('+1 555-0100');
  });

  it('suggests phone call or visit', () => {
    const html = buildPartnerEscalationAlertHtml(baseEngagementParams());
    expect(html).toContain('Recommend a personal phone call or visit');
  });

  it('escapes HTML in user content', () => {
    const html = buildPartnerEscalationAlertHtml(baseEngagementParams({
      businessName: '<script>alert("xss")</script>',
      ownerEmail: 'test@test.com',
    }));
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

// ── buildPartnerLowEngagementAlertHtml ────────────────────────────────

describe('buildPartnerLowEngagementAlertHtml', () => {
  it('contains approval rate percentage in header', () => {
    const html = buildPartnerLowEngagementAlertHtml(baseLowEngagementParams({ approvalRate: 25 }));
    expect(html).toContain('approval rate dropped to 25%');
  });

  it('has amber accent via border-left', () => {
    const html = buildPartnerLowEngagementAlertHtml(baseLowEngagementParams());
    expect(html).toContain('border-left:4px solid #d97706');
  });

  it('includes business name in header', () => {
    const html = buildPartnerLowEngagementAlertHtml(baseLowEngagementParams({ businessName: 'Cafe Latte' }));
    expect(html).toContain('Cafe Latte');
  });

  it('includes approval rate in body', () => {
    const html = buildPartnerLowEngagementAlertHtml(baseLowEngagementParams({ approvalRate: 42 }));
    expect(html).toContain('<strong>42%</strong>');
  });

  it('includes pending count', () => {
    const html = buildPartnerLowEngagementAlertHtml(baseLowEngagementParams({ pendingCount: 15 }));
    expect(html).toContain('<strong>15</strong>');
  });

  it('includes owner email', () => {
    const html = buildPartnerLowEngagementAlertHtml(baseLowEngagementParams());
    expect(html).toContain('owner@acme.com');
  });

  it('includes owner phone when provided', () => {
    const html = buildPartnerLowEngagementAlertHtml(baseLowEngagementParams({ ownerPhone: '+44 7911 123456' }));
    expect(html).toContain('+44 7911 123456');
  });

  it('omits phone when null', () => {
    const html = buildPartnerLowEngagementAlertHtml(baseLowEngagementParams({ ownerPhone: null }));
    expect(html).not.toContain('Phone:');
  });

  it('escapes HTML in user content', () => {
    const html = buildPartnerLowEngagementAlertHtml(baseLowEngagementParams({
      businessName: '<script>alert("xss")</script>',
      ownerEmail: 'test@test.com',
      ownerPhone: '<img src=x>',
    }));
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img src=x>');
    expect(html).toContain('&lt;script&gt;');
  });
});
