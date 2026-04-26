import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { requireRole, AuthError } from '@/lib/db/auth';
import { NO_STORE_HEADERS } from '@/lib/shared/constants';
import { buildPaymentLinkUrl } from '@/lib/payments/payment-link';
import { parseDbArray } from '@/lib/shared/db-array';

export const dynamic = 'force-dynamic';

export interface DashboardSettings {
  tone: string;
  productsServices: string;
  avoidFacts: string[];
  sampleResponses: string[];
  ownerPhone: string;
  ownerEmail: string;
  weeklySummaryEnabled: boolean;
  monthlyImpactEnabled: boolean;
  category: string;
  googlePlaceId: string;
}

export interface DashboardDataActive {
  subscriptionStatus?: never;
  business: { name: string; createdAt: string };
  valueSummary: {
    totalReviewsHandled: number;
    totalTimeSavedMinutes: number;
    currentResponseRate: number;
    baselineResponseRate: number | null;
  };
  reviewVelocity: Array<{ weekStart: string; count: number }>;
  ranking: Array<{
    keyword: string;
    snapshots: Array<{ date: string; position: number }>;
  }> | null;
  recentReviews: Array<{
    id: string;
    reviewerName: string;
    starRating: number | null;
    reviewText: string | null;
    reviewDate: string;
    status: string;
    responseText: string | null;
    responseStatus: string | null;
  }>;
  latestBrief: {
    text: string;
    type: 'monthly' | 'weekly';
    periodLabel: string;
  } | null;
  settings: DashboardSettings;
}

export interface DashboardDataPendingPayment {
  subscriptionStatus: 'pending_payment';
  businessId: string;
  businessName: string;
  paymentUrl: string | null;
}

export interface DashboardDataPendingAdminHandoff {
  subscriptionStatus: 'pending_payment_admin_handoff';
  businessId: string;
  businessName: string;
}

export interface DashboardDataActivePendingBusiness {
  subscriptionStatus: 'active_pending_business';
  businessId: string;
  businessName: string;
}

export type DashboardData =
  | DashboardDataActive
  | DashboardDataPendingPayment
  | DashboardDataPendingAdminHandoff
  | DashboardDataActivePendingBusiness;


/** All dashboard responses use no-store headers — owner-specific data. */
function jsonResponse(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE_HEADERS });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  let user;
  try {
    user = await requireRole(request, 'owner');
  } catch (err) {
    if (err instanceof AuthError) {
      return jsonResponse({ error: err.message }, err.statusCode);
    }
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  if (!user.businessId) {
    return jsonResponse({ error: 'No business associated with this account' }, 403);
  }

  const businessId = user.businessId;

  try {
    // Cheap pre-query: determine subscription status + onboarding state
    // before running the 8 heavy queries.
    const [subRow] = await sql<{
      name: string;
      subscription_status: string;
      subscription_tier: string;
      owner_email: string;
      onboarded_by: string | null;
      place_id_verified: boolean;
      google_maps_url: string | null;
    }[]>`
      SELECT name, subscription_status, subscription_tier, owner_email, onboarded_by,
             place_id_verified, google_maps_url
      FROM businesses WHERE id = ${businessId}
    `;
    if (!subRow) {
      return jsonResponse({ error: 'Business not found' }, 404);
    }

    if (subRow.subscription_status === 'pending_payment') {
      // Admin-onboarded businesses should NOT see the self-serve payment CTA —
      // they already have a handoff path via the partner. Showing the payment
      // link here would risk a double-charge if the partner's flow used a
      // different price point or coupon.
      if (subRow.onboarded_by !== null) {
        return jsonResponse({
          subscriptionStatus: 'pending_payment_admin_handoff',
          businessId,
          businessName: subRow.name,
        });
      }
      const tier: 'founding' | 'standard' =
        subRow.subscription_tier === 'founding' ||
        subRow.subscription_tier === 'standard'
          ? subRow.subscription_tier
          : 'standard';
      const paymentUrl = buildPaymentLinkUrl(tier, businessId, subRow.owner_email);
      return jsonResponse({
        subscriptionStatus: 'pending_payment',
        businessId,
        businessName: subRow.name,
        paymentUrl,
      });
    }

    // Active subscription but the owner skipped or never reached the
    // /onboarding/business wizard (e.g. bookmarked /dashboard from earlier
    // or closed the tab during the post-payment redirect). Surface a
    // CTA-only screen instead of the empty-state dashboard so they have
    // an obvious next action.
    if (
      subRow.subscription_status === 'active' &&
      !subRow.place_id_verified &&
      subRow.google_maps_url === null
    ) {
      return jsonResponse({
        subscriptionStatus: 'active_pending_business',
        businessId,
        businessName: subRow.name,
      });
    }

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
      return jsonResponse({ error: 'Business not found' }, 404);
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

    const totalTimeSavedMinutes = totalResponded * 7;

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

    const data: DashboardData = {
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

    return jsonResponse(data);
  } catch (error) {
    console.error('[api/dashboard] Failed to fetch dashboard data:', error);
    return jsonResponse({ error: 'Failed to fetch dashboard data' }, 500);
  }
}
