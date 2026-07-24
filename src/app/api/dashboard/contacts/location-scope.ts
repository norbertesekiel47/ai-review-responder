// Single owner of the location-scope policy shared by the three contacts
// routes (#541): contacts and uploads are strictly per-location, so the
// aggregate ("all locations") scope has no meaning here — it is rejected with
// one 400 — and the location resolves with the 'uniform-not-found' exposure
// (a new surface should not leak foreign-location existence). Takes `sql` as
// an explicit parameter (invariant #15); the route handlers stay thin.

import type { NextRequest, NextResponse } from 'next/server';
import type { Sql } from 'postgres';
import { errorResponse } from '@/lib/auth/route-helpers';
import {
  resolveDashboardLocation,
  resolveDashboardRequest,
} from '@/app/api/dashboard/policy';

export type ContactsLocationScopeResult =
  | { ok: true; locationId: string }
  | { ok: false; response: NextResponse };

export async function requireContactsLocationScope(
  sql: Sql,
  request: NextRequest,
  input: { accountId: string; userLocationId: string | null | undefined },
): Promise<ContactsLocationScopeResult> {
  const { scopePolicy } = resolveDashboardRequest(request, input.userLocationId);
  if (scopePolicy.mode === 'aggregate') {
    return { ok: false, response: errorResponse('A location scope is required', 400) };
  }

  return resolveDashboardLocation(sql, {
    accountId: input.accountId,
    locationId: scopePolicy.locationId,
    exposure: 'uniform-not-found',
  });
}
