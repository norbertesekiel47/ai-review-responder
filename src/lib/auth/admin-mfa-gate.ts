import { NextRequest, NextResponse } from 'next/server';
import { AuthError, requireRole, cookieBackedServerClient, type AppUser } from '@/lib/db/auth';
import { requireCurrentAal2FromSupabase, type SupabaseMfaAalClient } from '@/lib/auth/mfa';
import { NO_STORE_HEADERS } from '@/lib/shared/constants';

export type AdminMfaGateResult =
  | { ok: true; admin: AppUser }
  | { ok: false; response: NextResponse };

/**
 * The admin control-plane's uniform internal-error response: a structured log
 * line under `label` + a 500 { error: 'internal_error' } with no-store headers.
 * Shared by this gate and every admin mutation route so the on-the-wire shape of
 * an admin server fault — and its no-store cache behavior — has a single owner.
 */
export function internalError(label: string, error: unknown): NextResponse {
  console.error(label, error);
  return NextResponse.json({ error: 'internal_error' }, { status: 500, headers: NO_STORE_HEADERS });
}

/**
 * The admin control-plane preamble shared by every admin route that needs
 * elevated access: requireRole(admin) → AAL2 (MFA step-up) against a
 * cookie-backed Supabase client. Returns the admin user on success, or a
 * no-store JSON Response on failure:
 *
 *   - AuthError              → its statusCode (401 unauth / 403 forbidden),
 *                              { error: message }
 *   - missing AAL2 step-up   → 403 { error: 'mfa_required' | 'mfa_check_failed' }
 *   - unexpected (non-auth)  → 500 { error: 'internal_error' }
 *
 * CSRF is deliberately NOT handled here. Mutating routes get same-origin
 * protection by construction at the export — `export const POST =
 * withSameOrigin()(handler)` (src/lib/auth/route-helpers.ts) — the same
 * mechanism the rest of the app uses, visible at the route boundary. A
 * previous `{ sameOrigin: true }` opt-in flag made the check forgettable: a new
 * admin POST that omitted it shipped CSRF-vulnerable with no type error. Read
 * routes (e.g. the flagged GET queue) need no wrapper. The 500 path replaces
 * both the per-route errorToResponse helpers and the old non-AuthError
 * 401-mask on the flagged GET.
 *
 * Deliberate asymmetry with requireRoleOr401 (the owner/channel gate,
 * src/lib/auth/route-helpers.ts) on the unexpected-error mode: that gate
 * RE-THROWS a non-auth failure (bare Next 500), while this gate CATCHES it and
 * returns the clean internal_error 500 above. Each preserves its own routes'
 * pre-refactor behavior; don't unify one onto the other without accepting the
 * observable change.
 */
export async function requireAdminWithAal2(
  request: NextRequest,
): Promise<AdminMfaGateResult> {
  let admin: AppUser;
  try {
    admin = await requireRole(request, 'admin');
  } catch (err) {
    if (err instanceof AuthError) {
      return {
        ok: false,
        response: NextResponse.json({ error: err.message }, { status: err.statusCode, headers: NO_STORE_HEADERS }),
      };
    }
    return { ok: false, response: internalError('[admin-mfa-gate] unexpected failure:', err) };
  }

  let aal;
  try {
    aal = await requireCurrentAal2FromSupabase(
      cookieBackedServerClient(request) as SupabaseMfaAalClient,
    );
  } catch (err) {
    // The Supabase client construction or the AAL2 lookup can throw (network,
    // misconfig) rather than returning { ok: false }. Surface it as the same
    // clean 500 the role step uses, not a raw unhandled 500.
    return { ok: false, response: internalError('[admin-mfa-gate] unexpected failure:', err) };
  }
  if (!aal.ok) {
    return {
      ok: false,
      response: NextResponse.json({ error: aal.reason }, { status: 403, headers: NO_STORE_HEADERS }),
    };
  }

  return { ok: true, admin };
}
