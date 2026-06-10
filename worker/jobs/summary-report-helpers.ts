import { sql } from '../../src/lib/db/server';
import {
  checkSubscription,
  type AccountFlagsInput,
} from '../../src/lib/shared/subscription-guard';
import { markOutboxCompleted, markOutboxFailed } from '../../src/lib/shared/outbox';
import type { LocationId } from '../../src/lib/shared/ids';
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

export async function loadSummaryReportBusiness(
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

export async function completeOrFailSkippedSummaryReport(input: {
  business: SummaryReportBusiness | null;
  businessId: LocationId;
  outboxId: string;
  outboxAttempt: number | undefined;
  logger: Pick<WorkerLogger, 'log' | 'warn'>;
}): Promise<boolean> {
  const { business, businessId, outboxId, outboxAttempt, logger } = input;
  if (!business) {
    logger.warn(`Business ${businessId} not found`);
    await markOutboxFailed(outboxId, 'business_not_found', outboxAttempt);
    return true;
  }

  if (business.archived_at) {
    logger.log('archived — skipping summary report', {
      reason: 'archived_location',
      business_id: businessId,
    });
    await markOutboxCompleted(outboxId, outboxAttempt);
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
    await markOutboxCompleted(outboxId, outboxAttempt);
    return true;
  }

  if (business.owner_email_bounced) {
    logger.log(`Business ${businessId} owner email bounced — skipping`);
    await markOutboxCompleted(outboxId, outboxAttempt);
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

export async function loadLatestRankingSummary(businessId: LocationId): Promise<RankingSummary | null> {
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

export async function ownerHasDashboardAuth(businessId: LocationId): Promise<Array<{ exists: number }>> {
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
