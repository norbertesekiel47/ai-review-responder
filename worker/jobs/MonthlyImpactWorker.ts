import type { Job } from 'bullmq';
import { v7 as uuidv7 } from 'uuid';
import { sql } from '../../src/lib/db/server';
import { markOutboxCompleted, markOutboxFailed, extractOutboxHandle } from '../../src/lib/shared/outbox';
import { getWorkerConfig } from '../../src/lib/config/worker';
import { sendInternalEmail, buildMonthlyImpactEmailHtml } from '../../src/lib/notifications/email';
import { recordNotificationDelivery } from '../../src/lib/notifications/delivery';
import { generateReviewSummary } from '../../src/lib/responses/review-summary';
import type { SendMonthlyImpactPayload } from '../../src/lib/shared/worker-types';
import { createWorkerLogger } from '../../src/lib/shared/logger';
import { HANDLED_STATUSES } from '../../src/lib/shared/response-status';
import { asLocationId } from '../../src/lib/shared/ids';
import type { LocationId } from '../../src/lib/shared/ids';
import {
  buildDashboardUrl,
  calculateBaselineResponseRate,
  completeOrFailSkippedSummaryReport,
  loadLatestRankingSummary,
  loadSummaryReportBusiness,
  mapSummaryReviews,
  ownerHasDashboardAuth,
} from './summary-report-helpers';

