import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { isProtectedRoute } from '@/lib/shared/protected-routes';

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
  // ── Public paths: skip Supabase work ──────────────────────────────
  const { pathname } = request.nextUrl;
  if (!isProtectedRoute(pathname)) {
    return NextResponse.next({ request });
  }

  // ── Protected paths: existing Supabase auth logic ─────────────────
  let response = NextResponse.next({ request });

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
          response = NextResponse.next({ request });
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

  // 3. Admin pages (except /admin/login, /admin/forgot-password, /admin/reset-password)
  if (
    pathname.startsWith('/admin') &&
    pathname !== '/admin/login' &&
    pathname !== '/admin/forgot-password' &&
    pathname !== '/admin/reset-password'
  ) {
    if (!authUser) {
      return redirectToLogin(request);
    }
    const self = await readSelf();
    if (!self || self.role !== 'admin') {
      return redirectToLogin(request);
    }
  }

  // 4. Admin API routes
  if (pathname.startsWith('/api/admin')) {
    if (!authUser) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const self = await readSelf();
    if (!self || self.role !== 'admin') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
  }

  // 5. Owner API routes
  if (
    pathname.startsWith('/api/dashboard') ||
    pathname.startsWith('/api/settings') ||
    pathname.startsWith('/api/billing') ||
    pathname.startsWith('/api/locations')
  ) {
    const noStoreHeaders = { 'Cache-Control': 'no-store, private' };
    if (!authUser) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: noStoreHeaders });
    }
    const self = await readSelf();
    if (!self || self.role !== 'owner' || !self.account_id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403, headers: noStoreHeaders });
    }
  }

  // 6. Owner pages
  if (pathname.startsWith('/dashboard') || pathname.startsWith('/settings')) {
    if (!authUser) {
      return redirectToLogin(request, 'owner');
    }
    const self = await readSelf();
    if (!self || self.role !== 'owner' || !self.account_id) {
      return redirectToLogin(request, 'owner');
    }
  }

  // 6b. MFA challenge pages require a first-factor session. Owners and admins
  // both use this surface after password login when Supabase reports
  // currentLevel=aal1 and nextLevel=aal2.
  if (pathname === '/mfa' || pathname.startsWith('/mfa/')) {
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

  // 7. Onboarding paths require authenticated owner with a users row.
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
  if (pathname === '/onboarding' || pathname.startsWith('/onboarding/')) {
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
