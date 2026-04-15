import type { Job } from 'bullmq';
import { sql } from '../../src/lib/db/server';
import { checkSubscription } from '../../src/lib/shared/subscription-guard';
import { markOutboxCompleted, markOutboxFailed } from '../../src/lib/shared/outbox';
import {
  sendInternalEmail,
  buildOwnerNudgeEmailHtml,
  buildPartnerEngagementAlertHtml,
  buildPartnerEscalationAlertHtml,
  buildPartnerLowEngagementAlertHtml,
} from '../../src/lib/notifications/email';
import { recordNotificationDelivery } from '../../src/lib/notifications/delivery';
import { createApprovalLink } from '../../src/lib/approval/create-link';
import type { EngagementAlertPayload } from '../../src/lib/shared/worker-types';

const LOG_PREFIX = '[EngagementAlertWorker]';

export async function handleEngagementAlert(job: Job<EngagementAlertPayload>): Promise<void> {
  const { business_id, alert_type, metrics } = job.data;
  const outboxId = (job.data as unknown as { outbox_id?: string }).outbox_id ?? job.id!;

  // ── Step 1: Load business ─────────────────────────────────────────
  const [business] = await sql<{
    name: string;
    owner_email: string;
    owner_phone: string | null;
    subscription_status: string;
    updated_at: Date;
  }[]>`
    SELECT name, owner_email, owner_phone, subscription_status, updated_at
    FROM businesses WHERE id = ${business_id}
  `;

  if (!business) {
    console.warn(`${LOG_PREFIX} Business ${business_id} not found`);
    await markOutboxFailed(outboxId, 'business_not_found');
    return;
  }

  // ── Step 2: Subscription guard ────────────────────────────────────
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

  if (alert_type === 'owner_nudge') {
    await handleOwnerNudge(outboxId, business_id, business, markOutboxFailed);
  } else {
    await handlePartnerAlert(outboxId, business_id, alert_type, metrics, business);
  }
}

// ── Owner nudge: email the business owner about pending reviews ─────

async function handleOwnerNudge(
  outboxId: string,
  businessId: string,
  business: { name: string; owner_email: string },
  markOutboxFailedFn: typeof markOutboxFailed,
): Promise<void> {
  // Validate config before creating any approval links
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!appUrl) {
    console.error(`${LOG_PREFIX} NEXT_PUBLIC_APP_URL not set — cannot send owner nudge`);
    await markOutboxFailedFn(outboxId, 'NEXT_PUBLIC_APP_URL not configured');
    return;
  }

  const fromEmail = process.env.RESEND_FROM_EMAIL;
  if (!fromEmail) {
    console.error(`${LOG_PREFIX} RESEND_FROM_EMAIL not set — cannot send owner nudge`);
    await markOutboxFailedFn(outboxId, 'RESEND_FROM_EMAIL not configured');
    return;
  }

  // Idempotency: skip if a nudge delivery was already recorded for this business recently
  const [existingNudge] = await sql<{ id: string }[]>`
    SELECT id FROM notification_deliveries
    WHERE business_id = ${businessId}
      AND template = 'owner_nudge'
      AND sent_at IS NOT NULL
      AND sent_at > NOW() - INTERVAL '3 days'
    LIMIT 1
  `;
  if (existingNudge) {
    console.log(`${LOG_PREFIX} Owner nudge already sent for business ${businessId} recently — skipping`);
    await markOutboxCompleted(outboxId);
    return;
  }

  // Query pending reviews with their response IDs + total count
  const pendingRows = await sql<{
    response_id: string;
    reviewer_name: string;
    star_rating: number | null;
    review_text: string | null;
    total_pending: number;
  }[]>`
    SELECT resp.id AS response_id,
           COALESCE(r.reviewer_name, 'Anonymous') AS reviewer_name,
           r.star_rating,
           r.review_text,
           COUNT(*) OVER ()::int AS total_pending
    FROM responses resp
    JOIN reviews r ON r.id = resp.review_id
    WHERE resp.business_id = ${businessId}
      AND resp.status = 'pending_approval'
    ORDER BY resp.created_at ASC
    LIMIT 10
  `;

  if (pendingRows.length === 0) {
    console.log(`${LOG_PREFIX} No pending reviews for business ${businessId} — skipping nudge`);
    await markOutboxCompleted(outboxId);
    return;
  }

  // Create approval links for each pending review
  const totalPending = pendingRows[0]?.total_pending ?? 0;
  const pendingReviews: Array<{
    reviewerName: string;
    starRating: number | null;
    reviewText: string | null;
    approvalUrl: string;
  }> = [];

  for (const row of pendingRows) {
    const { rawToken } = await createApprovalLink({
      responseId: row.response_id,
      businessId,
      revokeMode: 'orphaned_only',
    });
    pendingReviews.push({
      reviewerName: row.reviewer_name,
      starRating: row.star_rating,
      reviewText: row.review_text,
      approvalUrl: `${appUrl}/approve/${rawToken}`,
    });
  }

  const bodyHtml = buildOwnerNudgeEmailHtml({
    businessName: business.name,
    totalPending,
    pendingReviews,
  });

  const subject = `You have ${totalPending} review${totalPending !== 1 ? 's' : ''} waiting for your approval`;

  const { messageId } = await sendInternalEmail({
    to: business.owner_email,
    subject,
    bodyHtml,
  });

  await recordNotificationDelivery({
    businessId,
    channel: 'email',
    recipient: business.owner_email,
    template: 'owner_nudge',
    externalMessageId: messageId,
  });

  await markOutboxCompleted(outboxId);
  console.log(`${LOG_PREFIX} Owner nudge sent to ${business.owner_email} (${totalPending} pending reviews)`);
}

