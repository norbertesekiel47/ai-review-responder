import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  formatApprovalWhatsApp,
  formatAutoPostNoticeWhatsApp,
  formatAutonomySuspendedNoticeWhatsApp,
  renderAutonomySuspendedNoticeWhatsAppBody,
  formatEscalationNoticeWhatsApp,
  formatPendingPostNoticeWhatsApp,
  renderApprovalCardBody,
  extractTokenFromApprovalUrl,
  stripWaPrefix,
  toWaRecipient,
  truncate,
} from '../whatsapp-body';

describe('formatAutonomySuspendedNoticeWhatsApp', () => {
  it('uses only account-safe fields and the settings URL suffix', () => {
    const sensitiveReview = 'SENSITIVE_REVIEW_TEXT';
    const sensitiveResponse = 'SENSITIVE_RESPONSE_TEXT';
    const params = {
      accountName: 'Acme\nGroup',
      reason: 'Recent safety reviews exceeded the auto-posting safety threshold.',
      settingsPath: 'settings/auto-approval',
      reviewText: sensitiveReview,
      responsePreview: sensitiveResponse,
    } as Parameters<typeof formatAutonomySuspendedNoticeWhatsApp>[0];
    const { contentSid, contentVariables } = formatAutonomySuspendedNoticeWhatsApp(params, 'HXsuspended');

    expect(contentSid).toBe('HXsuspended');
    expect(contentVariables).toEqual({
      '1': 'Acme Group',
      '2': 'Recent safety reviews exceeded the auto-posting safety threshold.',
      '3': 'settings/auto-approval',
    });
    expect(JSON.stringify(contentVariables)).not.toContain(sensitiveReview);
    expect(JSON.stringify(contentVariables)).not.toContain(sensitiveResponse);
    const body = renderAutonomySuspendedNoticeWhatsAppBody(contentVariables);
    expect(body).toContain('paused after a safety review');
    expect(body).toContain('entire account');
    expect(body).toContain('Drafts will continue');
    expect(body).toContain('approve them manually');
    expect(body).toContain('Recent safety reviews exceeded');
    expect(body).toContain('support@repworth.net');
  });

  it('is byte-pinned to the runbook body and URL-button variable contract', () => {
    const runbook = readFileSync('docs/runbooks/whatsapp-templates.md', 'utf8');
    const section = runbook.split('## Autonomy-suspended notice (`WHATSAPP_AUTONOMY_SUSPENDED_TEMPLATE_SID`)')[1]
      ?.split('\n---')[0];
    expect(section).toBeTruthy();
    const documentedBody = section!.match(/\*\*Exact provider body \(byte-locked\):\*\*\n\n```\n([\s\S]*?)\n```/)?.[1];
    const sourceBody = renderAutonomySuspendedNoticeWhatsAppBody({
      '1': '{{1}}',
      '2': '{{2}}',
    });
    expect(documentedBody).toBe(sourceBody);
    expect(section).toContain('"1" = accountName');
    expect(section).toContain('"2" = reason');
    expect(section).toContain('`"3"` = `settings/auto-approval`');
    expect(section).toContain('"url": "https://app.repworth.com/{{3}}"');
  });

  it('rejects a leading-slash or otherwise divergent settings suffix', () => {
    expect(() => formatAutonomySuspendedNoticeWhatsApp({
      accountName: 'Acme',
      reason: 'Safety review.',
      settingsPath: '/settings/auto-approval',
    }, 'HXsuspended')).toThrow(/settingsPath must equal settings\/auto-approval/);
  });
});
import { resetWorkerConfigForTests } from '@/lib/config/worker';

describe('truncate', () => {
  it('returns input unchanged when under limit', () => {
    expect(truncate('short', 100)).toBe('short');
  });
  it('truncates with ellipsis when over limit', () => {
    const out = truncate('a'.repeat(500), 400);
    expect(out.length).toBeLessThanOrEqual(400);
    expect(out.endsWith('…')).toBe(true);
  });
  it('handles null input by returning empty string', () => {
    expect(truncate(null, 100)).toBe('');
  });
  it('handles empty string', () => {
    expect(truncate('', 100)).toBe('');
  });
});

