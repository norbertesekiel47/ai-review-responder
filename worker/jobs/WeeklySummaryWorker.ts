import type { Job } from 'bullmq';
import { isSubscriptionTier, type SubscriptionTierValue } from '@/lib/accounts/tier-config';
import type { Sql } from 'postgres';
import { v7 as uuidv7 } from 'uuid';
import { sql, jsonb } from '../../src/lib/db/server';
import { markOutboxCompleted } from '../../src/lib/shared/outbox';
import { getWorkerConfig } from '../../src/lib/config/worker';
import { buildWeeklyValueReportHtml } from '../../src/lib/notifications/email';
import { recordNotificationDelivery } from '../../src/lib/notifications/delivery';
import { generateReviewSummary } from '../../src/lib/responses/review-summary';
import type { WeeklySummaryPayload } from '../../src/lib/shared/worker-types';
import { buildFeedbackUrl } from '../../src/lib/shared/feedback-hmac';
import { createWorkerLogger, type WorkerLogger } from '../../src/lib/shared/logger';
import { HANDLED_STATUSES } from '../../src/lib/shared/response-status';
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
  loadLatestRankingSummary,
  mapSummaryReviews,
  ownerHasDashboardAuth,
  prepareSummaryReport,
  sendSummaryReportEmail,
  type SummaryReportBusiness,
} from './summary-report-helpers';

const STALE_CLAIM_MINUTES = 15;

interface WeeklyNotableReview {
  reviewer_name: string;
  star_rating: number;
  review_text: string | null;
}

interface WeeklyReviewRow {
  star_rating: number;
  review_text: string | null;
}

interface WeeklyReviewStats {
  totalReviews: number;
  totalResponded: number;
  notableReviews: WeeklyNotableReview[];
}

interface WeeklyValueInputs {
  reviewsForSummary: WeeklyReviewRow[];
  fourWeekAvgReviews: number;
  ranking: Awaited<ReturnType<typeof loadLatestRankingSummary>>;
  dashboardUrl: string | null;
  appUrl: string | undefined;
  csrfSecret: string | undefined;
}

interface WeeklySummaryRow {
  sent_at: string | null;
  summary_text: string | null;
}

export interface CommitWeeklyInsightsDigestInput {
  accountId: string;
  businessId: string;
  weekStartDate: string;
  correlationId?: string;
}

// Non-review-subject spine tenant (NON_REVIEW_SUBJECT_CALLERS carve-out in
// outcome-anchor-pairing.test.ts): this tx explicitly locks only its
// weekly_summaries row + the account_week run row, but the spine INSERTs
// (agent_runs / agent_run_steps / agent_outcomes) also take implicit FK
// FOR KEY SHARE locks on the parent businesses + accounts rows. Cycle-free:
// those key-shares conflict only with exclusive parent-row locks (e.g. a
// reviews-lane tx holding businesses FOR UPDATE), and no such holder ever
// waits on weekly_summaries or a weekly-subject run — this tx can wait, but
// no cycle can close back onto it. Growing a reviews/businesses lock here
// requires leaving the carve-out and re-entering the global
// reviews → businesses → child rows → agent_runs order.
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

function weekEndDateFor(weekStartDate: string): string {
  const weekEnd = new Date(`${weekStartDate}T00:00:00Z`);
  weekEnd.setUTCDate(weekEnd.getUTCDate() + 7);
  return weekEnd.toISOString().slice(0, 10);
}

async function loadWeeklyReviewStats(
  db: Sql,
  businessId: LocationId,
  weekStartDate: string,
  weekEndDate: string,
): Promise<WeeklyReviewStats> {
  const [reviewCount] = await db<{ count: string }[]>`
    SELECT COUNT(*)::text AS count FROM reviews
    WHERE business_id = ${businessId}
      AND detected_at >= ${weekStartDate}::date
      AND detected_at < ${weekEndDate}::date
  `;
  const [respondedCount] = await db<{ count: string }[]>`
    SELECT COUNT(DISTINCT r.id)::text AS count FROM reviews r
    JOIN responses resp ON resp.review_id = r.id
      AND resp.business_id = ${businessId}
      AND resp.status = ANY(${[...HANDLED_STATUSES] as string[]}::text[])
    WHERE r.business_id = ${businessId}
      AND r.detected_at >= ${weekStartDate}::date
      AND r.detected_at < ${weekEndDate}::date
  `;
  const notableReviews = await db<WeeklyNotableReview[]>`
    SELECT reviewer_name, star_rating, review_text FROM reviews
    WHERE business_id = ${businessId}
      AND star_rating <= 2
      AND detected_at >= ${weekStartDate}::date
      AND detected_at < ${weekEndDate}::date
    ORDER BY detected_at DESC
    LIMIT 5
  `;
  return {
    totalReviews: parseInt(reviewCount?.count ?? '0', 10),
    totalResponded: parseInt(respondedCount?.count ?? '0', 10),
    notableReviews,
  };
}

