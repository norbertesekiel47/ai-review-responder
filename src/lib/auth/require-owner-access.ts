// src/lib/auth/require-owner-access.ts
//
// Shared server-component guard for owner-only pages. Bootstraps the Supabase
// server client, resolves the auth user, looks up the user's role +
// account_id + subscription_status (from the accounts table), and redirects
// on any of the standard failure cases:
//   - no auth session               → /admin/login
//   - no users row matching auth_id → /admin/login
//   - role === 'admin'              → /admin/overview
//   - unsupported legacy role       → /login
//   - subscription_status not active/past_due → /onboarding/pay
//
// Returns { accountId, currentLocationId, role } when all checks pass.
// The currentLocationId is resolved by getRequestScope() which reads the
// 'rw_location_scope' cookie and falls back to the primary location.
//
// Render-scoped memo (React.cache): the authenticated layout and the page it
// wraps both need the auth user, the `users` row, and the request scope. Each
// used to fetch all three independently — two Supabase Auth round trips, two
// `users` reads, and two `businesses` scans per page render. The three
// `getRender*` helpers below are wrapped in `cache()`, which memoizes per
// server request and is shared across every Server Component in that render
// (layout + page + nested components). They return data only and never
// redirect, so each caller keeps its own redirect ordering. `cache()` does
// NOT reach route handlers or the proxy — those keep `getCurrentUser(request)`
// in src/lib/db/auth.ts, and the proxy still validates every request on its
// own (defense in depth is unchanged).
//
// Validation contract: VAL-AUTH-023.
// Migration note: users.business_id was dropped in migration 034; this
// function now reads users.account_id instead.

import { cache } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { createServerClient } from '@supabase/ssr';
import type { User } from '@supabase/supabase-js';
import type { Sql } from 'postgres';
import { asAccountId, asLocationId } from '@/lib/shared/ids';
import type { AccountId, LocationId } from '@/lib/shared/ids';
import { subscriptionAllowsDashboardRead } from '@/lib/shared/subscription-status';
import { getRequestScope, type RequestScope } from './get-request-scope';

const LOCATION_SCOPE_COOKIE = 'rw_location_scope';

export interface OwnerAccess {
  accountId: AccountId;
  currentLocationId: LocationId;
  role: string;
}

/**
 * The one `users` row shape every render-time consumer reads. Superset of what
 * the layout needs (role, account_id, name, email) and what the page gate
 * needs (role, account_id, subscription_status), so one SELECT serves both.
 *
 * `has_account` is `a.id IS NOT NULL`: it preserves the old inner-JOIN miss
 * (a users row whose account_id is NULL or dangling used to yield no row at
 * all) without dropping the row for the layout, which wants the name/email
 * even when it is about to redirect on role.
 */
interface RenderOwnerRow {
  id: string;
  role: string;
  account_id: string | null;
  name: string | null;
  email: string;
  subscription_status: string | null;
  has_account: boolean;
}

/**
 * One Supabase Auth `getUser()` per server render. Reads the cookie store
 * itself so it takes no arguments (a single memo key per request).
 */
export const getRenderAuthUser = cache(async (): Promise<User | null> => {
  const cookieStore = await cookies();
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll() {
          // Server components can't set cookies; proxy handles refresh.
        },
      },
    },
  );
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
});

/**
 * One `users` (+ `accounts`) read per server render for a given auth id.
 * users.business_id was dropped in migration 034; we LEFT JOIN through
 * users.account_id → accounts and expose the join hit as `has_account`.
 */
export const getRenderOwnerRow = cache(
  async (sql: Sql, authId: string): Promise<RenderOwnerRow | null> => {
    const rows = await sql<RenderOwnerRow[]>`
      SELECT u.id, u.role, u.account_id, u.name, u.email,
             a.subscription_status,
             (a.id IS NOT NULL) AS has_account
      FROM users u
      LEFT JOIN accounts a ON a.id = u.account_id
      WHERE u.auth_id = ${authId}
      LIMIT 1
    `;
    return rows[0] ?? null;
  },
);

/**
 * One scope resolution (the `businesses WHERE account_id` scan) per server
 * render for a given (account, cookie) pair.
 */
export const getRenderRequestScope = cache(
  (sql: Sql, accountId: AccountId, cookieLocationId: LocationId | null): Promise<RequestScope> =>
    getRequestScope(sql, accountId, cookieLocationId),
);

/**
 * @param sql  Postgres.js client (composition root supplies the singleton —
 *   this module never imports @/lib/db/server).
 */
export async function requireOwnerAccess(sql: Sql): Promise<OwnerAccess> {
  const authUser = await getRenderAuthUser();
  if (!authUser) redirect('/admin/login');

  const row = await getRenderOwnerRow(sql, authUser.id);
  // `!row.has_account` is the former inner-JOIN miss: same redirect, same order.
  if (!row || !row.has_account) redirect('/admin/login');
  if (row.role === 'admin') redirect('/admin/overview');
  if (row.role !== 'owner') redirect('/login');
  if (!subscriptionAllowsDashboardRead(row.subscription_status ?? '')) {
    redirect('/onboarding/pay');
  }

  const accountId = asAccountId(row.account_id!);

  // Read the location scope cookie and resolve currentLocationId
  const cookieStore = await cookies();
  const scopeCookie = cookieStore.get(LOCATION_SCOPE_COOKIE);
  const cookieLocationId = scopeCookie?.value ? asLocationId(scopeCookie.value) : null;

  const scope = await getRenderRequestScope(sql, accountId, cookieLocationId);

  return {
    accountId: scope.accountId,
    currentLocationId: scope.currentLocationId,
    role: row.role,
  };
}
