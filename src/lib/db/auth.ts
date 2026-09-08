import { NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { sql } from '@/lib/db/server';
import { asAccountId, asLocationId } from '@/lib/shared/ids';
import type { AccountId, LocationId } from '@/lib/shared/ids';

export interface AppUser {
  id: string;
  name: string;
  email: string;
  role: string;
  accountId: AccountId | null;
  /** Primary location for the user's account. Null when account has no active locations. */
  locationId: LocationId | null;
}

/**
 * Read-only cookie-backed Supabase SSR client for a Next.js route handler.
 * Reads auth cookies off the NextRequest; `setAll` is a deliberate no-op
 * because route handlers cannot mutate request cookies — the proxy refreshes
 * the session. getUser() still validates the token against Supabase on every
 * call, so a stale access token surfaces as a 401 (triggering a browser-side
 * refresh), never a trust gap. The single owner of this adapter — previously
 * copy-pasted into getCurrentUser, the (since-deleted) `withSession` wrapper,
 * and the admin MFA gate.
 */
export function cookieBackedServerClient(request: NextRequest) {
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll() {
          // No-op: route handlers cannot mutate request cookies; the proxy
          // handles session refresh.
        },
      },
    },
  );
}

/**
 * Reads the Supabase session from request cookies and maps the auth identity
 * to the app `users` table. Returns null if unauthenticated or no matching user row.
 *
 * Uses getUser() (not getSession()) — getUser() validates the token with the
 * Supabase Auth server on every call, which is required for server-side trust.
 *
 * The users-row mapping (and its migration-034 note) now lives in `loadAppUser`
 * below; this function is the cookie half of the composition.
 */
export async function getCurrentUser(
  request: NextRequest,
): Promise<AppUser | null> {
  const supabase = cookieBackedServerClient(request);

  const {
    data: { user: authUser },
  } = await supabase.auth.getUser();

  if (!authUser) return null;

  return loadAppUser(authUser.id);
}

/**
 * Maps a Supabase Auth identity (`users.auth_id`) to its app `users` row, or null
 * when there is none. Resolves the account's primary location in the same query.
 *
 * Extracted from `getCurrentUser` for the **Admin transport** seam (#1183): that
 * seam resolves an `authUserId` from EITHER a session cookie or a bearer and then
 * needs exactly this mapping — but it must not import `@/lib/db/server` itself
 * (invariant #15). This file is the composition root that owns the singleton, so
 * the mapping lives here and the seam stays a pure identity resolver.
 *
 * The predicate is `u.auth_id`, never `u.id` (invariant #8). Those are two
 * different namespaces — the Supabase Auth identity and the app's own primary key —
 * and transposing them would return whichever `users` row happens to carry an auth
 * id as its primary key.
 *
 * Migration note (034): `users.business_id` was dropped; this reads
 * `users.account_id` and joins `businesses` for the primary location.
 */
export async function loadAppUser(authUserId: string): Promise<AppUser | null> {
  const rows = await sql<{
    id: string;
    name: string;
    email: string;
    role: string;
    account_id: string | null;
    primary_location_id: string | null;
  }[]>`
    SELECT u.id, u.name, u.email, u.role, u.account_id,
           (SELECT b.id FROM businesses b
            WHERE b.account_id = u.account_id
              AND b.is_primary = TRUE
              AND b.archived_at IS NULL
            LIMIT 1) AS primary_location_id
    FROM users u
    WHERE u.auth_id = ${authUserId}
    LIMIT 1
  `;

  const row = rows[0];
  if (!row) return null;

  return {
    id: row.id as string,
    name: row.name as string,
    email: row.email as string,
    role: row.role as string,
    accountId: row.account_id ? asAccountId(row.account_id) : null,
    locationId: row.primary_location_id ? asLocationId(row.primary_location_id) : null,
  };
}

/**
 * Throws a structured error if the user is not authenticated.
 */
async function requireAuth(request: NextRequest): Promise<AppUser> {
  const user = await getCurrentUser(request);
  if (!user) {
    throw new AuthError('Unauthorized', 401);
  }
  return user;
}

/**
 * Throws a structured error if the user doesn't have one of the required roles.
 */
export async function requireRole(
  request: NextRequest,
  ...roles: string[]
): Promise<AppUser> {
  const user = await requireAuth(request);
  if (!roles.includes(user.role)) {
    throw new AuthError('Forbidden', 403);
  }
  return user;
}

export class AuthError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}