async function loadWeeklyValueInputs(
  db: Sql,
  businessId: LocationId,
  weekStartDate: string,
  weekEndDate: string,
): Promise<WeeklyValueInputs> {
  const reviewsForSummary = await db<WeeklyReviewRow[]>`
    SELECT star_rating, review_text FROM reviews
    WHERE business_id = ${businessId}
      AND detected_at >= ${weekStartDate}::date
      AND detected_at < ${weekEndDate}::date
      AND review_text IS NOT NULL
      AND star_rating IS NOT NULL
    ORDER BY detected_at DESC
    LIMIT 30
  `;
  const [avgRow] = await db<{ avg: string }[]>`
    SELECT COALESCE(COUNT(*)::float / 4.0, 0)::text AS avg
    FROM reviews
    WHERE business_id = ${businessId}
      AND detected_at >= (${weekStartDate}::date - INTERVAL '28 days')
      AND detected_at < ${weekStartDate}::date
  `;
  const ranking = await loadLatestRankingSummary(db, businessId);
  const cfg = getWorkerConfig();
  const dashboardUrl = buildDashboardUrl(
    await ownerHasDashboardAuth(db, businessId),
    cfg.NEXT_PUBLIC_APP_URL,
  );
  return {
    reviewsForSummary,
    fourWeekAvgReviews: parseFloat(avgRow?.avg ?? '0'),
    ranking,
    dashboardUrl,
    appUrl: cfg.NEXT_PUBLIC_APP_URL,
    csrfSecret: cfg.CSRF_SECRET,
  };
}

async function upsertWeeklySummary(
  db: Sql,
  input: {
    businessId: LocationId;
    weekStartDate: string;
    stats: WeeklyReviewStats;
  },
): Promise<WeeklySummaryRow | null> {
  const [row] = await db<WeeklySummaryRow[]>`
    INSERT INTO weekly_summaries (id, business_id, week_start_date, total_reviews, total_responded, notable_reviews)
    VALUES (
      ${uuidv7()}, ${input.businessId}, ${input.weekStartDate}::date,
      ${input.stats.totalReviews}, ${input.stats.totalResponded},
      ${jsonb(input.stats.notableReviews)}
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
  return row ?? null;
}

async function resolveUnavailableWeeklySummary(
  db: Sql,
  input: {
    businessId: LocationId;
    weekStartDate: string;
    outboxId: string;
    outboxAttempt: number | undefined;
    logger: WorkerLogger;
  },
): Promise<void> {
  const [existing] = await db<{ sent_at: string | null; claimed_at: string | null }[]>`
    SELECT sent_at, claimed_at FROM weekly_summaries
    WHERE business_id = ${input.businessId} AND week_start_date = ${input.weekStartDate}::date
  `;
  if (existing?.sent_at) {
    input.logger.log(`Weekly summary for ${input.businessId} week ${input.weekStartDate} already sent`);
    await markOutboxCompleted(db, input.outboxId, input.outboxAttempt);
    return;
  }
  input.logger.log(`Weekly summary for ${input.businessId} week ${input.weekStartDate} claimed by another worker, will retry`);
  throw new Error('Report claimed by another worker');
}

async function claimWeeklySummary(
  db: Sql,
  businessId: LocationId,
  weekStartDate: string,
  logger: WorkerLogger,
): Promise<void> {
  const [claimed] = await db<{ id: string }[]>`
    UPDATE weekly_summaries
    SET claimed_at = NOW()
    WHERE business_id = ${businessId}
      AND week_start_date = ${weekStartDate}::date
      AND sent_at IS NULL
      AND (claimed_at IS NULL
           OR claimed_at < NOW() - (${STALE_CLAIM_MINUTES} * INTERVAL '1 minute'))
    RETURNING id
  `;
  if (claimed) return;
  logger.log(`Weekly summary for ${businessId} week ${weekStartDate} claimed by another worker, will retry`);
  throw new Error('Report claimed by another worker');
}

async function acquireWeeklySummary(
  db: Sql,
  input: {
    businessId: LocationId;
    weekStartDate: string;
    stats: WeeklyReviewStats;
    outboxId: string;
    outboxAttempt: number | undefined;
    logger: WorkerLogger;
  },
): Promise<WeeklySummaryRow | null> {
  const row = await upsertWeeklySummary(db, input);
  if (!row) {
    await resolveUnavailableWeeklySummary(db, input);
    return null;
  }
  await claimWeeklySummary(db, input.businessId, input.weekStartDate, input.logger);
  return row;
}

async function resolveWeeklyIntelligenceBrief(
  db: Sql,
  input: {
    existingSummary: string | null;
    reviews: WeeklyReviewRow[];
    businessId: LocationId;
    subscriptionTier: SubscriptionTierValue;
    weekStartDate: string;
  },
): Promise<string | null> {
  if (input.existingSummary || input.reviews.length === 0) {
    return input.existingSummary;
  }
  const result = await generateReviewSummary(
    db,
    mapSummaryReviews(input.reviews),
    input.businessId,
    input.subscriptionTier,
  );
  const intelligenceBrief = result?.summaryText ?? null;
  if (intelligenceBrief) {
    await db`
      UPDATE weekly_summaries
      SET summary_text = ${intelligenceBrief}
      WHERE business_id = ${input.businessId} AND week_start_date = ${input.weekStartDate}::date
    `;
  }
  return intelligenceBrief;
}

function weeklyFeedbackUrls(
  appUrl: string | undefined,
  csrfSecret: string | undefined,
  businessId: LocationId,
  weekStartDate: string,
): { great: string; ok: string; notGreat: string } | null {
  if (!appUrl || !csrfSecret) return null;
  return {
    great: buildFeedbackUrl(appUrl, businessId, 'great', weekStartDate),
    ok: buildFeedbackUrl(appUrl, businessId, 'ok', weekStartDate),
    notGreat: buildFeedbackUrl(appUrl, businessId, 'not_great', weekStartDate),
  };
}

async function commitAndDeliverWeeklySummary(
  db: Sql,
  input: {
    business: SummaryReportBusiness;
    businessId: LocationId;
    weekStartDate: string;
    weekEndDate: string;
    correlationId: string | undefined;
    html: string;
    outboxId: string;
    outboxAttempt: number | undefined;
    logger: WorkerLogger;
  },
): Promise<void> {
  const committed = await commitWeeklyInsightsDigest(db, {
    accountId: input.business.account_id,
    businessId: input.businessId,
    weekStartDate: input.weekStartDate,
    correlationId: input.correlationId,
  });
  if (!committed) {
    input.logger.log(`Weekly summary for ${input.businessId} week ${input.weekStartDate} already sent`);
    await markOutboxCompleted(db, input.outboxId, input.outboxAttempt);
    return;
  }
  const messageId = await sendSummaryReportEmail(db, {
    to: input.business.owner_email,
    subject: `Your Insights agent's weekly report — ${input.business.name} (${input.weekStartDate} to ${input.weekEndDate})`,
    bodyHtml: input.html,
    failureContext: `Failed to send weekly value report for business ${input.businessId} (week ${input.weekStartDate})`,
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
    template: 'weekly_value_report',
    externalMessageId: messageId,
  });
  await markOutboxCompleted(db, input.outboxId, input.outboxAttempt);
  input.logger.log(`Weekly value report sent for business ${input.businessId} (week ${input.weekStartDate})`);
}

