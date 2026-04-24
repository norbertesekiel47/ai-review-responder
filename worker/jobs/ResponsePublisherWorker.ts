import type { Job } from 'bullmq';
import { v7 as uuidv7 } from 'uuid';
import { sql } from '../../src/lib/db/server';
import { checkSubscription } from '../../src/lib/shared/subscription-guard';
import { markOutboxCompleted, markOutboxFailed, extractOutboxHandle } from '../../src/lib/shared/outbox';
import { sendInternalEmail, buildManualPostEmailHtml } from '../../src/lib/notifications/email';
import { buildGoogleMapsUrl } from '../../src/lib/shared/constants';
import type { PublishResponsePayload } from '../../src/lib/shared/worker-types';
import { createWorkerLogger } from '../../src/lib/shared/logger';

export async function handlePublishResponse(
  job: Job<PublishResponsePayload>,
): Promise<void> {
  const logger = createWorkerLogger('[ResponsePublisherWorker]', job.data.correlation_id);
  const { response_id, business_id } = job.data;
  const { outboxId, attempt: outboxAttempt } = extractOutboxHandle(job.data, job.id!);

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
    await markOutboxFailed(outboxId, `response_not_found: ${response_id}`, outboxAttempt);
    return;
  }

  if (response.business_id !== business_id) {
    logger.error(`Response ${response_id} belongs to business ${response.business_id}, not ${business_id}`);
    await markOutboxFailed(outboxId, 'business_id_mismatch', outboxAttempt);
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
    await markOutboxFailed(outboxId, `business_not_found: ${business_id}`, outboxAttempt);
    return;
  }

  // ── Step 2: Idempotency — only 'posted' is terminal ─────────────────
  // 'awaiting_manual_post' means a previous attempt set the status but
  // may not have sent the email (crash between UPDATE and send). Allow
  // it to continue to the email path so the retry actually delivers.
  if (response.status === 'posted') {
    logger.log(`Response ${response_id} already posted, skipping`);
    await markOutboxCompleted(outboxId, outboxAttempt);
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
    await markOutboxCompleted(outboxId, outboxAttempt);
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
      await markOutboxCompleted(outboxId, outboxAttempt);
      return;
    }
  }

  logger.log(`Response ${response_id} set to awaiting_manual_post`);

  // ── Step 5: Determine admin email recipient ─────────────────────────
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
    await markOutboxCompleted(outboxId, outboxAttempt);
    return;
  }

  // ── Step 6: Atomically claim the delivery slot BEFORE sending ───────
  // Closes the send-before-record race. Migration 024's unique index on
  // (response_id, template) makes INSERT ON CONFLICT DO NOTHING a safe
  // atomic claim. If another attempt already claimed, `claimed` is empty
  // and we skip rather than risk a duplicate send. The row is persisted
  // without sent_at/external_message_id so a crash between this INSERT and
  // the email send does not falsely count as a sent notification. The NEXT
  // retry still sees the claim and skips (documented trade-off:
  // prefer "retry-skip may miss an email the admin can manually retrigger"
  // over "retry-send may deliver duplicate admin emails").
  const deliveryId = uuidv7();
  const claimed = await sql<{ id: string }[]>`
    INSERT INTO notification_deliveries
      (id, business_id, response_id, channel, recipient, template)
    VALUES
      (${deliveryId}, ${business_id}, ${response_id}, 'email',
       ${adminEmail}, 'admin_manual_post')
    ON CONFLICT (response_id, template)
      WHERE response_id IS NOT NULL AND template = 'admin_manual_post'
      DO NOTHING
    RETURNING id
  `;

  if (claimed.length === 0) {
    logger.log(`Admin email already claimed for response ${response_id}, skipping`);
    await markOutboxCompleted(outboxId, outboxAttempt);
    return;
  }

  // ── Step 7: Build email and send ─────────────────────────────────────
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

  let messageId: string;
  try {
    const result = await sendInternalEmail({
      to: adminEmail,
      subject: `Manual post needed: ${businessName}`,
      bodyHtml,
      category: 'internal',
    });
    messageId = result.messageId;
  } catch (err) {
    // Send failed — roll back the claim so a retry can re-attempt delivery.
    // BullMQ will retry; the next attempt re-INSERTs and retries sending.
    // Without this rollback the retry would see the claim row and skip,
    // losing the email entirely on any transient Resend failure.
    await sql`
      DELETE FROM notification_deliveries
      WHERE id = ${deliveryId} AND external_message_id IS NULL
    `.catch((delErr) => {
      logger.error(
        `Failed to roll back delivery claim ${deliveryId} after send error: ${delErr instanceof Error ? delErr.message : delErr}`,
      );
    });
    throw err;
  }

  // Backfill provider message id so the admin can reconcile with Resend.
  await sql`
    UPDATE notification_deliveries
    SET external_message_id = ${messageId}, sent_at = NOW()
    WHERE id = ${deliveryId}
  `;

  logger.log(
    `Manual-post email sent for response ${response_id} (business ${business_id})`,
  );

  // ── Step 8: Complete outbox ────────────────────────────────────────
  await markOutboxCompleted(outboxId, outboxAttempt);
}
