// src/lib/admin/flagged-service.ts
//
// Extracted verbatim from src/app/api/admin/flagged/route.ts's GET body
// (admin console Phase 2, Task 9). Same join query, same open-flag COUNT,
// same row→DTO mapping. The POST disposition transaction stays in the route
// — it is a mutation orchestrator nothing else calls. Born-injected: `sql`
// is a parameter, not an import — the composition root (the route, and the
// flagged server page) supplies the singleton (invariant #15).

import type { Sql } from 'postgres';

interface FlaggedRow {
  id: string;
  response_id: string;
  business_id: string;
  account_id: string;
  review_id: string;
  source: string;
  reason: string | null;
  severity: string;
  status: string;
  created_at: Date;
  response_text: string;
  version: number;
  reviewer_name: string;
  star_rating: number;
  business_name: string;
}

export interface AdminFlaggedItem {
  id: string;
  responseId: string;
  businessId: string;
  accountId: string;
  reviewId: string;
  source: string;
  reason: string | null;
  severity: string;
  status: string;
  createdAt: string;
  responseText: string;
  version: number;
  reviewerName: string;
  starRating: number;
  businessName: string;
}

export interface AdminFlaggedData {
  flagged: AdminFlaggedItem[];
  total: number;
}

/**
 * Open flagged-response queue: a page of held drafts (joined to their
 * response/review/business rows) plus the total open count for pagination
 * (spec §4). Admin-only cross-tenant read — same sensitivity as the POST
 * disposition, gated by the same admin + AAL2 requirement at both call
 * sites (route + server page).
 */
export async function listOpenFlaggedResponses(
  sql: Sql,
  { limit, offset }: { limit: number; offset: number },
): Promise<AdminFlaggedData> {
  const [rows, countRows] = await Promise.all([
    // Admin cross-tenant read of the OPEN flagged queue. The joins to tenant
    // tables (responses/reviews/businesses) are intentionally unscoped (admin
    // sees every tenant) and are covered by tenant-scope-allowlist.ts entries.
    sql<FlaggedRow[]>`
      SELECT fr.id, fr.response_id, fr.business_id, fr.account_id, fr.review_id,
             fr.source, fr.reason, fr.severity, fr.status, fr.created_at,
             r.response_text, r.version,
             rev.reviewer_name, rev.star_rating,
             b.name AS business_name
      FROM flagged_responses fr
      JOIN responses r ON r.id = fr.response_id
      JOIN reviews rev ON rev.id = fr.review_id
      JOIN businesses b ON b.id = fr.business_id
      WHERE fr.status = 'open'
      ORDER BY fr.created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `,
    // Total OPEN flags for the "Showing X-Y of Z" pagination footer.
    sql<{ total: number }[]>`
      SELECT COUNT(*)::int AS total FROM flagged_responses WHERE status = 'open'
    `,
  ]);
  const total = countRows[0]?.total ?? 0;

  return {
    flagged: rows.map((row) => ({
      id: row.id,
      responseId: row.response_id,
      businessId: row.business_id,
      accountId: row.account_id,
      reviewId: row.review_id,
      source: row.source,
      reason: row.reason,
      severity: row.severity,
      status: row.status,
      createdAt: row.created_at.toISOString(),
      responseText: row.response_text,
      version: row.version,
      reviewerName: row.reviewer_name,
      starRating: row.star_rating,
      businessName: row.business_name,
    })),
    total,
  };
}
