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
import { recordNotificationDelivery } from '../../src/lib/notifications/delivery';
import { getVerifiedEnrollments } from '../../src/lib/notifications/enrollments';
import { getChannel } from '../../src/lib/notifications/channels';
import type { ChannelId } from '../../src/lib/notifications/channels/types';
import { createApprovalLink } from '../../src/lib/approval/create-link';
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
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.error(`${channelId} send failed for response ${response_id}: ${reason}`);
      await sql`
        INSERT INTO notification_deliveries
          (id, business_id, response_id, channel, recipient, template, failed_at, failure_reason)
        VALUES (
          ${uuidv7()}, ${business_id}, ${response_id}, ${channelId},
          ${enrollment.handle}, 'approval_request', NOW(), ${`send_error:${reason}`}
        )
      `;
      continue;
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
  }

  if (attempted > 0 && succeeded === 0) {
    throw new Error(
      `All ${attempted} channel send(s) failed for response ${response_id}. ` +
      `Failed deliveries recorded. BullMQ will retry.`,
    );
  }

  await markOutboxCompleted(outboxId);
}
