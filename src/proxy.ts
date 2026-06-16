import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import {
  isProtectedMixedRoleApiRoute,
  isProtectedOwnerApiRoute,
  isProtectedRoute,
  normalizePath,
} from '@/lib/shared/protected-routes';
import { REQUEST_PATHNAME_HEADER } from '@/lib/shared/request-path-header';
import { buildContentSecurityPolicy, generateCspNonce } from '@/lib/security/csp.mjs';

// Role lookups use the cookie-bound anon client below, relying on the
// users_self_select RLS policy (migration 006) that lets any authenticated
// user read their own row. Removes SUPABASE_SERVICE_KEY from Edge proxy
// so a service-role secret isn't required — and doesn't get used — on every
// protected request.
//
// Migration note (034): users.business_id was dropped and replaced by
// users.account_id. The readSelf() function now selects account_id instead
// of business_id. Validation contract: VAL-AUTH-029.

export async function proxy(request: NextRequest) {
  // Per-request CSP nonce (production only). Dev/test get an empty policy so HMR
  // and React Refresh — which rely on inline eval the production policy forbids —
  // keep working unchanged. Computed once and reused for BOTH the forwarded
  // request headers (so Next applies the nonce to its own bootstrap scripts) and
  // the response header (so the browser enforces the same nonce). F-11.
  const nonce = process.env.NODE_ENV === 'production' ? generateCspNonce() : undefined;
  const cspValue = buildContentSecurityPolicy(process.env.NODE_ENV, nonce);

  const response = await routeRequest(request, nonce, cspValue);

  // Emit CSP on every response (pages, redirects, JSON) — defense-in-depth parity
  // with the prior static next.config `/(.*)` coverage. Setting it once here is
  // why none of routeRequest's ~12 return points has to remember to. Inert on
  // bodiless responses; the nonce only matters for rendered HTML.
  if (cspValue) {
    response.headers.set('Content-Security-Policy', cspValue);
  }
  return response;
}

async function routeRequest(
  request: NextRequest,
  nonce: string | undefined,
  cspValue: string,
): Promise<NextResponse> {
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
    if (nonce) {
      // x-nonce is a convenience seam for Server Components that need to nonce
      // their own inline content via headers() (none today) — Next does NOT read
      // it. The load-bearing header is the forwarded Content-Security-Policy
      // below: Next parses the nonce out of the REQUEST CSP header and applies it
      // to its <script> bootstrap/hydration tags. Only set on rendered requests.
      downstreamHeaders.set('x-nonce', nonce);
      downstreamHeaders.set('content-security-policy', cspValue);
    }
    return { headers: downstreamHeaders };
  }

  if (!isProtectedRoute(routePath)) {
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
    if (process.env.MFA_ENFORCEMENT_ENABLED !== 'true') {
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