describe('stripWaPrefix', () => {
  it('strips whatsapp: prefix from E.164', () => {
    expect(stripWaPrefix('whatsapp:+15551234567')).toBe('+15551234567');
  });
  it('returns plain E.164 unchanged', () => {
    expect(stripWaPrefix('+15551234567')).toBe('+15551234567');
  });
  it('handles empty string', () => {
    expect(stripWaPrefix('')).toBe('');
  });
});

describe('toWaRecipient', () => {
  it('adds whatsapp: prefix to bare E.164', () => {
    expect(toWaRecipient('+15551234567')).toBe('whatsapp:+15551234567');
  });
  it('is idempotent on already-prefixed value', () => {
    expect(toWaRecipient('whatsapp:+15551234567')).toBe('whatsapp:+15551234567');
  });
});

describe('extractTokenFromApprovalUrl', () => {
  it('extracts token from clean /approve/<token> URL', () => {
    expect(extractTokenFromApprovalUrl('https://app.repworth.com/approve/abc123'))
      .toBe('abc123');
  });
  it('throws on trailing slash (empty token)', () => {
    expect(() => extractTokenFromApprovalUrl('https://app.repworth.com/approve/'))
      .toThrow(/approve\/<token>|empty/i);
  });
  it('throws when URL has a query string', () => {
    expect(() => extractTokenFromApprovalUrl('https://app.repworth.com/approve/abc123?x=1'))
      .toThrow(/query string/i);
  });
  it('throws when URL has a hash fragment', () => {
    expect(() => extractTokenFromApprovalUrl('https://app.repworth.com/approve/abc123#frag'))
      .toThrow(/hash fragment/i);
  });
  it('throws for URL without /approve/ segment', () => {
    // Safety: Meta-approved template has URL base `.../approve/`. A URL
    // that doesn't follow that shape would produce a broken button.
    expect(() => extractTokenFromApprovalUrl('https://app.repworth.com/somewhere/else'))
      .toThrow(/approve\/<token>/i);
  });
  it('throws for /approve/ with trailing extra segment', () => {
    expect(() => extractTokenFromApprovalUrl('https://app.repworth.com/approve/abc/extra'))
      .toThrow(/approve\/<token>/i);
  });
  it('throws on URL with no path', () => {
    expect(() => extractTokenFromApprovalUrl('https://app.repworth.com/')).toThrow();
  });
  it('throws on empty string', () => {
    expect(() => extractTokenFromApprovalUrl('')).toThrow();
  });
  it('throws on non-URL garbage', () => {
    expect(() => extractTokenFromApprovalUrl('not a url')).toThrow();
  });
});

