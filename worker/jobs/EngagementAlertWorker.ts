import type { Job } from 'bullmq';
import { sql } from '../../src/lib/db/server';
import {
  checkSubscription,
  type AccountFlagsInput,
} from '../../src/lib/shared/subscription-guard';
import { markOutboxCompleted, markOutboxFailed, extractOutboxHandle } from '../../src/lib/shared/outbox';
import { getWorkerConfig } from '../../src/lib/config/worker';
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
import { asLocationId } from '../../src/lib/shared/ids';
import type { LocationId } from '../../src/lib/shared/ids';

export async function handleEngagementAlert(job: Job<EngagementAlertPayload>): Promise<void> {
  const logger = createWorkerLogger('[EngagementAlertWorker]', job.data.correlation_id);
  const { alert_type, metrics } = job.data;
  // Cast job data IDs to branded types at entry point
  const businessId: LocationId = asLocationId(job.data.business_id);
  const { outboxId, attempt: outboxAttempt } = extractOutboxHandle(job.data, job.id!);

  // ── Step 1: Load business + account subscription ──────────────────
  const [business] = await sql<{
    name: string;
    account_id: string;
    owner_email: string;
    owner_email_bounced: boolean;
    owner_phone: string | null;
    subscription_status: string;
    account_past_due_at: Date | null;
    account_flags: AccountFlagsInput;
  }[]>`
    SELECT b.name, b.owner_email, b.owner_email_bounced, b.owner_phone,
           a.id AS account_id, a.subscription_status,
           a.past_due_at AS account_past_due_at, a.flags AS account_flags
    FROM businesses b
    JOIN accounts a ON a.id = b.account_id
    WHERE b.id = ${businessId}
  `;

  if (!business) {
    logger.warn(`Business ${businessId} not found`);
    await markOutboxFailed(sql, outboxId, 'business_not_found', outboxAttempt);
    return;
  }

  // ── Step 2: Subscription guard ────────────────────────────────────
  const subCheck = checkSubscription({
    status: business.subscription_status,
    pastDueAt: business.account_past_due_at,
    accountFlags: business.account_flags ?? {},
    workerType: 'notification',
  });

  if (!subCheck.allowed) {
    logger.log(`Business ${businessId} skipped: ${subCheck.reason}`);
    await markOutboxCompleted(sql, outboxId, outboxAttempt);
    return;
  }

  if (alert_type === 'owner_nudge') {
    await handleOwnerNudge(outboxId, outboxAttempt, businessId, business, logger);
  } else if (alert_type === 'partner_satisfaction_alert') {
    const satisfaction = (job.data as EngagementAlertPayload).satisfaction;
    await handleSatisfactionAlert(outboxId, outboxAttempt, businessId, business, satisfaction ?? null, logger);
  } else {
    if (!metrics) {
      logger.warn(`${alert_type} missing metrics for business ${businessId}`);
      await markOutboxFailed(sql, outboxId, 'missing metrics payload', outboxAttempt);
      return;
    }
    await handlePartnerAlert(outboxId, outboxAttempt, businessId, alert_type, metrics, business, logger);
  }
}

// ── Owner nudge: email the business owner about pending reviews ─────

async function handleOwnerNudge(
  outboxId: string,
  outboxAttempt: number | undefined,
  businessId: string,
  business: { name: string; account_id: string; owner_email: string; owner_email_bounced: boolean },
  logger: WorkerLogger,
): Promise<void> {
  // Local binding so the env-config branches below read naturally.
  const markOutboxFailedFn = (id: string, err: string) => markOutboxFailed(sql, id, err, outboxAttempt);
  // ── Hard bounce check (must come BEFORE env validation) ──
  // Skip owner-directed nudges when the owner's email has hard-bounced.
  // Admin verifies and clears owner_email_bounced manually from /admin/businesses/[id].
  // Doing this BEFORE env validation ensures a config outage can't mark a
  // bounced-owner nudge as failed — bounced owners should always short-circuit
  // to completed so they never retry or alert, regardless of env state.
  if (business.owner_email_bounced) {
    logger.log(`Business ${businessId} owner email bounced — skipping owner nudge`);
    await markOutboxCompleted(sql, outboxId, outboxAttempt);
    return;
  }

  // Validate config before creating any approval links
  const cfg = getWorkerConfig();
  const appUrl = cfg.NEXT_PUBLIC_APP_URL;
  if (!appUrl) {
    logger.error(`NEXT_PUBLIC_APP_URL not set — cannot send owner nudge`);
    await markOutboxFailedFn(outboxId, 'NEXT_PUBLIC_APP_URL not configured');
    return;
  }

  const fromEmail = cfg.RESEND_FROM_EMAIL;
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
    await markOutboxCompleted(sql, outboxId, outboxAttempt);
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
    await markOutboxCompleted(sql, outboxId, outboxAttempt);
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
    const { rawToken } = await createApprovalLink(sql, {
      responseId: row.response_id,
      businessId,
      channel: 'email',
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
    category: 'marketing',
  });

  await recordNotificationDelivery(sql, {
    accountId: business.account_id,
    businessId,
    channel: 'email',
    recipient: business.owner_email,
    template: 'owner_nudge',
    externalMessageId: messageId,
  });

  await markOutboxCompleted(sql, outboxId, outboxAttempt);
  logger.log(`Owner nudge sent for business ${businessId} (${totalPending} pending reviews)`);
}

