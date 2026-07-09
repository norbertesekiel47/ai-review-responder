import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSendTemplate = vi.fn();
vi.mock('../whatsapp-client', async () => {
  const actual = await vi.importActual<typeof import('../whatsapp-client')>('../whatsapp-client');
  return {
    ...actual,
    WhatsAppClient: class {
      sendTemplate = mockSendTemplate;
    },
  };
});

import { WhatsAppChannel } from '../whatsapp-channel';
import { WhatsAppRecipientBlockedError } from '../whatsapp-client';
import { resetWorkerConfigForTests } from '@/lib/config/worker';

describe('WhatsAppChannel', () => {
  beforeEach(() => {
    mockSendTemplate.mockReset();
    // formatApprovalWhatsApp's default-param now reads WHATSAPP_APPROVAL_TEMPLATE_SID
    // via the memoized getWorkerConfig() — reset the memo so each send re-parses
    // the just-set value (convention #6).
    process.env.WHATSAPP_APPROVAL_TEMPLATE_SID = 'HX_test';
    process.env.WORKER_PUBLIC_URL = 'https://worker.example.com';
    process.env.TWILIO_WHATSAPP_NUMBER = 'whatsapp:+14155238886';
    process.env.TWILIO_ACCOUNT_SID = 'AC_test';
    process.env.TWILIO_AUTH_TOKEN = 'auth_test';
    resetWorkerConfigForTests();
  });

  it('supports inline actions and requires opt-in handshake', () => {
    const ch = new WhatsAppChannel();
    expect(ch.id).toBe('whatsapp');
    expect(ch.supportsInlineActions).toBe(true);
    expect(ch.requiresOptInHandshake).toBe(true);
  });

  it('sends a template and returns the external message id', async () => {
    mockSendTemplate.mockResolvedValueOnce({ externalMessageId: 'SM_sent' });
    const ch = new WhatsAppChannel();
    const out = await ch.sendApprovalRequest({
      handle: '+15551234567',
      locationLabel: 'Downtown Cafe',
      businessName: 'Acme',
      reviewerName: 'Jane',
      starRating: 3,
      reviewText: 'ok',
      reviewDate: 'Apr 18',
      responsePreview: 'Thanks!',
      approvalUrl: 'https://app.repworth.com/approve/TOKEN',
      approvalLinkId: 'LINKID',
    });
    expect(out).toEqual({ externalMessageId: 'SM_sent' });

    expect(mockSendTemplate).toHaveBeenCalledWith({
      to: 'whatsapp:+15551234567',
      contentSid: 'HX_test',
      contentVariables: expect.objectContaining({
        '1': 'Acme', '2': 'Jane', '3': '3', '7': 'a:LINKID', '8': 'r:LINKID', '9': 'TOKEN',
      }),
      statusCallback: 'https://worker.example.com/ingress/twilio/whatsapp-status',
    });
  });

  describe('sendPendingPostNotice', () => {
    const params = {
      handle: '+15551234567',
      locationLabel: 'Downtown Cafe',
      businessName: 'Acme',
      reviewerName: 'Jane',
      starRating: 5,
      reviewText: 'Great!',
      responsePreview: 'Thanks Jane!',
      scheduledPostAt: new Date(Date.now() + 30 * 60_000),
      approveUrl: 'https://app.repworth.com/approve/TOKEN123',
      responseId: 'resp-1',
    };

    it('fails closed (skipped, no send) when WHATSAPP_PENDING_POST_TEMPLATE_SID is unset', async () => {
      delete process.env.WHATSAPP_PENDING_POST_TEMPLATE_SID;
      resetWorkerConfigForTests();
      const ch = new WhatsAppChannel();
      const out = await ch.sendPendingPostNotice(params);
      expect(out).toEqual({ status: 'skipped', reason: 'whatsapp_pending_post_template_unset' });
      expect(mockSendTemplate).not.toHaveBeenCalled();
    });

    it('sends the approved template with the token URL suffix when the SID is set', async () => {
      process.env.WHATSAPP_PENDING_POST_TEMPLATE_SID = 'HX_pending';
      resetWorkerConfigForTests();
      mockSendTemplate.mockResolvedValueOnce({ externalMessageId: 'SM_pending' });
      const ch = new WhatsAppChannel();
      const out = await ch.sendPendingPostNotice(params);
      expect(out).toEqual({ status: 'sent', externalMessageId: 'SM_pending' });
      expect(mockSendTemplate).toHaveBeenCalledWith({
        to: 'whatsapp:+15551234567',
        contentSid: 'HX_pending',
        contentVariables: expect.objectContaining({
          '1': 'Acme', '2': 'Jane', '3': '5', '7': 'TOKEN123',
        }),
        statusCallback: 'https://worker.example.com/ingress/twilio/whatsapp-status',
      });
    });
  });

  it('propagates WhatsAppRecipientBlockedError unchanged', async () => {
    mockSendTemplate.mockRejectedValueOnce(new WhatsAppRecipientBlockedError(63014));
    const ch = new WhatsAppChannel();
    await expect(ch.sendApprovalRequest({
      handle: '+15551234567', locationLabel: 'X', businessName: 'X', reviewerName: 'Y', starRating: 3,
      reviewText: 'r', reviewDate: 'd', responsePreview: 'p',
      approvalUrl: 'https://app.repworth.com/approve/T', approvalLinkId: 'L',
    })).rejects.toBeInstanceOf(WhatsAppRecipientBlockedError);
  });
});
