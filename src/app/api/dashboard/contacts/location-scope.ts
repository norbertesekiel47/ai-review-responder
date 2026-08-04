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
import { reportCaughtError } from '@/lib/shared/report-caught-error';
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

/** Everything a `[id]` contacts mutation is allowed to act on, and nothing a
 *  caller could choose: the account and actor come from the authenticated owner
 *  scope, the location from the resolved scope policy, the contact from the
 *  route param. */
export interface ScopedContactContext {
  accountId: string;
  locationId: string;
  contactId: string;
  actorUserId: string;
}

/**
 * The `[id]` contacts-mutation policy, in one place. Every handler under
 * `/api/dashboard/contacts/[id]` runs exactly this preamble, and each copy of
 * it was a chance for one route to drift into a different exposure:
 *
 *  1. Flag gate FIRST, then owner auth (inside requireContactsWriteAccess) —
 *     when watch-mode is off this surface does not exist, so the 404 precedes
 *     auth and leaks no auth-shaped response (invariant #13).
 *  2. Auth stays OUTSIDE the catch, so an auth-infrastructure failure keeps
 *     requireWritableOwner's rethrow contract instead of being flattened to a
 *     500 with this route's copy.
 *  3. Malformed id, foreign contact, foreign/archived location → one uniform
 *     404 (invariant #8): a caller can never tell a contact that is not theirs
 *     from one that does not exist.
 *  4. Anything thrown by the handler is reported against `endpoint` and mapped
 *     to `failureMessage` — the two things that legitimately differ per route.
 *
 * `withSameOrigin()` is deliberately NOT applied here: it is the outermost
 * wrapper on the exported handler, so a cross-origin request is refused before
 * this preamble runs at all.
 */
export function withScopedContact(
  sql: Sql,
  options: { endpoint: string; failureMessage: string },
  handler: (scoped: ScopedContactContext) => Promise<NextResponse>,
): (
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) => Promise<NextResponse> {
  return async (request, { params }) => {
    const owner = await requireContactsWriteAccess(sql, request);
    if (!owner.ok) return owner.response;
    const { user, accountId } = owner;

    try {
      const scoped = await resolveContactsScopedId(
        sql,
        request,
        { accountId, userLocationId: user.locationId },
        params,
      );
      if (!scoped.ok) return scoped.response;

      return await handler({
        accountId,
        locationId: scoped.locationId,
        contactId: scoped.id,
        actorUserId: user.id,
      });
    } catch (error) {
      reportCaughtError(options.endpoint, error, { accountId });
      return errorResponse(options.failureMessage, 500);
    }
  };
}
