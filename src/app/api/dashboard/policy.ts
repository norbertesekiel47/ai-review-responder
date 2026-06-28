import type { NextRequest } from 'next/server';
import { multiLocationEnabled as isMultiLocationEnabled } from '@/lib/locations/flags';
import { type DashboardWindow, resolveDashboardWindow } from '@/lib/kpi/types';

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
