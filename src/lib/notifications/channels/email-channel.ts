// src/lib/notifications/channels/email-channel.ts
//
// EmailChannel wraps the existing sendApprovalEmail(). All Resend-specific
// logic (template builders, categories, tags) stays in src/lib/notifications/email.ts;
// this class just adapts that call to the NotificationChannel interface.

import { sendApprovalEmail } from '../email';
import type { NotificationChannel, SendApprovalParams, SendApprovalResult } from './types';

export class EmailChannel implements NotificationChannel {
  readonly id = 'email' as const;
  readonly supportsInlineActions = false;
  readonly requiresOptInHandshake = false;

  async sendApprovalRequest(p: SendApprovalParams): Promise<SendApprovalResult> {
    const from = process.env.RESEND_FROM_EMAIL;
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
    });

    return { externalMessageId: messageId };
  }
}
