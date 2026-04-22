// src/lib/notifications/channels/__tests__/email-channel.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSendApprovalEmail } = vi.hoisted(() => ({
  mockSendApprovalEmail: vi.fn(),
}));

vi.mock('../../email', () => ({
  sendApprovalEmail: mockSendApprovalEmail,
}));

import { EmailChannel } from '../email-channel';

describe('EmailChannel', () => {
  beforeEach(() => {
    mockSendApprovalEmail.mockReset();
    process.env.RESEND_FROM_EMAIL = 'RepWorth <notifications@example.com>';
  });

  it('exposes the expected capabilities', () => {
    const ch = new EmailChannel();
    expect(ch.id).toBe('email');
    expect(ch.supportsInlineActions).toBe(false);
    expect(ch.requiresOptInHandshake).toBe(false);
  });

  it('forwards approval params to sendApprovalEmail and returns the messageId', async () => {
    mockSendApprovalEmail.mockResolvedValueOnce({ messageId: 'resend-msg-123' });
    const ch = new EmailChannel();

    const result = await ch.sendApprovalRequest({
      handle: 'owner@example.com',
      businessName: 'Gjelina',
      reviewerName: 'Jane',
      starRating: 4,
      reviewText: 'Great food',
      reviewDate: '2026-04-01',
      responsePreview: 'Thank you Jane!',
      approvalUrl: 'https://repworth.example.com/approve/tok-abc',
      approvalLinkId: '019d9f0e-566b-730d-8097-fd67a51559d9',
    });

    expect(result).toEqual({ externalMessageId: 'resend-msg-123' });
    expect(mockSendApprovalEmail).toHaveBeenCalledTimes(1);
    expect(mockSendApprovalEmail).toHaveBeenCalledWith({
      to: 'owner@example.com',
      from: 'RepWorth <notifications@example.com>',
      businessName: 'Gjelina',
      reviewerName: 'Jane',
      starRating: 4,
      reviewText: 'Great food',
      reviewDate: '2026-04-01',
      responsePreview: 'Thank you Jane!',
      approvalUrl: 'https://repworth.example.com/approve/tok-abc',
    });
  });

  it('throws when RESEND_FROM_EMAIL is not set', async () => {
    delete process.env.RESEND_FROM_EMAIL;
    const ch = new EmailChannel();

    await expect(
      ch.sendApprovalRequest({
        handle: 'x@y.com', businessName: 'b', reviewerName: 'r',
        starRating: 3, reviewText: null, reviewDate: '2026-04-01',
        responsePreview: 'p', approvalUrl: 'u', approvalLinkId: 'id-1',
      }),
    ).rejects.toThrow(/RESEND_FROM_EMAIL/);
  });

  it('propagates the underlying Resend error on failure', async () => {
    mockSendApprovalEmail.mockRejectedValueOnce(new Error('Resend 5xx'));
    const ch = new EmailChannel();

    await expect(
      ch.sendApprovalRequest({
        handle: 'x@y.com', businessName: 'b', reviewerName: 'r',
        starRating: 3, reviewText: null, reviewDate: '2026-04-01',
        responsePreview: 'p', approvalUrl: 'u', approvalLinkId: 'id-1',
      }),
    ).rejects.toThrow(/Resend 5xx/);
  });
});

import { getChannel } from '../index';
import type { ChannelId } from '../types';

describe('getChannel factory', () => {
  it('returns an EmailChannel for id "email"', () => {
    const ch = getChannel('email');
    expect(ch.id).toBe('email');
    expect(ch).toBeInstanceOf(EmailChannel);
  });

  it('throws for an unknown channel id', () => {
    expect(() => getChannel('discord' as ChannelId)).toThrow(/unknown channel/i);
  });

  it('throws for a not-yet-implemented channel (whatsapp)', () => {
    expect(() => getChannel('whatsapp')).toThrow(/not yet implemented/i);
  });

  it('throws for telegram when flag is disabled', () => {
    delete process.env.CHANNELS_TELEGRAM_ENABLED;
    expect(() => getChannel('telegram')).toThrow(/CHANNELS_TELEGRAM_ENABLED/);
  });
});
