// src/lib/auth/require-owner-access.ts
//
// Shared server-component guard for owner-only pages. Bootstraps the Supabase
// server client, resolves the auth user, looks up the user's role +
// business_id + subscription_status, and redirects on any of the standard
// failure cases:
//   - no auth session               → /admin/login
//   - no users row matching auth_id → /admin/login
//   - role !== 'owner'              → /admin/overview
//   - subscription_status !== 'active' → /onboarding/pay
//
// Returns the resolved row (authId, businessId, email) when all checks pass.
// The owner email is included so callers like the /settings/channels page can
// fall back to it when no channel_enrollments row exists yet.

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { createServerClient } from '@supabase/ssr';
import { sql } from '@/lib/db/server';

export interface OwnerAccess {
  authId: string;
  businessId: string;
  email: string;
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
          // Server components can't set cookies; middleware handles refresh.
        },
      },
    },
  );

  const { data: { user: authUser } } = await supabase.auth.getUser();
  if (!authUser) redirect('/admin/login');

  const rows = await sql<{ role: string; business_id: string; subscription_status: string; email: string }[]>`
    SELECT u.role, b.id AS business_id, b.subscription_status, u.email
    FROM users u
    JOIN businesses b ON b.id = u.business_id
    WHERE u.auth_id = ${authUser.id}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) redirect('/admin/login');
  if (row.role !== 'owner') redirect('/admin/overview');
  if (row.subscription_status !== 'active') redirect('/onboarding/pay');

  return {
    authId: authUser.id,
    businessId: row.business_id,
    email: row.email,
  };
}
