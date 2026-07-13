import type { Job } from 'bullmq';
import type { Sql } from 'postgres';
import { v7 as uuidv7 } from 'uuid';
import { sql } from '../../src/lib/db/server';
import { markOutboxCompleted } from '../../src/lib/shared/outbox';
import { getWorkerConfig } from '../../src/lib/config/worker';
import { buildMonthlyImpactEmailHtml } from '../../src/lib/notifications/email';
import { recordNotificationDelivery } from '../../src/lib/notifications/delivery';
import { generateReviewSummary } from '../../src/lib/responses/review-summary';
import type { SendMonthlyImpactPayload } from '../../src/lib/shared/worker-types';
import { createWorkerLogger, type WorkerLogger } from '../../src/lib/shared/logger';
import { HANDLED_STATUSES } from '../../src/lib/shared/response-status';
import type { LocationId } from '../../src/lib/shared/ids';
import {
  buildDashboardUrl,
  calculateBaselineResponseRate,
  loadLatestRankingSummary,
  mapSummaryReviews,
  ownerHasDashboardAuth,
  prepareSummaryReport,
  sendSummaryReportEmail,
  type SummaryReportBusiness,
} from './summary-report-helpers';

const STALE_CLAIM_MINUTES = 15;

interface MonthlySummaryRow {
  sent_at: string | null;
  summary_text: string | null;
}

interface MonthlyStats {
  totalReviews: number;
  totalResponded: number;
}

interface MonthlyBestReviewRow {
  reviewer_name: string;
  star_rating: number;
  review_text: string;
  response_text: string | null;
}

async function upsertMonthlySummary(
  db: Sql,
  businessId: LocationId,
  monthStartDate: string,
): Promise<MonthlySummaryRow | null> {
  const [row] = await db<MonthlySummaryRow[]>`
    INSERT INTO monthly_impact_emails (id, business_id, month_start_date)
    VALUES (${uuidv7()}, ${businessId}, ${monthStartDate}::date)
    ON CONFLICT (business_id, month_start_date)
    DO UPDATE SET business_id = monthly_impact_emails.business_id
    WHERE monthly_impact_emails.sent_at IS NULL
      AND (monthly_impact_emails.claimed_at IS NULL
           OR monthly_impact_emails.claimed_at < NOW() - (${STALE_CLAIM_MINUTES} * INTERVAL '1 minute'))
    RETURNING sent_at, summary_text
  `;
  return row ?? null;
}

async function resolveUnavailableMonthlySummary(
  db: Sql,
  input: {
    businessId: LocationId;
    monthStartDate: string;
    outboxId: string;
    outboxAttempt: number | undefined;
    logger: WorkerLogger;
  },
): Promise<void> {
  const [existing] = await db<{ sent_at: string | null; claimed_at: string | null }[]>`
    SELECT sent_at, claimed_at FROM monthly_impact_emails
    WHERE business_id = ${input.businessId} AND month_start_date = ${input.monthStartDate}::date
  `;
  if (existing?.sent_at) {
    input.logger.log(`Monthly impact for ${input.businessId} month ${input.monthStartDate} already sent`);
    await markOutboxCompleted(db, input.outboxId, input.outboxAttempt);
    return;
  }
  input.logger.log(`Monthly impact for ${input.businessId} month ${input.monthStartDate} claimed by another worker, will retry`);
  throw new Error('Report claimed by another worker');
}

async function claimMonthlySummary(
  db: Sql,
  businessId: LocationId,
  monthStartDate: string,
  logger: WorkerLogger,
): Promise<void> {
  const [claimed] = await db<{ id: string }[]>`
    UPDATE monthly_impact_emails
    SET claimed_at = NOW()
    WHERE business_id = ${businessId}
      AND month_start_date = ${monthStartDate}::date
      AND sent_at IS NULL
      AND (claimed_at IS NULL
           OR claimed_at < NOW() - (${STALE_CLAIM_MINUTES} * INTERVAL '1 minute'))
    RETURNING id
  `;
  if (claimed) return;
  logger.log(`Monthly impact for ${businessId} month ${monthStartDate} claimed by another worker, will retry`);
  throw new Error('Report claimed by another worker');
}

