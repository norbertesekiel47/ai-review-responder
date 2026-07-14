// src/lib/notifications/channels/email-channel.ts
//
// EmailChannel wraps the existing sendApprovalEmail(). All Resend-specific
// logic (template builders, categories, tags) stays in src/lib/notifications/email.ts;
// this class just adapts that call to the NotificationChannel interface.

import {
  sendApprovalEmail,
  sendAutoPostNoticeEmail,
  sendEscalationNoticeEmail,
  sendPendingPostNoticeEmail,
  sendAutonomySuspendedNoticeEmail,
} from '../email';
import { getWorkerConfig } from '@/lib/config/worker';
import type {
  NotificationChannel,
  SendApprovalParams,
  SendApprovalResult,
  SendAutoPostNoticeParams,
  SendAutoPostNoticeResult,
  SendEscalationNoticeParams,
  SendEscalationNoticeResult,
  SendPendingPostNoticeParams,
  SendPendingPostNoticeResult,
  SendAutonomySuspendedNoticeParams,
  SendAutonomySuspendedNoticeResult,
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

  // Interface-dispatched via getChannel(id).sendEscalationNotice in the
  // escalation-notice worker; fallow's member graph misses interface dispatch.
  // fallow-ignore-next-line unused-class-member
  async sendEscalationNotice(p: SendEscalationNoticeParams): Promise<SendEscalationNoticeResult> {
    const from = getWorkerConfig().RESEND_FROM_EMAIL;
    if (!from) {
      throw new Error('RESEND_FROM_EMAIL not configured');
    }

    const { messageId } = await sendEscalationNoticeEmail({
      to: p.handle,
      from,
      locationLabel: p.locationLabel,
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

  // Interface-dispatched via getChannel(id).sendPendingPostNotice in the
  // pending-post-notice worker (Task 7); fallow's member graph misses
  // interface dispatch.
  // fallow-ignore-next-line unused-class-member
  async sendPendingPostNotice(p: SendPendingPostNoticeParams): Promise<SendPendingPostNoticeResult> {
    const from = getWorkerConfig().RESEND_FROM_EMAIL;
    if (!from) {
      throw new Error('RESEND_FROM_EMAIL not configured');
    }

    const { messageId } = await sendPendingPostNoticeEmail({
      to: p.handle,
      from,
      locationLabel: p.locationLabel,
      reviewerName: p.reviewerName,
      starRating: p.starRating,
      reviewText: p.reviewText,
      responsePreview: p.responsePreview,
      scheduledPostAt: p.scheduledPostAt,
      approveUrl: p.approveUrl,
      idempotencyKey: `pending_post_notice:${p.responseId}`,
    });

    return { status: 'sent', externalMessageId: messageId };
  }

  async sendAutonomySuspendedNotice(
    p: SendAutonomySuspendedNoticeParams,
  ): Promise<SendAutonomySuspendedNoticeResult> {
    const from = getWorkerConfig().RESEND_FROM_EMAIL;
    if (!from) throw new Error('RESEND_FROM_EMAIL not configured');
    const { messageId } = await sendAutonomySuspendedNoticeEmail({
      to: p.handle,
      from,
      accountName: p.accountName,
      reason: p.reason,
      settingsUrl: p.settingsUrl,
      supportUrl: p.supportUrl,
      idempotencyKey: `autonomy_suspended_notice:${p.suspensionEventId}`,
    });
    return { status: 'sent', externalMessageId: messageId };
  }
}
