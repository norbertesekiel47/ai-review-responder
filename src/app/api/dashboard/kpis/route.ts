import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { requireRole, AuthError } from '@/lib/db/auth';
import { NO_STORE_HEADERS } from '@/lib/shared/constants';
import { subscriptionAllowsDashboardRead } from '@/lib/shared/subscription-status';
import { isValidUuid } from '@/lib/shared/ids';
import { getLocationById } from '@/lib/locations/repo';
import { getLocationKpiSummary, getAccountKpiSummary } from '@/lib/kpi/service';
import { resolveDashboardScopePolicy } from '../policy';

export const dynamic = 'force-dynamic';

/** All KPI responses use no-store headers — owner-specific data. */
function jsonResponse(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE_HEADERS });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  let user;
  try {
    user = await requireRole(request, 'owner');
  } catch (err) {
    if (err instanceof AuthError) {
      return jsonResponse({ error: err.message }, err.statusCode);
    }
    console.error('[api/dashboard/kpis] auth check failed:', err);
    return jsonResponse({ error: 'Internal server error' }, 500);
  }

  if (!user.accountId) {
    return jsonResponse({ error: 'No account associated with this user' }, 403);
  }

  const accountId = user.accountId;

  try {
    // Subscription gate: only entitled accounts get customer KPI data. Mirrors
    // /api/dashboard — active + past_due (grace) return data; pending_payment /
    // cancelled do not. Enforced for BOTH aggregate and per-location modes,
    // before any KPI is computed, so a churned/unpaid owner can't read KPIs.
    const [account] = await sql<{ subscription_status: string }[]>`
      SELECT subscription_status FROM accounts WHERE id = ${accountId}::uuid
    `;
    if (!account) {
      return jsonResponse({ error: 'Account not found' }, 404);
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
      return jsonResponse({ error: 'No business associated with this account' }, 403);
    }

    // Validate the scope/location id BEFORE the DB read so a malformed
    // client-supplied `?scope=` value produces a controlled 400, not a
    // Postgres `::uuid` cast error surfaced as a 500.
    if (!isValidUuid(locationId)) {
      return jsonResponse({ error: 'Invalid scope: location must be a valid UUID' }, 400);
    }

    // IDOR protection: verify the location belongs to the authenticated user's account.
    // getLocationById fetches via service-role SQL (bypasses RLS), so ownership
    // and archived state must be checked explicitly before returning any data.
    const location = await getLocationById(locationId);

    if (!location) {
      return jsonResponse({ error: 'Business not found' }, 404);
    }

    if (location.account_id !== accountId) {
      // IDOR attempt: location exists but belongs to a different account
      return jsonResponse({ error: 'Not authorized to access this location' }, 403);
    }

    if (location.archived_at !== null) {
      return jsonResponse({ error: 'No active location available' }, 404);
    }

    const summary = await getLocationKpiSummary(locationId);
    return jsonResponse(summary);
  } catch (err) {
    console.error('[api/dashboard/kpis] failed to fetch KPIs:', err);
    return jsonResponse({ error: 'Failed to fetch KPIs' }, 500);
  }
}