// ── Partner alerts: email the admin about customer engagement ────────

async function handlePartnerAlert(
  outboxId: string,
  outboxAttempt: number | undefined,
  businessId: string,
  alertType: 'partner_engagement_alert' | 'partner_escalation_alert' | 'partner_low_engagement',
  metrics: NonNullable<EngagementAlertPayload['metrics']>,
  business: { name: string; account_id: string; owner_email: string; owner_phone: string | null },
  logger: WorkerLogger,
): Promise<void> {
  const adminEmail = getWorkerConfig().ADMIN_NOTIFICATION_EMAIL;
  if (!adminEmail) {
    logger.error(`ADMIN_NOTIFICATION_EMAIL not set — cannot send partner alert`);
    await markOutboxFailed(sql, outboxId, 'ADMIN_NOTIFICATION_EMAIL not configured', outboxAttempt);
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
    category: 'internal',
  });

  await recordNotificationDelivery(sql, {
    accountId: business.account_id,
    businessId,
    channel: 'email',
    recipient: adminEmail,
    template: alertType,
    externalMessageId: messageId,
  });

  await markOutboxCompleted(sql, outboxId, outboxAttempt);
  logger.log(`${alertType} sent for business ${businessId}`);
}

// ── Partner satisfaction alert: triggered by "not great" pulse response ─

async function handleSatisfactionAlert(
  outboxId: string,
  outboxAttempt: number | undefined,
  businessId: string,
  business: { name: string; account_id: string; owner_email: string; owner_phone: string | null },
  satisfaction: EngagementAlertPayload['satisfaction'] | null,
  logger: WorkerLogger,
): Promise<void> {
  const adminEmail = getWorkerConfig().ADMIN_NOTIFICATION_EMAIL;
  if (!adminEmail) {
    logger.error(`ADMIN_NOTIFICATION_EMAIL not set — cannot send satisfaction alert`);
    await markOutboxFailed(sql, outboxId, 'ADMIN_NOTIFICATION_EMAIL not configured', outboxAttempt);
    return;
  }

  if (!satisfaction) {
    logger.warn(`partner_satisfaction_alert missing satisfaction data for business ${businessId}`);
    await markOutboxFailed(sql, outboxId, 'missing satisfaction payload', outboxAttempt);
    return;
  }

  // Runtime validation — JSONB payloads are not type-checked by TypeScript
  const validRatings = ['great', 'ok', 'not_great'] as const;
  if (!validRatings.includes(satisfaction.rating as typeof validRatings[number])) {
    logger.warn(`Invalid satisfaction rating: ${String(satisfaction.rating)}`);
    await markOutboxFailed(sql, outboxId, `invalid satisfaction rating: ${String(satisfaction.rating)}`, outboxAttempt);
    return;
  }
  if (typeof satisfaction.week_start_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(satisfaction.week_start_date)) {
    logger.warn(`Invalid satisfaction week_start_date: ${String(satisfaction.week_start_date)}`);
    await markOutboxFailed(sql, outboxId, 'invalid satisfaction week_start_date', outboxAttempt);
    return;
  }
  // Round-trip validation: reject impossible dates like 2026-99-99
  const parsedDate = new Date(satisfaction.week_start_date + 'T00:00:00Z');
  if (Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== satisfaction.week_start_date) {
    logger.warn(`Invalid calendar date in week_start_date: ${satisfaction.week_start_date}`);
    await markOutboxFailed(sql, outboxId, 'invalid satisfaction week_start_date (not a real date)', outboxAttempt);
    return;
  }
  if (satisfaction.comment !== null && typeof satisfaction.comment !== 'string') {
    logger.warn(`Invalid satisfaction comment type: ${typeof satisfaction.comment}`);
    await markOutboxFailed(sql, outboxId, 'invalid satisfaction comment type', outboxAttempt);
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
    await markOutboxCompleted(sql, outboxId, outboxAttempt);
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
    await markOutboxCompleted(sql, outboxId, outboxAttempt);
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
  await markOutboxCompleted(sql, outboxId, outboxAttempt);

  const { messageId } = await sendInternalEmail({
    to: adminEmail,
    subject,
    bodyHtml,
    category: 'internal',
  });

  // Record delivery with week-scoped template tag for future idempotency checks
  await recordNotificationDelivery(sql, {
    accountId: business.account_id,
    businessId,
    channel: 'email',
    recipient: adminEmail,
    template: weekTag,
    externalMessageId: messageId,
  });

  logger.log(`partner_satisfaction_alert sent for business ${businessId} (rating: ${satisfaction.rating}, week: ${satisfaction.week_start_date})`);
}
