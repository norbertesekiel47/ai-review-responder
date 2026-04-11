import type { Job } from 'bullmq';
import { v7 as uuidv7 } from 'uuid';
import { sql } from '../../src/lib/db/server';
import { checkSubscription } from '../../src/lib/shared/subscription-guard';
import { markOutboxCompleted, markOutboxFailed } from '../../src/lib/shared/outbox';
import { sendInternalEmail } from '../../src/lib/notifications/email';
import type { PublishResponsePayload } from '../../src/lib/shared/worker-types';

import { escapeHtml } from '../../src/lib/shared/html';

const LOG_PREFIX = '[ResponsePublisherWorker]';

function renderStars(rating: number): string {
  return '★'.repeat(rating) + '☆'.repeat(5 - rating);
}

export async function handlePublishResponse(
  job: Job<PublishResponsePayload>,
): Promise<void> {
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
    console.error(`${LOG_PREFIX} Response ${response_id} not found`);
    await markOutboxFailed(outboxId, `response_not_found: ${response_id}`);
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
    console.error(`${LOG_PREFIX} Business ${business_id} not found`);
    await markOutboxFailed(outboxId, `business_not_found: ${business_id}`);
    return;
  }

  // ── Step 2: Idempotency — only 'posted' is terminal ─────────────────
  // 'awaiting_manual_post' means a previous attempt set the status but
  // may not have sent the email (crash between UPDATE and send). Allow
  // it to continue to the email path so the retry actually delivers.
  if (response.status === 'posted') {
    console.log(`${LOG_PREFIX} Response ${response_id} already posted, skipping`);
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
    console.warn(
      `${LOG_PREFIX} Business ${business_id} subscription blocked: ${subCheck.reason}`,
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
      console.warn(
        `${LOG_PREFIX} Response ${response_id} not in approved/edited state (current: ${response.status}), skipping`,
      );
      await markOutboxCompleted(outboxId);
      return;
    }
  }

  console.log(`${LOG_PREFIX} Response ${response_id} set to awaiting_manual_post`);

  // ── Step 5: Check if admin email was already sent (idempotent retry) ──
  const [existingDelivery] = await sql<{ id: string }[]>`
    SELECT id FROM notification_deliveries
    WHERE response_id = ${response_id} AND template = 'admin_manual_post' AND sent_at IS NOT NULL
  `;

  if (existingDelivery) {
    console.log(`${LOG_PREFIX} Admin email already sent for response ${response_id}, skipping`);
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
    console.warn(
      `${LOG_PREFIX} No admin email found for business ${business_id}, skipping notification`,
    );
    await markOutboxCompleted(outboxId);
    return;
  }

  // ── Step 6: Build email and send ───────────────────────────────────
  const approvedText = response.approved_text ?? '';
  if (!response.approved_text) {
    console.warn(`${LOG_PREFIX} Response ${response_id} has null approved_text — email will contain empty response`);
  }
  const reviewerName = review?.reviewer_name ?? 'Unknown reviewer';
  const starRating = review?.star_rating ?? 0;
  const businessName = business.name;

  const googleMapsUrl = business.google_place_id
    ? `https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(business.google_place_id)}`
    : null;

  const safeBusinessName = escapeHtml(businessName);
  const safeReviewerName = escapeHtml(reviewerName);
  const safeApprovedText = escapeHtml(approvedText);
  const stars = renderStars(starRating);

  const mapsLinkHtml = googleMapsUrl
    ? `<p style="margin:16px 0 0;"><a href="${escapeHtml(googleMapsUrl)}" style="display:inline-block;background:#2563eb;color:#ffffff;padding:12px 24px;border-radius:6px;font-size:14px;font-weight:600;text-decoration:none;">Open on Google Maps</a></p>`
    : `<p style="margin:16px 0 0;font-size:13px;color:#9ca3af;">No Google Place ID on file — locate the business manually on Google Maps.</p>`;

  const bodyHtml = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f5f5f5;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;max-width:600px;width:100%;">
        <tr><td style="padding:32px 24px 0;">
          <h2 style="margin:0 0 4px;font-size:18px;color:#111;">Manual post needed: ${safeBusinessName}</h2>
          <p style="margin:0 0 20px;font-size:14px;color:#666;">An owner-approved response is ready to be posted on Google Maps.</p>
        </td></tr>
        <tr><td style="padding:0 24px;">
          <table role="presentation" width="100%" style="background:#f9fafb;border-radius:6px;padding:16px;border:1px solid #e5e7eb;">
            <tr><td>
              <p style="margin:0 0 4px;font-size:14px;color:#374151;font-weight:600;">${safeReviewerName} ${stars}</p>
            </td></tr>
          </table>
        </td></tr>
        <tr><td style="padding:16px 24px 0;">
          <p style="margin:0 0 8px;font-size:12px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.5px;">Instructions</p>
          <p style="margin:0 0 16px;font-size:14px;color:#374151;line-height:1.5;">Copy the response below and paste it as an owner reply on Google Maps.</p>
        </td></tr>
        <tr><td style="padding:0 24px;">
          <table role="presentation" width="100%" style="background:#f0fdf4;border-radius:6px;padding:16px;border:1px solid #bbf7d0;">
            <tr><td>
              <p style="margin:0 0 4px;font-size:12px;color:#166534;text-transform:uppercase;letter-spacing:0.5px;font-weight:600;">Approved response (copy this)</p>
              <p style="margin:0;font-size:14px;color:#14532d;line-height:1.6;white-space:pre-wrap;">${safeApprovedText}</p>
            </td></tr>
          </table>
        </td></tr>
        <tr><td style="padding:16px 24px 24px;">
          ${mapsLinkHtml}
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  // Throw on email failure so BullMQ retries.
  // The response is already awaiting_manual_post — the idempotency check
  // at the top prevents a double status update on retry.
  const { messageId } = await sendInternalEmail({
    to: adminEmail,
    subject: `Manual post needed: ${businessName}`,
    bodyHtml,
  });

  // Record delivery so retries can detect the email was already sent
  await sql`
    INSERT INTO notification_deliveries (id, business_id, response_id, channel, recipient, template, sent_at, external_message_id)
    VALUES (${uuidv7()}, ${business_id}, ${response_id}, 'email', ${adminEmail}, 'admin_manual_post', NOW(), ${messageId})
  `;

  console.log(
    `${LOG_PREFIX} Manual-post email sent to ${adminEmail} for response ${response_id}`,
  );

  // ── Step 8: Complete outbox ────────────────────────────────────────
  await markOutboxCompleted(outboxId);
}
