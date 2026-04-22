// worker/jobs/NotificationWorker.ts
//
// Dispatcher for approval notifications. Loads per-business channel enrollments
// and sends through a NotificationChannel interface. Channel-level failures are
// isolated (one bad channel does not abort the rest). The failover poller
// handles the all-deliveries-failed case separately.
//
// See docs/adding-communication-channels.md §3.1 for the full flow.

import { v7 as uuidv7 } from 'uuid';
import type { Job } from 'bullmq';
import { sql } from '../../src/lib/db/server';
import { checkSubscription } from '../../src/lib/shared/subscription-guard';
import { markOutboxCompleted, markOutboxFailed } from '../../src/lib/shared/outbox';
import { recordNotificationDelivery, insertFailedDelivery } from '../../src/lib/notifications/delivery';
import { getVerifiedEnrollments } from '../../src/lib/notifications/enrollments';
import {
  getChannel,
  SmsRecipientUnsubscribedError,
  TelegramRecipientBlockedError,
  TelegramChatNotFoundError,
} from '../../src/lib/notifications/channels';
import type { ChannelId } from '../../src/lib/notifications/channels/types';
import { createApprovalLink } from '../../src/lib/approval/create-link';
import {
  reserveSmsCost,
  refundSmsCost,
  DailySmsLimitExceededError,
} from '../../src/lib/costs/sms-tracker';
import type { SendNotificationPayload } from '../../src/lib/shared/worker-types';
import { createWorkerLogger } from '../../src/lib/shared/logger';

