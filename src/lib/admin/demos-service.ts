// src/lib/admin/demos-service.ts
//
// Extracted verbatim from src/app/api/admin/demos/route.ts's GET body (admin
// console Phase 3, Task 7). Same query, same row→DTO mapping — including the
// two `.toISOString()` conversions the route already did. Born-injected:
// `sql` is a parameter, not an import — the API route supplies the singleton
// (invariant #15) for the separate Admin app's list read.
//
// Error handling stays in the API route, which maps a throw to a 500 with
// `reportCaughtError`.

import type { Sql } from 'postgres';
import type { DemoListItem } from '@/lib/demos/types';

interface ProspectDemoRow {
  id: string;
  demo_url_slug: string;
  business_name: string;
  generation_status: string;
  generation_error: string | null;
  view_count: number;
  generated_at: Date;
  expires_at: Date;
}

/**
 * Every prospect demo, newest first, for the Admin app's Demos page (spec §4).
 *
 * Callers must gate on admin first: `prospect_demos` is a cross-tenant sales
 * surface with no account/business column (allowlisted in tenant-scope).
 */
export async function getAdminDemos(sql: Sql): Promise<DemoListItem[]> {
  const rows = await sql<ProspectDemoRow[]>`
      SELECT id, demo_url_slug, business_name, generation_status,
             generation_error, view_count, generated_at, expires_at
      FROM prospect_demos
      ORDER BY generated_at DESC
    `;

  return rows.map((row) => ({
    id: row.id,
    slug: row.demo_url_slug,
    businessName: row.business_name,
    generationStatus: row.generation_status,
    generationError: row.generation_error,
    viewCount: row.view_count,
    // Both timestamptz; the DTO exposes explicit ISO strings to its API caller.
    createdAt: row.generated_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
  }));
}
