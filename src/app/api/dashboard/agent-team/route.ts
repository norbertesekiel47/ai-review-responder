import { NextRequest, NextResponse } from 'next/server';
import { getAgentTeamSummary } from '@/lib/agents/read';
import {
  jsonResponse,
} from '@/lib/auth/route-helpers';
import { sql } from '@/lib/db/server';
import {
  resolveDashboardLocation,
  resolveDashboardRequest,
  withDashboardOwnerRead,
} from '../policy';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  return withDashboardOwnerRead(request, {
    errorContext: 'api/dashboard/agent-team',
    errorMessage: 'Failed to fetch agent team',
  }, async ({ user, accountId }) => {
    const { window, scopePolicy } = resolveDashboardRequest(request, user.locationId);

    if (scopePolicy.mode === 'aggregate') {
      const summary = await getAgentTeamSummary(
        sql,
        { kind: 'account', accountId },
        window,
      );
      return jsonResponse({ window, ...summary });
    }

    const location = await resolveDashboardLocation(sql, {
      accountId,
      locationId: scopePolicy.locationId,
      exposure: 'uniform-not-found',
    });
    if (!location.ok) return location.response;

    const summary = await getAgentTeamSummary(
      sql,
      { kind: 'location', accountId, businessId: location.locationId },
      window,
    );
    return jsonResponse({ window, ...summary });
  });
}
