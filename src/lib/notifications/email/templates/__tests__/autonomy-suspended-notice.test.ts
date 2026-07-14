import { describe, expect, it } from 'vitest';
import {
  autonomySuspendedNoticeSubject,
  buildAutonomySuspendedNoticeEmailHtml,
} from '../autonomy-suspended-notice';

describe('autonomy suspended notice email', () => {
  it('renders the complete safety message and excludes raw review/response text', () => {
    const sensitiveReview = 'SENSITIVE_REVIEW_TEXT';
    const sensitiveResponse = 'SENSITIVE_RESPONSE_TEXT';
    const params = {
      accountName: 'Acme & Co',
      reason: 'Recent owner vetoes exceeded the auto-posting safety threshold.',
      settingsUrl: 'https://app.example.com/settings/auto-approval',
      supportUrl: 'mailto:support@repworth.net',
      reviewText: sensitiveReview,
      responsePreview: sensitiveResponse,
    } as Parameters<typeof buildAutonomySuspendedNoticeEmailHtml>[0];
    const html = buildAutonomySuspendedNoticeEmailHtml(params);

    expect(autonomySuspendedNoticeSubject('Acme & Co')).toContain('Auto-posting paused');
    expect(html).toContain('paused after a safety review');
    expect(html).toContain('entire account');
    expect(html).toContain('Drafts will continue');
    expect(html).toContain('approve them manually');
    expect(html).toContain('Recent owner vetoes');
    expect(html).toContain('Acme &amp; Co');
    expect(html).toContain('https://app.example.com/settings/auto-approval');
    expect(html).toContain('mailto:support@repworth.net');
    expect(html).not.toContain(sensitiveReview);
    expect(html).not.toContain(sensitiveResponse);
  });
});
