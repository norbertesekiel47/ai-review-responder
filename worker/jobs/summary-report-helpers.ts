import type postgres from 'postgres';
import {
  isSubscriptionTier,
  type SubscriptionTierValue,
} from '../../src/lib/accounts/tier-config';
import { sendInternalEmail } from '../../src/lib/notifications/email';
import {
  checkSubscription,
  type AccountFlagsInput,
} from '../../src/lib/shared/subscription-guard';
import {
  extractOutboxHandle,
  markOutboxCompleted,
  markOutboxFailed,
} from '../../src/lib/shared/outbox';
import { SKIP_REASON_ARCHIVED_LOCATION } from '../../src/lib/shared/worker-types';
import { asLocationId, type LocationId } from '../../src/lib/shared/ids';
import type { WorkerLogger } from '../../src/lib/shared/logger';

export interface SummaryReportBusiness {
  id: string;
  account_id: string;
  name: string;
  owner_email: string;
  owner_email_bounced: boolean;
  subscription_status: string;
  account_updated_at: Date;
  account_past_due_at: Date | null;
  account_flags: AccountFlagsInput;
  initial_review_count: number | null;
  initial_responded_count: number | null;
  baseline_captured_at: Date | null;
  subscription_tier: string;
  archived_at: Date | null;
}

type ValidatedSummaryReportBusiness = Omit<SummaryReportBusiness, 'subscription_tier'> & {
  subscription_tier: SubscriptionTierValue;
};

export interface BaselineFields {
  baseline_captured_at: Date | null;
  initial_review_count: number | null;
  initial_responded_count: number | null;
}

export interface SummaryReviewRow {
  star_rating: number;
  review_text: string | null;
}

export interface RankingSummary {
  keyword: string;
  currentRank: number;
  initialRank: number;
}

export interface SummaryReportContext {
  business: ValidatedSummaryReportBusiness;
  businessId: LocationId;
  outboxId: string;
  outboxAttempt: number | undefined;
}

export async function prepareSummaryReport(
  sql: postgres.Sql,
  job: { id?: string; data: { business_id: string } },
  logger: Pick<WorkerLogger, 'log' | 'warn'>,
): Promise<SummaryReportContext | null> {
  const businessId = asLocationId(job.data.business_id);
  const { outboxId, attempt: outboxAttempt } = extractOutboxHandle(
    job.data,
    job.id!,
  );
  const business = await loadSummaryReportBusiness(sql, businessId);
  const skipped = await completeOrFailSkippedSummaryReport(sql, {
    business,
    businessId,
    outboxId,
    outboxAttempt,
    logger,
  });
  if (skipped || !business) return null;
  if (!isSubscriptionTier(business.subscription_tier)) {
    throw new Error(`Unsupported subscription tier: ${business.subscription_tier}`);
  }
  const validatedBusiness: ValidatedSummaryReportBusiness = {
    ...business,
    subscription_tier: business.subscription_tier,
  };
  return { business: validatedBusiness, businessId, outboxId, outboxAttempt };
}

export async function sendSummaryReportEmail(
  sql: postgres.Sql,
  input: {
    to: string;
    subject: string;
    bodyHtml: string;
    failureContext: string;
    outboxId: string;
    outboxAttempt: number | undefined;
    logger: Pick<WorkerLogger, 'error'>;
  },
): Promise<string | null> {
  try {
    const result = await sendInternalEmail({
      to: input.to,
      subject: input.subject,
      bodyHtml: input.bodyHtml,
      category: 'marketing',
    });
    return result.messageId;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    input.logger.error(`${input.failureContext}: ${reason}`);
    // The caller has already committed sent_at. Keep it set because the
    // provider may have accepted the email before returning an error.
    await markOutboxFailed(sql, input.outboxId, reason, input.outboxAttempt);
    return null;
  }
}

