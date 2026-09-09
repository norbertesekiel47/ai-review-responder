import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import {
  isAdminApiRoute,
  isProtectedMixedRoleApiRoute,
  isProtectedOwnerApiRoute,
  isProtectedRoute,
  normalizePath,
} from '@/lib/shared/protected-routes';
import { REQUEST_PATHNAME_HEADER } from '@/lib/shared/request-path-header';
import { mfaEnforcementEnabled } from '@/lib/auth/flags';
import { isBearerRequest, readBearerToken } from '@/lib/auth/admin-transport';
import { NO_STORE_HEADERS } from '@/lib/shared/constants';
import {
  AdminOriginConfigError,
  isAllowedAdminOrigin,
  normalizeOrigin,
  readAdminAppOrigins,
} from '@/lib/config/admin-origins';

// Role lookups use the cookie-bound anon client below, relying on the
// users_self_select RLS policy (migration 006) that lets any authenticated
// user read their own row. Removes SUPABASE_SERVICE_KEY from Edge proxy
// so a service-role secret isn't required — and doesn't get used — on every
// protected request.
//
// Migration note (034): users.business_id was dropped and replaced by
// users.account_id. The readSelf() function now selects account_id instead
// of business_id. Validation contract: VAL-AUTH-029.

// ── Admin API CORS (#1186 · ADR 0026) ────────────────────────────────────────
//
// This file is the SINGLE owner of CORS for the Admin API (ADR 0026 D1): the
// three constants below are the only `Access-Control-*` values in the repo, and
// nothing else writes one of those headers. The DECISION — which origins are
// admitted — belongs to `@/lib/config/admin-origins`; only the header writing
// lives here.
//
// Fixed constants, never echoed from the request (ADR 0026 D3). `DELETE` is
// absent because no admin route exports one; adding a `DELETE` route later is a
// deliberate edit HERE, and the failure until then is loud and at the preflight.
// Echoing `Access-Control-Request-Headers` instead of naming a constant makes
// the answer always yes and leaves no readable statement of what the Admin app
// may send.
const ADMIN_CORS_ALLOW_METHODS = 'GET, POST, PUT, PATCH, OPTIONS';
const ADMIN_CORS_ALLOW_HEADERS = 'Authorization, Content-Type';
// 600 s is the highest value Safari honours (Chrome caps at 7200 s), so a
// browser sends one preflight per path per ten minutes rather than one per
// request.
const ADMIN_CORS_MAX_AGE = '600';

/**
 * Add `Origin` to `Vary` without destroying what is already there.
 *
 * Exported for its test: the merge cases cannot be reached through `proxy()`,
 * because no response it returns today carries a `Vary` header to merge into.
 *
 * `Vary: Origin` goes on EVERY `/api/admin/**` response, refusals and
 * no-`Origin` requests included (ADR 0026 D3) — without it a shared cache may
 * serve one origin's `Access-Control-Allow-Origin` to another, and the
 * no-`Origin` response is exactly the one that would be served to an origin.
 * A plain `set()` would silently drop a value such as `Accept-Encoding`.
 */
export function addVaryOrigin(headers: Headers): void {
  const existing = headers.get('Vary')?.trim();
  if (!existing) {
    headers.set('Vary', 'Origin');
    return;
  }
  // `*` already varies on everything; narrowing it would be a lie.
  if (existing === '*') return;

  const tokens = existing
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  if (tokens.some((token) => token.toLowerCase() === 'origin')) return;

  headers.set('Vary', [...tokens, 'Origin'].join(', '));
}

/** ADR 0026 D3: a refused origin gets a greppable status, not a silent 204. */
function adminOriginRefusal(): NextResponse {
  const response = NextResponse.json({ error: 'origin' }, { status: 403 });
  addVaryOrigin(response.headers);
  return response;
}

/** ADR 0026 D3's allowlisted column. No credentials, no expose-headers. */
function adminCorsPreflight(origin: string): NextResponse {
  const response = new NextResponse(null, { status: 204 });
  response.headers.set('Access-Control-Allow-Origin', origin);
  response.headers.set('Access-Control-Allow-Methods', ADMIN_CORS_ALLOW_METHODS);
  response.headers.set('Access-Control-Allow-Headers', ADMIN_CORS_ALLOW_HEADERS);
  response.headers.set('Access-Control-Max-Age', ADMIN_CORS_MAX_AGE);
  addVaryOrigin(response.headers);
  return response;
}

