import { type NextRequest, type NextResponse } from 'next/server';
import type { Sql } from 'postgres';
import {
  errorResponse,
  requireOwnerWithAccount,
} from '@/lib/auth/route-helpers';
import type { AppUser } from '@/lib/db/auth';
import { multiLocationEnabled as isMultiLocationEnabled } from '@/lib/locations/flags';
import { getLocationById } from '@/lib/locations/repo';
import { type DashboardWindow, resolveDashboardWindow } from '@/lib/kpi/types';
import { isValidUuid } from '@/lib/shared/ids';
import { reportCaughtError } from '@/lib/shared/report-caught-error';

export type DashboardScopePolicy =
  | { mode: 'aggregate' }
  | { mode: 'location'; locationId: string | null };

export function resolveDashboardScopePolicy(input: {
  scopeParam: string | null;
  userLocationId: string | null | undefined;
  multiLocationEnabled: boolean;
}): DashboardScopePolicy {
  if (input.multiLocationEnabled && input.scopeParam === 'all') {
    return { mode: 'aggregate' };
  }

  return {
    mode: 'location',
    locationId:
      input.scopeParam && input.scopeParam !== 'all'
        ? input.scopeParam
        : input.userLocationId ?? null,
  };
}

/**
 * Single owner of the per-request `?scope=` + `?window=` parse for the two
 * dashboard read routes (#403). Validates + clamps the untrusted window to the
 * allowlisted enum and resolves the scope policy — both routes consume this so
 * the parse logic lives in exactly one place.
 */
export function resolveDashboardRequest(
  request: NextRequest,
  userLocationId: string | null | undefined,
): { window: DashboardWindow; scopePolicy: DashboardScopePolicy } {
  const window = resolveDashboardWindow(request.nextUrl.searchParams.get('window'));
  const scopePolicy = resolveDashboardScopePolicy({
    scopeParam: request.nextUrl.searchParams.get('scope'),
    userLocationId,
    multiLocationEnabled: isMultiLocationEnabled(),
  });
  return { window, scopePolicy };
}

interface DashboardOwnerContext {
  user: AppUser;
  accountId: string;
}

/**
 * Shared owner auth + error boundary for dashboard read routes. Authentication
 * stays outside the catch so unexpected auth-infrastructure failures preserve
 * requireOwnerWithAccount's rethrow contract.
 */
export async function withDashboardOwnerRead(
  request: NextRequest,
  options: { errorContext: string; errorMessage: string },
  read: (context: DashboardOwnerContext) => Promise<NextResponse>,
): Promise<NextResponse> {
  const owner = await requireOwnerWithAccount(request);
  if (!owner.ok) return owner.response;

  const { user, accountId } = owner;
  try {
    return await read({ user, accountId });
  } catch (error) {
    reportCaughtError(options.errorContext, error, { accountId });
    return errorResponse(options.errorMessage, 500);
  }
}

type LocationExposurePolicy = 'uniform-not-found' | 'legacy-kpis';

type DashboardLocationResult =
  | { ok: true; locationId: string }
  | { ok: false; response: NextResponse };

/**
 * Resolves and authorizes one dashboard location. The exposure policy is
 * explicit because the WS5 agent-team endpoint deliberately hides foreign and
 * archived locations behind one 404, while the older KPI route retains its
 * established foreign-location 403 and archived-location error copy.
 */
export async function resolveDashboardLocation(
  sql: Sql,
  input: {
    accountId: string;
    locationId: string | null;
    exposure: LocationExposurePolicy;
  },
): Promise<DashboardLocationResult> {
  if (!input.locationId) {
    return {
      ok: false,
      response: errorResponse('No business associated with this account', 403),
    };
  }

  if (!isValidUuid(input.locationId)) {
    return {
      ok: false,
      response: errorResponse('Invalid scope: location must be a valid UUID', 400),
    };
  }

  const location = await getLocationById(sql, input.locationId);
  if (!location) {
    return { ok: false, response: errorResponse('Business not found', 404) };
  }

  if (location.account_id !== input.accountId) {
    const response = input.exposure === 'uniform-not-found'
      ? errorResponse('Business not found', 404)
      : errorResponse('Not authorized to access this location', 403);
    return { ok: false, response };
  }

  if (location.archived_at !== null) {
    const response = input.exposure === 'uniform-not-found'
      ? errorResponse('Business not found', 404)
      : errorResponse('No active location available', 404);
    return { ok: false, response };
  }

  return { ok: true, locationId: input.locationId };
}
