// src/lib/notifications/channels/sms-channel.ts
//
// NotificationChannel implementation for SMS via Twilio Programmable SMS
// routed through a Messaging Service (TWILIO_MESSAGING_SERVICE_SID).
//
// Cross-cutting concerns (cost reservation, enrollment status flipping on
// 21610, failed-delivery recording) live in the dispatcher — not here.
// This class only owns:
//   - Format the body (sms-body.ts)
//   - Call Twilio messages.create
//   - Map 21610 to a typed error the dispatcher can pattern-match

import twilio from 'twilio';
import { formatApprovalSms } from '../sms-body';
import type { NotificationChannel, ChannelId, SendApprovalParams, SendApprovalResult } from './types';

export class SmsRecipientUnsubscribedError extends Error {
  constructor() {
    super('sms_recipient_unsubscribed');
    this.name = 'SmsRecipientUnsubscribedError';
  }
}

function isUnsubscribedError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: number }).code === 21610;
}

export class SmsChannel implements NotificationChannel {
  readonly id: ChannelId = 'sms';
  readonly supportsInlineActions = false;
  readonly requiresOptInHandshake = false;

  async sendApprovalRequest(p: SendApprovalParams): Promise<SendApprovalResult> {
    const body = formatApprovalSms({
      reviewerName: p.reviewerName,
      starRating: p.starRating,
      approvalUrl: p.approvalUrl,
    });
    const client = twilio(process.env.TWILIO_ACCOUNT_SID!, process.env.TWILIO_AUTH_TOKEN!);
    try {
      const msg = await client.messages.create({
        messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID!,
        to: p.handle,
        body,
        statusCallback: `${process.env.WORKER_PUBLIC_URL}/ingress/twilio/status`,
      });
      return { externalMessageId: msg.sid };
    } catch (err) {
      if (isUnsubscribedError(err)) throw new SmsRecipientUnsubscribedError();
      throw err;
    }
  }
}
