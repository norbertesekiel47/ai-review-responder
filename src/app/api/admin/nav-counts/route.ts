import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { requireAdminWithAal2 } from '@/lib/auth/admin-mfa-gate';
import { reportCaughtError } from '@/lib/shared/report-caught-error';
import { getAdminNavCounts } from '@/lib/admin/nav-counts-service';

export const dynamic = 'force-dynamic';

// Thin orchestrator (auth → call service → return; invariant #12). Polled every
// 60s by the admin sidebar for badge counts.
//
// #1184 (ADR 0025 D5): folded from `requireRoleOr401` onto the admin control-plane
// gate, so this read requires AAL2 and accepts either **Admin transport**. Two
// behaviours changed with it, both the accepted direction: an `aal1` admin is now
// refused `mfa_required` where it was served, and a non-auth failure is now the
// gate's clean `internal_error` 500 instead of `requireRoleOr401`'s re-throw.
export async function GET(request: NextRequest): Promise<NextResponse> {
  const gate = await requireAdminWithAal2(request);
  if (!gate.ok) return gate.response;

  try {
    const data = await getAdminNavCounts(sql);
    return NextResponse.json(data, { headers: { 'Cache-Control': 'no-store, private' } });
  } catch (error) {
    reportCaughtError('api/admin/nav-counts', error);
    return NextResponse.json({ error: 'Failed to fetch nav counts' }, { status: 500 });
  }
}
