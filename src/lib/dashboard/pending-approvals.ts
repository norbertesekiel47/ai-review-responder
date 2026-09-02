// src/lib/dashboard/pending-approvals.ts
//
// The Needs Action queue's own read (UX audit D2). The queue used to be a
// filter over the dashboard payload's 10-most-recent `recentReviews` slice, so
// an owner with 50 drafts waiting saw at most 10 and had no way to reach the
// rest. This read answers the queue's actual question — "which reviews are
// waiting on me right now" — with a page of rows and the authoritative totals,
// while `recentReviews` stays the home feed's sample.
//
// A row belongs in the queue when its latest displayable response is either
//   (a) `pending_approval` and not moderation-held (the owner's decision), or
//   (b) an approved auto-policy post whose veto window is still open — the one
//       post-approval state the owner must be able to see and stop.
// Held drafts never surface (invariant #4); the admin queue owns them.
//
// Statements run one at a time (#505 — no Promise combinators over the pool);
// the count and the page share one FROM/WHERE fragment so they cannot drift.

import type { Sql } from 'postgres';
import { APPROVAL_METHOD } from '@/lib/auto-approval/types';
import { getDisplayLabel } from '@/lib/locations/display-label';
import { openFlagExistsSql } from '@/lib/moderation/held-draft';
import { REVIEW_STATUS } from '@/lib/reviews/status';
import { RECENT_REVIEW_DISPLAY_STATUSES } from '@/lib/shared/response-status';
import { statusArraySql } from '@/lib/shared/response-status-sql';
import { mapRecentReviews } from './active-mappers';
import { getPendingApprovalCount, getPendingApprovalCountsForAccount } from './pending-count';
import type { DashboardDataActive } from './types';

/** Rows per page. The nav badge can read 50+; the queue must be able to show them all. */
export const PENDING_APPROVALS_PAGE_SIZE = 50;

// Single-value binds for the two response statuses the queue predicate names.
// Not a group, so `statusArraySql` does not apply; bound (never spelled into the
// SQL text) so the reviews-status audit cannot mistake them for a reviews literal.
const RESPONSE_PENDING_APPROVAL: (typeof RECENT_REVIEW_DISPLAY_STATUSES)[number] = 'pending_approval';
const RESPONSE_APPROVED: (typeof RECENT_REVIEW_DISPLAY_STATUSES)[number] = 'approved';

/**
 * Both scopes carry the account: the owner's account boundary is the tenant
 * predicate every statement spells out, and the location scope narrows it
 * further. A location id alone would leave the account boundary implicit.
 */
export type PendingApprovalsScope =
  | { kind: 'location'; accountId: string; businessId: string }
  | { kind: 'account'; accountId: string };

/** A queue row: the per-location feed item, plus location chip fields on the account scope. */
export type PendingApprovalItem = DashboardDataActive['recentReviews'][number] & {
  locationId?: string;
  locationDisplayName?: string;
};

export interface PendingApprovalsPage {
  items: PendingApprovalItem[];
  /** Rows matching the queue predicate across the whole scope — drives "Showing N of M". */
  total: number;
  /** Authoritative drafts-awaiting-approval count (same helper as the nav badge). */
  pendingTotal: number;
  limit: number;
  offset: number;
}

export interface PendingApprovalsPageOptions {
  offset?: number;
  limit?: number;
}

/** Clamp an untrusted offset to a non-negative integer. */
export function normalizePendingOffset(raw: string | null): number {
  if (raw === null || raw === '') return 0;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) return 0;
  return parsed;
}

