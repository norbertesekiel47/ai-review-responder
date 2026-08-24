import { NextRequest, NextResponse } from 'next/server';
import type { ZodType } from 'zod';
import { AuthError, requireRole, cookieBackedServerClient, type AppUser } from '@/lib/db/auth';
import { requireCurrentAal2FromSupabase, type SupabaseMfaAalClient } from '@/lib/auth/mfa';
import { NO_STORE_HEADERS } from '@/lib/shared/constants';

export type AdminMfaGateResult =
  | { ok: true; admin: AppUser }
  | { ok: false; response: NextResponse };

/** `requireAdminJson`'s result: the gated admin AND the parsed body, or the refusal. */
export type AdminJsonGateResult<T> =
  | { ok: true; admin: AppUser; data: T }
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

  let aal: Awaited<ReturnType<typeof requireCurrentAal2FromSupabase>>;
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

/**
 * The admin MUTATION preamble: the gate above, then `request.json()`, then
 * `schema.safeParse` — with the two 400 shapes those steps produce (#909, B3.11).
 *
 * WHY THIS IS ALLOWED TO EXIST, when a helper that hides an admin gate normally
 * is not. `ci:admin-aal2` is a fail-closed ALLOWLIST of recognized gate shapes,
 * and its stated property is that you can READ an admin handler and SEE its
 * gate. A wrapper is invisible to it by construction — which is why this exact
 * helper was built and REVERTED once during #898 step 8, when all three routes
 * went red the moment their preamble moved.
 *
 * The resolution is not an exemption. `requireAdminJson` is a THIRD RECOGNIZED
 * GATE SHAPE in `scripts/ci/admin-aal2-audit.ts`, credited only when the local
 * name is bound by an import from THIS module — the same provenance check
 * `requireAdminWithAal2` and `resolveAdminActor` carry. `requireAdminJson`
 * imported from anywhere else earns nothing, and every unrecognized wrapper is
 * still a finding. Widening a security control's vocabulary is a deliberate act
 * that ships with the extraction it enables, never as its side effect.
 *
 * ONE composition, ZERO new behaviour. Both refusals are byte-identical to what
 * the three routes spelled by hand:
 *
 *   - unreadable body → 400 { error: 'invalid_body' }
 *   - schema refusal  → 400 { error: <first issue message> | 'invalid_request' }
 *
 * Both carry `NO_STORE_HEADERS`, and the gate's own 401/403/500 arms pass
 * through untouched.
 *
 * CSRF is still NOT handled here, for the reason `requireAdminWithAal2` gives:
 * same-origin protection is applied at the export (`withSameOrigin()(handler)`)
 * so it stays visible at the route boundary.
 */
export async function requireAdminJson<T>(
  request: NextRequest,
  schema: ZodType<T>,
): Promise<AdminJsonGateResult<T>> {
  const gate = await requireAdminWithAal2(request);
  if (!gate.ok) return { ok: false, response: gate.response };

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'invalid_body' },
        { status: 400, headers: NO_STORE_HEADERS },
      ),
    };
  }

  const parsed = schema.safeParse(rawBody);
  if (!parsed.success) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? 'invalid_request' },
        { status: 400, headers: NO_STORE_HEADERS },
      ),
    };
  }

  return { ok: true, admin: gate.admin, data: parsed.data };
}