// ── Partner alerts: email the admin about customer engagement ────────

async function handlePartnerAlert(
  outboxId: string,
  businessId: string,
  alertType: 'partner_engagement_alert' | 'partner_escalation_alert' | 'partner_low_engagement',
  metrics: EngagementAlertPayload['metrics'],
  business: { name: string; owner_email: string; owner_phone: string | null },
): Promise<void> {
  const adminEmail = process.env.ADMIN_NOTIFICATION_EMAIL;
  if (!adminEmail) {
    console.error(`${LOG_PREFIX} ADMIN_NOTIFICATION_EMAIL not set — cannot send partner alert`);
    await markOutboxFailed(outboxId, 'ADMIN_NOTIFICATION_EMAIL not configured');
    return;
  }

  let bodyHtml: string;
  let subject: string;

  const activityAgeDays = metrics.days_since_approval ?? metrics.oldest_pending_age_days;

  switch (alertType) {
    case 'partner_engagement_alert': {
      bodyHtml = buildPartnerEngagementAlertHtml({
        businessName: business.name,
        daysSinceApproval: metrics.days_since_approval,
        activityAgeDays,
        pendingCount: metrics.pending_count,
        approvalRate: metrics.approval_rate,
        ownerEmail: business.owner_email,
        ownerPhone: business.owner_phone,
      });
      subject = `Customer ${business.name} hasn't engaged in ${activityAgeDays} days`;
      break;
    }
    case 'partner_escalation_alert': {
      bodyHtml = buildPartnerEscalationAlertHtml({
        businessName: business.name,
        daysSinceApproval: metrics.days_since_approval,
        activityAgeDays,
        pendingCount: metrics.pending_count,
        approvalRate: metrics.approval_rate,
        ownerEmail: business.owner_email,
        ownerPhone: business.owner_phone,
      });
      subject = `Customer ${business.name} may be at risk`;
      break;
    }
    case 'partner_low_engagement': {
      const approvalRateDisplay = metrics.approval_rate ?? 0;
      bodyHtml = buildPartnerLowEngagementAlertHtml({
        businessName: business.name,
        approvalRate: approvalRateDisplay,
        pendingCount: metrics.pending_count,
        ownerEmail: business.owner_email,
        ownerPhone: business.owner_phone,
      });
      subject = `Customer ${business.name} approval rate is ${approvalRateDisplay}%`;
      break;
    }
  }

  const { messageId } = await sendInternalEmail({
    to: adminEmail,
    subject,
    bodyHtml,
  });

  await recordNotificationDelivery({
    businessId,
    channel: 'email',
    recipient: adminEmail,
    template: alertType,
    externalMessageId: messageId,
  });

  await markOutboxCompleted(outboxId);
  console.log(`${LOG_PREFIX} ${alertType} sent to ${adminEmail} for business ${business.name}`);
}
