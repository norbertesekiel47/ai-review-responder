// src/lib/admin/businesses-list-service.ts
//
// Extracted verbatim from src/app/api/admin/businesses/route.ts's GET body
// (admin console Phase 3, Task 2). Same two queries in the same Promise.all,
// same row→DTO mapping. Born-injected: `sql` is a parameter, not an import —
// the composition roots (the route and the businesses server page) supply the
// singleton (invariant #15).
//
// `limit`/`offset` clamping deliberately stays in the route: it owns query-param
// parsing. This service takes already-clamped numbers.

import type { Sql } from 'postgres';

interface BusinessListRow {
  id: string;
  name: string;
  category: string | null;
  subscription_status: string;
  last_sync_at: Date | null;
  pending_count: number;
}

export interface AdminBusinessListItem {
  id: string;
  name: string;
  category: string | null;
  subscriptionStatus: string;
  /** ISO-8601. Postgres returns Date; converted here so the RSC path is safe. */
  lastSyncAt: string | null;
  pendingCount: number;
}

export interface AdminBusinessesList {
  businesses: AdminBusinessListItem[];
  total: number;
}

/**
 * One page of the admin business list (location + billing status + pending-draft
 * count) plus the unpaginated total, for the console's Businesses page (spec §4).
 */
export async function getAdminBusinessesList(
  sql: Sql,
  { limit, offset }: { limit: number; offset: number },
): Promise<AdminBusinessesList> {
  // SEQUENCED, NOT `Promise.all` — at most ONE query in flight (#773). See
  // src/lib/admin/flagged-service.ts for the mechanism and staging evidence.
  // Not collapsed into a window `COUNT(*) OVER ()`: this page query GROUPs and
  // the count is over unfiltered `businesses`, so a window total would count
  // grouped page rows instead — a different number.
  const businessRows = await sql<BusinessListRow[]>`
        SELECT
          b.id,
          b.name,
          b.category,
          a.subscription_status,
          b.last_sync_at,
          COUNT(CASE WHEN resp.status = 'pending_approval' THEN 1 END)::int AS pending_count
        FROM businesses b
        JOIN accounts a ON a.id = b.account_id
        LEFT JOIN responses resp
          ON resp.business_id = b.id AND resp.status != 'superseded'
        GROUP BY b.id, b.name, b.category, a.subscription_status, b.last_sync_at
        ORDER BY b.name ASC
        LIMIT ${limit} OFFSET ${offset}
      `;
  const countRows = await sql<{ total: number }[]>`SELECT COUNT(*)::int AS total FROM businesses`;

  return {
    businesses: businessRows.map((row) => ({
      id: row.id,
      name: row.name,
      category: row.category ?? null,
      subscriptionStatus: row.subscription_status,
      lastSyncAt: row.last_sync_at ? row.last_sync_at.toISOString() : null,
      pendingCount: row.pending_count,
    })),
    total: countRows[0]?.total ?? 0,
  };
}
