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

import { formatApprovalWhatsApp, formatAutoPostNoticeWhatsApp, toWaRecipient } from './whatsapp-body';
import { WhatsAppClient } from './whatsapp-client';
import { getWorkerPublicUrl } from '@/lib/shared/worker-public-url';
import type {
  NotificationChannel,
  ChannelId,
  SendApprovalParams,
  SendApprovalResult,
  SendAutoPostNoticeParams,
  SendAutoPostNoticeResult,
} from './types';

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
      statusCallback: `${getWorkerPublicUrl()}/ingress/twilio/whatsapp-status`,
    });
    return { externalMessageId: result.externalMessageId };
  }

  async sendAutoPostNotice(p: SendAutoPostNoticeParams): Promise<SendAutoPostNoticeResult> {
    // Graceful degradation (B7): the FYI needs its own approved Meta template.
    // Until WHATSAPP_AUTOPOST_TEMPLATE_SID is set, skip WhatsApp cleanly —
    // email + Telegram still send. No enrollment flip, no job failure. The
    // dispatcher also pre-filters this, but the channel is self-protecting.
    const contentSid = process.env.WHATSAPP_AUTOPOST_TEMPLATE_SID;
    if (!contentSid) {
      return { status: 'skipped', reason: 'whatsapp_autopost_template_unset' };
    }

    const { contentVariables } = formatAutoPostNoticeWhatsApp(
      {
        businessName: p.businessName,
        reviewerName: p.reviewerName,
        starRating: p.starRating,
        responseId: p.responseId,
      },
      contentSid,
    );
    const client = new WhatsAppClient();
    const result = await client.sendTemplate({
      to: toWaRecipient(p.handle),
      contentSid,
      contentVariables,
      statusCallback: `${getWorkerPublicUrl()}/ingress/twilio/whatsapp-status`,
    });
    return { status: 'sent', externalMessageId: result.externalMessageId };
  }
}
