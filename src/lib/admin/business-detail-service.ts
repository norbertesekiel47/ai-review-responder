// src/lib/admin/business-detail-service.ts
//
// Service layer for `GET/PATCH /api/admin/businesses/[id]`.
// Owns the SQL queries; the route handler is a thin HTTP wrapper.
// Mirrors the src/lib/dashboard/service.ts split shipped earlier in this branch.

import { sql } from '@/lib/db/server';
import { computeChurnRiskScore } from '@/lib/shared/churn-score';
import { parseDbArray } from '@/lib/shared/db-array';
import type {
  BusinessDetailResponse,
  BusinessRow,
  RankingSnapshotRow,
  ReviewRow,
} from './business-detail-types';

/**
 * Fetch the admin business-detail aggregation: business row + reviews +
 * latest non-superseded responses + ranking snapshots + churn-score
 * metrics. Returns null when the business does not exist (route maps
 * to 404).
 */
export async function getBusinessDetail(
  businessId: string,
): Promise<BusinessDetailResponse | null> {
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
    return null;
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

  return {
    business: {
      id: business.id,
      name: business.name,
      category: business.category ?? null,
      website: business.website ?? null,
      googlePlaceId: business.google_place_id ?? null,
      tone: business.tone ?? null,
      productsServices: business.products_services ?? null,
      staffNames: parseDbArray(business.staff_names),
      highlightFacts: parseDbArray(business.highlight_facts),
      avoidFacts: parseDbArray(business.avoid_facts),
      sampleResponses: parseDbArray(business.sample_responses),
      subscriptionStatus: business.subscription_status,
      subscriptionTier: business.subscription_tier,
      ownerName: business.owner_name ?? null,
      ownerEmail: business.owner_email ?? null,
      lastSyncAt: business.last_sync_at ? business.last_sync_at.toISOString() : null,
      trackedKeywords: parseDbArray(business.tracked_keywords),
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
  };
}
