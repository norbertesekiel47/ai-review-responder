import type { Job } from 'bullmq';
import { v7 as uuidv7 } from 'uuid';
import { sql } from '../../src/lib/db/server';
import { checkSubscription } from '../../src/lib/shared/subscription-guard';
import { markOutboxCompleted, markOutboxFailed } from '../../src/lib/shared/outbox';
import { sendInternalEmail, buildManualPostEmailHtml } from '../../src/lib/notifications/email';
import { recordNotificationDelivery } from '../../src/lib/notifications/delivery';
import { buildGoogleMapsUrl } from '../../src/lib/shared/constants';
import type { PublishResponsePayload } from '../../src/lib/shared/worker-types';
import { createWorkerLogger } from '../../src/lib/shared/logger';

export async function handlePublishResponse(
  job: Job<PublishResponsePayload>,
): Promise<void> {
  const logger = createWorkerLogger('[ResponsePublisherWorker]', job.data.correlation_id);
  const { response_id, business_id } = job.data;
  const outboxId = (job.data as unknown as { outbox_id?: string }).outbox_id ?? job.id!;

  // ── Step 1: Load response + review + business ──────────────────────
  const [response] = await sql<{
    id: string;
    review_id: string;
    business_id: string;
    approved_text: string | null;
    status: string;
  }[]>`
    SELECT id, review_id, business_id, approved_text, status
    FROM responses
    WHERE id = ${response_id}
  `;

  if (!response) {
    logger.error(`Response ${response_id} not found`);
    await markOutboxFailed(outboxId, `response_not_found: ${response_id}`);
    return;
  }

  if (response.business_id !== business_id) {
    logger.error(`Response ${response_id} belongs to business ${response.business_id}, not ${business_id}`);
    await markOutboxFailed(outboxId, 'business_id_mismatch');
    return;
  }

  const [review] = await sql<{
    id: string;
    reviewer_name: string;
    star_rating: number;
  }[]>`
    SELECT id, reviewer_name, star_rating
    FROM reviews
    WHERE id = ${response.review_id}
  `;

  const [business] = await sql<{
    id: string;
    name: string;
    subscription_status: string;
    updated_at: Date;
    google_place_id: string | null;
  }[]>`
    SELECT id, name, subscription_status, updated_at, google_place_id
    FROM businesses
    WHERE id = ${business_id}
  `;

  if (!business) {
    logger.error(`Business ${business_id} not found`);
    await markOutboxFailed(outboxId, `business_not_found: ${business_id}`);
    return;
  }

  // ── Step 2: Idempotency — only 'posted' is terminal ─────────────────
  // 'awaiting_manual_post' means a previous attempt set the status but
  // may not have sent the email (crash between UPDATE and send). Allow
  // it to continue to the email path so the retry actually delivers.
  if (response.status === 'posted') {
    logger.log(`Response ${response_id} already posted, skipping`);
    await markOutboxCompleted(outboxId);
    return;
  }

  // ── Step 3: Subscription guard ─────────────────────────────────────
  const subCheck = checkSubscription(
    business.subscription_status,
    new Date(business.updated_at),
    'publisher',
  );

  if (!subCheck.allowed) {
    logger.warn(
      `Business ${business_id} subscription blocked: ${subCheck.reason}`,
    );
    await markOutboxCompleted(outboxId);
    return;
  }

  // ── Step 4: Transition to awaiting_manual_post ─────────────────────
  // Guarded by business_id + status to prevent stale/wrong-business jobs
  // from resurrecting superseded or failed responses. Treat existing
  // awaiting_manual_post as "already transitioned, proceed to send."
  if (response.status !== 'awaiting_manual_post') {
    const updated = await sql`
      UPDATE responses
      SET status = 'awaiting_manual_post', updated_at = NOW()
      WHERE id = ${response_id}
        AND business_id = ${business_id}
        AND status IN ('approved', 'edited')
    `;

    if (updated.count === 0) {
      logger.warn(
        `Response ${response_id} not in approved/edited state (current: ${response.status}), skipping`,
      );
      await markOutboxCompleted(outboxId);
      return;
    }
  }

  logger.log(`Response ${response_id} set to awaiting_manual_post`);

  // ── Step 5: Check if admin email was already sent (idempotent retry) ──
  const [existingDelivery] = await sql<{ id: string }[]>`
    SELECT id FROM notification_deliveries
    WHERE response_id = ${response_id} AND template = 'admin_manual_post' AND sent_at IS NOT NULL
  `;

  if (existingDelivery) {
    logger.log(`Admin email already sent for response ${response_id}, skipping`);
    await markOutboxCompleted(outboxId);
    return;
  }

  // ── Step 6: Determine admin email recipient ────────────────────────
  // Per spec: query users WHERE role IN ('admin','sales_partner') AND
  // business_id = businessId first, then fall back to ADMIN_NOTIFICATION_EMAIL.
  const [businessScopedAdmin] = await sql<{ email: string }[]>`
    SELECT email FROM users
    WHERE role IN ('admin', 'sales_partner')
      AND business_id = ${business_id}
    LIMIT 1
  `;

  let adminEmail = businessScopedAdmin?.email;

  // Fall back to the onboarding partner (may not have business_id set)
  if (!adminEmail) {
    const [onboarder] = await sql<{ email: string }[]>`
      SELECT u.email FROM users u
      JOIN businesses b ON b.onboarded_by = u.id
      WHERE b.id = ${business_id}
        AND u.role IN ('admin', 'sales_partner')
      LIMIT 1
    `;
    adminEmail = onboarder?.email;
  }

  adminEmail = adminEmail ?? process.env.ADMIN_NOTIFICATION_EMAIL;

  if (!adminEmail) {
    logger.warn(
      `No admin email found for business ${business_id}, skipping notification`,
    );
    await markOutboxCompleted(outboxId);
    return;
  }

  // ── Step 6: Build email and send ───────────────────────────────────
  const approvedText = response.approved_text ?? '';
  if (!response.approved_text) {
    logger.warn(`Response ${response_id} has null approved_text — email will contain empty response`);
  }
  const reviewerName = review?.reviewer_name ?? 'Unknown reviewer';
  const starRating = review?.star_rating ?? 0;
  const businessName = business.name;

  const googleMapsUrl = business.google_place_id
    ? buildGoogleMapsUrl(business.google_place_id)
    : null;

  const bodyHtml = buildManualPostEmailHtml({
    businessName,
    reviewerName,
    starRating,
    approvedText,
    googleMapsUrl,
  });

  // Throw on email failure so BullMQ retries.
  // The response is already awaiting_manual_post — the idempotency check
  // at the top prevents a double status update on retry.
  const { messageId } = await sendInternalEmail({
    to: adminEmail,
    subject: `Manual post needed: ${businessName}`,
    bodyHtml,
  });

  // Record delivery so retries can detect the email was already sent
  await recordNotificationDelivery({
    businessId: business_id,
    responseId: response_id,
    channel: 'email',
    recipient: adminEmail,
    template: 'admin_manual_post',
    externalMessageId: messageId,
  });

  logger.log(
    `Manual-post email sent for response ${response_id} (business ${business_id})`,
  );

  // ── Step 8: Complete outbox ────────────────────────────────────────
  await markOutboxCompleted(outboxId);
}
