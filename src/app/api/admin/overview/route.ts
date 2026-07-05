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
    const rawLimit = parseInt(request.nextUrl.searchParams.get('limit') ?? '20', 10);
    const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 20, 1), 100);
    const offset = Math.max(parseInt(request.nextUrl.searchParams.get('offset') ?? '0', 10) || 0, 0);

    const data = await getAdminOverview(sql, { limit, offset });

    return NextResponse.json(data);
  } catch (error) {
    reportCaughtError('api/admin/overview', error);
    return NextResponse.json(
      { error: 'Failed to fetch overview' },
      { status: 500 },
    );
  }
}
