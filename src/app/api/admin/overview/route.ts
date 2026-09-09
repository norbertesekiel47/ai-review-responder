import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { requireAdminWithAal2 } from '@/lib/auth/admin-mfa-gate';
import { reportCaughtError } from '@/lib/shared/report-caught-error';
import { getAdminOverview } from '@/lib/admin/overview-service';

export const dynamic = 'force-dynamic';

// Thin orchestrator (auth → parse → call getAdminOverview → return; invariant #12).
// Its fallow CRAP score is high only because it has no dedicated unit test (covered
// by e2e), not because of control-flow complexity — cyclomatic is 7.
//
// #1184 (ADR 0025 D5): folded onto the admin control-plane gate, so this read requires
// AAL2 and accepts either Admin transport. An aal1 admin is now refused `mfa_required`
// where it was served, and a non-auth failure is the gate's clean `internal_error` 500
// rather than `requireRoleOr401`'s re-throw.
// fallow-ignore-next-line complexity
export async function GET(request: NextRequest): Promise<NextResponse> {
  const gate = await requireAdminWithAal2(request);
  if (!gate.ok) return gate.response;

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
