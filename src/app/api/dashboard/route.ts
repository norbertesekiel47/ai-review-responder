import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { requireRole, AuthError } from '@/lib/db/auth';
import { NO_STORE_HEADERS } from '@/lib/shared/constants';

export const dynamic = 'force-dynamic';

export interface DashboardData {
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
    starRating: number;
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
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  let user;
  try {
    user = await requireRole(request, 'owner');
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json(
        { error: err.message },
        { status: err.statusCode },
      );
    }
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (!user.businessId) {
    return NextResponse.json(
      { error: 'No business associated with this account' },
      { status: 403 },
    );
  }

  const businessId = user.businessId;

  try {
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
      // Business info
      sql`
        SELECT name, created_at, initial_review_count, initial_responded_count, baseline_captured_at
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
            AND status IN ('posted', 'approved', 'edited', 'awaiting_manual_post')
          ORDER BY version DESC
          LIMIT 1
        ) resp ON true
        WHERE rev.business_id = ${businessId}
        ORDER BY rev.detected_at DESC
        LIMIT 10
      `,
      // Latest monthly brief
      sql`
        SELECT summary_text, month_start_date
        FROM monthly_impact_emails
        WHERE business_id = ${businessId}
          AND summary_text IS NOT NULL
          AND sent_at IS NOT NULL
        ORDER BY month_start_date DESC
        LIMIT 1
      `,
      // Latest weekly brief
      sql`
        SELECT summary_text, week_start_date
        FROM weekly_summaries
        WHERE business_id = ${businessId}
          AND summary_text IS NOT NULL
          AND sent_at IS NOT NULL
        ORDER BY week_start_date DESC
        LIMIT 1
      `,
    ]);

    const business = businessRows[0];
    if (!business) {
      return NextResponse.json(
        { error: 'Business not found' },
        { status: 404 },
      );
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

    // Pick whichever brief is more recent
    let latestBrief: DashboardData['latestBrief'] = null;
    const monthlyBrief = monthlyBriefRows[0];
    const weeklyBrief = weeklyBriefRows[0];

    const monthlyDate = monthlyBrief?.month_start_date ? String(monthlyBrief.month_start_date) : '';
    const weeklyDate = weeklyBrief?.week_start_date ? String(weeklyBrief.week_start_date) : '';

    if (monthlyBrief?.summary_text && (!weeklyDate || monthlyDate >= weeklyDate)) {
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
        periodLabel: `Week of ${weeklyDate}`,
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
        starRating: row.star_rating as number,
        reviewText: (row.review_text as string) ?? null,
        reviewDate: row.review_date
          ? (row.review_date as Date).toISOString()
          : '',
        status: row.status as string,
        responseText: (row.response_text as string) ?? null,
        responseStatus: (row.response_status as string) ?? null,
      })),
      latestBrief,
    };

    return NextResponse.json(data, { headers: NO_STORE_HEADERS });
  } catch (error) {
    console.error('[api/dashboard] Failed to fetch dashboard data:', error);
    return NextResponse.json(
      { error: 'Failed to fetch dashboard data' },
      { status: 500 },
    );
  }
}
