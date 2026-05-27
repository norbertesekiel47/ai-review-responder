import { NextRequest, NextResponse } from 'next/server';
import { requireRole, AuthError } from '@/lib/db/auth';
import { NO_STORE_HEADERS } from '@/lib/shared/constants';
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