async function acquireMonthlySummary(
  db: Sql,
  input: {
    businessId: LocationId;
    monthStartDate: string;
    outboxId: string;
    outboxAttempt: number | undefined;
    logger: WorkerLogger;
  },
): Promise<MonthlySummaryRow | null> {
  const row = await upsertMonthlySummary(db, input.businessId, input.monthStartDate);
  if (!row) {
    await resolveUnavailableMonthlySummary(db, input);
    return null;
  }
  await claimMonthlySummary(db, input.businessId, input.monthStartDate, input.logger);
  return row;
}

function monthEndDateFor(monthStartDate: string): string {
  const monthStart = new Date(`${monthStartDate}T00:00:00Z`);
  const monthEnd = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 1));
  return monthEnd.toISOString().slice(0, 10);
}

async function loadMonthlyStats(
  db: Sql,
  businessId: LocationId,
  monthStartDate: string,
  monthEndDate: string,
): Promise<MonthlyStats> {
  const [reviewCount] = await db<{ count: string }[]>`
    SELECT COUNT(*)::text AS count FROM reviews
    WHERE business_id = ${businessId}
      AND detected_at >= ${monthStartDate}::date
      AND detected_at < ${monthEndDate}::date
  `;
  const [respondedCount] = await db<{ count: string }[]>`
    SELECT COUNT(DISTINCT r.id)::text AS count FROM reviews r
    JOIN responses resp ON resp.review_id = r.id
      AND resp.status = ANY(${[...HANDLED_STATUSES] as string[]}::text[])
    WHERE r.business_id = ${businessId}
      AND r.detected_at >= ${monthStartDate}::date
      AND r.detected_at < ${monthEndDate}::date
  `;
  return {
    totalReviews: parseInt(reviewCount?.count ?? '0', 10),
    totalResponded: parseInt(respondedCount?.count ?? '0', 10),
  };
}

async function loadMonthlyBestReview(
  db: Sql,
  businessId: LocationId,
  monthStartDate: string,
  monthEndDate: string,
) {
  const [row] = await db<MonthlyBestReviewRow[]>`
    SELECT r.reviewer_name, r.star_rating, r.review_text,
           resp.approved_text AS response_text
    FROM reviews r
    LEFT JOIN responses resp ON resp.review_id = r.id
      AND resp.status = ANY(${[...HANDLED_STATUSES] as string[]}::text[])
    WHERE r.business_id = ${businessId}
      AND r.detected_at >= ${monthStartDate}::date
      AND r.detected_at < ${monthEndDate}::date
      AND r.review_text IS NOT NULL
      AND r.star_rating IS NOT NULL
    ORDER BY r.star_rating DESC NULLS LAST, LENGTH(r.review_text) DESC
    LIMIT 1
  `;
  return row ? {
    reviewerName: row.reviewer_name,
    starRating: row.star_rating,
    reviewText: row.review_text,
    responseText: row.response_text,
  } : null;
}

async function resolveMonthlyIntelligenceBrief(
  db: Sql,
  input: {
    existingSummary: string | null;
    businessId: LocationId;
    subscriptionTier: string;
    monthStartDate: string;
    monthEndDate: string;
  },
): Promise<string | null> {
  if (input.existingSummary) return input.existingSummary;
  const reviews = await db<{ star_rating: number; review_text: string | null }[]>`
    SELECT star_rating, review_text FROM reviews
    WHERE business_id = ${input.businessId}
      AND detected_at >= ${input.monthStartDate}::date
      AND detected_at < ${input.monthEndDate}::date
      AND review_text IS NOT NULL
      AND star_rating IS NOT NULL
    ORDER BY detected_at DESC
    LIMIT 30
  `;
  if (reviews.length === 0) return null;
  const result = await generateReviewSummary(
    db,
    mapSummaryReviews(reviews),
    input.businessId,
    input.subscriptionTier,
  );
  const intelligenceBrief = result?.summaryText ?? null;
  if (intelligenceBrief) {
    await db`
      UPDATE monthly_impact_emails
      SET summary_text = ${intelligenceBrief}
      WHERE business_id = ${input.businessId} AND month_start_date = ${input.monthStartDate}::date
    `;
  }
  return intelligenceBrief;
}

