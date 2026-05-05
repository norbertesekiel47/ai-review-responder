// src/lib/notifications/channels/whatsapp-channel.ts
//
// NotificationChannel implementation for WhatsApp. Wires the pure body
// formatter (whatsapp-body.ts) to the Twilio client (whatsapp-client.ts).
// Cross-cutting concerns — enrollment-state flipping on owner-intent errors,
// config-error admin alerts, transient-error retry — live in the dispatcher
// (worker/jobs/notification/NotificationWorker.ts), not here.
//
// Side-effect-free at import (Phase 3 spec §2.0 rule 2): no env reads at module
// scope; no client construction until sendApprovalRequest() runs.

import { formatApprovalWhatsApp, toWaRecipient } from './whatsapp-body';
import { WhatsAppClient } from './whatsapp-client';
import type { NotificationChannel, ChannelId, SendApprovalParams, SendApprovalResult } from './types';

export class WhatsAppChannel implements NotificationChannel {
  readonly id: ChannelId = 'whatsapp';
  readonly supportsInlineActions = true;
  readonly requiresOptInHandshake = true;

  async sendApprovalRequest(p: SendApprovalParams): Promise<SendApprovalResult> {
    const { contentSid, contentVariables } = formatApprovalWhatsApp(p);
    const client = new WhatsAppClient();
    const result = await client.sendTemplate({
      to: toWaRecipient(p.handle),
      contentSid,
      contentVariables,
      statusCallback: `${process.env.WORKER_PUBLIC_URL}/ingress/twilio/whatsapp-status`,
    });
    return { externalMessageId: result.externalMessageId };
  }
}
