import { NextRequest, NextResponse } from 'next/server';
import type { OffboardingGate } from '@/lib/account-offboarding/gate';
import { requireRole, AuthError } from '@/lib/db/auth';
import type { AppUser } from '@/lib/db/auth';
import type { AccountId } from '@/lib/shared/ids';
import type { z } from 'zod';
import { assertSameOrigin, SameOriginError } from '@/lib/shared/csrf';
import { assertWritableSubscriptionForAccount } from '@/lib/shared/writable-subscription';

export const LOCATION_ROUTE_NO_STORE = { 'Cache-Control': 'no-store, private' } as const;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type LocationOwnerRouteUser = AppUser & { accountId: AccountId };

export type LocationOwnerRouteResult =
  | { ok: true; user: LocationOwnerRouteUser }
  | { ok: false; response: NextResponse };

export type LocationRouteBodyResult<T> =
  | { ok: true; data: T }
  | { ok: false; response: NextResponse };

export async function readOwnerForMultiLocationRoute(
  req: NextRequest,
  offboardingGate?: Pick<OffboardingGate, 'getOffboardingState'>,
): Promise<LocationOwnerRouteResult> {
  if (process.env.MULTI_LOCATION_ENABLED !== 'true') {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'not_found' },
        { status: 404, headers: LOCATION_ROUTE_NO_STORE },
      ),
    };
  }

  try {
    assertSameOrigin(req);
  } catch (err) {
    if (err instanceof SameOriginError) {
      return {
        ok: false,
        response: NextResponse.json(
          { error: 'forbidden' },
          { status: 403, headers: LOCATION_ROUTE_NO_STORE },
        ),
      };
    }
    throw err;
  }

  let user: AppUser;
  try {
    user = await requireRole(req, 'owner');
  } catch (err) {
    if (err instanceof AuthError) {
      return {
        ok: false,
        response: NextResponse.json(
          { error: err.message },
          { status: err.statusCode, headers: LOCATION_ROUTE_NO_STORE },
        ),
      };
    }
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401, headers: LOCATION_ROUTE_NO_STORE },
      ),
    };
  }

  if (!user.accountId) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'No account associated with this user' },
        { status: 403, headers: LOCATION_ROUTE_NO_STORE },
      ),
    };
  }

  const writable = offboardingGate
    ? await assertWritableSubscriptionForAccount(user.accountId, undefined, offboardingGate)
    : await assertWritableSubscriptionForAccount(user.accountId);
  if (!writable.ok) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: writable.error },
        { status: writable.status, headers: LOCATION_ROUTE_NO_STORE },
      ),
    };
  }

  return { ok: true, user: user as LocationOwnerRouteUser };
}

/**
 * Single owner of the location-denial → HTTP-status vocabulary, shared by
 * the archive / promote-primary / reactivate routes for BOTH pre-tx guard
 * results and in-tx code-string throws. Exact-match only — substring
 * matching on error prose is how dialects and dead branches creep in.
 */
export const LOCATION_DENIAL_STATUS: Record<string, number> = {
  location_not_found: 404,
  location_not_owned: 403,
  location_already_archived: 409,
  location_archive_conflict: 409,
  location_reactivate_conflict: 409,
  last_active_location: 409,
  promote_first: 409,
  already_primary: 400,
};

/** Map an in-tx denial code to its response, or null for unexpected errors. */
export function locationDenialResponse(message: string): NextResponse | null {
  const status = LOCATION_DENIAL_STATUS[message];
  if (status === undefined) return null;
  return NextResponse.json(
    { error: message },
    { status, headers: LOCATION_ROUTE_NO_STORE },
  );
}

export function ownerAccountMismatchResponse(): NextResponse {
  return NextResponse.json(
    { error: 'Account ID mismatch' },
    { status: 403, headers: LOCATION_ROUTE_NO_STORE },
  );
}

export function invalidJsonResponse(): NextResponse {
  return NextResponse.json(
    { error: 'invalid_json' },
    { status: 400, headers: LOCATION_ROUTE_NO_STORE },
  );
}

export function invalidBodyResponse(issues: unknown): NextResponse {
  return NextResponse.json(
    { error: 'invalid_body', issues },
    { status: 400, headers: LOCATION_ROUTE_NO_STORE },
  );
}

export async function readLocationRouteJson<TSchema extends z.ZodTypeAny>(
  req: NextRequest,
  schema: TSchema,
): Promise<LocationRouteBodyResult<z.output<TSchema>>> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return { ok: false, response: invalidJsonResponse() };
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, response: invalidBodyResponse(parsed.error.issues) };
  }

  return { ok: true, data: parsed.data };
}
