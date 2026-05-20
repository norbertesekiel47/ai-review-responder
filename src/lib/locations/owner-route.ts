import { NextRequest, NextResponse } from 'next/server';
import { requireRole, AuthError } from '@/lib/db/auth';
import type { AppUser } from '@/lib/db/auth';
import type { AccountId } from '@/lib/shared/ids';
import type { z } from 'zod';

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

  return { ok: true, user: user as LocationOwnerRouteUser };
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