/**
 * The CORS block, and the ONLY thing that runs before `isProtectedRoute`.
 *
 * A preflight must never reach `handleProxy`'s branch 4: it carries no cookie,
 * so branch 4 would return 401 with no `Access-Control-Allow-Origin`, and the
 * browser would report a CORS failure whose status is never readable.
 *
 * Three rules, in this order:
 *
 *  1. Not the Admin API → untouched. `ADMIN_APP_ORIGINS` is not even read, so a
 *     bad value can never break `/admin/login` or a public page.
 *  2. Admin API → read and VALIDATE the allowlist unconditionally, before the
 *     self-origin / loopback / no-`Origin` shortcuts. `ADMIN_APP_ORIGINS=*` is a
 *     configuration error and must fail loudly on every admin request, not only
 *     on the ones that happen to consult the list.
 *  3. No `Origin` header → no check at all (a same-origin GET sends none). The
 *     request proceeds exactly as before and still gets `Vary: Origin`.
 */
export async function proxy(request: NextRequest): Promise<NextResponse> {
  const routePath = normalizePath(request.nextUrl.pathname);
  if (!isAdminApiRoute(routePath)) {
    return handleProxy(request);
  }

  let allowlist: readonly string[];
  try {
    allowlist = readAdminAppOrigins();
  } catch (error) {
    if (!(error instanceof AdminOriginConfigError)) throw error;
    // A misconfigured ADMIN_APP_ORIGINS is a REFUSAL, not a crash. Letting the
    // throw escape makes an unhandled proxy exception — a platform 500 with no
    // CORS envelope, on every /api/admin/** request including the no-Origin and
    // same-origin ones, for as long as the deployment lives (the value cannot be
    // re-read: changing it requires a redeploy). Failing closed with the SAME
    // 403 envelope keeps the response contract, still denies everything, and is
    // still loud — the log line below is the diagnosis, and the Admin app being
    // down is the alarm ADR 0026 Consequences intends.
    //
    // The envelope is deliberately IDENTICAL to an origin refusal: a distinct
    // body would be a contract element ADR 0026 D3's table does not define, and
    // would tell an unauthenticated caller that the admin edge is misconfigured.
    //
    // The message names the offending entry on purpose. ADMIN_APP_ORIGINS holds
    // public web origins an operator typed into a dashboard — it is
    // server-authoritative (invariant #13), not confidential — and a config
    // outage nobody can diagnose is the worse failure.
    console.error('[proxy] ADMIN_APP_ORIGINS is invalid — refusing every /api/admin request', {
      reason: error.message,
    });
    return adminOriginRefusal();
  }

  const rawOrigin = request.headers.get('origin');
  // `allowedOrigin` is non-null ONLY once the request has passed the check, so
  // it is exactly "the origin we will echo". Absent header and refused origin
  // are both handled before it is read again, and normalization happens once.
  const candidate = rawOrigin === null ? null : normalizeOrigin(rawOrigin);
  if (rawOrigin !== null && (candidate === null || !isAllowedAdminOrigin(candidate, allowlist))) {
    return adminOriginRefusal();
  }
  const allowedOrigin = candidate;

  if (allowedOrigin !== null && request.method === 'OPTIONS') {
    return adminCorsPreflight(allowedOrigin);
  }

  const response = await handleProxy(request);
  addVaryOrigin(response.headers);
  if (allowedOrigin !== null) {
    // The NORMALIZED origin, never the raw header: the value written is then
    // always exactly the origin that was decided about. A browser's own
    // serialization is already identical to it.
    response.headers.set('Access-Control-Allow-Origin', allowedOrigin);
  }
  return response;
}

