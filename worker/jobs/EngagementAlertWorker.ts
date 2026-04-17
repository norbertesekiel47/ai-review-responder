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
  buildPartnerSatisfactionAlertHtml,
} from '../../src/lib/notifications/email';
import { recordNotificationDelivery } from '../../src/lib/notifications/delivery';
import { createApprovalLink } from '../../src/lib/approval/create-link';
import type { EngagementAlertPayload } from '../../src/lib/shared/worker-types';
import { createWorkerLogger, type WorkerLogger } from '../../src/lib/shared/logger';

export async function handleEngagementAlert(job: Job<EngagementAlertPayload>): Promise<void> {
  const logger = createWorkerLogger('[EngagementAlertWorker]', job.data.correlation_id);
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
    logger.warn(`Business ${business_id} not found`);
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
    logger.log(`Business ${business_id} skipped: ${subCheck.reason}`);
    await markOutboxCompleted(outboxId);
    return;
  }

  if (alert_type === 'owner_nudge') {
    await handleOwnerNudge(outboxId, business_id, business, markOutboxFailed, logger);
  } else if (alert_type === 'partner_satisfaction_alert') {
    const satisfaction = (job.data as EngagementAlertPayload).satisfaction;
    await handleSatisfactionAlert(outboxId, business_id, business, satisfaction ?? null, logger);
  } else {
    if (!metrics) {
      logger.warn(`${alert_type} missing metrics for business ${business_id}`);
      await markOutboxFailed(outboxId, 'missing metrics payload');
      return;
    }
    await handlePartnerAlert(outboxId, business_id, alert_type, metrics, business, logger);
  }
}

// ── Owner nudge: email the business owner about pending reviews ─────

async function handleOwnerNudge(
  outboxId: string,
  businessId: string,
  business: { name: string; owner_email: string },
  markOutboxFailedFn: typeof markOutboxFailed,
  logger: WorkerLogger,
): Promise<void> {
  // Validate config before creating any approval links
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!appUrl) {
    logger.error(`NEXT_PUBLIC_APP_URL not set — cannot send owner nudge`);
    await markOutboxFailedFn(outboxId, 'NEXT_PUBLIC_APP_URL not configured');
    return;
  }

  const fromEmail = process.env.RESEND_FROM_EMAIL;
  if (!fromEmail) {
    logger.error(`RESEND_FROM_EMAIL not set — cannot send owner nudge`);
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
    logger.log(`Owner nudge already sent for business ${businessId} recently — skipping`);
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
    logger.log(`No pending reviews for business ${businessId} — skipping nudge`);
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
  logger.log(`Owner nudge sent to ${business.owner_email} (${totalPending} pending reviews)`);
}

// ── Partner alerts: email the admin about customer engagement ────────

