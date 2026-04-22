import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }));

vi.mock('twilio', () => ({
  default: vi.fn(() => ({ messages: { create: mockCreate } })),
}));

import { SmsChannel, SmsRecipientUnsubscribedError } from '../sms-channel';

function sampleParams() {
  return {
    handle: '+15551234567',
    businessName: 'Test Biz',
    reviewerName: 'Jane Doe',
    starRating: 3,
    reviewText: null,
    reviewDate: '2026-04-01',
    responsePreview: 'Thanks for the feedback!',
    approvalUrl: 'https://app.repworth.net/approve/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    approvalLinkId: 'link-id-1',
  };
}

describe('SmsChannel', () => {
  beforeEach(() => {
    mockCreate.mockReset();
    process.env.TWILIO_ACCOUNT_SID = 'ACtest';
    process.env.TWILIO_AUTH_TOKEN = 'token';
    process.env.TWILIO_MESSAGING_SERVICE_SID = 'MGtest';
    process.env.WORKER_PUBLIC_URL = 'https://worker.example.com';
  });

  it('exposes the correct NotificationChannel identity flags', () => {
    const ch = new SmsChannel();
    expect(ch.id).toBe('sms');
    expect(ch.supportsInlineActions).toBe(false);
    expect(ch.requiresOptInHandshake).toBe(false);
  });

  it('returns externalMessageId on successful send', async () => {
    mockCreate.mockResolvedValueOnce({ sid: 'SMabc123' });
    const result = await new SmsChannel().sendApprovalRequest(sampleParams());
    expect(result.externalMessageId).toBe('SMabc123');
  });

  it('calls Twilio with the expected messagingServiceSid, to, and statusCallback', async () => {
    mockCreate.mockResolvedValueOnce({ sid: 'SMabc123' });
    await new SmsChannel().sendApprovalRequest(sampleParams());
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
      messagingServiceSid: 'MGtest',
      to: '+15551234567',
      statusCallback: 'https://worker.example.com/ingress/twilio/status',
    }));
  });

  it('body passes through formatApprovalSms — contains the star rating and approval URL', async () => {
    mockCreate.mockResolvedValueOnce({ sid: 'SMabc' });
    const p = sampleParams();
    await new SmsChannel().sendApprovalRequest(p);
    const args = mockCreate.mock.calls[0]![0] as { body: string };
    expect(args.body).toMatch(/New 3-star review/);
    expect(args.body).toContain(p.approvalUrl);
    expect(args.body).toContain('Reply STOP to unsubscribe.');
    expect(args.body.length).toBeLessThanOrEqual(160);
  });

  it('maps 21610 Twilio error to SmsRecipientUnsubscribedError', async () => {
    mockCreate.mockRejectedValueOnce({ code: 21610, message: 'unsubscribed' });
    await expect(new SmsChannel().sendApprovalRequest(sampleParams())).rejects.toBeInstanceOf(SmsRecipientUnsubscribedError);
  });

  it('re-throws non-21610 Twilio errors untouched', async () => {
    const err = new Error('network broke');
    mockCreate.mockRejectedValueOnce(err);
    await expect(new SmsChannel().sendApprovalRequest(sampleParams())).rejects.toBe(err);
  });

  it('re-throws Twilio RestException with different code untouched', async () => {
    const err = Object.assign(new Error('invalid to'), { code: 21211 });
    mockCreate.mockRejectedValueOnce(err);
    await expect(new SmsChannel().sendApprovalRequest(sampleParams())).rejects.toBe(err);
  });
});
