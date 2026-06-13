import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { jsonResponse, errorResponse, requireOwnerWithAccount } from '@/lib/auth/route-helpers';
import { subscriptionAllowsDashboardRead } from '@/lib/shared/subscription-status';
import { isValidUuid } from '@/lib/shared/ids';
import { getLocationById } from '@/lib/locations/repo';
import { getLocationKpiSummary, getAccountKpiSummary } from '@/lib/kpi/service';
import { reportCaughtError } from '@/lib/shared/report-caught-error';
import { resolveDashboardScopePolicy } from '../policy';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  // requireOwnerWithAccount is the shared owner read-gate: owner role + account
  // presence, with AuthError mapped and unexpected (non-auth) failures re-thrown
  // as a real 5xx (the Part A contract) — replacing this route's bespoke
  // preamble and its unique 'Internal server error' 500 spelling.
  const owner = await requireOwnerWithAccount(request);
  if (!owner.ok) return owner.response;
  const { user, accountId } = owner;

  try {
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

    const scopeParam = request.nextUrl.searchParams.get('scope');
    const multiLocationEnabled = process.env.MULTI_LOCATION_ENABLED === 'true';
    const scopePolicy = resolveDashboardScopePolicy({
      scopeParam,
      userLocationId: user.locationId,
      multiLocationEnabled,
    });

    if (scopePolicy.mode === 'aggregate') {
      const summary = await getAccountKpiSummary(accountId);
      return jsonResponse(summary);
    }

    // Per-location mode
    const locationId = scopePolicy.locationId;

    if (!locationId) {
      return errorResponse('No business associated with this account', 403);
    }

    // Validate the scope/location id BEFORE the DB read so a malformed
    // client-supplied `?scope=` value produces a controlled 400, not a
    // Postgres `::uuid` cast error surfaced as a 500.
    if (!isValidUuid(locationId)) {
      return errorResponse('Invalid scope: location must be a valid UUID', 400);
    }

    // IDOR protection: verify the location belongs to the authenticated user's account.
    // getLocationById fetches via service-role SQL (bypasses RLS), so ownership
    // and archived state must be checked explicitly before returning any data.
    const location = await getLocationById(locationId);

    if (!location) {
      return errorResponse('Business not found', 404);
    }

    if (location.account_id !== accountId) {
      // IDOR attempt: location exists but belongs to a different account
      return errorResponse('Not authorized to access this location', 403);
    }

    if (location.archived_at !== null) {
      return errorResponse('No active location available', 404);
    }

    const summary = await getLocationKpiSummary(locationId);
    return jsonResponse(summary);
  } catch (err) {
    reportCaughtError('api/dashboard/kpis', err, { accountId });
    return errorResponse('Failed to fetch KPIs', 500);
  }
}
