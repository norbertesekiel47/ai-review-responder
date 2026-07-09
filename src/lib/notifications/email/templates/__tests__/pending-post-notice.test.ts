import { describe, expect, it } from 'vitest';
import { buildPendingPostNoticeEmailHtml, pendingPostNoticeSubject } from '../pending-post-notice';

const now = new Date('2026-07-09T14:00:00.000Z');

const baseParams = {
  locationLabel: 'Main St',
  reviewerName: 'Jane D',
  starRating: 5,
  reviewText: 'Wonderful service, will come again.',
  responsePreview: 'Thank you so much, Jane — see you soon!',
  scheduledPostAt: new Date('2026-07-09T14:30:00.000Z'),
  approveUrl: 'https://app.repworth.com/approve/TOKEN123',
  now,
};

describe('pending post notice email', () => {
  it('renders reviewer, star rating, review text, draft text, and the approve link', () => {
    const html = buildPendingPostNoticeEmailHtml(baseParams);
    expect(html).toContain('Jane D');
    expect(html).toContain('★★★★★');
    expect(html).toContain('Wonderful service, will come again.');
    expect(html).toContain('Thank you so much, Jane');
    expect(html).toContain('https://app.repworth.com/approve/TOKEN123');
  });

  it('phrases the deadline both absolute UTC and relative', () => {
    const html = buildPendingPostNoticeEmailHtml(baseParams);
    expect(html).toContain('14:30 UTC');
    expect(html).toContain('in about 30 minutes');
  });

  it('labels the single CTA "Review or cancel"', () => {
    const html = buildPendingPostNoticeEmailHtml(baseParams);
    expect(html).toContain('Review or cancel');
  });

  it('truncates long review and draft text via the shared truncate helper', () => {
    const html = buildPendingPostNoticeEmailHtml({
      ...baseParams,
      reviewText: 'r'.repeat(500),
      responsePreview: 'd'.repeat(500),
    });
    expect(html).toContain('r'.repeat(400) + '...');
    expect(html).not.toContain('r'.repeat(401));
    expect(html).toContain('d'.repeat(400) + '...');
    expect(html).not.toContain('d'.repeat(401));
  });

  it('escapes reviewer-controlled text', () => {
    const html = buildPendingPostNoticeEmailHtml({
      ...baseParams,
      reviewText: '<script>alert(1)</script>',
    });
    expect(html).not.toContain('<script>');
  });

  it('renders the no-review-text placeholder when review text is null', () => {
    const html = buildPendingPostNoticeEmailHtml({ ...baseParams, reviewText: null });
    expect(html).toContain('(no review text)');
  });

  it('subject carries the location label and the absolute UTC deadline', () => {
    expect(pendingPostNoticeSubject(baseParams))
      .toBe('[Main St] ⏳ Reply will post automatically at 14:30 UTC');
  });
});
