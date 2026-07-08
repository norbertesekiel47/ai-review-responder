// src/lib/admin/business-detail/queries.ts
//
// SQL fetchers for the admin business-detail page.
// Extracted verbatim from business-detail-service.ts; only export/import
// wiring changed. No edits to SQL, column names, or result shapes.

import type { Sql } from 'postgres';
import { HANDLED_STATUSES } from '@/lib/shared/response-status';
import type { AccountFlagsInput } from '@/lib/shared/past-due-recovery';
import type { AutoApprovalThreshold } from '@/lib/auto-approval/types';
import type {
  AwaitingOwnerConnectRow,
  BusinessRow,
  RankingSnapshotRow,
  ReviewRow,
  ZernioConnectionRow,
  ZernioFinalizeIncidentRow,
} from '../business-detail-types';

// ── Batch-2 row types (promoted from inline) ──────────────────────────────

export interface BusinessMetricsRow {
  approval_rate: number | null;
  notified_count: number;
  pending_count: number;
  days_since_approval: number | null;
  account_age_days: number;
  avg_hours_current: number | null;
  avg_hours_prev: number | null;
}

export interface AccountLocationRow {
  id: string;
  name: string;
  display_label: string | null;
  is_primary: boolean;
  archived_at: Date | null;
}

export interface ApprovalAuditRow {
  id: string;
  response_id: string;
  action: string;
  actor_user_id: string | null;
  created_at: Date;
  business_id: string;
  account_id: string;
}

export interface AccountAuditRow {
  id: string;
  event_type: string;
  actor_user_id: string | null;
  location_id: string | null;
  payload: unknown;
  created_at: Date;
}

export interface AutoApprovalPolicyRow {
  id: string;
  account_id: string;
  location_id: string | null;
  auto_approve_min_star: AutoApprovalThreshold | null;
  veto_window_minutes: 15 | 30;
  daily_auto_post_cap: number | null;
  suspended_at: Date | null;
}

export interface AutoApprovalAccountRow {
  subscription_status: string;
  past_due_at: Date | string | null;
  flags: AccountFlagsInput;
}

// ── Batch 1 ───────────────────────────────────────────────────────────────

export interface BusinessDetailBatch1 {
  businessRows: BusinessRow[];
  reviewRows: ReviewRow[];
  rankingSnapshots: RankingSnapshotRow[];
  zernioConnectionRows: ZernioConnectionRow[];
  awaitingOwnerConnectRows: AwaitingOwnerConnectRow[];
  finalizeIncidentRows: ZernioFinalizeIncidentRow[];
}