export async function handleSendNotification(
  job: Job<SendNotificationPayload>,
): Promise<void> {
  const logger = createWorkerLogger('[NotificationWorker]', job.data.correlation_id);
  const { response_id, business_id } = job.data;
  const outboxId = (job.data as unknown as { outbox_id?: string }).outbox_id ?? job.id!;

  const [responseRow] = await sql<{
    id: string; response_text: string; status: string;
    resp_business_id: string; review_id: string;
    reviewer_name: string; star_rating: number;
    review_text: string | null; review_date: string;
  }[]>`
    SELECT resp.id, resp.response_text, resp.status,
           resp.business_id AS resp_business_id, resp.review_id,
           r.reviewer_name, r.star_rating, r.review_text, r.review_date
    FROM responses resp
    JOIN reviews r ON resp.review_id = r.id
    WHERE resp.id = ${response_id}
  `;

  if (!responseRow) {
    logger.warn(`Response ${response_id} not found`);
    await markOutboxFailed(outboxId, 'response_not_found');
    return;
  }
  if (responseRow.resp_business_id !== business_id) {
    logger.error(`Response ${response_id} belongs to business ${responseRow.resp_business_id}, not ${business_id}`);
    await markOutboxFailed(outboxId, 'business_id_mismatch');
    return;
  }
  if (responseRow.status !== 'pending_approval') {
    logger.warn(`Response ${response_id} is ${responseRow.status}, not pending_approval — skipping`);
    await markOutboxCompleted(outboxId);
    return;
  }

  const [business] = await sql<{
    name: string;
    owner_email_bounced: boolean;
    subscription_status: string;
    updated_at: Date;
  }[]>`
    SELECT name, owner_email_bounced, subscription_status, updated_at
    FROM businesses WHERE id = ${business_id}
  `;
  if (!business) {
    logger.warn(`Business ${business_id} not found`);
    await markOutboxFailed(outboxId, 'business_not_found');
    return;
  }

  const subCheck = checkSubscription(
    business.subscription_status,
    new Date(business.updated_at),
    'notification',
  );
  if (!subCheck.allowed) {
    logger.log(`Business ${business_id} skipped: ${subCheck.reason}`);
    await markOutboxCompleted(outboxId);
    return;
  }

  const enrollments = await getVerifiedEnrollments(business_id);
  if (enrollments.length === 0) {
    logger.warn(`Business ${business_id} has no verified channel enrollments — skipping`);
    await markOutboxCompleted(outboxId);
    return;
  }

  const isFailover = !!(job.data as SendNotificationPayload).failover;

  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!appUrl) {
    logger.error('NEXT_PUBLIC_APP_URL not set — cannot construct approval URLs');
    await markOutboxFailed(outboxId, 'NEXT_PUBLIC_APP_URL not configured');
    return;
  }

  let attempted = 0;
  let succeeded = 0;

  for (const enrollment of enrollments) {
    const channelId: ChannelId = enrollment.channel;

    if (channelId === 'email' && business.owner_email_bounced) {
      logger.log(`Email channel skipped for business ${business_id}: owner_email_bounced`);
      continue;
    }

    if (channelId === 'sms' && process.env.CHANNELS_SMS_ENABLED !== 'true') {
      logger.log(`SMS channel disabled by flag — skipping enrollment for business ${business_id}`);
      continue;
    }

    if (channelId === 'telegram' && process.env.CHANNELS_TELEGRAM_ENABLED !== 'true') {
      logger.log(`Telegram channel disabled by flag — skipping enrollment for business ${business_id}`);
      continue;
    }

    let existing: { id: string } | undefined;
    if (isFailover) {
      // Failover mode: only skip if a delivery was actually confirmed (delivered_at set).
      // A sent_at without delivered_at means the email may have been lost.
      [existing] = await sql<{ id: string }[]>`
        SELECT id FROM notification_deliveries
        WHERE response_id = ${response_id}
          AND channel = ${channelId}
          AND template = 'approval_request'
          AND delivered_at IS NOT NULL
        LIMIT 1
      `;
    } else {
      // Normal mode: skip if any successful delivery record exists for this channel.
      [existing] = await sql<{ id: string }[]>`
        SELECT id FROM notification_deliveries
        WHERE response_id = ${response_id}
          AND channel = ${channelId}
          AND template = 'approval_request'
          AND sent_at IS NOT NULL AND failed_at IS NULL
        LIMIT 1
      `;
    }
    if (existing) {
      logger.log(`${channelId} channel already has a prior delivery for response ${response_id}, skipping`);
      continue;
    }

    // SMS cost reservation. The cap-rejection branch auto-refunds inside
    // reserveSmsCost, so we only need to refund on downstream failure paths.
    let smsReservationDate: string | null = null;
    if (channelId === 'sms') {
      try {
        smsReservationDate = await reserveSmsCost(business_id);
      } catch (err) {
        if (err instanceof DailySmsLimitExceededError) {
          logger.warn(`SMS cap reached for business ${business_id} (${err.scope})`);
          attempted++;
          await insertFailedDelivery(
            business_id,
            response_id,
            'sms',
            enrollment.handle,
            `daily_sms_limit_exceeded:${err.scope}`,
          );
          continue;
        }
        throw err;
      }
    }

    // sendAccepted flips to true ONLY after the provider returns a SID.
    // The finally block refunds iff we reserved and did NOT get that ack.
    // A crash AFTER the provider ack but before recordNotificationDelivery
    // intentionally commits the cost — the message was sent.
    let sendAccepted = false;
    try {
      const { rawToken, approvalLinkId } = await createApprovalLink({
        responseId: response_id,
        businessId: business_id,
        channel: channelId,
      });
      const approvalUrl = `${appUrl}/approve/${rawToken}`;
      attempted++;

      let externalMessageId: string;
      try {
        const result = await getChannel(channelId).sendApprovalRequest({
          handle: enrollment.handle,
          businessName: business.name,
          reviewerName: responseRow.reviewer_name,
          starRating: responseRow.star_rating,
          reviewText: responseRow.review_text,
          reviewDate: responseRow.review_date,
          responsePreview: responseRow.response_text,
          approvalUrl,
          approvalLinkId,
        });
        externalMessageId = result.externalMessageId;
        sendAccepted = true;
      } catch (err) {
        // Sender-wide 21610 handling: Twilio rejected because the handle is
        // blocked at the Messaging Service level. Flip all matching active
        // enrollments and record durable audit evidence in one transaction.
        if (err instanceof SmsRecipientUnsubscribedError) {
          const msid = process.env.TWILIO_MESSAGING_SERVICE_SID!;
          const reason = err instanceof Error ? err.message : String(err);
          await sql.begin(async (tx) => {
            await tx`
              INSERT INTO sms_sender_opt_outs (messaging_service_sid, handle, opted_out_at, opted_in_at, last_event_at)
              VALUES (${msid}, ${enrollment.handle}, NOW(), NULL, NOW())
              ON CONFLICT (messaging_service_sid, handle) DO UPDATE
                SET opted_out_at = EXCLUDED.opted_out_at,
                    opted_in_at = NULL,
                    last_event_at = EXCLUDED.last_event_at
            `;
            await tx`
              INSERT INTO sms_sender_opt_out_events (id, messaging_service_sid, handle, event_type, source, inbound_event_id)
              VALUES (${uuidv7()}, ${msid}, ${enrollment.handle}, '21610_at_send', 'twilio_21610', NULL)
            `;
            await tx`
              UPDATE channel_enrollments
              SET status = 'unsubscribed',
                  unsubscribed_at = COALESCE(unsubscribed_at, NOW()),
                  unsubscribed_reason = COALESCE(unsubscribed_reason, 'twilio_21610_at_send'),
                  updated_at = NOW()
              WHERE handle = ${enrollment.handle} AND channel = 'sms' AND archived_at IS NULL
            `;
          });
          logger.log(`SMS enrollment flipped to unsubscribed (twilio_21610_at_send) for business ${business_id}`);
          logger.error(`[NotificationWorker] SMS 21610: ${reason}`);
          await insertFailedDelivery(business_id, response_id, 'sms', enrollment.handle, 'twilio_21610_at_send');
          continue; // `finally` runs before continue, so refund still triggers when sendAccepted=false.
        }
        if (err instanceof TelegramRecipientBlockedError) {
          await sql.begin(async (tx) => {
            await tx`
              UPDATE channel_enrollments
              SET status = 'unsubscribed',
                  unsubscribed_at = COALESCE(unsubscribed_at, NOW()),
                  unsubscribed_reason = COALESCE(unsubscribed_reason, 'telegram_blocked'),
                  updated_at = NOW()
              WHERE business_id = ${business_id}
                AND channel = 'telegram'
                AND archived_at IS NULL
            `;
          });
          logger.log(`Telegram enrollment flipped to unsubscribed (telegram_blocked) for business ${business_id}`);
          await insertFailedDelivery(business_id, response_id, 'telegram', enrollment.handle, 'telegram_blocked');
          continue; // `finally` runs before continue, so any refund still triggers when sendAccepted=false.
        }
        if (err instanceof TelegramChatNotFoundError) {
          await sql.begin(async (tx) => {
            await tx`
              UPDATE channel_enrollments
              SET status = 'disabled',
                  disabled_at = COALESCE(disabled_at, NOW()),
                  updated_at = NOW()
              WHERE business_id = ${business_id}
                AND channel = 'telegram'
                AND archived_at IS NULL
            `;
          });
          logger.log(`Telegram enrollment flipped to disabled (chat_not_found) for business ${business_id}`);
          await insertFailedDelivery(business_id, response_id, 'telegram', enrollment.handle, 'telegram_chat_not_found');
          continue; // `finally` runs before continue, so any refund still triggers when sendAccepted=false.
        }
        const reason = err instanceof Error ? err.message : String(err);
        logger.error(`${channelId} send failed for response ${response_id}: ${reason}`);
        await insertFailedDelivery(
          business_id,
          response_id,
          channelId,
          enrollment.handle,
          `send_error:${reason}`,
        );
        continue; // `finally` runs before continue, so refund still triggers when sendAccepted=false.
      }

      await recordNotificationDelivery({
        businessId: business_id,
        responseId: response_id,
        channel: channelId,
        recipient: enrollment.handle,
        template: 'approval_request',
        externalMessageId,
      });
      succeeded++;
      logger.log(`${channelId} approval notification sent for response ${response_id} (business ${business_id})`);
    } finally {
      if (channelId === 'sms' && smsReservationDate && !sendAccepted) {
        await refundSmsCost(business_id, smsReservationDate);
      }
    }
  }

  if (attempted > 0 && succeeded === 0) {
    throw new Error(
      `All ${attempted} channel send(s) failed for response ${response_id}. ` +
      `Failed deliveries recorded. BullMQ will retry.`,
    );
  }

  await markOutboxCompleted(outboxId);
}
