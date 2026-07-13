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

import {
  formatApprovalWhatsApp,
  formatAutoPostNoticeWhatsApp,
  formatEscalationNoticeWhatsApp,
  formatPendingPostNoticeWhatsApp,
  toWaRecipient,
} from './whatsapp-body';
import { WhatsAppClient } from './whatsapp-client';
import { getWorkerConfig } from '@/lib/config/worker';
import { getWorkerPublicUrl } from '@/lib/shared/worker-public-url';
import type {
  NotificationChannel,
  ChannelId,
  SendApprovalParams,
  SendApprovalResult,
  SendAutoPostNoticeParams,
  SendAutoPostNoticeResult,
  SendEscalationNoticeParams,
  SendEscalationNoticeResult,
  SendPendingPostNoticeParams,
  SendPendingPostNoticeResult,
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
    const contentSid = getWorkerConfig().WHATSAPP_AUTOPOST_TEMPLATE_SID;
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

  // Interface-dispatched via getChannel(id).sendEscalationNotice in the
  // escalation-notice worker; fallow's member graph misses interface dispatch.
  // fallow-ignore-next-line unused-class-member
  async sendEscalationNotice(p: SendEscalationNoticeParams): Promise<SendEscalationNoticeResult> {
    // Business-initiated → outside any 24h session window → approved template
    // only (ADR 0003). Until WHATSAPP_ESCALATION_TEMPLATE_SID is set, skip
    // cleanly — email + Telegram still send.
    const contentSid = getWorkerConfig().WHATSAPP_ESCALATION_TEMPLATE_SID;
    if (!contentSid) {
      return { status: 'skipped', reason: 'whatsapp_escalation_template_unset' };
    }

    const { contentVariables } = formatEscalationNoticeWhatsApp(
      {
        businessName: p.businessName,
        reviewerName: p.reviewerName,
        starRating: p.starRating,
        severity: p.severity,
        isFallback: p.isFallback,
        escalationId: p.escalationId,
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

  async sendPendingPostNotice(p: SendPendingPostNoticeParams): Promise<SendPendingPostNoticeResult> {
    // Business-initiated → outside any 24h session window → approved template
    // only (ADR 0003). Until WHATSAPP_PENDING_POST_TEMPLATE_SID is set, skip
    // cleanly — email + Telegram still send.
    const contentSid = getWorkerConfig().WHATSAPP_PENDING_POST_TEMPLATE_SID;
    if (!contentSid) {
      return { status: 'skipped', reason: 'whatsapp_pending_post_template_unset' };
    }

    const { contentVariables } = formatPendingPostNoticeWhatsApp(
      {
        businessName: p.businessName,
        reviewerName: p.reviewerName,
        starRating: p.starRating,
        reviewText: p.reviewText,
        responsePreview: p.responsePreview,
        scheduledPostAt: p.scheduledPostAt,
        approveUrl: p.approveUrl,
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
