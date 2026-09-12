import { NextRequest, NextResponse } from 'next/server';
import type { ZodType } from 'zod';
import { loadAppUser, type AppUser } from '@/lib/db/auth';
import { resolveAdminApiIdentity } from '@/lib/auth/verified-identity';
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
 * Canonical Admin API gate: verified bearer identity, application admin role,
 * then strict AAL2. Only /api/admin/impersonation/** retains its existing cookie
 * identity below this gate (ADR 0031 D6); owner gates remain cookie-only.
 *
 * The seam owns credential verification and the segment-bounded exception.
 * This gate, requireAdminJson and resolveAdminActor keep their names and result
 * shapes, so ci:admin-aal2 retains the same three credited gate shapes.
 *
 * Refusals are unchanged: 401 Unauthorized for no live credential; 403 Forbidden
 * for no application admin; 403 mfa_required for a readable non-aal2 level;
 * 403 mfa_check_failed for unreadable AAL; 500 internal_error for unexpected
 * failures. All are no-store JSON with no redirects. The gate never consults
 * MFA_ENFORCEMENT_ENABLED; bearer trust still includes signature, expiry and
 * liveness, and AAL2 is unconditional.
 *
 * Ordinary Admin API routes carry no cookie CSRF wrapper after #1203; the proxy
 * still owns the origin allowlist. Impersonation keeps withSameOrigin at its
 * mutation exports, and its cookie failure semantics are unchanged.
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
    const identity = await resolveAdminApiIdentity(request);
    // No live bearer, or no live cookie inside the permanent exception.
    // A malformed Authorization header never falls back to a cookie.
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
 * ordinary routes require bearer identity before any body is read.
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
