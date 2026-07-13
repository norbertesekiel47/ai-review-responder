import type { Sql } from 'postgres';
import type { TriageOutput, TriageSeverity } from '@/lib/reviews/triage-schema';
import type { OpenEscalationStatus } from './types';

type EscalationListRow = {
  id: string;
  status: OpenEscalationStatus;
  triage_severity: TriageSeverity;
  triage_suggested_action: TriageOutput['suggested_action'];
  created_at: Date | string;
  review_id: string;
  business_name: string;
  review_rating: number | null;
};

export interface OpenEscalationListItem {
  id: string;
  status: OpenEscalationStatus;
  severity: TriageSeverity;
  suggestedAction: TriageOutput['suggested_action'];
  createdAt: string;
  reviewId: string;
  businessName: string;
  /** reviews.star_rating is nullable — sources may deliver rating-less reviews. */
  reviewRating: number | null;
}

export interface OpenEscalationsList {
  totalOpen: number;
  items: OpenEscalationListItem[];
}

/**
 * Reads the bounded owner exception queue. Both statements keep tenant scope
 * inline at the top level so the app-enforced account boundary remains
 * visible to the tenant-scope audit. Archived locations are excluded so every
 * row's timeline link resolves (the timeline scope read filters archived).
 */
export async function listOpenEscalations(
  sql: Sql,
  params: { accountId: string },
): Promise<OpenEscalationsList> {
  return sql.begin('isolation level repeatable read read only', async (tx) => {
    const countRows = await tx<{ total_open: number }[]>`
      SELECT COUNT(*)::int AS total_open
      FROM review_escalations e
      JOIN reviews r ON r.id = e.review_id
      JOIN businesses b ON b.id = r.business_id
      WHERE e.account_id = ${params.accountId}
        AND b.account_id = ${params.accountId}
        AND b.archived_at IS NULL
        AND e.status <> 'resolved'
    `;
    const rows = await tx<EscalationListRow[]>`
      SELECT e.id, e.status, e.triage_severity, e.triage_suggested_action,
             e.created_at, r.id AS review_id, b.name AS business_name,
             r.star_rating AS review_rating
      FROM review_escalations e
      JOIN reviews r ON r.id = e.review_id
      JOIN businesses b ON b.id = r.business_id
      WHERE e.account_id = ${params.accountId}
        AND b.account_id = ${params.accountId}
        AND b.archived_at IS NULL
        AND e.status <> 'resolved'
      ORDER BY
        CASE e.status
          WHEN 'escalated' THEN 0
          WHEN 'acknowledged' THEN 1
          ELSE 2
        END,
        CASE e.triage_severity
          WHEN 'high' THEN 0
          WHEN 'medium' THEN 1
          WHEN 'low' THEN 2
          ELSE 3
        END,
        e.created_at ASC
      LIMIT 20
    `;

    return {
      totalOpen: Number(countRows[0]?.total_open ?? 0),
      items: rows.map((row) => ({
        id: row.id,
        status: row.status,
        severity: row.triage_severity,
        suggestedAction: row.triage_suggested_action,
        createdAt: new Date(row.created_at).toISOString(),
        reviewId: row.review_id,
        businessName: row.business_name,
        reviewRating: row.review_rating,
      })),
    };
  });
}