async function commitAndDeliverMonthlyImpact(
  db: Sql,
  input: {
    business: SummaryReportBusiness;
    businessId: LocationId;
    monthStartDate: string;
    monthLabel: string;
    html: string;
    outboxId: string;
    outboxAttempt: number | undefined;
    logger: WorkerLogger;
  },
): Promise<void> {
  await db`
    UPDATE monthly_impact_emails
    SET sent_at = NOW()
    WHERE business_id = ${input.businessId} AND month_start_date = ${input.monthStartDate}::date
  `;
  const messageId = await sendSummaryReportEmail(db, {
    to: input.business.owner_email,
    subject: `Monthly Impact Report — ${input.business.name} (${input.monthLabel})`,
    bodyHtml: input.html,
    failureContext: `Failed to send monthly impact report for business ${input.businessId} (month ${input.monthStartDate})`,
    outboxId: input.outboxId,
    outboxAttempt: input.outboxAttempt,
    logger: input.logger,
  });
  if (!messageId) return;
  await recordNotificationDelivery(db, {
    accountId: input.business.account_id,
    businessId: input.businessId,
    channel: 'email',
    recipient: input.business.owner_email,
    template: 'monthly_impact',
    externalMessageId: messageId,
  });
  await markOutboxCompleted(db, input.outboxId, input.outboxAttempt);
  input.logger.log(`Monthly impact report sent for business ${input.businessId} (month ${input.monthStartDate})`);
}

export async function handleMonthlyImpact(
  job: Job<SendMonthlyImpactPayload>,
): Promise<void> {
  const logger = createWorkerLogger('[MonthlyImpactWorker]', job.data.correlation_id);
  const { month_start_date } = job.data;
  const context = await prepareSummaryReport(sql, job, logger);
  if (!context) return;
  const { business, businessId, outboxId, outboxAttempt } = context;
  const summaryRow = await acquireMonthlySummary(sql, {
    businessId,
    monthStartDate: month_start_date,
    outboxId,
    outboxAttempt,
    logger,
  });
  if (!summaryRow) return;
  const monthEndDate = monthEndDateFor(month_start_date);
  const stats = await loadMonthlyStats(sql, businessId, month_start_date, monthEndDate);
  const bestReview = await loadMonthlyBestReview(sql, businessId, month_start_date, monthEndDate);
  const intelligenceBrief = await resolveMonthlyIntelligenceBrief(sql, {
    existingSummary: summaryRow.summary_text,
    businessId,
    subscriptionTier: business.subscription_tier,
    monthStartDate: month_start_date,
    monthEndDate,
  });
  const ranking = await loadLatestRankingSummary(sql, businessId);
  const dashboardUrl = buildDashboardUrl(
    await ownerHasDashboardAuth(sql, businessId),
    getWorkerConfig().NEXT_PUBLIC_APP_URL,
  );
  const monthLabel = new Date(`${month_start_date}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
  const html = buildMonthlyImpactEmailHtml({
    businessName: business.name,
    monthLabel,
    totalReviews: stats.totalReviews,
    totalResponded: stats.totalResponded,
    responseRate: stats.totalReviews > 0
      ? Math.round((stats.totalResponded / stats.totalReviews) * 100)
      : 0,
    baselineResponseRate: calculateBaselineResponseRate(business),
    timeSavedMinutes: stats.totalResponded * 7,
    intelligenceBrief,
    ranking,
    bestReview,
    dashboardUrl,
  });
  await commitAndDeliverMonthlyImpact(sql, {
    business,
    businessId,
    monthStartDate: month_start_date,
    monthLabel,
    html,
    outboxId,
    outboxAttempt,
    logger,
  });
}
