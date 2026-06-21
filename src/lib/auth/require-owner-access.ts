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
// Validation contract: VAL-AUTH-023.
// Migration note: users.business_id was dropped in migration 034; this
// function now reads users.account_id instead.

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { createServerClient } from '@supabase/ssr';
import { sql } from '@/lib/db/server';
import { asAccountId, asLocationId } from '@/lib/shared/ids';
import type { AccountId, LocationId } from '@/lib/shared/ids';
import { SubscriptionStatus } from '@/lib/shared/subscription-status';
import { getRequestScope } from './get-request-scope';

const LOCATION_SCOPE_COOKIE = 'rw_location_scope';

export interface OwnerAccess {
  accountId: AccountId;
  currentLocationId: LocationId;
  role: string;
}

export async function requireOwnerAccess(): Promise<OwnerAccess> {
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

  const { data: { user: authUser } } = await supabase.auth.getUser();
  if (!authUser) redirect('/admin/login');

  // Read user role + account_id + subscription_status via the accounts table.
  // users.business_id was dropped in migration 034; we JOIN through
  // users.account_id → accounts instead.
  const rows = await sql<{
    role: string;
    account_id: string;
    subscription_status: string;
  }[]>`
    SELECT u.role, u.account_id, a.subscription_status
    FROM users u
    JOIN accounts a ON a.id = u.account_id
    WHERE u.auth_id = ${authUser.id}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) redirect('/admin/login');
  if (row.role === 'admin') redirect('/admin/overview');
  if (row.role !== 'owner') redirect('/login');
  if (
    row.subscription_status !== SubscriptionStatus.ACTIVE
    && row.subscription_status !== SubscriptionStatus.TRIALING
    && row.subscription_status !== SubscriptionStatus.PAST_DUE
  ) {
    redirect('/onboarding/pay');
  }

  const accountId = asAccountId(row.account_id);

  // Read the location scope cookie and resolve currentLocationId
  const scopeCookie = cookieStore.get(LOCATION_SCOPE_COOKIE);
  const cookieLocationId = scopeCookie?.value ? asLocationId(scopeCookie.value) : null;

  const scope = await getRequestScope(accountId, cookieLocationId);

  return {
    accountId: scope.accountId,
    currentLocationId: scope.currentLocationId,
    role: row.role,
  };
}
