import type { Job } from 'bullmq';
import type { Sql } from 'postgres';
import { v7 as uuidv7 } from 'uuid';
import { sql, jsonb } from '../../src/lib/db/server';
import { markOutboxCompleted, markOutboxFailed, extractOutboxHandle } from '../../src/lib/shared/outbox';
import { getWorkerConfig } from '../../src/lib/config/worker';
import { sendInternalEmail, buildWeeklyValueReportHtml } from '../../src/lib/notifications/email';
import { recordNotificationDelivery } from '../../src/lib/notifications/delivery';
import { generateReviewSummary } from '../../src/lib/responses/review-summary';
import type { WeeklySummaryPayload } from '../../src/lib/shared/worker-types';
import { buildFeedbackUrl } from '../../src/lib/shared/feedback-hmac';
import { createWorkerLogger } from '../../src/lib/shared/logger';
import { HANDLED_STATUSES } from '../../src/lib/shared/response-status';
import { asLocationId } from '../../src/lib/shared/ids';
import type { LocationId } from '../../src/lib/shared/ids';
import {
  completeRun,
  recordOutcome,
  recordStep,
  startOrGetActiveRun,
} from '../../src/lib/agents/run-spine';
import {
  buildDashboardUrl,
  calculateBaselineResponseRate,
  completeOrFailSkippedSummaryReport,
  loadLatestRankingSummary,
  loadSummaryReportBusiness,
  mapSummaryReviews,
  ownerHasDashboardAuth,
} from './summary-report-helpers';

export interface CommitWeeklyInsightsDigestInput {
  accountId: string;
  businessId: string;
  weekStartDate: string;
  correlationId?: string;
}

export async function commitWeeklyInsightsDigest(
  db: Sql,
  input: CommitWeeklyInsightsDigestInput,
): Promise<boolean> {
  return db.begin(async (tx) => {
    const [sent] = await tx<{ id: string }[]>`
      UPDATE weekly_summaries
      SET sent_at = NOW()
      WHERE business_id = ${input.businessId}
        AND week_start_date = ${input.weekStartDate}::date
        AND sent_at IS NULL
      RETURNING id
    `;
    if (!sent) return false;

    const { runId } = await startOrGetActiveRun(tx, {
      kind: 'weekly_insights',
      subjectType: 'account_week',
      subjectId: `${input.accountId}_${input.weekStartDate}`,
      accountId: input.accountId,
      businessId: input.businessId,
      correlationId: input.correlationId,
    });
    await recordStep(tx, {
      runId,
      stepKey: 'digest_sent',
      detail: {
        week_start_date: input.weekStartDate,
        business_id: input.businessId,
      },
    });
    await recordOutcome(tx, {
      runId,
      accountId: input.accountId,
      businessId: input.businessId,
      outcomeKind: 'digest_sent',
      attributedAgent: 'insights',
    });
    await completeRun(tx, runId, 'completed');
    return true;
  });
}

