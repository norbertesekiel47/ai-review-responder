import type { NextRequest } from 'next/server';
import { sql } from '@/lib/db/server';
import { getCacheRedis } from '@/lib/db/redis-cache';
import { assertSameOrigin, SameOriginError } from '@/lib/shared/csrf';
import { requireRole, AuthError } from '@/lib/db/auth';
import { ZernioRouteError } from '@/lib/zernio/errors';
import { locationsKey } from '@/lib/zernio/connect-state';
import { readConnectSessionCookie } from '@/lib/zernio/connect-session-cookie';
import { assertWritableSubscriptionStatus } from '@/lib/shared/writable-subscription';
import type { AppUser } from '@/lib/db/auth';
import type { ConnectLocationsBlob } from '@/lib/zernio/types';
import type { AccountFlagsInput } from '@/lib/shared/past-due-recovery';

interface SelectLocationBody {
  locationId?: unknown;
}

export interface SelectLocationContext {
  user: AppUser;
  sessionId: string;
  stored: ConnectLocationsBlob;
  locationId: string;
  redis: ReturnType<typeof getCacheRedis>;
}

/**
 * Steps 1–7 of the select-location finalize choreography: feature flag, CSRF,
 * auth, body parse, session cookie, cached-locations load, and auth-scope
 * verification. Throws `ZernioRouteError` for every validation failure — these
 * map byte-for-byte to the route's `errorToResponse` (same status + `NO_STORE`
 * headers). Unexpected (untyped) errors propagate unchanged so the outer
 * `errorToResponse` produces the identical `internal_error`/`zernio_*` surface.
 *
 * The locationId parser is intentionally PERMISSIVE — any non-empty string is
 * accepted and an empty/missing value yields `invalid_location_id` (NOT
 * preflight's UUID validation + `invalid_body`). Do not swap in preflight's
 * parser: it would silently change validation and the wire response.
 */
export async function authorizeSelectLocation(
  req: NextRequest,
): Promise<SelectLocationContext> {
  // Feature flag — subsystem A is gated by ZERNIO_PUBLISHING_ENABLED (§1.1).
  if (process.env.ZERNIO_PUBLISHING_ENABLED !== 'true') {
    throw new ZernioRouteError(503, 'feature_disabled');
  }

  // 1. CSRF (FIRST, before any DB or external work).
  try {
    assertSameOrigin(req);
  } catch (err) {
    if (err instanceof SameOriginError) {
      throw new ZernioRouteError(403, 'forbidden');
    }
    throw err;
  }

  // 2. Auth.
  let user: AppUser;
  try {
    user = await requireRole(req, 'owner');
  } catch (err) {
    if (err instanceof AuthError) {
      throw new ZernioRouteError(
        err.statusCode,
        err.statusCode === 401 ? 'unauthorized' : 'forbidden',
      );
    }
    throw err;
  }
  if (!user.accountId) {
    throw new ZernioRouteError(403, 'unscoped_owner');
  }

  // 3. Parse body.
  let body: SelectLocationBody;
  try {
    body = (await req.json()) as SelectLocationBody;
  } catch {
    throw new ZernioRouteError(400, 'invalid_body');
  }
  const locationId =
    typeof body.locationId === 'string' && body.locationId.length > 0
      ? body.locationId
      : null;
  if (!locationId) {
    throw new ZernioRouteError(400, 'invalid_location_id');
  }

  // 4. Read signed cookie → sessionId.
  const sessionId = readConnectSessionCookie(req);
  if (!sessionId) {
    throw new ZernioRouteError(401, 'connect_session_missing');
  }

  const redis = getCacheRedis();

  // 5. Load the cached locations blob.
  const raw = await redis.get(locationsKey(sessionId));
  if (!raw) {
    throw new ZernioRouteError(410, 'connect_session_expired');
  }
  let stored: ConnectLocationsBlob;
  try {
    stored = JSON.parse(raw) as ConnectLocationsBlob;
  } catch {
    throw new ZernioRouteError(410, 'connect_session_expired');
  }

  // 6. Auth-scope verify (defence-in-depth — cookie alone is insufficient).
  if (stored.userId !== user.id) {
    throw new ZernioRouteError(403, 'user_mismatch');
  }
  const [business] = await sql<{
    subscription_status: string;
    past_due_at: Date | string | null;
    flags: AccountFlagsInput;
  }[]>`
    SELECT a.subscription_status, a.past_due_at, a.flags
    FROM businesses b
    JOIN accounts a ON a.id = b.account_id
    WHERE b.id = ${stored.businessId}
      AND b.account_id = ${user.accountId}
      AND b.archived_at IS NULL
    LIMIT 1
  `;
  if (!business) {
    throw new ZernioRouteError(403, 'business_mismatch');
  }
  const writable = assertWritableSubscriptionStatus({
    subscriptionStatus: business.subscription_status,
    pastDueAt: business.past_due_at,
    accountFlags: business.flags,
  });
  if (!writable.ok) {
    throw new ZernioRouteError(writable.status, writable.error);
  }
  const locationKnown = stored.locations.some((loc) => loc.id === locationId);
  if (!locationKnown) {
    throw new ZernioRouteError(400, 'invalid_location_id');
  }

  return { user, sessionId, stored, locationId, redis };
}