async function loadSummaryReportBusiness(
  sql: postgres.Sql,
  businessId: LocationId,
): Promise<SummaryReportBusiness | null> {
  const [business] = await sql<SummaryReportBusiness[]>`
    SELECT b.id, b.name, b.owner_email, b.owner_email_bounced,
           a.id AS account_id, a.subscription_status, a.updated_at AS account_updated_at,
           a.past_due_at AS account_past_due_at, a.flags AS account_flags,
           b.initial_review_count, b.initial_responded_count, b.baseline_captured_at,
           a.subscription_tier, b.archived_at
    FROM businesses b
    JOIN accounts a ON a.id = b.account_id
    WHERE b.id = ${businessId}
  `;
  return business ?? null;
}

export async function completeOrFailSkippedSummaryReport(sql: postgres.Sql, input: {
  business: SummaryReportBusiness | null;
  businessId: LocationId;
  outboxId: string;
  outboxAttempt: number | undefined;
  logger: Pick<WorkerLogger, 'log' | 'warn'>;
}): Promise<boolean> {
  const { business, businessId, outboxId, outboxAttempt, logger } = input;
  if (!business) {
    logger.warn(`Business ${businessId} not found`);
    await markOutboxFailed(sql, outboxId, 'business_not_found', outboxAttempt);
    return true;
  }

  if (business.archived_at) {
    logger.log('archived — skipping summary report', {
      reason: SKIP_REASON_ARCHIVED_LOCATION,
      business_id: businessId,
    });
    await markOutboxCompleted(sql, outboxId, outboxAttempt);
    return true;
  }

  const subCheck = checkSubscription({
    status: business.subscription_status,
    pastDueAt: business.account_past_due_at,
    accountFlags: business.account_flags ?? {},
    workerType: 'summary',
  });

  if (!subCheck.allowed) {
    logger.log(`Business ${businessId} skipped: ${subCheck.reason}`);
    await markOutboxCompleted(sql, outboxId, outboxAttempt);
    return true;
  }

  if (business.owner_email_bounced) {
    logger.log(`Business ${businessId} owner email bounced — skipping`);
    await markOutboxCompleted(sql, outboxId, outboxAttempt);
    return true;
  }

  return false;
}

export function mapSummaryReviews(rows: SummaryReviewRow[]): Array<{ starRating: number; reviewText: string | null }> {
  return rows.map((r) => ({
    starRating: r.star_rating,
    reviewText: r.review_text,
  }));
}

export async function loadLatestRankingSummary(sql: postgres.Sql, businessId: LocationId): Promise<RankingSummary | null> {
  const [latestRanking] = await sql<{
    keyword: string;
    rank_position: number;
  }[]>`
    SELECT keyword, rank_position FROM ranking_snapshots
    WHERE business_id = ${businessId} AND rank_position IS NOT NULL
    ORDER BY snapshot_date DESC LIMIT 1
  `;

  if (!latestRanking) return null;

  const [initialRanking] = await sql<{ rank_position: number }[]>`
    SELECT rank_position FROM ranking_snapshots
    WHERE business_id = ${businessId} AND keyword = ${latestRanking.keyword} AND rank_position IS NOT NULL
    ORDER BY snapshot_date ASC LIMIT 1
  `;

  return {
    keyword: latestRanking.keyword,
    currentRank: latestRanking.rank_position,
    initialRank: initialRanking?.rank_position ?? latestRanking.rank_position,
  };
}

export async function ownerHasDashboardAuth(sql: postgres.Sql, businessId: LocationId): Promise<Array<{ exists: number }>> {
  return sql<{ exists: number }[]>`
    SELECT 1 AS exists FROM users
    WHERE business_id = ${businessId} AND role = 'owner' AND auth_id IS NOT NULL
    LIMIT 1
  `;
}

export function buildDashboardUrl(
  ownerWithAuth: Array<{ exists: number }>,
  appUrl: string | undefined,
): string | null {
  return ownerWithAuth.length > 0 && appUrl ? `${appUrl}/dashboard` : null;
}

export function calculateBaselineResponseRate(business: BaselineFields): number | null {
  if (
    business.baseline_captured_at &&
    business.initial_review_count !== null &&
    business.initial_review_count > 0 &&
    business.initial_responded_count !== null
  ) {
    return Math.round(
      (business.initial_responded_count / business.initial_review_count) * 100,
    );
  }
  return null;
}
