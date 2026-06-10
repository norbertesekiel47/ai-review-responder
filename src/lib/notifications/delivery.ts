import { v7 as uuidv7 } from 'uuid';
import { sql } from '@/lib/db/server';
import type { ChannelId } from '@/lib/notifications/channels/types';

/**
 * Records a notification delivery in the notification_deliveries table.
 * Used by NotificationWorker (approval emails) and other workers that
 * send owner or admin notifications.
 *
 * accountId is required — notification_deliveries.account_id is NOT NULL
 * after migration 034, so every INSERT must include it.
 */
export async function recordNotificationDelivery(params: {
  accountId: string;
  businessId: string;
  responseId?: string | null;
  channel: ChannelId;
  recipient: string;
  template: string;
  externalMessageId: string;
}): Promise<void> {
  await sql`
    INSERT INTO notification_deliveries (id, account_id, business_id, response_id, channel, recipient, template, sent_at, external_message_id)
    VALUES (
      ${uuidv7()}, ${params.accountId}, ${params.businessId}, ${params.responseId ?? null}, ${params.channel},
      ${params.recipient}, ${params.template}, NOW(), ${params.externalMessageId}
    )
  `;
}

/**
 * Records a FAILED delivery. Used when a channel send threw before returning
 * an external message ID (Twilio rejected, Resend errored, cost-cap blocked),
 * or when a pre-send guard rejected the send. Mirrors recordNotificationDelivery
 * but sets failed_at + failure_reason and leaves external_message_id NULL.
 *
 * Defaults template to 'approval_request' since that's the primary use site
 * (the dispatcher's per-channel catch block). Owner-directed non-approval
 * templates (e.g., 'weekly_value_report') should pass the template explicitly.
 *
 * accountId is required — notification_deliveries.account_id is NOT NULL
 * after migration 034, so every INSERT must include it.
 */
export async function insertFailedDelivery(
  accountId: string,
  businessId: string,
  responseId: string | null,
  channel: ChannelId,
  recipient: string,
  failureReason: string,
  template: string = 'approval_request',
): Promise<void> {
  await sql`
    INSERT INTO notification_deliveries
      (id, account_id, business_id, response_id, channel, recipient, template, failed_at, failure_reason)
    VALUES (
      ${uuidv7()}, ${accountId}, ${businessId}, ${responseId}, ${channel},
      ${recipient}, ${template}, NOW(), ${failureReason}
    )
  `;
}