describe('formatApprovalWhatsApp', () => {
  const baseParams = {
    handle: '+15551234567',
    locationLabel: 'Downtown Cafe',
    businessName: 'Acme Co',
    reviewerName: 'Jane D',
    starRating: 3,
    reviewText: 'Decent coffee.',
    reviewDate: 'Apr 18',
    responsePreview: 'Thanks Jane — come back!',
    approvalUrl: 'https://app.repworth.com/approve/RAWTOKEN',
    approvalLinkId: '01JXYZ-link-id',
  };

  it('produces exactly 9 content variables', () => {
    const { contentVariables } = formatApprovalWhatsApp(baseParams, 'HX_test');
    expect(Object.keys(contentVariables).sort())
      .toEqual(['1','2','3','4','5','6','7','8','9']);
  });

  it('maps variables to the spec positions', () => {
    const { contentVariables } = formatApprovalWhatsApp(baseParams, 'HX_test');
    expect(contentVariables['1']).toBe('Acme Co');
    expect(contentVariables['2']).toBe('Jane D');
    expect(contentVariables['3']).toBe('3');
    expect(contentVariables['4']).toBe('Apr 18');
    expect(contentVariables['5']).toBe('Decent coffee.');
    expect(contentVariables['6']).toBe('Thanks Jane — come back!');
    expect(contentVariables['7']).toBe('a:01JXYZ-link-id');
    expect(contentVariables['8']).toBe('r:01JXYZ-link-id');
    expect(contentVariables['9']).toBe('RAWTOKEN');
  });

  it('substitutes "(no comment)" when reviewText is null', () => {
    const { contentVariables } = formatApprovalWhatsApp({ ...baseParams, reviewText: null }, 'HX_test');
    expect(contentVariables['5']).toBe('(no comment)');
  });

  it('truncates long review text to 400 chars', () => {
    const long = 'x'.repeat(1000);
    const { contentVariables } = formatApprovalWhatsApp({ ...baseParams, reviewText: long }, 'HX_test');
    expect(contentVariables['5']!.length).toBeLessThanOrEqual(400);
  });

  it('truncates long response preview to 400 chars', () => {
    const long = 'y'.repeat(1000);
    const { contentVariables } = formatApprovalWhatsApp({ ...baseParams, responsePreview: long }, 'HX_test');
    expect(contentVariables['6']!.length).toBeLessThanOrEqual(400);
  });

  it('returns contentSid from passed-in value (testable without env mutation)', () => {
    const { contentSid } = formatApprovalWhatsApp(baseParams, 'HX_test_sid');
    expect(contentSid).toBe('HX_test_sid');
  });

  it('falls back to env.WHATSAPP_APPROVAL_TEMPLATE_SID when contentSid arg omitted', () => {
    // The default-param now reads WHATSAPP_APPROVAL_TEMPLATE_SID via the memoized
    // getWorkerConfig() — reset the memo around the mutation so the omitted-arg
    // call re-parses the just-set value, then again after restore (convention #6).
    const prev = process.env.WHATSAPP_APPROVAL_TEMPLATE_SID;
    process.env.WHATSAPP_APPROVAL_TEMPLATE_SID = 'HX_env';
    resetWorkerConfigForTests();
    try {
      const { contentSid } = formatApprovalWhatsApp(baseParams);
      expect(contentSid).toBe('HX_env');
    } finally {
      if (prev === undefined) delete process.env.WHATSAPP_APPROVAL_TEMPLATE_SID;
      else process.env.WHATSAPP_APPROVAL_TEMPLATE_SID = prev;
      resetWorkerConfigForTests();
    }
  });

  it('uses "Reviewer" fallback when reviewerName is empty', () => {
    const { contentVariables } = formatApprovalWhatsApp({ ...baseParams, reviewerName: '' }, 'HX_test');
    expect(contentVariables['2']).toBe('Reviewer');
  });

  it('keeps the rendered card body within the 1024-char WhatsApp limit for worst-case inputs', () => {
    // Worst case: every variable far exceeds its budget. The rendered body
    // (fixed template text + all substituted variables) must still fit the
    // whatsapp/card 1024-char ceiling — a longer body trips Twilio 21656.
    const worstCase = {
      ...baseParams,
      businessName: 'B'.repeat(500),
      reviewerName: 'R'.repeat(500),
      reviewDate: 'D'.repeat(80),
      starRating: 5,
      reviewText: 'x'.repeat(5000),
      responsePreview: 'y'.repeat(5000),
    };
    const { contentVariables } = formatApprovalWhatsApp(worstCase, 'HX_test');
    const rendered = renderApprovalCardBody(contentVariables);
    expect(rendered.length).toBeLessThanOrEqual(1024);
  });

  it('clamps over-long business and reviewer names to keep the body budget provable', () => {
    const { contentVariables } = formatApprovalWhatsApp(
      { ...baseParams, businessName: 'B'.repeat(300), reviewerName: 'R'.repeat(300) },
      'HX_test',
    );
    expect(contentVariables['1']!.length).toBeLessThanOrEqual(100);
    expect(contentVariables['2']!.length).toBeLessThanOrEqual(100);
  });
});

describe('formatAutoPostNoticeWhatsApp', () => {
  const baseParams = {
    businessName: 'Acme Coffee',
    reviewerName: 'Jane Doe',
    starRating: 5,
    responseId: '0190b0c0-0000-7000-8000-000000000abc',
  };

  it('collapses whitespace and clamps over-long names (mirrors the approval template fix for 21656)', () => {
    const { contentVariables } = formatAutoPostNoticeWhatsApp(
      {
        ...baseParams,
        businessName: 'B'.repeat(300),
        reviewerName: 'R\n\nlong\t\tname'.padEnd(300, 'x'),
      },
      'HX_autopost_test',
    );
    expect(contentVariables['1']!.length).toBeLessThanOrEqual(100);
    expect(contentVariables['2']!.length).toBeLessThanOrEqual(100);
    // oneLine() must strip every newline/tab/4+ space run (Meta policy / 21656).
    expect(contentVariables['1']).not.toMatch(/[\n\t]|\s{4,}/);
    expect(contentVariables['2']).not.toMatch(/[\n\t]|\s{4,}/);
  });

  it('falls back to "Reviewer" for an empty reviewer name', () => {
    const { contentVariables } = formatAutoPostNoticeWhatsApp(
      { ...baseParams, reviewerName: '' },
      'HX_autopost_test',
    );
    expect(contentVariables['2']).toBe('Reviewer');
  });
});

