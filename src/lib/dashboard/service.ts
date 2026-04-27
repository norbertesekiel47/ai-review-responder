// src/lib/dashboard/service.ts
//
// Builds DashboardDataActive for owners with an active subscription
// and a completed onboarding wizard. The route handler runs preflight
// checks and only calls this when the active dashboard path applies.
//
// See docs/superpowers/specs/2026-04-26-modularization-design.md §7.1.

import { sql } from '@/lib/db/server';
import { parseDbArray } from '@/lib/shared/db-array';
import type { DashboardDataActive } from './types';

/**
 * Heuristic minutes saved per response — owner-facing time-saved metric on
 * the dashboard. The value is intentionally rough (real time per response
 * varies wildly by business size and review complexity) but consistent so
 * week-over-week comparisons are meaningful. Treat as a presentational
 * constant, not an SLA.
 */
const MINUTES_SAVED_PER_RESPONSE = 7;

/**
 * Thrown when the businesses row vanishes between the route's preflight
 * SELECT and the service's 8-query assembly. Extremely rare in practice
 * (TOCTOU window is sub-millisecond and no normal flow deletes a business
 * out from under an authenticated owner), but kept as an explicit signal
 * so the route can return 404 instead of 500.
 */
export class BusinessNotFoundError extends Error {
  constructor(businessId: string) {
    super(`Business not found: ${businessId}`);
    this.name = 'BusinessNotFoundError';
  }
}