async function handleProxy(request: NextRequest): Promise<NextResponse> {
  // ── Public paths: skip Supabase work ──────────────────────────────
  const { pathname } = request.nextUrl;
  // Case/slash-normalized copy used ONLY for protection + branch decisions.
  // The raw `pathname` is still forwarded downstream (REQUEST_PATHNAME_HEADER)
  // and used for redirect `next=`/`from=` params, preserving original casing.
  const routePath = normalizePath(pathname);

  function createDownstreamRequest(): { headers: Headers } {
    const downstreamHeaders = new Headers(request.headers);
    const cookieHeader = request.cookies
      .getAll()
      .map(({ name, value }) => `${name}=${value}`)
      .join('; ');
    if (cookieHeader) {
      downstreamHeaders.set('cookie', cookieHeader);
    }
    downstreamHeaders.set(REQUEST_PATHNAME_HEADER, pathname);
    return { headers: downstreamHeaders };
  }

  if (!isProtectedRoute(routePath)) {
    return NextResponse.next({ request: createDownstreamRequest() });
  }

  // Branch 4's bearer arm precedes cookie work. CORS has already run; the
  // canonical route gate owns signature, liveness, role and AAL2 verification.
  // Impersonation keeps its cookie path permanently (ADR 0024 D4 amendment).
  const isImpersonation = routePath === '/api/admin/impersonation' ||
    routePath.startsWith('/api/admin/impersonation/');
  if (isAdminApiRoute(routePath) && !isImpersonation && isBearerRequest(request)) {
    if (readBearerToken(request) === null) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE_HEADERS });
    }
    return NextResponse.next({ request: createDownstreamRequest() });
  }

  // ── Protected paths: existing Supabase auth logic ─────────────────
  let response = NextResponse.next({ request: createDownstreamRequest() });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          response = NextResponse.next({ request: createDownstreamRequest() });
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  const {
    data: { user: authUser },
  } = await supabase.auth.getUser();

  // RLS policy `users_self_select` (migration 006) permits self-reads via
  // auth_id = auth.uid()::text, so the cookie-bound anon client returns the
  // caller's single row without needing the service-role key.
  //
  // After migration 034: reads account_id instead of business_id.
  // VAL-AUTH-028: the users_self_select policy still works because it only
  // checks auth_id = auth.uid() — the column being selected doesn't matter.
  async function readSelf(): Promise<{ role: string; account_id: string | null } | null> {
    const { data } = await supabase
      .from('users')
      .select('role, account_id')
      .eq('auth_id', authUser!.id)
      .limit(1)
      .single();
    return (data as { role: string; account_id: string | null } | null) ?? null;
  }

  async function getAalGate(): Promise<'ok' | 'mfa_required' | 'mfa_check_failed'> {
    if (!mfaEnforcementEnabled()) {
      return 'ok';
    }
    const { data, error } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (error || !data) {
      return 'mfa_check_failed';
    }
    return data.nextLevel === 'aal2' && data.currentLevel !== 'aal2'
      ? 'mfa_required'
      : 'ok';
  }

  function redirectToMfaChallenge(): NextResponse {
    const mfaUrl = new URL('/mfa/challenge', request.url);
    mfaUrl.searchParams.set('next', `${request.nextUrl.pathname}${request.nextUrl.search}`);
    return withSupabaseCookies(NextResponse.redirect(mfaUrl));
  }

  function withSupabaseCookies(target: NextResponse): NextResponse {
    for (const cookie of response.cookies.getAll()) {
      target.cookies.set(cookie);
    }
    return target;
  }

  // 3. Admin pages (except /admin/login, /admin/forgot-password, /admin/reset-password)
  if (
    routePath.startsWith('/admin') &&
    routePath !== '/admin/login' &&
    routePath !== '/admin/forgot-password' &&
    routePath !== '/admin/reset-password'
  ) {
    if (!authUser) {
      return redirectToLogin(request);
    }
    const self = await readSelf();
    if (!self || self.role !== 'admin') {
      return redirectToLogin(request);
    }
    const aal = await getAalGate();
    if (aal !== 'ok') {
      return redirectToMfaChallenge();
    }
  }

  // 4. Admin API routes
  if (routePath.startsWith('/api/admin')) {
    if (!authUser) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const self = await readSelf();
    if (!self || self.role !== 'admin') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    const aal = await getAalGate();
    if (aal !== 'ok') {
      return withSupabaseCookies(NextResponse.json({ error: aal }, { status: 403 }));
    }
  }

  // 5. Mixed-role owner/admin API routes
  if (isProtectedMixedRoleApiRoute(routePath)) {
    const noStoreHeaders = { 'Cache-Control': 'no-store, private' };
    if (!authUser) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: noStoreHeaders });
    }
    const self = await readSelf();
    if (
      !self ||
      (self.role !== 'owner' && self.role !== 'admin') ||
      (self.role === 'owner' && !self.account_id)
    ) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403, headers: noStoreHeaders });
    }
    const aal = await getAalGate();
    if (aal !== 'ok') {
      return withSupabaseCookies(
        NextResponse.json({ error: aal }, { status: 403, headers: noStoreHeaders }),
      );
    }
  }

  // 6. Owner API routes
  if (isProtectedOwnerApiRoute(routePath)) {
    const noStoreHeaders = { 'Cache-Control': 'no-store, private' };
    if (!authUser) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: noStoreHeaders });
    }
    const self = await readSelf();
    if (!self || self.role !== 'owner' || !self.account_id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403, headers: noStoreHeaders });
    }
    const aal = await getAalGate();
    if (aal !== 'ok') {
      return withSupabaseCookies(
        NextResponse.json({ error: aal }, { status: 403, headers: noStoreHeaders }),
      );
    }
  }

  // 7. Owner pages
  if (
    routePath.startsWith('/dashboard') ||
    routePath.startsWith('/settings') ||
    routePath.startsWith('/account')
  ) {
    if (!authUser) {
      return redirectToLogin(request, 'owner');
    }
    const self = await readSelf();
    if (!self || self.role !== 'owner' || !self.account_id) {
      return redirectToLogin(request, 'owner');
    }
    const aal = await getAalGate();
    if (aal !== 'ok') {
      return redirectToMfaChallenge();
    }
  }

  // 7b. MFA challenge pages require a first-factor session. Owners and admins
  // both use this surface after password login when Supabase reports
  // currentLevel=aal1 and nextLevel=aal2.
  if (routePath === '/mfa' || routePath.startsWith('/mfa/')) {
    const next = request.nextUrl.searchParams.get('next') ?? '';
    const flow = next.startsWith('/admin') ? 'admin' : 'owner';
    if (!authUser) {
      return redirectToLogin(request, flow);
    }
    const self = await readSelf();
    if (!self || (self.role !== 'owner' && self.role !== 'admin')) {
      return redirectToLogin(request, flow);
    }
  }

  // 8. Onboarding paths require authenticated owner with a users row.
  // Does NOT require subscription_status='active' — the pages work pre-payment.
  //
  // Three sub-cases (split intentionally — collapsing them sends admins to
  // the OWNER login page when they accidentally navigate to an owner-flow
  // URL, which is what the page-level guard already correctly avoids):
  //   a. No session → owner login (this IS the right destination — they
  //      need to authenticate as an owner to reach onboarding).
  //   b. Authenticated as admin → admin home (they're already
  //      logged in correctly, just on the wrong page; don't make them
  //      re-authenticate).
  //   c. Authenticated as owner without account_id → owner login with
  //      `from=` (signup-not-finished provisioning state).
  if (routePath === '/onboarding' || routePath.startsWith('/onboarding/')) {
    if (!authUser) {
      return redirectToLogin(request, 'owner');
    }
    const self = await readSelf();
    if (!self) {
      // No public.users row at all — could be mid-provisioning Google
      // signup. Owner login lets them retry.
      return redirectToLogin(request, 'owner');
    }
    if (self.role === 'admin') {
      // Admin landed here by mistake — bounce to admin home, not owner login.
      return NextResponse.redirect(new URL('/admin/overview', request.url));
    }
    if (self.role !== 'owner' || !self.account_id) {
      return redirectToLogin(request, 'owner');
    }
    const aal = await getAalGate();
    if (aal !== 'ok') {
      return redirectToMfaChallenge();
    }
  }

  return response;
}

function redirectToLogin(request: NextRequest, flow: 'owner' | 'admin' = 'admin'): NextResponse {
  const loginPath = flow === 'owner' ? '/login' : '/admin/login';
  const loginUrl = new URL(loginPath, request.url);
  loginUrl.searchParams.set('from', request.nextUrl.pathname);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
