import { NextRequest, NextResponse } from 'next/server';
import { v7 as uuidv7 } from 'uuid';
import { sql } from '@/lib/db/server';
import { UpdateBusinessSchema } from '@/lib/shared/schemas';
import { requireRole, AuthError } from '@/lib/db/auth';
import { computeChurnRiskScore, type ChurnScore } from '@/lib/shared/churn-score';

export const dynamic = 'force-dynamic';

// PgBouncer returns text[] columns as JSON strings — guard both shapes.
const parseArray = (val: unknown): string[] => {
  if (Array.isArray(val)) return val;
  if (typeof val === 'string') {
    try {
      return JSON.parse(val);
    } catch {
      return [];
    }
  }
  return [];
};

// ---------------------------------------------------------------------------
// GET /api/admin/businesses/[id] — business detail + reviews + latest responses
// ---------------------------------------------------------------------------

interface BusinessRow {
  id: string;
  name: string;
  category: string | null;
  website: string | null;
  google_place_id: string | null;
  tone: string | null;
  products_services: string | null;
  staff_names: unknown;
  highlight_facts: unknown;
  avoid_facts: unknown;
  sample_responses: unknown;
  subscription_status: string;
  subscription_tier: string;
  owner_name: string | null;
  owner_email: string | null;
  last_sync_at: Date | null;
  tracked_keywords: unknown;
  google_place_lat: number | null;
  google_place_lng: number | null;
  ranking_search_location: string | null;
  google_place_address: string | null;
  owner_email_bounced: boolean | null;
}

interface RankingSnapshotRow {
  keyword: string;
  rank_position: number | null;
  snapshot_date: string;
  source: string;
}

