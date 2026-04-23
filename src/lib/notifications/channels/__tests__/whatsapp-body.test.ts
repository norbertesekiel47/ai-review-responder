import { describe, it, expect } from 'vitest';
import {
  formatApprovalWhatsApp,
  extractTokenFromApprovalUrl,
  stripWaPrefix,
  toWaRecipient,
  truncate,
} from '../whatsapp-body';

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
    const prev = process.env.WHATSAPP_APPROVAL_TEMPLATE_SID;
    process.env.WHATSAPP_APPROVAL_TEMPLATE_SID = 'HX_env';
    try {
      const { contentSid } = formatApprovalWhatsApp(baseParams);
      expect(contentSid).toBe('HX_env');
    } finally {
      if (prev === undefined) delete process.env.WHATSAPP_APPROVAL_TEMPLATE_SID;
      else process.env.WHATSAPP_APPROVAL_TEMPLATE_SID = prev;
    }
  });

  it('uses "Reviewer" fallback when reviewerName is empty', () => {
    const { contentVariables } = formatApprovalWhatsApp({ ...baseParams, reviewerName: '' }, 'HX_test');
    expect(contentVariables['2']).toBe('Reviewer');
  });
});