describe('formatEscalationNoticeWhatsApp', () => {
  it('maps template variables and clamps names', () => {
    const { contentSid, contentVariables } = formatEscalationNoticeWhatsApp(
      {
        businessName: 'Acme Diner',
        reviewerName: 'Jane D',
        starRating: 1,
        severity: 'high',
        isFallback: false,
        escalationId: 'esc-1',
      },
      'HXescalation',
    );
    expect(contentSid).toBe('HXescalation');
    expect(contentVariables).toEqual({
      '1': 'Acme Diner',
      '2': 'Jane D',
      '3': '1',
      '4': 'High severity',
      '5': 'esc-1',
    });
  });

  it('renders a rating-less review as "–"', () => {
    const { contentVariables } = formatEscalationNoticeWhatsApp(
      { businessName: 'A', reviewerName: 'B', starRating: null, severity: 'low', isFallback: true, escalationId: 'e' },
      'HX1',
    );
    expect(contentVariables['3']).toBe('–');
  });

  it('renders the humanized severity label for a non-fallback escalation', () => {
    const { contentVariables } = formatEscalationNoticeWhatsApp(
      { businessName: 'A', reviewerName: 'B', starRating: 5, severity: 'high', isFallback: false, escalationId: 'e' },
      'HX1',
    );
    expect(contentVariables['4']).toBe('High severity');
  });

  it('renders "Needs a look" for a fallback-sourced escalation regardless of severity', () => {
    const { contentVariables } = formatEscalationNoticeWhatsApp(
      { businessName: 'A', reviewerName: 'B', starRating: 5, severity: 'high', isFallback: true, escalationId: 'e' },
      'HX1',
    );
    expect(contentVariables['4']).toBe('Needs a look');
  });
});

describe('formatPendingPostNoticeWhatsApp', () => {
  const now = new Date('2026-07-09T14:00:00.000Z');
  const params = {
    businessName: 'Acme Diner',
    reviewerName: 'Jane D',
    starRating: 5,
    reviewText: 'Wonderful service',
    responsePreview: 'Thank you Jane!',
    scheduledPostAt: new Date('2026-07-09T14:30:00.000Z'),
    approveUrl: 'https://app.repworth.com/approve/TOKEN123',
    now,
  };

  it('maps template variables including the combined time phrase and token suffix', () => {
    const { contentSid, contentVariables } = formatPendingPostNoticeWhatsApp(params, 'HXpending');
    expect(contentSid).toBe('HXpending');
    expect(contentVariables).toEqual({
      '1': 'Acme Diner',
      '2': 'Jane D',
      '3': '5',
      '4': '14:30 UTC (in about 30 minutes)',
      '5': 'Wonderful service',
      '6': 'Thank you Jane!',
      '7': 'TOKEN123',
    });
  });

  it('renders "(no comment)" for a rating-only review', () => {
    const { contentVariables } = formatPendingPostNoticeWhatsApp({ ...params, reviewText: null }, 'HX1');
    expect(contentVariables['5']).toBe('(no comment)');
  });

  it('flattens and truncates free-text variables within the card body budget', () => {
    const { contentVariables } = formatPendingPostNoticeWhatsApp(
      { ...params, reviewText: 'line1\nline2\t' + 'r'.repeat(500), responsePreview: 'd'.repeat(500) },
    'HX1');
    expect(contentVariables['5']).toContain('line1 line2');
    expect(contentVariables['5']!.length).toBeLessThanOrEqual(400);
    expect(contentVariables['5']!.endsWith('…')).toBe(true);
    expect(contentVariables['6']!.length).toBeLessThanOrEqual(400);
    expect(contentVariables['6']!.endsWith('…')).toBe(true);
  });

  it('clamps pathological business and reviewer names', () => {
    const { contentVariables } = formatPendingPostNoticeWhatsApp(
      { ...params, businessName: 'B'.repeat(300), reviewerName: '' },
      'HX1',
    );
    expect(contentVariables['1']!.length).toBeLessThanOrEqual(100);
    expect(contentVariables['2']).toBe('Reviewer');
  });
});
