import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { AuthError, requireRole } from '@/lib/db/auth';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store, private' } as const;

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
  created_at: string;
  response_text: string;
  version: number;
  reviewer_name: string;
  star_rating: number;
  business_name: string;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    await requireRole(request, 'admin');
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode, headers: NO_STORE });
    }
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE });
  }

  const rawLimit = request.nextUrl.searchParams.get('limit');
  const rawOffset = request.nextUrl.searchParams.get('offset');
  const limit = Math.min(Math.max(parseInt(rawLimit ?? '20', 10) || 20, 1), 100);
  const offset = Math.max(parseInt(rawOffset ?? '0', 10) || 0, 0);

  // Admin cross-tenant read of the OPEN flagged queue. The joins to tenant
  // tables (responses/reviews/businesses) are intentionally unscoped (admin
  // sees every tenant) and are covered by tenant-scope-allowlist.ts entries.
  const rows = await sql<FlaggedRow[]>`
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
  `;

  const flagged = rows.map((row) => ({
    id: row.id,
    responseId: row.response_id,
    businessId: row.business_id,
    accountId: row.account_id,
    reviewId: row.review_id,
    source: row.source,
    reason: row.reason,
    severity: row.severity,
    status: row.status,
    createdAt: row.created_at,
    responseText: row.response_text,
    version: row.version,
    reviewerName: row.reviewer_name,
    starRating: row.star_rating,
    businessName: row.business_name,
  }));

  return NextResponse.json({ flagged, limit, offset }, { headers: NO_STORE });
}