export async function handleMonthlyImpact(
  job: Job<SendMonthlyImpactPayload>,
): Promise<void> {
  const logger = createWorkerLogger('[MonthlyImpactWorker]', job.data.correlation_id);
  const { month_start_date } = job.data;
  // Cast job data IDs to branded types at entry point
  const businessId: LocationId = asLocationId(job.data.business_id);
  const { outboxId, attempt: outboxAttempt } = extractOutboxHandle(job.data, job.id!);

  const business = await loadSummaryReportBusiness(sql, businessId);
  const skipped = await completeOrFailSkippedSummaryReport(sql, {
    business,
    businessId,
    outboxId,
    outboxAttempt,
    logger,
  });
  if (skipped || !business) return;

  // ── 3. Upsert monthly_impact_emails row (idempotent) ──────────────
  // Allow reclaim of stale claims (>15 min) so a crashed worker doesn't
  // permanently block the email.
  const STALE_CLAIM_MINUTES = 15;
  const [upsertRow] = await sql<{ sent_at: string | null; summary_text: string | null }[]>`
    INSERT INTO monthly_impact_emails (id, business_id, month_start_date)
    VALUES (${uuidv7()}, ${businessId}, ${month_start_date}::date)
    ON CONFLICT (business_id, month_start_date)
    DO UPDATE SET business_id = monthly_impact_emails.business_id
    WHERE monthly_impact_emails.sent_at IS NULL
      AND (monthly_impact_emails.claimed_at IS NULL
           OR monthly_impact_emails.claimed_at < NOW() - (${STALE_CLAIM_MINUTES} * INTERVAL '1 minute'))
    RETURNING sent_at, summary_text
  `;

  if (!upsertRow) {
    const [existing] = await sql<{ sent_at: string | null; claimed_at: string | null }[]>`
      SELECT sent_at, claimed_at FROM monthly_impact_emails
      WHERE business_id = ${businessId} AND month_start_date = ${month_start_date}::date
    `;
    if (existing?.sent_at) {
      logger.log(`Monthly impact for ${businessId} month ${month_start_date} already sent`);
      await markOutboxCompleted(sql, outboxId, outboxAttempt);
    } else {
      logger.log(`Monthly impact for ${businessId} month ${month_start_date} claimed by another worker, will retry`);
      throw new Error('Report claimed by another worker');
    }
    return;
  }

  // ── 3b. Claim: atomically set claimed_at to prevent duplicate sends ──
  // The upsert above auto-commits and does NOT hold a lock across the
  // rest of the worker. This conditional UPDATE is atomic — only one
  // concurrent job wins the claim. Stale claims (>15 min) are reclaimable.
  const [claimed] = await sql<{ id: string }[]>`
    UPDATE monthly_impact_emails
    SET claimed_at = NOW()
    WHERE business_id = ${businessId}
      AND month_start_date = ${month_start_date}::date
      AND sent_at IS NULL
      AND (claimed_at IS NULL
           OR claimed_at < NOW() - (${STALE_CLAIM_MINUTES} * INTERVAL '1 minute'))
    RETURNING id
  `;
  if (!claimed) {
    logger.log(`Monthly impact for ${businessId} month ${month_start_date} claimed by another worker, will retry`);
    throw new Error('Report claimed by another worker');
  }

  // ── 4. Compute month boundaries ──────────────────────────────────
  const monthStart = new Date(month_start_date + 'T00:00:00Z');
  const monthEnd = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 1));
  const monthEndDate = monthEnd.toISOString().slice(0, 10);

  // ── 5. Query month stats ─────────────────────────────────────────
  const [reviewCount] = await sql<{ count: string }[]>`
    SELECT COUNT(*)::text AS count FROM reviews
    WHERE business_id = ${businessId}
      AND detected_at >= ${month_start_date}::date
      AND detected_at < ${monthEndDate}::date
  `;

  const [respondedCount] = await sql<{ count: string }[]>`
    SELECT COUNT(DISTINCT r.id)::text AS count FROM reviews r
    JOIN responses resp ON resp.review_id = r.id
      AND resp.status = ANY(${[...HANDLED_STATUSES] as string[]}::text[])
    WHERE r.business_id = ${businessId}
      AND r.detected_at >= ${month_start_date}::date
      AND r.detected_at < ${monthEndDate}::date
  `;

  const totalReviews = parseInt(reviewCount?.count ?? '0', 10);
  const totalResponded = parseInt(respondedCount?.count ?? '0', 10);

  // ── 6. Best review of the month ──────────────────────────────────
  const [bestReviewRow] = await sql<{
    reviewer_name: string;
    star_rating: number;
    review_text: string;
    response_text: string | null;
  }[]>`
    SELECT r.reviewer_name, r.star_rating, r.review_text,
           resp.approved_text AS response_text
    FROM reviews r
    LEFT JOIN responses resp ON resp.review_id = r.id
      AND resp.status = ANY(${[...HANDLED_STATUSES] as string[]}::text[])
    WHERE r.business_id = ${businessId}
      AND r.detected_at >= ${month_start_date}::date
      AND r.detected_at < ${monthEndDate}::date
      AND r.review_text IS NOT NULL
      AND r.star_rating IS NOT NULL
    ORDER BY r.star_rating DESC NULLS LAST, LENGTH(r.review_text) DESC
    LIMIT 1
  `;

  const bestReview = bestReviewRow
    ? {
        reviewerName: bestReviewRow.reviewer_name,
        starRating: bestReviewRow.star_rating,
        reviewText: bestReviewRow.review_text,
        responseText: bestReviewRow.response_text,
      }
    : null;

  // ── 7. Intelligence brief (reuse existing or generate) ────────────
  let intelligenceBrief: string | null = upsertRow.summary_text ?? null;

  if (!intelligenceBrief) {
    const reviewsForSummary = await sql<{
      star_rating: number;
      review_text: string | null;
    }[]>`
      SELECT star_rating, review_text FROM reviews
      WHERE business_id = ${businessId}
        AND detected_at >= ${month_start_date}::date
        AND detected_at < ${monthEndDate}::date
        AND review_text IS NOT NULL
        AND star_rating IS NOT NULL
      ORDER BY detected_at DESC
      LIMIT 30
    `;

    if (reviewsForSummary.length > 0) {
      const summaryResult = await generateReviewSummary(
        sql,
        mapSummaryReviews(reviewsForSummary),
        businessId,
        business.subscription_tier,
      );
      intelligenceBrief = summaryResult?.summaryText ?? null;

      if (intelligenceBrief) {
        await sql`
          UPDATE monthly_impact_emails
          SET summary_text = ${intelligenceBrief}
          WHERE business_id = ${businessId} AND month_start_date = ${month_start_date}::date
        `;
      }
    }
  }

  // ── 8. Ranking snapshot (conditional) ─────────────────────────────
  const ranking = await loadLatestRankingSummary(sql, businessId);

  // ── 9. Dashboard eligibility ─────────────────────────────────────
  const dashboardUrl = buildDashboardUrl(
    await ownerHasDashboardAuth(sql, businessId),
    getWorkerConfig().NEXT_PUBLIC_APP_URL,
  );

  // ── 10. Compute values ───────────────────────────────────────────
  const responseRate = totalReviews > 0 ? Math.round((totalResponded / totalReviews) * 100) : 0;

  const baselineResponseRate = calculateBaselineResponseRate(business);

  const timeSavedMinutes = totalResponded * 7;

  const monthLabel = new Date(month_start_date + 'T00:00:00Z').toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });

  // ── 11. Build email ──────────────────────────────────────────────
  const html = buildMonthlyImpactEmailHtml({
    businessName: business.name,
    monthLabel,
    totalReviews,
    totalResponded,
    responseRate,
    baselineResponseRate,
    timeSavedMinutes,
    intelligenceBrief,
    ranking,
    bestReview,
    dashboardUrl,
  });

  // ── 12. Mark sent_at just before Resend call (crash-safe) ─────────
  await sql`
    UPDATE monthly_impact_emails
    SET sent_at = NOW()
    WHERE business_id = ${businessId} AND month_start_date = ${month_start_date}::date
  `;

  // ── 13. Send email ───────────────────────────────────────────────
  let messageId: string;
  try {
    const result = await sendInternalEmail({
      to: business.owner_email,
      subject: `Monthly Impact Report — ${business.name} (${monthLabel})`,
      bodyHtml: html,
      category: 'marketing',
    });
    messageId = result.messageId;
  } catch (err) {
    logger.error(`Failed to send monthly impact report for business ${businessId} (month ${month_start_date}): ${err instanceof Error ? err.message : err}`);
    // Keep sent_at set — Resend may have accepted the email before the error.
    // Clearing would risk a duplicate if the scheduler re-queues this business.
    await markOutboxFailed(sql, outboxId, err instanceof Error ? err.message : String(err), outboxAttempt);
    return;
  }

  // ── 14. Record notification delivery ─────────────────────────────
  await recordNotificationDelivery(sql, {
    accountId: business.account_id,
    businessId: businessId,
    channel: 'email',
    recipient: business.owner_email,
    template: 'monthly_impact',
    externalMessageId: messageId,
  });

  await markOutboxCompleted(sql, outboxId, outboxAttempt);
  logger.log(`Monthly impact report sent for business ${businessId} (month ${month_start_date})`);
}
