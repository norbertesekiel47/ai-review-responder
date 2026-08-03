import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import type { Sql } from 'postgres';
import {
  mfaChallengePath,
  requireCurrentAal2FromSupabase,
  type SupabaseMfaAalClient,
} from '@/lib/auth/mfa';

export interface AdminPageUser {
  id: string;
  role: string;
}

interface RequireAdminPageOptions {
  /**
   * The current page path, used as the `/admin/login` `?from=` redirect target.
   * Must be a static internal page path (e.g. '/admin/jobs'); never thread
   * unvalidated request input through this — it feeds the login/MFA redirect query.
   */
  from: string;
  /** Require an AAL2 (MFA step-up) session — Safety pages reading sensitive content. */
  aal2?: boolean;
}

/**
 * Server-component admin gate (spec §4). Defense-in-depth behind src/proxy.ts's
 * /admin gate — its real job is giving the page the authenticated admin user.
 * Mirrors the cookie-store-backed Supabase client construction and MFA
 * handling from src/app/admin/impersonate/[sessionId]/view/page.tsx, the one
 * existing server-page auth pattern.
 *
 * Takes `sql` explicitly (invariant #15) — pages are composition roots and
 * pass their own `sql` import through.
 */
export async function requireAdminPage(
  sql: Sql,
  { from, aal2 = false }: RequireAdminPageOptions,
): Promise<AdminPageUser> {
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
          // Server components cannot mutate response cookies.
        },
      },
    },
  );

  const loginRedirect = `/admin/login?from=${encodeURIComponent(from)}`;

  const {
    data: { user: authUser },
  } = await supabase.auth.getUser();
  if (!authUser) redirect(loginRedirect);

  const rows = await sql<AdminPageUser[]>`
    SELECT id, role FROM users WHERE auth_id = ${authUser.id} LIMIT 1
  `;
  const appUser = rows[0];
  if (!appUser || appUser.role !== 'admin') redirect(loginRedirect);

  if (aal2) {
    const aal = await requireCurrentAal2FromSupabase(supabase as unknown as SupabaseMfaAalClient);
    if (!aal.ok) redirect(mfaChallengePath(from));
  }

  return appUser;
}