export async function handleWeeklySummary(
  job: Job<WeeklySummaryPayload>,
): Promise<void> {
  const logger = createWorkerLogger('[WeeklySummaryWorker]', job.data.correlation_id);
  const { week_start_date } = job.data;
  const context = await prepareSummaryReport(sql, job, logger);
  if (!context) return;
  const { business, businessId, outboxId, outboxAttempt } = context;
  if (!isSubscriptionTier(business.subscription_tier)) {
    throw new Error(`Unsupported subscription tier: ${business.subscription_tier}`);
  }
  const weekEndDate = weekEndDateFor(week_start_date);
  const stats = await loadWeeklyReviewStats(sql, businessId, week_start_date, weekEndDate);
  const valueInputs = await loadWeeklyValueInputs(sql, businessId, week_start_date, weekEndDate);
  const summaryRow = await acquireWeeklySummary(sql, {
    businessId,
    weekStartDate: week_start_date,
    stats,
    outboxId,
    outboxAttempt,
    logger,
  });
  if (!summaryRow) return;
  const intelligenceBrief = await resolveWeeklyIntelligenceBrief(sql, {
    existingSummary: summaryRow.summary_text,
    reviews: valueInputs.reviewsForSummary,
    businessId,
    subscriptionTier: business.subscription_tier,
    weekStartDate: week_start_date,
  });
  const html = buildWeeklyValueReportHtml({
    businessName: business.name,
    weekStartDate: week_start_date,
    weekEndDate,
    totalReviews: stats.totalReviews,
    totalResponded: stats.totalResponded,
    notableReviews: stats.notableReviews.map((r) => ({
      reviewerName: r.reviewer_name,
      starRating: r.star_rating,
      reviewText: r.review_text,
    })),
    intelligenceBrief,
    baselineResponseRate: calculateBaselineResponseRate(business),
    fourWeekAvgReviews: valueInputs.fourWeekAvgReviews,
    ranking: valueInputs.ranking,
    dashboardUrl: valueInputs.dashboardUrl,
    feedbackUrls: weeklyFeedbackUrls(
      valueInputs.appUrl,
      valueInputs.csrfSecret,
      businessId,
      week_start_date,
    ),
  });
  await commitAndDeliverWeeklySummary(sql, {
    business,
    businessId,
    weekStartDate: week_start_date,
    weekEndDate,
    correlationId: job.data.correlation_id,
    html,
    outboxId,
    outboxAttempt,
    logger,
  });
}
