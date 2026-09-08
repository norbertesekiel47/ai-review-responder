import { NextRequest, NextResponse } from 'next/server';
import type { ZodType } from 'zod';
import { loadAppUser, type AppUser } from '@/lib/db/auth';
import { resolveDualModeIdentity } from '@/lib/auth/verified-identity';
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
 * elevated access. Since #1183 it is DUAL-MODE (ADR 0025): the **Admin transport**
 * seam resolves a verified identity from EITHER the session cookie (the Legacy
 * admin portal, same-origin) or a Supabase access token in `Authorization: Bearer`
 * (the Admin app, cross-origin), and this gate then decides — role, then a STRICT
 * aal2 test. A **Verified admin** means authentic, live and aal2 on both
 * transports; bearer mode is not cheaper than cookie mode and must not be made so.
 *
 * The transport branch deliberately lives BELOW this function, in
 * `@/lib/auth/verified-identity`, and NOT inside `requireRole` — about 40 owner and
 * mixed-role routes reach that through `requireRoleOr401`, and none of them asked
 * to accept a bearer (ADR 0025 D1). `requireRole` stays cookie-only.
 *
 * The exported name and result shape are UNCHANGED, so `ci:admin-aal2`'s allowlist
 * is untouched and `requireAdminJson` / `resolveAdminActor` inherit dual mode by
 * composition.
 *
 * `MFA_ENFORCEMENT_ENABLED` is never read here. It gates the proxy's AAL step only;
 * this gate is unconditional and stays unconditional (ADR 0025 D10).
 *
 * The refusal contract, byte-for-byte on both transports:
 *
 *   - no/bad/expired/revoked credential → 401 { error: 'Unauthorized' }
 *   - verified, but no `users` row or role is not admin
 *                                      → 403 { error: 'Forbidden' }
 *   - verified, aal is not 'aal2'       → 403 { error: 'mfa_required' }
 *   - aal missing or unreadable         → 403 { error: 'mfa_check_failed' }
 *   - Supabase transport fault, or any
 *     other unexpected failure          → 500 { error: 'internal_error' }
 *
 * All carry NO_STORE_HEADERS, and none is a redirect — a cross-origin API must not
 * redirect (ADR 0025 D9).
 *
 * Two refusals moved with the ticket's table, which is declared for BOTH
 * transports: a verified cookie session with no `users` row was a 401 and is now a
 * 403 (the old path could not tell "no session" from "no row"), and a cookie AAL
 * read yielding no level is now `mfa_check_failed` rather than `mfa_required`.
 *
 * A THIRD, narrower difference comes from ORDER and is declared rather than fixed
 * (deviations D6): the seam resolves identity and AAL together, so the AAL read now
 * happens BEFORE the role check, where `requireRole` used to refuse a non-admin
 * first. A non-admin whose AAL read THROWS therefore gets 500 rather than 403 —
 * fail-closed, and it needs a Supabase fault and a non-admin at the same moment —
 * and a refused cookie request pays one extra AAL round-trip.
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
  const refuse = (status: number, error: string): AdminMfaGateResult => ({
    ok: false,
    response: NextResponse.json({ error }, { status, headers: NO_STORE_HEADERS }),
  });

  let admin: AppUser | null;
  let aal: string | null;
  try {
    const identity = await resolveDualModeIdentity(request);
    // No live credential on the transport the caller chose. The seam never falls
    // back to the other one: an Authorization header suppresses the cookie even
    // when it is malformed, so this cannot be retried into a cookie session.
    if (!identity) return refuse(401, 'Unauthorized');

    admin = await loadAppUser(identity.authUserId);
    aal = identity.aal;
  } catch (err) {
    // A Supabase transport fault (unreachable, or 5xx) arrives here as an
    // IdentityTransportError, and loadAppUser can fail on the database. Both are
    // faults, not refusals, and both keep the clean internal_error 500 this gate
    // has always returned rather than a raw unhandled one. A MALFORMED credential
    // never reaches this catch — the seam classifies that as "no identity" above.
    return { ok: false, response: internalError('[admin-mfa-gate] unexpected failure:', err) };
  }

  if (!admin || admin.role !== 'admin') return refuse(403, 'Forbidden');

  // Two distinct answers, and the Admin app acts on the difference: mfa_required
  // means "run your MFA challenge and retry", mfa_check_failed means the assurance
  // level could not be read at all. The aal2 test is STRICT — never the proxy's
  // lenient nextLevel form, which passes an unenrolled admin.
  if (aal === null) return refuse(403, 'mfa_check_failed');
  if (aal !== 'aal2') return refuse(403, 'mfa_required');

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
