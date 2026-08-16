import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { requireRoleOr401 } from '@/lib/auth/route-helpers';
import { reportCaughtError } from '@/lib/shared/report-caught-error';
import { getAdminOverview } from '@/lib/admin/overview-service';

export const dynamic = 'force-dynamic';

// Thin orchestrator (auth → parse → call getAdminOverview → return; invariant #12).
// Its fallow CRAP score is high only because it has no dedicated unit test (covered
// by e2e), not because of control-flow complexity — cyclomatic is 7.
// fallow-ignore-next-line complexity
export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = await requireRoleOr401(request, 'admin');
  if (!auth.ok) return auth.response;

  try {
    // No limit/offset: Overview returns the at-risk list, capped in the service
    // at OVERVIEW_AT_RISK_LIMIT (spec §5.1/§5.3). Nothing here to parse or clamp.
    const data = await getAdminOverview(sql);

    return NextResponse.json(data);
  } catch (error) {
    reportCaughtError('api/admin/overview', error);
    return NextResponse.json(
      { error: 'Failed to fetch overview' },
      { status: 500 },
    );
  }
}
