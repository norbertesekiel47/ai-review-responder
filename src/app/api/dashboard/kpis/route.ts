import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { jsonResponse, errorResponse } from '@/lib/auth/route-helpers';
import { subscriptionAllowsDashboardRead } from '@/lib/shared/subscription-status';
import { getLocationKpiSummary, getAccountKpiSummary } from '@/lib/kpi/service';
import {
  resolveDashboardLocation,
  resolveDashboardRequest,
  withDashboardOwnerRead,
} from '../policy';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  // requireOwnerWithAccount is the shared owner read-gate: owner role + account
  // presence, with AuthError mapped and unexpected (non-auth) failures re-thrown
  // as a real 5xx (the Part A contract) — replacing this route's bespoke
  // preamble and its unique 'Internal server error' 500 spelling.
  return withDashboardOwnerRead(request, {
    errorContext: 'api/dashboard/kpis',
    errorMessage: 'Failed to fetch KPIs',
  }, async ({ user, accountId }) => {
    // Subscription gate: only entitled accounts get customer KPI data. Mirrors
    // /api/dashboard — active + past_due (grace) return data; pending_payment /
    // cancelled do not. Enforced for BOTH aggregate and per-location modes,
    // before any KPI is computed, so a churned/unpaid owner can't read KPIs.
    const [account] = await sql<{ subscription_status: string }[]>`
      SELECT subscription_status FROM accounts WHERE id = ${accountId}::uuid
    `;
    if (!account) {
      return errorResponse('Account not found', 404);
    }
    if (!subscriptionAllowsDashboardRead(account.subscription_status)) {
      return jsonResponse(
        {
          error: 'subscription_inactive',
          subscriptionStatus: account.subscription_status,
        },
        403,
      );
    }

    // #403: validate + clamp the client window and resolve the scope policy in
    // one shared step (the untrusted window never reaches SQL un-clamped).
    const { window, scopePolicy } = resolveDashboardRequest(request, user.locationId);

    if (scopePolicy.mode === 'aggregate') {
      const summary = await getAccountKpiSummary(sql, accountId, window);
      return jsonResponse(summary);
    }

    // Per-location mode
    const location = await resolveDashboardLocation(sql, {
      accountId,
      locationId: scopePolicy.locationId,
      exposure: 'legacy-kpis',
    });
    if (!location.ok) return location.response;

    const summary = await getLocationKpiSummary(sql, location.locationId, window);
    return jsonResponse(summary);
  });
}
