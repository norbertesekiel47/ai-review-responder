import type { Job } from 'bullmq';
import { randomUUID, createHash } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { sql } from '../../src/lib/db/server';
import { checkSubscription } from '../../src/lib/shared/subscription-guard';
import { markOutboxCompleted, markOutboxFailed } from '../../src/lib/shared/outbox';
import { sendApprovalEmail } from '../../src/lib/notifications/email';
import type { SendNotificationPayload } from '../../src/lib/shared/worker-types';

const LOG_PREFIX = '[NotificationWorker]';

export async function handleSendNotification(
  job: Job<SendNotificationPayload>,
): Promise<void> {
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
    console.warn(`${LOG_PREFIX} Response ${response_id} not found`);
    await markOutboxFailed(outboxId, 'response_not_found');
    return;
  }

  if (responseRow.resp_business_id !== business_id) {
    console.error(`${LOG_PREFIX} Response ${response_id} belongs to business ${responseRow.resp_business_id}, not ${business_id}`);
    await markOutboxFailed(outboxId, 'business_id_mismatch');
    return;
  }

  if (responseRow.status !== 'pending_approval') {
    console.warn(`${LOG_PREFIX} Response ${response_id} is ${responseRow.status}, not pending_approval — skipping notification`);
    await markOutboxCompleted(outboxId);
    return;
  }

  const [business] = await sql<{
    owner_email: string;
    owner_name: string;
    name: string;
    subscription_status: string;
    updated_at: Date;
  }[]>`
    SELECT owner_email, owner_name, name, subscription_status, updated_at
    FROM businesses WHERE id = ${business_id}
  `;

  if (!business) {
    console.warn(`${LOG_PREFIX} Business ${business_id} not found`);
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
    console.log(`${LOG_PREFIX} Business ${business_id} skipped: ${subCheck.reason}`);
    await markOutboxCompleted(outboxId);
    return;
  }

  // ── Step 3: Idempotency check ──────────────────────────────────────
  // If a delivery record already exists for this response, the email was
  // already sent (previous attempt succeeded). Complete and return.
  const [existingDelivery] = await sql<{ id: string }[]>`
    SELECT id FROM notification_deliveries
    WHERE response_id = ${response_id} AND template = 'approval_request' AND sent_at IS NOT NULL
  `;

  if (existingDelivery) {
    console.log(`${LOG_PREFIX} Delivery already exists for response ${response_id}, skipping`);
    await markOutboxCompleted(outboxId);
    return;
  }

  // ── Step 4: Validate config before creating any state ───────────────
  const fromEmail = process.env.RESEND_FROM_EMAIL;
  if (!fromEmail) {
    console.error(`${LOG_PREFIX} RESEND_FROM_EMAIL not set — cannot send approval email`);
    await markOutboxFailed(outboxId, 'RESEND_FROM_EMAIL not configured');
    return;
  }

  // ── Step 5: Generate approval token ────────────────────────────────
  const rawToken = randomUUID();
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');

  // ── Step 6: Revoke orphaned links + create new link in ONE transaction ─
  // If a previous attempt created a link but crashed before sending the
  // email, the link is orphaned (we can't reconstruct the raw token from
  // the hash). Revoking + creating in the same transaction ensures we never
  // leave the response with zero links after a crash.
  await sql.begin(async (tx) => {
    await tx`
      UPDATE approval_links SET revoked_at = NOW()
      WHERE response_id = ${response_id}
        AND revoked_at IS NULL
        AND consumed_at IS NULL
        AND expires_at > NOW()
    `;

    await tx`
      INSERT INTO approval_links (id, response_id, business_id, token_hash, channel, expires_at)
      VALUES (
        ${uuidv7()}, ${response_id}, ${business_id}, ${tokenHash}, 'email',
        NOW() + INTERVAL '48 hours'
      )
    `;
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
    console.error(`${LOG_PREFIX} Failed to send email for response ${response_id}: ${err instanceof Error ? err.message : err}`);
    throw err;
  }

  // ── Step 7: Record delivery ────────────────────────────────────────
  await sql`
    INSERT INTO notification_deliveries (id, business_id, response_id, channel, recipient, template, sent_at, external_message_id)
    VALUES (
      ${uuidv7()}, ${business_id}, ${response_id}, 'email', ${business.owner_email},
      'approval_request', NOW(), ${messageId}
    )
  `;

  // Raw token only existed in memory during this function.
  // NEVER log it, NEVER store it in outbox payloads.
  await markOutboxCompleted(outboxId);
  console.log(`${LOG_PREFIX} Approval email sent for response ${response_id} to ${business.owner_email}`);
}