async function handlePartnerAlert(
  outboxId: string,
  businessId: string,
  alertType: 'partner_engagement_alert' | 'partner_escalation_alert' | 'partner_low_engagement',
  metrics: NonNullable<EngagementAlertPayload['metrics']>,
  business: { name: string; owner_email: string; owner_phone: string | null },
  logger: WorkerLogger,
): Promise<void> {
  const adminEmail = process.env.ADMIN_NOTIFICATION_EMAIL;
  if (!adminEmail) {
    logger.error(`ADMIN_NOTIFICATION_EMAIL not set — cannot send partner alert`);
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
  logger.log(`${alertType} sent to ${adminEmail} for business ${business.name}`);
}

// ── Partner satisfaction alert: triggered by "not great" pulse response ─

async function handleSatisfactionAlert(
  outboxId: string,
  businessId: string,
  business: { name: string; owner_email: string; owner_phone: string | null },
  satisfaction: EngagementAlertPayload['satisfaction'] | null,
  logger: WorkerLogger,
): Promise<void> {
  const adminEmail = process.env.ADMIN_NOTIFICATION_EMAIL;
  if (!adminEmail) {
    logger.error(`ADMIN_NOTIFICATION_EMAIL not set — cannot send satisfaction alert`);
    await markOutboxFailed(outboxId, 'ADMIN_NOTIFICATION_EMAIL not configured');
    return;
  }

  if (!satisfaction) {
    logger.warn(`partner_satisfaction_alert missing satisfaction data for business ${businessId}`);
    await markOutboxFailed(outboxId, 'missing satisfaction payload');
    return;
  }

  // Runtime validation — JSONB payloads are not type-checked by TypeScript
  const validRatings = ['great', 'ok', 'not_great'] as const;
  if (!validRatings.includes(satisfaction.rating as typeof validRatings[number])) {
    logger.warn(`Invalid satisfaction rating: ${String(satisfaction.rating)}`);
    await markOutboxFailed(outboxId, `invalid satisfaction rating: ${String(satisfaction.rating)}`);
    return;
  }
  if (typeof satisfaction.week_start_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(satisfaction.week_start_date)) {
    logger.warn(`Invalid satisfaction week_start_date: ${String(satisfaction.week_start_date)}`);
    await markOutboxFailed(outboxId, 'invalid satisfaction week_start_date');
    return;
  }
  // Round-trip validation: reject impossible dates like 2026-99-99
  const parsedDate = new Date(satisfaction.week_start_date + 'T00:00:00Z');
  if (Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== satisfaction.week_start_date) {
    logger.warn(`Invalid calendar date in week_start_date: ${satisfaction.week_start_date}`);
    await markOutboxFailed(outboxId, 'invalid satisfaction week_start_date (not a real date)');
    return;
  }
  if (satisfaction.comment !== null && typeof satisfaction.comment !== 'string') {
    logger.warn(`Invalid satisfaction comment type: ${typeof satisfaction.comment}`);
    await markOutboxFailed(outboxId, 'invalid satisfaction comment type');
    return;
  }

  // Idempotency: skip if a satisfaction alert was already sent for this business + specific week.
  // Uses the week_start_date from the payload to scope the check precisely — a 7-day time
  // window would suppress legitimate alerts for adjacent weeks if timing drifts.
  const weekTag = `partner_satisfaction_alert:${satisfaction.week_start_date}`;
  const [existingDelivery] = await sql<{ id: string }[]>`
    SELECT id FROM notification_deliveries
    WHERE business_id = ${businessId}
      AND template = ${weekTag}
      AND sent_at IS NOT NULL
    LIMIT 1
  `;
  if (existingDelivery) {
    logger.log(`Satisfaction alert already sent for business ${businessId} week ${satisfaction.week_start_date} — skipping`);
    await markOutboxCompleted(outboxId);
    return;
  }

  // Re-read the current satisfaction_responses row — the owner may have changed
  // their feedback (e.g. not_great → great) after this outbox entry was created.
  // Use the live DB state, not the stale outbox payload.
  const [currentResponse] = await sql<{ rating: string; comment: string | null }[]>`
    SELECT rating, comment FROM satisfaction_responses
    WHERE business_id = ${businessId} AND week_start_date = ${satisfaction.week_start_date}::date
  `;

  if (!currentResponse || currentResponse.rating !== 'not_great') {
    logger.log(`Satisfaction rating changed to '${currentResponse?.rating ?? 'deleted'}' for ${businessId} week ${satisfaction.week_start_date} — skipping alert`);
    await markOutboxCompleted(outboxId);
    return;
  }

  // Use live comment from DB, not stale payload
  const liveComment = currentResponse.comment;

  const bodyHtml = buildPartnerSatisfactionAlertHtml({
    businessName: business.name,
    rating: 'not_great',
    comment: liveComment,
    weekStartDate: satisfaction.week_start_date,
    ownerEmail: business.owner_email,
    ownerPhone: business.owner_phone,
  });

  const ratingLabel = 'Not great';
  const subject = `Satisfaction pulse: ${business.name} rated "${ratingLabel}"`;

  // Mark outbox completed BEFORE sending the email. This is the same crash-safe
  // pattern used by WeeklySummaryWorker and MonthlyImpactWorker: if the worker
  // crashes after marking completed but before Resend accepts, we lose one
  // internal partner alert (acceptable) rather than sending duplicates on retry.
  await markOutboxCompleted(outboxId);

  const { messageId } = await sendInternalEmail({
    to: adminEmail,
    subject,
    bodyHtml,
  });

  // Record delivery with week-scoped template tag for future idempotency checks
  await recordNotificationDelivery({
    businessId,
    channel: 'email',
    recipient: adminEmail,
    template: weekTag,
    externalMessageId: messageId,
  });

  logger.log(`partner_satisfaction_alert sent to ${adminEmail} for business ${business.name} (rating: ${satisfaction.rating}, week: ${satisfaction.week_start_date})`);
}