export async function listPendingApprovals(
  sql: Sql,
  scope: PendingApprovalsScope,
  options: PendingApprovalsPageOptions = {},
): Promise<PendingApprovalsPage> {
  const limit = options.limit ?? PENDING_APPROVALS_PAGE_SIZE;
  const offset = options.offset ?? 0;

  // Sequential on purpose (#505): one statement in flight at a time.
  const pendingTotal = await readPendingTotal(sql, scope);

  const [countRow] = await sql<{ total: number }[]>`
    SELECT COUNT(*)::int AS total
    ${queueFromWhere(sql, scope)}
  `;

  const rows = await sql<Record<string, unknown>[]>`
    SELECT
      rev.id,
      rev.reviewer_name,
      rev.star_rating,
      rev.review_text,
      rev.review_date,
      rev.status,
      resp.response_text,
      resp.status AS response_status,
      resp.approval_method,
      resp.auto_post_scheduled_at,
      esc.id AS escalation_id,
      esc.status AS escalation_status,
      esc.triage_severity AS escalation_severity,
      b.id AS location_id,
      b.name AS location_name,
      b.display_label AS location_display_label
    ${queueFromWhere(sql, scope)}
    ORDER BY rev.detected_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;

  const base = mapRecentReviews(rows);
  const items: PendingApprovalItem[] = scope.kind === 'account'
    ? base.map((item, index) => ({
        ...item,
        locationId: rows[index]!.location_id as string,
        locationDisplayName: getDisplayLabel({
          name: rows[index]!.location_name as string,
          display_label: (rows[index]!.location_display_label as string | null) ?? null,
        }),
      }))
    : base;

  return {
    items,
    total: Number(countRow?.total ?? 0),
    pendingTotal,
    limit,
    offset,
  };
}

async function readPendingTotal(sql: Sql, scope: PendingApprovalsScope): Promise<number> {
  if (scope.kind === 'location') {
    return getPendingApprovalCount(sql, scope.businessId);
  }
  const counts = await getPendingApprovalCountsForAccount(sql, scope.accountId);
  let total = 0;
  for (const count of counts.values()) total += count;
  return total;
}

/**
 * The FROM … WHERE shared by the count and the page. Mirrors the dashboard
 * payload's recent-reviews projection (same LATERAL joins, same held-draft
 * exclusion) so a row reads identically here and on the home feed.
 *
 * ONE template on purpose: `ci:tenant-scope` reads each tagged template on its
 * own and cannot see into an interpolated fragment, so the account predicate
 * is spelled here, at the top level, for both scopes; the location scope adds
 * its narrowing as a second conjunct (`NULL` = no narrowing).
 */
function queueFromWhere(sql: Sql, scope: PendingApprovalsScope) {
  const businessId = scope.kind === 'location' ? scope.businessId : null;

  return sql`
    FROM reviews rev
    JOIN businesses b ON b.id = rev.business_id
    LEFT JOIN LATERAL (
      SELECT COALESCE(cand.approved_text, cand.response_text) AS response_text,
             cand.status, cand.approval_method, cand.auto_post_scheduled_at
      FROM responses cand
      WHERE cand.review_id = rev.id
        -- Explicit tenant scope: responses belong to the same location as the
        -- review (defense-in-depth alongside the review_id correlation).
        AND cand.business_id = rev.business_id
        AND cand.status = ANY(${statusArraySql(sql, RECENT_REVIEW_DISPLAY_STATUSES)})
        -- Held-for-review drafts (high-severity moderation flag still open)
        -- must never surface to the owner UI; the admin queue owns them.
        AND NOT ${openFlagExistsSql(sql, sql`cand.id`)}
      ORDER BY cand.version DESC
      LIMIT 1
    ) resp ON true
    LEFT JOIN LATERAL (
      SELECT id, status, triage_severity
      FROM review_escalations e
      WHERE e.review_id = rev.id
        -- Explicit tenant scope (defense-in-depth, mirrors the resp join).
        AND e.business_id = rev.business_id
        -- Status literal kept deliberately: it matches the
        -- review_escalations_one_open_per_review partial-index predicate
        -- byte-for-byte so the planner can use that index.
        AND e.status <> 'resolved'
      LIMIT 1
    ) esc ON true
    WHERE b.account_id = ${scope.accountId}::uuid
      AND b.archived_at IS NULL
      AND (${businessId}::uuid IS NULL OR rev.business_id = ${businessId}::uuid)
      AND rev.status <> ${REVIEW_STATUS.DELETED}
      AND (
        resp.status = ${RESPONSE_PENDING_APPROVAL}
        OR (
          resp.status = ${RESPONSE_APPROVED}
          AND resp.approval_method = ${APPROVAL_METHOD.AUTO_POLICY}
          AND resp.auto_post_scheduled_at > NOW()
        )
      )
  `;
}
