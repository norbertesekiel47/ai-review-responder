// Single owner of the access/scope policy shared by the contacts routes
// (#541): contacts and uploads are strictly per-location, so the aggregate
// ("all locations") scope has no meaning here — it is rejected with one 400 —
// and the location resolves with the 'uniform-not-found' exposure (a new
// surface should not leak foreign-location existence). Takes `sql` as an
// explicit parameter (invariant #15); the route handlers stay thin.

import type { NextRequest, NextResponse } from 'next/server';
import type { Sql } from 'postgres';
import {
  errorResponse,
  requireWritableOwner,
  type WritableOwnerResult,
} from '@/lib/auth/route-helpers';
import { isValidUuid } from '@/lib/shared/ids';
import { solicitationWatchEnabled } from '@/lib/solicitation/flags';
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

/**
 * Shared write-route preamble for the contacts mutation routes: flag gate
 * FIRST (invariant #13 — when watch-mode is off this surface does not exist,
 * so the 404 precedes auth and the response shape leaks nothing), then
 * requireWritableOwner (owner auth + writable-subscription gate).
 */
export async function requireContactsWriteAccess(
  sql: Sql,
  request: NextRequest,
): Promise<WritableOwnerResult> {
  if (!solicitationWatchEnabled()) {
    return { ok: false, response: errorResponse('Not found', 404) };
  }
  return requireWritableOwner(sql, request);
}

export type ContactsScopedIdResult =
  | { ok: true; id: string; locationId: string }
  | { ok: false; response: NextResponse };

/**
 * Shared [id]-route resolution: awaits the dynamic params, maps a malformed
 * UUID onto the uniform 404 (same exposure as an unknown row), then resolves
 * the location scope.
 */
export async function resolveContactsScopedId(
  sql: Sql,
  request: NextRequest,
  input: { accountId: string; userLocationId: string | null | undefined },
  params: Promise<{ id: string }>,
): Promise<ContactsScopedIdResult> {
  const { id } = await params;
  if (!isValidUuid(id)) {
    return { ok: false, response: errorResponse('Not found', 404) };
  }
  const location = await requireContactsLocationScope(sql, request, input);
  if (!location.ok) return location;
  return { ok: true, id, locationId: location.locationId };
}
