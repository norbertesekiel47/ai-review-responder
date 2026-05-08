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
 * Reads the Supabase session from request cookies and maps the auth identity
 * to the app `users` table. Returns null if unauthenticated or no matching user row.
 *
 * Uses getUser() (not getSession()) — getUser() validates the token with the
 * Supabase Auth server on every call, which is required for server-side trust.
 *
 * Migration note (034): users.business_id was dropped; this function now
 * reads users.account_id and resolves the primary location from the
 * businesses table.
 */
export async function getCurrentUser(
  request: NextRequest,
): Promise<AppUser | null> {
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll() {
          // Route handlers can't set cookies on a request object.
          // Session refresh is handled by middleware.
        },
      },
    },
  );

  const {
    data: { user: authUser },
  } = await supabase.auth.getUser();

  if (!authUser) return null;

  // Map Supabase Auth identity to app user + resolve primary location.
  // Reads users.account_id (not users.business_id, which was dropped in
  // migration 034). Joins to businesses to find the primary location.
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
    WHERE u.auth_id = ${authUser.id}
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
