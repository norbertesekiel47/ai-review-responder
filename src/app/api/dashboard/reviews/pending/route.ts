// src/app/api/dashboard/reviews/pending/route.ts
//
// GET /api/dashboard/reviews/pending?scope=<locationId|all>&offset=<n>
//
// The Needs Action queue's read (UX audit D2): a page of the reviews waiting
// on the owner plus the authoritative totals, so the queue is no longer a
// filter over the dashboard payload's 10-row sample. Composition root only:
// owner auth + scope policy + location authorization, then one call into
// `src/lib/dashboard/pending-approvals.ts`.

import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { jsonResponse } from '@/lib/auth/route-helpers';
import { multiLocationEnabled as isMultiLocationEnabled } from '@/lib/locations/flags';
import {
  listPendingApprovals,
  normalizePendingOffset,
} from '@/lib/dashboard/pending-approvals';
import {
  resolveDashboardLocation,
  resolveDashboardScopePolicy,
  withDashboardOwnerRead,
} from '@/app/api/dashboard/policy';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  return withDashboardOwnerRead(request, {
    errorContext: 'api/dashboard/reviews/pending',
    errorMessage: 'Failed to fetch pending approvals',
  }, async ({ user, accountId }) => {
    const scopePolicy = resolveDashboardScopePolicy({
      scopeParam: request.nextUrl.searchParams.get('scope'),
      userLocationId: user.locationId,
      multiLocationEnabled: isMultiLocationEnabled(),
    });
    const offset = normalizePendingOffset(request.nextUrl.searchParams.get('offset'));

    if (scopePolicy.mode === 'aggregate') {
      const page = await listPendingApprovals(sql, { kind: 'account', accountId }, { offset });
      return jsonResponse(page);
    }

    const location = await resolveDashboardLocation(sql, {
      accountId,
      locationId: scopePolicy.locationId,
      exposure: 'legacy-kpis',
    });
    if (!location.ok) return location.response;

    const page = await listPendingApprovals(
      sql,
      { kind: 'location', accountId, businessId: location.locationId },
      { offset },
    );
    return jsonResponse(page);
  });
}
