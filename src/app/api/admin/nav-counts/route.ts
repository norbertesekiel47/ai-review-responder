import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { requireRoleOr401 } from '@/lib/auth/route-helpers';
import { reportCaughtError } from '@/lib/shared/report-caught-error';
import { getAdminNavCounts } from '@/lib/admin/nav-counts-service';

export const dynamic = 'force-dynamic';

// Thin orchestrator (auth → call service → return; invariant #12). Polled every
// 60s by the admin sidebar for badge counts.
export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = await requireRoleOr401(request, 'admin');
  if (!auth.ok) return auth.response;

  try {
    const data = await getAdminNavCounts(sql);
    return NextResponse.json(data, { headers: { 'Cache-Control': 'no-store, private' } });
  } catch (error) {
    reportCaughtError('api/admin/nav-counts', error);
    return NextResponse.json({ error: 'Failed to fetch nav counts' }, { status: 500 });
  }
}
