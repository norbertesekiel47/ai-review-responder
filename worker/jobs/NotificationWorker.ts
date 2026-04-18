import type { Job } from 'bullmq';
import { sql } from '../../src/lib/db/server';
import { createApprovalLink } from '../../src/lib/approval/create-link';
import { checkSubscription } from '../../src/lib/shared/subscription-guard';
import { markOutboxCompleted, markOutboxFailed } from '../../src/lib/shared/outbox';
import { sendApprovalEmail } from '../../src/lib/notifications/email';
import { recordNotificationDelivery } from '../../src/lib/notifications/delivery';
import type { SendNotificationPayload } from '../../src/lib/shared/worker-types';
import { createWorkerLogger } from '../../src/lib/shared/logger';

export async function handleSendNotification(
  job: Job<SendNotificationPayload>,
): Promise<void> {
  const logger = createWorkerLogger('[NotificationWorker]', job.data.correlation_id);
  const { response_id, business_id } = job.data;
  const outboxId = (job.data as unknown as { outbox_id?: string }).outbox_id ?? job.id!;

  // ── Step 1: Read response + review + business ──────────────────────
  // Enforce business_id match and pending_approval status to prevent
  // stale jobs from emailing approval links for superseded/failed
  // responses or leaking responses to wrong business owners.
  const [responseRow] = await sql<{
    id: string;
    response_text: string;
    status: string;
    resp_business_id: string;
    review_id: string;
    reviewer_name: string;
    star_rating: number;
    review_text: string | null;
    review_date: string;
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
    logger.warn(`Response ${response_id} is ${responseRow.status}, not pending_approval — skipping notification`);
    await markOutboxCompleted(outboxId);
    return;
  }

  const [business] = await sql<{
    owner_email: string;
    owner_name: string;
    name: string;
    owner_email_bounced: boolean;
    subscription_status: string;
    updated_at: Date;
  }[]>`
    SELECT owner_email, owner_name, name, owner_email_bounced, subscription_status, updated_at
    FROM businesses WHERE id = ${business_id}
  `;

  if (!business) {
    logger.warn(`Business ${business_id} not found`);
    await markOutboxFailed(outboxId, 'business_not_found');
    return;
  }

  // ── Step 2: Subscription guard ─────────────────────────────────────
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

  // ── Hard bounce check ──────────────────────────────────
  // Skip owner-directed emails when the owner's email has hard-bounced.
  // Admin verifies and clears owner_email_bounced manually from /admin/businesses/[id].
  if (business.owner_email_bounced) {
    logger.log(`Business ${business_id} owner email bounced — skipping`);
    await markOutboxCompleted(outboxId);
    return;
  }

  // ── Step 3: Idempotency / failover check ───────────────────────────
  const isFailover = !!(job.data as SendNotificationPayload).failover;

  if (isFailover) {
    // Failover mode: only skip if a delivery was actually DELIVERED (not just sent).
    // A sent_at without delivered_at means the email may have been lost.
    const [deliveredRow] = await sql<{ id: string }[]>`
      SELECT id FROM notification_deliveries
      WHERE response_id = ${response_id}
        AND template = 'approval_request'
        AND delivered_at IS NOT NULL
    `;
    if (deliveredRow) {
      logger.log(`Failover: delivery already confirmed for response ${response_id}, skipping`);
      await markOutboxCompleted(outboxId);
      return;
    }
    logger.log(`Failover: re-sending notification for response ${response_id} (reason: ${job.data.failover!.reason})`);
  } else {
    // Normal mode: skip if any delivery record with sent_at exists (email was sent).
    const [existingDelivery] = await sql<{ id: string }[]>`
      SELECT id FROM notification_deliveries
      WHERE response_id = ${response_id} AND template = 'approval_request' AND sent_at IS NOT NULL
    `;
    if (existingDelivery) {
      logger.log(`Delivery already exists for response ${response_id}, skipping`);
      await markOutboxCompleted(outboxId);
      return;
    }
  }

  // ── Step 4: Validate config before creating any state ───────────────
  const fromEmail = process.env.RESEND_FROM_EMAIL;
  if (!fromEmail) {
    logger.error(`RESEND_FROM_EMAIL not set — cannot send approval email`);
    await markOutboxFailed(outboxId, 'RESEND_FROM_EMAIL not configured');
    return;
  }

  // ── Step 5-6: Create approval link (shared logic) ─────────────────
  const { rawToken } = await createApprovalLink({
    responseId: response_id,
    businessId: business_id,
  });

  // ── Step 7: Send email ─────────────────────────────────────────────
  const approvalUrl = `${process.env.NEXT_PUBLIC_APP_URL}/approve/${rawToken}`;

  let messageId: string;
  try {
    const result = await sendApprovalEmail({
      to: business.owner_email,
      from: fromEmail,
      businessName: business.name,
      reviewerName: responseRow.reviewer_name,
      starRating: responseRow.star_rating,
      reviewText: responseRow.review_text,
      reviewDate: responseRow.review_date,
      responsePreview: responseRow.response_text,
      approvalUrl,
    });
    messageId = result.messageId;
  } catch (err) {
    // Email send failed — throw so BullMQ retries.
    // The approval link exists in DB. On retry, the idempotency check
    // finds no delivery record, revokes the orphaned link, creates a
    // new one with a fresh token, and retries the email.
    logger.error(`Failed to send email for response ${response_id}: ${err instanceof Error ? err.message : err}`);
    throw err;
  }

  // ── Step 7: Record delivery ────────────────────────────────────────
  await recordNotificationDelivery({
    businessId: business_id,
    responseId: response_id,
    channel: 'email',
    recipient: business.owner_email,
    template: 'approval_request',
    externalMessageId: messageId,
  });

  // Raw token only existed in memory during this function.
  // NEVER log it, NEVER store it in outbox payloads.
  await markOutboxCompleted(outboxId);
  logger.log(`Approval email sent for response ${response_id} (business ${business_id})`);
}
