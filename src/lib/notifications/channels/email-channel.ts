// src/lib/notifications/channels/email-channel.ts
//
// EmailChannel wraps the existing sendApprovalEmail(). All Resend-specific
// logic (template builders, categories, tags) stays in src/lib/notifications/email.ts;
// this class just adapts that call to the NotificationChannel interface.

import { sendApprovalEmail, sendAutoPostNoticeEmail, sendEscalationNoticeEmail } from '../email';
import { getWorkerConfig } from '@/lib/config/worker';
import type {
  NotificationChannel,
  SendApprovalParams,
  SendApprovalResult,
  SendAutoPostNoticeParams,
  SendAutoPostNoticeResult,
  SendEscalationNoticeParams,
  SendEscalationNoticeResult,
} from './types';

export class EmailChannel implements NotificationChannel {
  readonly id = 'email' as const;
  readonly supportsInlineActions = false;
  readonly requiresOptInHandshake = false;

  async sendApprovalRequest(p: SendApprovalParams): Promise<SendApprovalResult> {
    const from = getWorkerConfig().RESEND_FROM_EMAIL;
    if (!from) {
      throw new Error('RESEND_FROM_EMAIL not configured');
    }

    const { messageId } = await sendApprovalEmail({
      to: p.handle,
      from,
      locationLabel: p.locationLabel,
      businessName: p.businessName,
      reviewerName: p.reviewerName,
      starRating: p.starRating,
      reviewText: p.reviewText,
      reviewDate: p.reviewDate,
      responsePreview: p.responsePreview,
      approvalUrl: p.approvalUrl,
      idempotencyKey: p.idempotencyKey,
    });

    return { externalMessageId: messageId };
  }

  async sendAutoPostNotice(p: SendAutoPostNoticeParams): Promise<SendAutoPostNoticeResult> {
    const from = getWorkerConfig().RESEND_FROM_EMAIL;
    if (!from) {
      throw new Error('RESEND_FROM_EMAIL not configured');
    }

    const { messageId } = await sendAutoPostNoticeEmail({
      to: p.handle,
      from,
      locationLabel: p.locationLabel,
      businessName: p.businessName,
      reviewerName: p.reviewerName,
      starRating: p.starRating,
      googleMapsUrl: p.googleMapsUrl,
      viewUrl: p.viewUrl,
      idempotencyKey: `auto_post_notice:${p.responseId}`,
    });

    return { status: 'sent', externalMessageId: messageId };
  }

  async sendEscalationNotice(p: SendEscalationNoticeParams): Promise<SendEscalationNoticeResult> {
    const from = getWorkerConfig().RESEND_FROM_EMAIL;
    if (!from) {
      throw new Error('RESEND_FROM_EMAIL not configured');
    }

    const { messageId } = await sendEscalationNoticeEmail({
      to: p.handle,
      from,
      locationLabel: p.locationLabel,
      businessName: p.businessName,
      reviewerName: p.reviewerName,
      starRating: p.starRating,
      reviewText: p.reviewText,
      severity: p.severity,
      issues: p.issues,
      isFallback: p.isFallback,
      dashboardUrl: p.dashboardUrl,
      idempotencyKey: `escalation_notice:${p.escalationId}`,
    });

    return { status: 'sent', externalMessageId: messageId };
  }
}
