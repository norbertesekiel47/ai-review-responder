import { v7 as uuidv7 } from 'uuid';
import { sql } from '@/lib/db/server';
import type { ChannelId } from '@/lib/notifications/channels/types';

/**
 * Records a notification delivery in the notification_deliveries table.
 * Used by both NotificationWorker (approval emails) and
 * ResponsePublisherWorker (admin manual-post emails).
 */
export async function recordNotificationDelivery(params: {
  businessId: string;
  responseId?: string | null;
  channel: ChannelId;                       // widened from 'email' | 'sms'
  recipient: string;
  template: string;
  externalMessageId: string;
}): Promise<void> {
  await sql`
    INSERT INTO notification_deliveries (id, business_id, response_id, channel, recipient, template, sent_at, external_message_id)
    VALUES (
      ${uuidv7()}, ${params.businessId}, ${params.responseId ?? null}, ${params.channel},
      ${params.recipient}, ${params.template}, NOW(), ${params.externalMessageId}
    )
  `;
}
