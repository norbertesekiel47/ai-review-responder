import { verifyImpersonationSession } from '@/lib/admin/impersonation/cookie';
import { assertImpersonatedActionAllowed } from '@/lib/admin/impersonation/guard';
import {
  loadActiveImpersonationSession,
  type ActiveImpersonationSession,
} from '@/lib/admin/impersonation/session';
import { sql } from '@/lib/db/server';

export type ImpersonationViewResolution =
  | {
      status: 'ok';
      admin: { id: string; email: string };
      session: ActiveImpersonationSession;
    }
  | { status: 'unauthenticated' }
  | { status: 'forbidden' }
  | { status: 'mfa_required' }
  | { status: 'not_found' };

export interface ImpersonationAccountLocation {
  id: string;
  name: string;
  displayLabel: string | null;
  isPrimary: boolean;
  archivedAt: Date | null;
}

export async function resolveImpersonationViewSession(input: {
  routeSessionId: string;
  signedCookieValue: string | null;
  authUserId: string | null;
  isAal2: boolean;
  action?: string;
  now?: Date;
}): Promise<ImpersonationViewResolution> {
  if (!input.authUserId) {
    return { status: 'unauthenticated' };
  }
  if (!input.signedCookieValue) {
    return { status: 'not_found' };
  }

  const signedSessionId = verifyImpersonationSession(input.signedCookieValue);
  if (!signedSessionId || signedSessionId !== input.routeSessionId) {
    return { status: 'not_found' };
  }

  const [admin] = await sql<{ id: string; email: string; role: string }[]>`
    SELECT id, email, role
    FROM users
    WHERE auth_id = ${input.authUserId}
    LIMIT 1
  `;

  if (!admin) {
    return { status: 'unauthenticated' };
  }
  if (admin.role !== 'admin') {
    return { status: 'forbidden' };
  }
  // AAL2 must be re-checked here, not just at session start: the page that
  // actually renders customer PII must not be reachable at AAL1 mid-session.
  if (!input.isAal2) {
    return { status: 'mfa_required' };
  }
  // Single choke point for impersonation surfaces: only allowlisted (read-only)
  // actions proceed. Any future write surface must add itself to the guard's
  // allowlist, so unknown/destructive actions are blocked by default.
  if (!assertImpersonatedActionAllowed(input.action ?? 'view_dashboard').ok) {
    return { status: 'forbidden' };
  }

  const session = await loadActiveImpersonationSession({
    sessionId: signedSessionId,
    actorUserId: admin.id,
    now: input.now,
  });

  if (!session) {
    return { status: 'not_found' };
  }

  return {
    status: 'ok',
    admin: { id: admin.id, email: admin.email },
    session,
  };
}

export async function loadImpersonationAccountLocations(
  accountId: string,
): Promise<ImpersonationAccountLocation[]> {
  const rows = await sql<{
    id: string;
    name: string;
    display_label: string | null;
    is_primary: boolean;
    archived_at: Date | string | null;
  }[]>`
    SELECT id, name, display_label, is_primary, archived_at
    FROM businesses
    WHERE account_id = ${accountId}::uuid
    ORDER BY is_primary DESC, name ASC
  `;

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    displayLabel: row.display_label,
    isPrimary: row.is_primary,
    archivedAt: row.archived_at ? new Date(row.archived_at) : null,
  }));
}