interface ReviewRow {
  id: string;
  reviewer_name: string;
  star_rating: number;
  review_text: string | null;
  review_date: string | null;
  detected_language: string | null;
  review_status: string;
  detected_at: Date | null;
  response_id: string | null;
  response_status: string | null;
  response_text: string | null;
  approved_text: string | null;
  version: number | null;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: businessId } = await params;

  try {
    await requireRole(request, 'admin', 'sales_partner');
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode });
    }
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const [businessRows, reviewRows, rankingSnapshots] = await Promise.all([
      sql<BusinessRow[]>`
        SELECT
          id, name, category, website, google_place_id, tone, products_services,
          staff_names, highlight_facts, avoid_facts, sample_responses,
          subscription_status, subscription_tier, owner_name, owner_email, last_sync_at,
          tracked_keywords, google_place_lat, google_place_lng,
          ranking_search_location, google_place_address, owner_email_bounced
        FROM businesses
        WHERE id = ${businessId}
      `,
      sql<ReviewRow[]>`
        SELECT
          r.id, r.reviewer_name, r.star_rating, r.review_text, r.review_date,
          r.detected_language, r.status AS review_status, r.detected_at,
          resp.id AS response_id, resp.status AS response_status,
          resp.response_text, resp.approved_text, resp.version
        FROM reviews r
        LEFT JOIN LATERAL (
          SELECT id, status, response_text, approved_text, version
          FROM responses
          WHERE review_id = r.id AND status != 'superseded'
          ORDER BY version DESC LIMIT 1
        ) resp ON true
        WHERE r.business_id = ${businessId}
        ORDER BY r.detected_at DESC
      `,
      sql<RankingSnapshotRow[]>`
        SELECT keyword, rank_position, snapshot_date::text, source
        FROM ranking_snapshots
        WHERE business_id = ${businessId}
        ORDER BY snapshot_date DESC
        LIMIT 50
      `,
    ]);

    const business = businessRows[0];
    if (!business) {
      return NextResponse.json({ error: 'Business not found' }, { status: 404 });
    }

    const [metrics] = await sql<{
      approval_rate: number | null;
      notified_count: number;
      pending_count: number;
      days_since_approval: number | null;
      account_age_days: number;
      avg_hours_current: number | null;
      avg_hours_prev: number | null;
    }[]>`
      WITH notif AS (
        SELECT
          COUNT(DISTINCT nd.response_id)::int AS notified_count,
          COUNT(DISTINCT nd.response_id) FILTER (
            WHERE r.status IN ('approved','edited','posted','awaiting_manual_post')
          )::int AS approved_count
        FROM notification_deliveries nd
        JOIN responses r ON r.id = nd.response_id
        WHERE nd.business_id = ${businessId}
          AND nd.template = 'approval_request'
          AND nd.sent_at IS NOT NULL
          AND nd.sent_at >= CURRENT_DATE - 30
      ),
      resp AS (
        SELECT
          COUNT(*) FILTER (WHERE rp.status = 'pending_approval')::int AS pending_count,
          EXTRACT(DAY FROM CURRENT_TIMESTAMP - MAX(rp.approved_at)
            FILTER (WHERE rp.status IN ('approved','edited','posted','awaiting_manual_post'))
          )::int AS days_since_approval,
          AVG(EXTRACT(EPOCH FROM rp.approved_at - rp.created_at) / 3600.0)
            FILTER (WHERE rp.approved_at IS NOT NULL AND rp.created_at >= CURRENT_DATE - 7)::float AS avg_hours_current,
          AVG(EXTRACT(EPOCH FROM rp.approved_at - rp.created_at) / 3600.0)
            FILTER (WHERE rp.approved_at IS NOT NULL AND rp.created_at >= CURRENT_DATE - 35 AND rp.created_at < CURRENT_DATE - 7)::float AS avg_hours_prev
        FROM responses rp
        WHERE rp.business_id = ${businessId}
      )
      SELECT
        CASE WHEN COALESCE(n.notified_count, 0) >= 3
             THEN n.approved_count::float / NULLIF(n.notified_count, 0)
             ELSE NULL END AS approval_rate,
        COALESCE(n.notified_count, 0)::int AS notified_count,
        COALESCE(r.pending_count, 0)::int AS pending_count,
        r.days_since_approval,
        EXTRACT(DAY FROM CURRENT_TIMESTAMP - b.created_at)::int AS account_age_days,
        r.avg_hours_current,
        r.avg_hours_prev
      FROM businesses b
      CROSS JOIN notif n
      CROSS JOIN resp r
      WHERE b.id = ${businessId}
    `;

    let responseTimeTrend: 'faster_or_stable' | 'slower' | 'stopped' | null = null;
    if (metrics?.avg_hours_current != null && metrics?.avg_hours_prev != null) {
      responseTimeTrend = metrics.avg_hours_current > metrics.avg_hours_prev * 1.5 ? 'slower' : 'faster_or_stable';
    } else if (metrics && metrics.pending_count > 0 && metrics.days_since_approval != null && metrics.days_since_approval > 7) {
      responseTimeTrend = 'stopped';
    }

    const churnScore = computeChurnRiskScore({
      approvalRate: metrics?.approval_rate ?? null,
      notifiedResponseCount30d: metrics?.notified_count ?? 0,
      pendingResponseCount: metrics?.pending_count ?? 0,
      daysSinceLastApproval: metrics?.days_since_approval ?? null,
      satisfactionResponses: null,
      responseTimeTrend,
      accountAgeDays: metrics?.account_age_days ?? 0,
    });

    return NextResponse.json({
      business: {
        id: business.id,
        name: business.name,
        category: business.category ?? null,
        website: business.website ?? null,
        googlePlaceId: business.google_place_id ?? null,
        tone: business.tone ?? null,
        productsServices: business.products_services ?? null,
        staffNames: parseArray(business.staff_names),
        highlightFacts: parseArray(business.highlight_facts),
        avoidFacts: parseArray(business.avoid_facts),
        sampleResponses: parseArray(business.sample_responses),
        subscriptionStatus: business.subscription_status,
        subscriptionTier: business.subscription_tier,
        ownerName: business.owner_name ?? null,
        ownerEmail: business.owner_email ?? null,
        lastSyncAt: business.last_sync_at ? business.last_sync_at.toISOString() : null,
        trackedKeywords: parseArray(business.tracked_keywords),
        googlePlaceLat: business.google_place_lat,
        googlePlaceLng: business.google_place_lng,
        rankingSearchLocation: business.ranking_search_location,
        googlePlaceAddress: business.google_place_address,
        ownerEmailBounced: business.owner_email_bounced ?? false,
        smsEnabled: process.env.CHANNELS_SMS_ENABLED === 'true',
        telegramEnabled: process.env.CHANNELS_TELEGRAM_ENABLED === 'true',
        whatsappEnabled: process.env.CHANNELS_WHATSAPP_ENABLED === 'true',
        churnScore,
      },
      rankingSnapshots: rankingSnapshots.map((s) => ({
        keyword: s.keyword,
        rankPosition: s.rank_position,
        snapshotDate: s.snapshot_date,
        source: s.source,
      })),
      reviews: reviewRows.map((row) => ({
        id: row.id,
        reviewerName: row.reviewer_name,
        starRating: row.star_rating,
        reviewText: row.review_text ?? null,
        reviewDate: row.review_date ?? null,
        detectedLanguage: row.detected_language ?? null,
        detectedAt: row.detected_at ? row.detected_at.toISOString() : null,
        responseId: row.response_id ?? null,
        responseStatus: row.response_status ?? null,
        responseText: row.response_text ?? null,
        approvedText: row.approved_text ?? null,
        responseVersion: row.version ?? null,
      })),
    });
  } catch (error) {
    console.error('[api/admin/businesses/[id] GET] Failed:', error);
    return NextResponse.json({ error: 'Failed to fetch business' }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// PATCH /api/admin/businesses/[id] — update business settings
// ---------------------------------------------------------------------------

class BusinessNotFoundError extends Error {}

// Column name mapping from camelCase API fields to snake_case DB columns.
const FIELD_TO_COLUMN: Record<string, string> = {
  name: 'name',
  category: 'category',
  tone: 'tone',
  productsServices: 'products_services',
  staffNames: 'staff_names',
  highlightFacts: 'highlight_facts',
  avoidFacts: 'avoid_facts',
  website: 'website',
  ownerEmail: 'owner_email',
  ownerEmailBounced: 'owner_email_bounced',
};

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: businessId } = await params;

  try {
    await requireRole(request, 'admin', 'sales_partner');
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode });
    }
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const parsed = UpdateBusinessSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Invalid input' },
      { status: 400 },
    );
  }

  const data = parsed.data;
  const fields = Object.keys(data) as (keyof typeof data)[];

  // Build dynamic SET clause: $1 reserved for businessId, fields start at $2.
  const setClauses: string[] = [];
  const values: (string | string[] | boolean | null)[] = [businessId];

  for (const field of fields) {
    const column = FIELD_TO_COLUMN[field];
    const value = data[field] ?? null;
    values.push(value);
    setClauses.push(`${column} = $${values.length}`);
  }
  setClauses.push('updated_at = NOW()');

  const setClause = setClauses.join(', ');
  const query = `UPDATE businesses SET ${setClause} WHERE id = $1`;

  try {
    await sql.begin(async (tx) => {
      const result = await tx.unsafe(query, values);
      if (result.count === 0) {
        throw new BusinessNotFoundError();
      }
      if (data.ownerEmail !== undefined) {
        // Upsert: if the email enrollment row was previously disabled/
        // unsubscribed, a fresh owner_email edit is an explicit admin action
        // to re-enable the channel — refresh to verified state in the same
        // transaction as the business UPDATE.
        await tx`
          INSERT INTO channel_enrollments
            (id, business_id, channel, handle, status, verified_at)
          VALUES
            (${uuidv7()}, ${businessId}, 'email', ${data.ownerEmail}, 'verified', NOW())
          ON CONFLICT (business_id, channel) WHERE archived_at IS NULL DO UPDATE SET
            handle              = EXCLUDED.handle,
            status              = 'verified',
            verified_at         = NOW(),
            disabled_at         = NULL,
            unsubscribed_at     = NULL,
            unsubscribed_reason = NULL,
            updated_at          = NOW()
        `;
      }
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof BusinessNotFoundError) {
      return NextResponse.json({ error: 'Business not found' }, { status: 404 });
    }
    // Duplicate email constraint (users.email or channel_enrollments UNIQUE) —
    // match the POST route's 409 semantics at src/app/api/admin/businesses/route.ts:281-287.
    // MUST come before the generic 500 fallback.
    const pgError = error as { code?: string };
    if (pgError.code === '23505') {
      return NextResponse.json({ error: 'Email already in use' }, { status: 409 });
    }
    console.error('[api/admin/businesses/[id] PATCH] Failed:', error);
    return NextResponse.json({ error: 'Failed to update business' }, { status: 500 });
  }
}