export async function getActiveDashboardData(
  businessId: string,
): Promise<DashboardDataActive> {
  const [
    businessRows,
    totalReviewRows,
    totalRespondedRows,
    velocityRows,
    rankingRows,
    recentReviewRows,
    monthlyBriefRows,
    weeklyBriefRows,
  ] = await Promise.all([
    // Business info + settings
    sql`
      SELECT name, created_at, initial_review_count, initial_responded_count, baseline_captured_at,
             tone, products_services, avoid_facts, sample_responses,
             owner_phone, owner_email,
             weekly_summary_enabled, monthly_impact_enabled,
             category, google_place_id
      FROM businesses
      WHERE id = ${businessId}
      LIMIT 1
    `,
    // Total reviews (all time)
    sql`
      SELECT COUNT(*)::int AS count
      FROM reviews
      WHERE business_id = ${businessId}
    `,
    // Total responded (distinct reviews with non-superseded responses)
    sql`
      SELECT COUNT(DISTINCT r.id)::int AS count
      FROM reviews r
      JOIN responses resp ON resp.review_id = r.id
      WHERE r.business_id = ${businessId}
        AND resp.status IN ('posted', 'approved', 'edited', 'awaiting_manual_post')
    `,
    // Review velocity: last 8 weeks (zero-filled)
    sql`
      SELECT gs::date AS week_start,
             COALESCE(r.cnt, 0)::int AS count
      FROM generate_series(
        DATE_TRUNC('week', NOW() - INTERVAL '7 weeks'),
        DATE_TRUNC('week', NOW()),
        INTERVAL '1 week'
      ) gs
      LEFT JOIN (
        SELECT DATE_TRUNC('week', detected_at)::date AS wk, COUNT(*) AS cnt
        FROM reviews
        WHERE business_id = ${businessId}
          AND detected_at >= NOW() - INTERVAL '8 weeks'
        GROUP BY DATE_TRUNC('week', detected_at)
      ) r ON r.wk = gs::date
      ORDER BY week_start ASC
    `,
    // Ranking snapshots (all with rank_position)
    sql`
      SELECT keyword, snapshot_date, rank_position
      FROM ranking_snapshots
      WHERE business_id = ${businessId}
        AND rank_position IS NOT NULL
        AND snapshot_date >= (CURRENT_DATE - INTERVAL '12 months')
      ORDER BY keyword ASC, snapshot_date ASC
    `,
    // Recent reviews: last 10 with latest non-superseded/failed response
    // Include pending_approval so the UI can show "check your email" reminders
    sql`
      SELECT
        rev.id,
        rev.reviewer_name,
        rev.star_rating,
        rev.review_text,
        rev.review_date,
        rev.status,
        resp.response_text,
        resp.status AS response_status
      FROM reviews rev
      LEFT JOIN LATERAL (
        SELECT COALESCE(approved_text, response_text) AS response_text, status
        FROM responses
        WHERE review_id = rev.id
          AND status IN ('pending_approval', 'posted', 'approved', 'edited', 'awaiting_manual_post')
        ORDER BY version DESC
        LIMIT 1
      ) resp ON true
      WHERE rev.business_id = ${businessId}
      ORDER BY rev.detected_at DESC
      LIMIT 10
    `,
    // Latest monthly brief (with sent_at for recency comparison)
    sql`
      SELECT summary_text, month_start_date, sent_at
      FROM monthly_impact_emails
      WHERE business_id = ${businessId}
        AND summary_text IS NOT NULL
        AND sent_at IS NOT NULL
      ORDER BY sent_at DESC
      LIMIT 1
    `,
    // Latest weekly brief (with sent_at for recency comparison)
    sql`
      SELECT summary_text, week_start_date, sent_at
      FROM weekly_summaries
      WHERE business_id = ${businessId}
        AND summary_text IS NOT NULL
        AND sent_at IS NOT NULL
      ORDER BY sent_at DESC
      LIMIT 1
    `,
  ]);

  const business = businessRows[0];
  if (!business) {
    throw new BusinessNotFoundError(businessId);
  }

  const totalReviews = totalReviewRows[0]?.count ?? 0;
  const totalResponded = totalRespondedRows[0]?.count ?? 0;

  const currentResponseRate =
    totalReviews > 0
      ? Math.round((totalResponded / totalReviews) * 100)
      : 0;

  let baselineResponseRate: number | null = null;
  if (
    business.baseline_captured_at &&
    business.initial_review_count != null &&
    business.initial_review_count > 0
  ) {
    baselineResponseRate = Math.round(
      ((business.initial_responded_count ?? 0) /
        business.initial_review_count) *
        100,
    );
  }

  const totalTimeSavedMinutes = totalResponded * MINUTES_SAVED_PER_RESPONSE;

  // Group ranking snapshots by keyword
  const rankingMap = new Map<
    string,
    Array<{ date: string; position: number }>
  >();
  for (const row of rankingRows) {
    const keyword = row.keyword as string;
    if (!rankingMap.has(keyword)) {
      rankingMap.set(keyword, []);
    }
    rankingMap.get(keyword)!.push({
      date: String(row.snapshot_date),
      position: row.rank_position as number,
    });
  }
  const ranking =
    rankingMap.size > 0
      ? Array.from(rankingMap.entries()).map(([keyword, snapshots]) => ({
          keyword,
          snapshots,
        }))
      : null;

  // Pick whichever brief was sent more recently (by sent_at, not period start)
  let latestBrief: DashboardDataActive['latestBrief'] = null;
  const monthlyBrief = monthlyBriefRows[0];
  const weeklyBrief = weeklyBriefRows[0];

  const monthlySentAt = monthlyBrief?.sent_at ? new Date(monthlyBrief.sent_at as string).getTime() : 0;
  const weeklySentAt = weeklyBrief?.sent_at ? new Date(weeklyBrief.sent_at as string).getTime() : 0;

  if (monthlyBrief?.summary_text && monthlySentAt >= weeklySentAt) {
    const monthlyDate = String(monthlyBrief.month_start_date);
    const d = new Date(monthlyDate + 'T00:00:00Z');
    latestBrief = {
      text: monthlyBrief.summary_text as string,
      type: 'monthly',
      periodLabel: d.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
    };
  } else if (weeklyBrief?.summary_text) {
    latestBrief = {
      text: weeklyBrief.summary_text as string,
      type: 'weekly',
      periodLabel: `Week of ${String(weeklyBrief.week_start_date)}`,
    };
  }

  const data: DashboardDataActive = {
    business: {
      name: business.name as string,
      createdAt: (business.created_at as Date).toISOString(),
    },
    valueSummary: {
      totalReviewsHandled: totalResponded,
      totalTimeSavedMinutes,
      currentResponseRate,
      baselineResponseRate,
    },
    reviewVelocity: velocityRows.map((row) => ({
      weekStart: String(row.week_start),
      count: row.count as number,
    })),
    ranking,
    recentReviews: recentReviewRows.map((row) => ({
      id: row.id as string,
      reviewerName: (row.reviewer_name as string) ?? 'Anonymous',
      starRating: (row.star_rating as number) ?? null,
      reviewText: (row.review_text as string) ?? null,
      reviewDate: row.review_date
        ? (row.review_date as Date).toISOString()
        : '',
      status: row.status as string,
      responseText: (row.response_text as string) ?? null,
      responseStatus: (row.response_status as string) ?? null,
    })),
    latestBrief,
    settings: {
      tone: (business.tone as string) ?? 'professional and friendly',
      productsServices: (business.products_services as string) ?? '',
      avoidFacts: parseDbArray(business.avoid_facts),
      sampleResponses: parseDbArray(business.sample_responses),
      ownerPhone: (business.owner_phone as string) ?? '',
      ownerEmail: (business.owner_email as string) ?? '',
      weeklySummaryEnabled: (business.weekly_summary_enabled as boolean) ?? true,
      monthlyImpactEnabled: (business.monthly_impact_enabled as boolean) ?? true,
      category: (business.category as string) ?? '',
      googlePlaceId: (business.google_place_id as string) ?? '',
    },
  };

  return data;
}
