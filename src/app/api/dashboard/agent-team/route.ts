import { NextRequest, NextResponse } from 'next/server';
import { getAgentTeamSummary } from '@/lib/agents/read';
import {
  errorResponse,
  jsonResponse,
  requireOwnerWithAccount,
} from '@/lib/auth/route-helpers';
import { sql } from '@/lib/db/server';
import { getLocationById } from '@/lib/locations/repo';
import { isValidUuid } from '@/lib/shared/ids';
import { reportCaughtError } from '@/lib/shared/report-caught-error';
import { resolveDashboardRequest } from '../policy';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const owner = await requireOwnerWithAccount(request);
  if (!owner.ok) return owner.response;
  const { user, accountId } = owner;

  try {
    const { window, scopePolicy } = resolveDashboardRequest(request, user.locationId);

    if (scopePolicy.mode === 'aggregate') {
      const summary = await getAgentTeamSummary(
        sql,
        { kind: 'account', accountId },
        window,
      );
      return jsonResponse({ window, ...summary });
    }

    const locationId = scopePolicy.locationId;
    if (!locationId) {
      return errorResponse('No business associated with this account', 403);
    }
    if (!isValidUuid(locationId)) {
      return errorResponse('Invalid scope: location must be a valid UUID', 400);
    }

    const location = await getLocationById(sql, locationId);
    if (
      !location
      || location.account_id !== accountId
      || location.archived_at !== null
    ) {
      return errorResponse('Business not found', 404);
    }

    const summary = await getAgentTeamSummary(
      sql,
      { kind: 'location', accountId, businessId: locationId },
      window,
    );
    return jsonResponse({ window, ...summary });
  } catch (error) {
    reportCaughtError('api/dashboard/agent-team', error, { accountId });
    return errorResponse('Failed to fetch agent team', 500);
  }
}
