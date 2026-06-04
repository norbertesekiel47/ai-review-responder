// src/lib/dashboard/service.ts
//
// Builds DashboardDataActive for owners with an active subscription
// and a completed onboarding wizard. The route handler runs preflight
// checks and only calls this when the active dashboard path applies.
//
// See docs/superpowers/specs/2026-04-26-modularization-design.md §7.1.

import { sql } from '@/lib/db/server';
import { getCacheRedis } from '@/lib/db/redis-cache';
import {
  HANDLED_STATUSES,
  RECENT_REVIEW_DISPLAY_STATUSES,
} from '@/lib/shared/response-status';
import { pendingKey } from '@/lib/zernio/connect-state';
import type { DashboardDataActive } from './types';
import {
  buildActiveDashboardResponse,
  type DashboardBriefRow,
  type DashboardBusinessRow,
  type DashboardRankingRow,
  type DashboardZernioConnectionRow,
} from './service-mappers';

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
    zernioConnectionRows,
    queuedReconnectRows,
    unresolvedIncidentRows,
    pendingRaw,
  ] = await Promise.all([
    // Business info + settings
    sql<DashboardBusinessRow[]>`
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
    sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM reviews
      WHERE business_id = ${businessId}
        AND status <> 'deleted'
    `,
    // Total responded (distinct reviews with non-superseded responses)
    sql<{ count: number }[]>`
      SELECT COUNT(DISTINCT r.id)::int AS count
      FROM reviews r
      JOIN responses resp ON resp.review_id = r.id
      WHERE r.business_id = ${businessId}
        AND r.status <> 'deleted'
        AND resp.status = ANY(${[...HANDLED_STATUSES] as string[]}::text[])
    `,
    // Review velocity: last 8 weeks (zero-filled)
    sql<{ week_start: unknown; count: unknown }[]>`
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
          AND status <> 'deleted'
        GROUP BY DATE_TRUNC('week', detected_at)
      ) r ON r.wk = gs::date
      ORDER BY week_start ASC
    `,
    // Ranking snapshots (all with rank_position)
    sql<DashboardRankingRow[]>`
      SELECT keyword, snapshot_date, rank_position
      FROM ranking_snapshots
      WHERE business_id = ${businessId}
        AND rank_position IS NOT NULL
        AND snapshot_date >= (CURRENT_DATE - INTERVAL '12 months')
      ORDER BY keyword ASC, snapshot_date ASC
    `,
    // Recent reviews: last 10 with latest non-superseded/failed response
    // Include pending_approval so the UI can show "check your email" reminders
    sql<Record<string, unknown>[]>`
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
          -- Explicit tenant scope: responses belong to the same location as the
          -- review (defense-in-depth alongside the review_id correlation).
          AND business_id = ${businessId}
          AND status = ANY(${[...RECENT_REVIEW_DISPLAY_STATUSES] as string[]}::text[])
          -- Held-for-review drafts (high-severity moderation flag still open)
          -- must never surface to the owner UI; the admin queue owns them.
          AND NOT EXISTS (
            SELECT 1 FROM flagged_responses fr
            WHERE fr.response_id = responses.id AND fr.status = 'open'
          )
        ORDER BY version DESC
        LIMIT 1
      ) resp ON true
      WHERE rev.business_id = ${businessId}
        AND rev.status <> 'deleted'
      ORDER BY rev.detected_at DESC
      LIMIT 10
    `,
    // Latest monthly brief (with sent_at for recency comparison)
    sql<DashboardBriefRow[]>`
      SELECT summary_text, month_start_date, sent_at
      FROM monthly_impact_emails
      WHERE business_id = ${businessId}
        AND summary_text IS NOT NULL
        AND sent_at IS NOT NULL
      ORDER BY sent_at DESC
      LIMIT 1
    `,
    // Latest weekly brief (with sent_at for recency comparison)
    sql<DashboardBriefRow[]>`
      SELECT summary_text, week_start_date, sent_at
      FROM weekly_summaries
      WHERE business_id = ${businessId}
        AND summary_text IS NOT NULL
        AND sent_at IS NOT NULL
      ORDER BY sent_at DESC
      LIMIT 1
    `,
    // Zernio connection: most-recent row (any status). Banner state machine
    // distinguishes 'none' (no row) from 'disconnected' (row with status='disconnected').
    sql<DashboardZernioConnectionRow[]>`
      SELECT status, disconnect_reason
      FROM zernio_connections
      WHERE business_id = ${businessId}
      ORDER BY created_at DESC
      LIMIT 1
    `,
    // Queued-for-reconnect responses: approved drafts parked while Zernio is
    // disconnected. Drives banner headline copy ("3 responses are waiting...").
    sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM responses
      WHERE business_id = ${businessId}
        AND status = 'awaiting_owner_connect'
    `,
    // Unresolved finalize incident: takes priority over the connection status —
    // owner sees "manual review" banner regardless of zernio_connections state.
    sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM zernio_finalize_incidents
      WHERE business_id = ${businessId}
        AND resolved_at IS NULL
    `,
    // In-flight connect flow marker. Lives in Redis only — the DB row
    // (zernio_connections) is not inserted until select-location succeeds.
    // Surfacing this lets the dashboard render a "Connecting…" UX during the
    // OAuth + finalize window instead of falling back to "Connect" which
    // would 409 on retry and confuse the owner.
    readPendingMarker(businessId),
  ]);

  const business = businessRows[0];
  if (!business) {
    throw new BusinessNotFoundError(businessId);
  }

  const totalReviews = totalReviewRows[0]?.count ?? 0;
  const totalResponded = totalRespondedRows[0]?.count ?? 0;

  // Zernio banner precedence (finalize-incident > active > pending marker >
  // connection status > none) is owned by resolveZernioConnectionState in
  // zernio-banner.ts — see there for the authoritative rules.
  return buildActiveDashboardResponse({
    business,
    totalReviews,
    totalResponded,
    velocityRows,
    rankingRows,
    recentReviewRows,
    monthlyBrief: monthlyBriefRows[0],
    weeklyBrief: weeklyBriefRows[0],
    zernioRow: zernioConnectionRows[0],
    queuedReconnectCount: queuedReconnectRows[0]?.count ?? 0,
    hasUnresolvedIncident: (unresolvedIncidentRows[0]?.count ?? 0) > 0,
    pendingRaw,
  });
}

async function readPendingMarker(businessId: string): Promise<string | null> {
  // Pending-marker read is wrapped so a Redis outage degrades gracefully. The
  // dashboard never depends on this value being available; it only upgrades
  // the UX during an in-flight connect flow.
  try {
    return await getCacheRedis().get(pendingKey(businessId));
  } catch (err) {
    console.error(
      '[dashboard/service] failed to read connect_pending marker:',
      err,
    );
    return null;
  }
}
