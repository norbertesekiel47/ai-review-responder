import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { AuthError, requireRole, type AppUser } from '@/lib/db/auth';
import { requireCurrentAal2FromSupabase, type SupabaseMfaAalClient } from '@/lib/auth/mfa';
import { assertSameOrigin, SameOriginError } from '@/lib/shared/csrf';
import { NO_STORE_HEADERS } from '@/lib/shared/constants';

export type AdminMfaGateResult =
  | { ok: true; admin: AppUser }
  | { ok: false; response: NextResponse };

/**
 * Cookie-backed Supabase client for the AAL2 (MFA step-up) check. setAll is a
 * no-op: route handlers cannot mutate request cookies — the proxy refreshes the
 * session. Previously copy-pasted into flagged + zernio-queue routes.
 */
function mfaClientForRequest(request: NextRequest): SupabaseMfaAalClient {
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll() {
          // Route handlers cannot mutate request cookies; proxy handles refresh.
        },
      },
    },
  ) as SupabaseMfaAalClient;
}

function internalError(error: unknown): NextResponse {
  console.error('[admin-mfa-gate] unexpected failure:', error);
  return NextResponse.json({ error: 'internal_error' }, { status: 500, headers: NO_STORE_HEADERS });
}

/**
 * The admin control-plane preamble shared by every admin mutation route:
 * optional same-origin (CSRF) check → requireRole(admin) → AAL2 (MFA step-up)
 * against a cookie-backed Supabase client. Returns the admin user on success,
 * or a no-store JSON Response on failure:
 *
 *   - cross-origin           → 403 { error: 'forbidden' }
 *   - AuthError              → its statusCode (401 unauth / 403 forbidden),
 *                              { error: message }
 *   - missing AAL2 step-up   → 403 { error: 'mfa_required' | 'mfa_check_failed' }
 *   - unexpected (non-auth)  → 500 { error: 'internal_error' }
 *
 * Pass `{ sameOrigin: true }` for mutating (POST) routes; read routes (e.g. the
 * flagged GET queue) omit it. The 500 path replaces both the per-route
 * errorToResponse helpers and the old non-AuthError 401-mask on the flagged GET.
 */
export async function requireAdminWithAal2(
  request: NextRequest,
  opts: { sameOrigin?: boolean } = {},
): Promise<AdminMfaGateResult> {
  if (opts.sameOrigin) {
    try {
      assertSameOrigin(request);
    } catch (err) {
      if (err instanceof SameOriginError) {
        return {
          ok: false,
          response: NextResponse.json({ error: 'forbidden' }, { status: 403, headers: NO_STORE_HEADERS }),
        };
      }
      return { ok: false, response: internalError(err) };
    }
  }

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
    return { ok: false, response: internalError(err) };
  }

  let aal;
  try {
    aal = await requireCurrentAal2FromSupabase(mfaClientForRequest(request));
  } catch (err) {
    // The Supabase client construction or the AAL2 lookup can throw (network,
    // misconfig) rather than returning { ok: false }. Surface it as the same
    // clean 500 the role step uses, not a raw unhandled 500.
    return { ok: false, response: internalError(err) };
  }
  if (!aal.ok) {
    return {
      ok: false,
      response: NextResponse.json({ error: aal.reason }, { status: 403, headers: NO_STORE_HEADERS }),
    };
  }

  return { ok: true, admin };
}