export async function fetchBusinessDetailBatch1(
  sql: Sql,
  businessId: string,
): Promise<BusinessDetailBatch1> {
  const [
    businessRows,
    reviewRows,
    rankingSnapshots,
    zernioConnectionRows,
    awaitingOwnerConnectRows,
    finalizeIncidentRows,
  ] = await Promise.all([
    sql<BusinessRow[]>`
      SELECT
        b.id, b.name, b.category, b.website, b.google_place_id, b.tone, b.products_services,
        b.staff_names, b.highlight_facts, b.avoid_facts, b.sample_responses,
        a.subscription_status, a.subscription_tier,
        b.owner_name, b.owner_email, b.last_sync_at,
        b.tracked_keywords, b.google_place_lat, b.google_place_lng,
        b.ranking_search_location, b.google_place_address, b.owner_email_bounced,
        b.account_id, b.display_label, b.is_primary
      FROM businesses b
      JOIN accounts a ON a.id = b.account_id
      WHERE b.id = ${businessId}
    `,
    sql<ReviewRow[]>`
      SELECT
        r.id, r.reviewer_name, r.star_rating, r.review_text, r.review_date,
        r.detected_language, r.status AS review_status, r.detected_at,
        resp.id AS response_id, resp.status AS response_status,
        resp.response_text, resp.approved_text, resp.approval_method, resp.version
      FROM reviews r
      LEFT JOIN LATERAL (
        SELECT id, status, response_text, approved_text, approval_method, version
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
    // Zernio panel — current connection snapshot. The partial unique index
    // `zernio_connections_one_active_per_business` allows multiple
    // 'disconnected' rows for audit history; ORDER BY created_at DESC LIMIT 1
    // returns the latest row regardless of status. NULL when the business
    // has never started a Zernio connect flow.
    sql<ZernioConnectionRow[]>`
      SELECT status, connected_at, disconnected_at, disconnect_reason,
             last_error, last_error_at, zernio_account_id, zernio_location_id
      FROM zernio_connections
      WHERE business_id = ${businessId}
      ORDER BY created_at DESC
      LIMIT 1
    `,
    // Responses queued waiting for owner reconnect — surfaced to admins so
    // they can see what's stuck behind a missing/disconnected Zernio
    // connection. Bounded LIMIT 50; admins can page via the responses
    // history if more are needed.
    sql<AwaitingOwnerConnectRow[]>`
      SELECT r.id, r.created_at,
             COALESCE(r.approved_text, r.response_text) AS draft_text,
             rev.reviewer_name, rev.review_text, rev.star_rating
      FROM responses r
      JOIN reviews rev ON rev.id = r.review_id
      WHERE r.business_id = ${businessId}
        AND r.status = 'awaiting_owner_connect'
      ORDER BY r.created_at DESC
      LIMIT 50
    `,
    // Unresolved finalize incidents — block new connect/start flows until
    // ops resolves them. Migration 026 enforces at most one unresolved
    // incident per business; LIMIT 50 is defensive only.
    sql<ZernioFinalizeIncidentRow[]>`
      SELECT id, finalize_unknown_at, flow_id, zernio_profile_id
      FROM zernio_finalize_incidents
      WHERE business_id = ${businessId} AND resolved_at IS NULL
      ORDER BY finalize_unknown_at DESC
      LIMIT 50
    `,
  ]);

  return {
    businessRows,
    reviewRows,
    rankingSnapshots,
    zernioConnectionRows,
    awaitingOwnerConnectRows,
    finalizeIncidentRows,
  };
}

// ── Batch 2 ───────────────────────────────────────────────────────────────

export interface BusinessDetailBatch2 {
  metricsRows: BusinessMetricsRow[];
  accountLocationRows: AccountLocationRow[];
  approvalAuditRows: ApprovalAuditRow[];
  accountAuditRows: AccountAuditRow[];
  autoApprovalPolicyRows: AutoApprovalPolicyRow[];
  autoApprovalAccountRows: AutoApprovalAccountRow[];
}

export async function fetchBusinessDetailBatch2(
  sql: Sql,
  businessId: string,
  accountId: string,
): Promise<BusinessDetailBatch2> {
  const [
    metricsRows,
    accountLocationRows,
    approvalAuditRows,
    accountAuditRows,
    autoApprovalPolicyRows,
    autoApprovalAccountRows,
  ] = await Promise.all([
    sql<BusinessMetricsRow[]>`
      WITH notif AS (
        SELECT
          COUNT(DISTINCT nd.response_id)::int AS notified_count,
          COUNT(DISTINCT nd.response_id) FILTER (
            WHERE r.status = ANY(${[...HANDLED_STATUSES] as string[]}::text[])
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
            FILTER (WHERE rp.status = ANY(${[...HANDLED_STATUSES] as string[]}::text[]))
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
    `,
    // Account locations — all locations under the same account (VAL-ADMIN-001)
    // Uses idx_businesses_account partial index on (account_id) WHERE archived_at IS NULL.
    // Also includes archived locations for admin visibility.
    sql<AccountLocationRow[]>`
      SELECT id, name, display_label, is_primary, archived_at
      FROM businesses
      WHERE account_id = ${accountId}
      ORDER BY is_primary DESC, archived_at ASC, created_at ASC
    `,
    // Approval audit log — queried by account_id using idx_audit_account
    // (VAL-ADMIN-004). Returns recent entries across all locations under
    // the account for admin visibility.
    sql<ApprovalAuditRow[]>`
      SELECT id, response_id, action, actor_user_id, created_at, business_id, account_id
      FROM approval_audit_log
      WHERE account_id = ${accountId}
      ORDER BY created_at DESC
      LIMIT 50
    `,
    // Account audit log — queried by account_id using idx_account_audit
    // (account_id, created_at composite index). Returns recent entries
    // for admin visibility into account-level state changes.
    sql<AccountAuditRow[]>`
      SELECT id, event_type, actor_user_id, location_id, payload, created_at
      FROM account_audit_log
      WHERE account_id = ${accountId}
      ORDER BY created_at DESC
      LIMIT 50
    `,
    sql<AutoApprovalPolicyRow[]>`
      SELECT id, account_id, location_id, auto_approve_min_star,
             veto_window_minutes, daily_auto_post_cap, suspended_at
      FROM auto_approval_policies
      WHERE account_id = ${accountId}
      ORDER BY location_id NULLS FIRST
    `,
    sql<AutoApprovalAccountRow[]>`
      SELECT subscription_status, past_due_at, flags
      FROM accounts
      WHERE id = ${accountId}
      LIMIT 1
    `,
  ]);

  return {
    metricsRows,
    accountLocationRows,
    approvalAuditRows,
    accountAuditRows,
    autoApprovalPolicyRows,
    autoApprovalAccountRows,
  };
}
