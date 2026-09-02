import type { Sql } from 'postgres';
import { requireCurrentAal2FromSupabase, type SupabaseMfaAalClient } from '@/lib/auth/mfa';
import { verifyImpersonationSession } from '@/lib/admin/impersonation/cookie';
import { loadActiveImpersonationSession } from '@/lib/admin/impersonation/session';

/** Who is signed in to the console, for the sidebar footer (X7). */
export interface AdminShellIdentity {
  email: string | null;
  /** True when the current session is already stepped up (AAL2). */
  aal2: boolean;
}

/** The live view-as session, for the persistent banner (X25). */
export interface AdminShellImpersonation {
  sessionId: string;
  /** ISO string — a `Date` must not cross the RSC boundary. */
  expiresAt: string;
  /** Account display name, or its id when the account has none. */
  accountLabel: string;
}

export interface AdminShellContext {
  identity: AdminShellIdentity | null;
  impersonation: AdminShellImpersonation | null;
}

/** The two Supabase calls this read makes — narrow so tests can hand in a fake. */
export interface AdminShellSupabaseClient extends SupabaseMfaAalClient {
  auth: SupabaseMfaAalClient['auth'] & {
    getUser: () => Promise<{
      data: { user: { id: string; email?: string | null } | null };
    }>;
  };
}

export interface LoadAdminShellContextInput {
  supabase: AdminShellSupabaseClient;
  /** Raw `rw_impersonation` cookie value, or null when absent. */
  signedImpersonationCookie: string | null;
  now?: Date;
}

const EMPTY: AdminShellContext = { identity: null, impersonation: null };

/**
 * What the admin shell (sidebar footer + impersonation banner) needs to know
 * about the current request. Read by `src/app/admin/layout.tsx` on every admin
 * render, so it is DISPLAY-ONLY and never redirects: the auth routes share the
 * layout and must render for a signed-out visitor, and every page still runs
 * its own `requireAdminPage` gate — this never substitutes for it.
 *
 * The three reads run in sequence (`ci:pool-fanout`), and each degrades to
 * "nothing to show" rather than failing the render: an unverifiable cookie,
 * an expired or foreign session, a misconfigured signing secret all yield
 * `impersonation: null`. The banner is a courtesy; the session's real gate is
 * `resolveImpersonationViewSession` on the view page.
 */
export async function loadAdminShellContext(
  sql: Sql,
  { supabase, signedImpersonationCookie, now }: LoadAdminShellContextInput,
): Promise<AdminShellContext> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return EMPTY;

  const aal = await requireCurrentAal2FromSupabase(supabase);
  const identity: AdminShellIdentity = { email: user.email ?? null, aal2: aal.ok };

  return {
    identity,
    impersonation: await loadImpersonation(sql, {
      authUserId: user.id,
      signedImpersonationCookie,
      now,
    }),
  };
}

async function loadImpersonation(
  sql: Sql,
  {
    authUserId,
    signedImpersonationCookie,
    now,
  }: { authUserId: string; signedImpersonationCookie: string | null; now?: Date },
): Promise<AdminShellImpersonation | null> {
  if (!signedImpersonationCookie) return null;

  let sessionId: string | null;
  try {
    sessionId = verifyImpersonationSession(signedImpersonationCookie);
  } catch {
    // IMPERSONATION_COOKIE_SECRET missing or too short. The start route would
    // have refused to mint the cookie, so this is a stale cookie from another
    // configuration — nothing to announce.
    return null;
  }
  if (!sessionId) return null;

  // `impersonation_sessions.actor_user_id` is the app user id, not the auth id.
  const actors = await sql<{ id: string }[]>`
    SELECT id FROM users WHERE auth_id = ${authUserId} AND role = 'admin' LIMIT 1
  `;
  const actor = actors[0];
  if (!actor) return null;

  const session = await loadActiveImpersonationSession(sql, {
    sessionId,
    actorUserId: actor.id,
    now,
  });
  if (!session) return null;

  return {
    sessionId: session.id,
    expiresAt: session.expiresAt.toISOString(),
    accountLabel: session.accountDisplayName ?? session.accountId,
  };
}
