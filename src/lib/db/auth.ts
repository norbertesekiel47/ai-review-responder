import { NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { sql } from '@/lib/db/server';

export interface AppUser {
  id: string;
  name: string;
  email: string;
  role: string;
  businessId: string | null;
}

/**
 * Reads the Supabase session from request cookies and maps the auth identity
 * to the app `users` table. Returns null if unauthenticated or no matching user row.
 *
 * Uses getUser() (not getSession()) — getUser() validates the token with the
 * Supabase Auth server on every call, which is required for server-side trust.
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

  // Map Supabase Auth identity to app user
  const rows = await sql`
    SELECT id, name, email, role, business_id
    FROM users
    WHERE auth_id = ${authUser.id}
    LIMIT 1
  `;

  const row = rows[0];
  if (!row) return null;

  return {
    id: row.id as string,
    name: row.name as string,
    email: row.email as string,
    role: row.role as string,
    businessId: (row.business_id as string) ?? null,
  };
}

/**
 * Throws a structured error if the user is not authenticated.
 */
export async function requireAuth(request: NextRequest): Promise<AppUser> {
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