export async function handleWeeklySummary(
  job: Job<WeeklySummaryPayload>,
): Promise<void> {
  const logger = createWorkerLogger('[WeeklySummaryWorker]', job.data.correlation_id);
  const { week_start_date } = job.data;
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

  // ── 3. Query week stats ───────────────────────────────────────────
  const weekEnd = new Date(week_start_date + 'T00:00:00Z');
  weekEnd.setUTCDate(weekEnd.getUTCDate() + 7);
  const weekEndDate = weekEnd.toISOString().slice(0, 10);

  const [reviewCount] = await sql<{ count: string }[]>`
    SELECT COUNT(*)::text AS count FROM reviews
    WHERE business_id = ${businessId}
      AND detected_at >= ${week_start_date}::date
      AND detected_at < ${weekEndDate}::date
  `;

  const [respondedCount] = await sql<{ count: string }[]>`
    SELECT COUNT(DISTINCT r.id)::text AS count FROM reviews r
    JOIN responses resp ON resp.review_id = r.id
      AND resp.status = ANY(${[...HANDLED_STATUSES] as string[]}::text[])
    WHERE r.business_id = ${businessId}
      AND r.detected_at >= ${week_start_date}::date
      AND r.detected_at < ${weekEndDate}::date
  `;

  const notableReviews = await sql<{
    reviewer_name: string;
    star_rating: number;
    review_text: string | null;
  }[]>`
    SELECT reviewer_name, star_rating, review_text FROM reviews
    WHERE business_id = ${businessId}
      AND star_rating <= 2
      AND detected_at >= ${week_start_date}::date
      AND detected_at < ${weekEndDate}::date
    ORDER BY detected_at DESC
    LIMIT 5
  `;

  const totalReviews = parseInt(reviewCount?.count ?? '0', 10);
  const totalResponded = parseInt(respondedCount?.count ?? '0', 10);

  // ── 4. Additional queries for value report ────────────────────────

  // 4a. Reviews for intelligence brief (texts for LLM summarization)
  const reviewsForSummary = await sql<{
    star_rating: number;
    review_text: string | null;
  }[]>`
    SELECT star_rating, review_text FROM reviews
    WHERE business_id = ${businessId}
      AND detected_at >= ${week_start_date}::date
      AND detected_at < ${weekEndDate}::date
      AND review_text IS NOT NULL
      AND star_rating IS NOT NULL
    ORDER BY detected_at DESC
    LIMIT 30
  `;

  // 4b. 4-week average review count
  const [avgRow] = await sql<{ avg: string }[]>`
    SELECT COALESCE(
      (SELECT COUNT(*)::float / 4.0 FROM reviews
       WHERE business_id = ${businessId}
         AND detected_at >= (${week_start_date}::date - INTERVAL '28 days')
         AND detected_at < ${week_start_date}::date),
      0
    )::text AS avg
  `;
  const fourWeekAvgReviews = parseFloat(avgRow?.avg ?? '0');

  // 4c. Ranking snapshot (conditional, no SerpAPI calls)
  const ranking = await loadLatestRankingSummary(sql, businessId);

  // 4d. Dashboard link eligibility
  const cfg = getWorkerConfig();
  const appUrl = cfg.NEXT_PUBLIC_APP_URL;
  const dashboardUrl = buildDashboardUrl(
    await ownerHasDashboardAuth(sql, businessId),
    appUrl,
  );

  // ── 5. Upsert weekly_summaries row (idempotent) ───────────────────
  // Allow reclaim of stale claims (>15 min) so a crashed worker doesn't
  // permanently block the email.
  const STALE_CLAIM_MINUTES = 15;
  const [upsertRow] = await sql<{ sent_at: string | null; summary_text: string | null }[]>`
    INSERT INTO weekly_summaries (id, business_id, week_start_date, total_reviews, total_responded, notable_reviews)
    VALUES (
      ${uuidv7()}, ${businessId}, ${week_start_date}::date,
      ${totalReviews}, ${totalResponded},
      ${jsonb(notableReviews)}
    )
    ON CONFLICT (business_id, week_start_date)
    DO UPDATE SET
      total_reviews = EXCLUDED.total_reviews,
      total_responded = EXCLUDED.total_responded,
      notable_reviews = EXCLUDED.notable_reviews
    WHERE weekly_summaries.sent_at IS NULL
      AND (weekly_summaries.claimed_at IS NULL
           OR weekly_summaries.claimed_at < NOW() - (${STALE_CLAIM_MINUTES} * INTERVAL '1 minute'))
    RETURNING sent_at, summary_text
  `;

  if (!upsertRow) {
    // No row returned — either already sent, or freshly claimed by another worker.
    // Check which case to decide whether to complete or retry.
    const [existing] = await sql<{ sent_at: string | null; claimed_at: string | null }[]>`
      SELECT sent_at, claimed_at FROM weekly_summaries
      WHERE business_id = ${businessId} AND week_start_date = ${week_start_date}::date
    `;
    if (existing?.sent_at) {
      logger.log(`Weekly summary for ${businessId} week ${week_start_date} already sent`);
      await markOutboxCompleted(sql, outboxId, outboxAttempt);
    } else {
      // Freshly claimed by another worker — throw so BullMQ retries after backoff
      logger.log(`Weekly summary for ${businessId} week ${week_start_date} claimed by another worker, will retry`);
      throw new Error('Report claimed by another worker');
    }
    return;
  }

  // ── 5b. Claim: atomically set claimed_at to prevent duplicate sends ──
  // The upsert above auto-commits and does NOT hold a lock across the
  // rest of the worker. This conditional UPDATE is atomic — only one
  // concurrent job wins the claim. Stale claims (>15 min) are reclaimable.
  const [claimed] = await sql<{ id: string }[]>`
    UPDATE weekly_summaries
    SET claimed_at = NOW()
    WHERE business_id = ${businessId}
      AND week_start_date = ${week_start_date}::date
      AND sent_at IS NULL
      AND (claimed_at IS NULL
           OR claimed_at < NOW() - (${STALE_CLAIM_MINUTES} * INTERVAL '1 minute'))
    RETURNING id
  `;
  if (!claimed) {
    // Another worker just claimed it between the upsert and this UPDATE — retry
    logger.log(`Weekly summary for ${businessId} week ${week_start_date} claimed by another worker, will retry`);
    throw new Error('Report claimed by another worker');
  }

  // ── 6. Intelligence brief (reuse existing or generate) ────────────
  let intelligenceBrief: string | null = upsertRow.summary_text ?? null;

  if (!intelligenceBrief && reviewsForSummary.length > 0) {
    const summaryResult = await generateReviewSummary(
      sql,
      mapSummaryReviews(reviewsForSummary),
      businessId,
      business.subscription_tier,
    );
    intelligenceBrief = summaryResult?.summaryText ?? null;

    // Persist the summary_text for idempotent retries
    if (intelligenceBrief) {
      await sql`
        UPDATE weekly_summaries
        SET summary_text = ${intelligenceBrief}
        WHERE business_id = ${businessId} AND week_start_date = ${week_start_date}::date
      `;
    }
  }

  // ── 7. Compute baseline response rate ─────────────────────────────
  const baselineResponseRate = calculateBaselineResponseRate(business);

  // ── 8. Build feedback URLs (satisfaction pulse) ───────────────────
  let feedbackUrls: { great: string; ok: string; notGreat: string } | null = null;
  if (appUrl && cfg.CSRF_SECRET) {
    feedbackUrls = {
      great: buildFeedbackUrl(appUrl, businessId, 'great', week_start_date),
      ok: buildFeedbackUrl(appUrl, businessId, 'ok', week_start_date),
      notGreat: buildFeedbackUrl(appUrl, businessId, 'not_great', week_start_date),
    };
  }

  // ── 9. Build email ────────────────────────────────────────────────
  const html = buildWeeklyValueReportHtml({
    businessName: business.name,
    weekStartDate: week_start_date,
    weekEndDate,
    totalReviews,
    totalResponded,
    notableReviews: notableReviews.map((r) => ({
      reviewerName: r.reviewer_name,
      starRating: r.star_rating,
      reviewText: r.review_text,
    })),
    intelligenceBrief,
    baselineResponseRate,
    fourWeekAvgReviews,
    ranking,
    dashboardUrl,
    feedbackUrls,
  });

  // ── 9. Commit the send + Insights attribution before Resend (crash-safe) ──
  const committedSend = await commitWeeklyInsightsDigest(sql, {
    accountId: business.account_id,
    businessId,
    weekStartDate: week_start_date,
    correlationId: job.data.correlation_id,
  });

  if (!committedSend) {
    logger.log(`Weekly summary for ${businessId} week ${week_start_date} already sent`);
    await markOutboxCompleted(sql, outboxId, outboxAttempt);
    return;
  }

  // ── 10. Send email ────────────────────────────────────────────────
  const weekLabel = `${week_start_date} to ${weekEndDate}`;
  let messageId: string;
  try {
    const result = await sendInternalEmail({
      to: business.owner_email,
      subject: `Your Insights agent's weekly report — ${business.name} (${weekLabel})`,
      bodyHtml: html,
      category: 'marketing',
    });
    messageId = result.messageId;
  } catch (err) {
    logger.error(`Failed to send weekly value report for business ${businessId} (week ${week_start_date}): ${err instanceof Error ? err.message : err}`);
    // Keep sent_at set — Resend may have accepted the email before the error.
    // Clearing would risk a duplicate if the scheduler re-queues this business.
    // Prompt 19a accepts the rare missed-email risk over duplicate sends.
    await markOutboxFailed(sql, outboxId, err instanceof Error ? err.message : String(err), outboxAttempt);
    return;
  }

  // ── 11. Record notification delivery ──────────────────────────────
  await recordNotificationDelivery(sql, {
    accountId: business.account_id,
    businessId: businessId,
    channel: 'email',
    recipient: business.owner_email,
    template: 'weekly_value_report',
    externalMessageId: messageId,
  });

  await markOutboxCompleted(sql, outboxId, outboxAttempt);
  logger.log(`Weekly value report sent for business ${businessId} (week ${week_start_date})`);
}
