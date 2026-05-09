import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSend = vi.fn();

vi.mock('resend', () => ({
  Resend: class {
    emails = { send: (...args: unknown[]) => mockSend(...args) };
  },
}));

vi.mock('@/lib/shared/mock-mode', () => ({
  isMockMode: vi.fn().mockReturnValue(false),
}));

import { sendApprovalEmail, sendInternalEmail } from '../email';

describe('sendApprovalEmail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockResolvedValue({ data: { id: 'msg-1' }, error: null });
    process.env.RESEND_API_KEY = 'test';
  });

  it('sends with NO List-Unsubscribe header (transactional)', async () => {
    await sendApprovalEmail({
      to: 'owner@example.com',
      from: 'RepWorth <notifications@repworth.example>',
      locationLabel: 'Test Biz',
      businessName: 'Test Biz',
      reviewerName: 'Jane',
      starRating: 5,
      reviewText: 'Great!',
      reviewDate: '2026-04-17',
      responsePreview: 'Thanks Jane!',
      approvalUrl: 'https://app.example/approve/xxx',
    });

    expect(mockSend).toHaveBeenCalledOnce();
    const arg = mockSend.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(arg.headers).toBeUndefined();
    // Still tags the email as transactional for Resend dashboard filtering
    expect(arg.tags).toEqual([{ name: 'category', value: 'transactional' }]);
  });
});

describe('sendInternalEmail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockResolvedValue({ data: { id: 'msg-2' }, error: null });
    process.env.RESEND_API_KEY = 'test';
    process.env.RESEND_FROM_EMAIL = 'RepWorth <notifications@repworth.example>';
  });

  it('defaults to internal category (no List-Unsubscribe)', async () => {
    await sendInternalEmail({
      to: 'admin@example.com',
      subject: 'Test',
      bodyHtml: '<p>hi</p>',
    });
    const arg = mockSend.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(arg.headers).toBeUndefined();
    expect(arg.tags).toEqual([{ name: 'category', value: 'internal' }]);
  });

  it('sends marketing emails with mailto List-Unsubscribe (no Post header without HTTPS URL)', async () => {
    // Default config: no LIST_UNSUBSCRIBE_URL → mailto-only form.
    delete process.env.LIST_UNSUBSCRIBE_URL;
    await sendInternalEmail({
      to: 'owner@example.com',
      subject: 'Your weekly report',
      bodyHtml: '<p>report</p>',
      category: 'marketing',
    });
    const arg = mockSend.mock.calls[0]?.[0] as Record<string, unknown>;
    const headers = arg.headers as Record<string, string>;
    expect(headers['List-Unsubscribe']).toMatch(/^<mailto:/);
    // Post header MUST NOT appear without an HTTPS URL — RFC 8058.
    expect(headers['List-Unsubscribe-Post']).toBeUndefined();
    expect(arg.tags).toEqual([{ name: 'category', value: 'marketing' }]);
  });

  it('sends marketing emails with both forms + Post header when LIST_UNSUBSCRIBE_URL is set', async () => {
    process.env.LIST_UNSUBSCRIBE_URL = 'https://repworth.example/unsub?t=xyz';
    try {
      await sendInternalEmail({
        to: 'owner@example.com',
        subject: 'Your weekly report',
        bodyHtml: '<p>report</p>',
        category: 'marketing',
      });
    } finally {
      delete process.env.LIST_UNSUBSCRIBE_URL;
    }
    const arg = mockSend.mock.calls[0]?.[0] as Record<string, unknown>;
    const headers = arg.headers as Record<string, string>;
    expect(headers['List-Unsubscribe']).toMatch(/^<https:/);
    expect(headers['List-Unsubscribe']).toContain('<mailto:');
    expect(headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
  });

  it('sends explicit internal category with no List-Unsubscribe', async () => {
    await sendInternalEmail({
      to: 'admin@example.com',
      subject: 'Exception alert',
      bodyHtml: '<p>alert</p>',
      category: 'internal',
    });
    const arg = mockSend.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(arg.headers).toBeUndefined();
    expect(arg.tags).toEqual([{ name: 'category', value: 'internal' }]);
  });
});
