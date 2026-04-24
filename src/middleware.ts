import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { isProtectedRoute } from '@/lib/shared/protected-routes';

// Role lookups use the cookie-bound anon client below, relying on the
// users_self_select RLS policy (migration 006) that lets any authenticated
// user read their own row. Removes SUPABASE_SERVICE_KEY from Edge middleware
// so a service-role secret isn't required — and doesn't get used — on every
// protected request.

export async function middleware(request: NextRequest) {
  const host = (request.headers.get('host') ?? '').toLowerCase().replace(/:\d+$/, '');

  // ── repworth.net: short-circuit before any Supabase work ─────────
  // Also handle www.repworth.net in case Vercel's www→apex redirect isn't in place.
  if (host === 'www.repworth.net') {
    return NextResponse.redirect(new URL(`https://repworth.net${request.nextUrl.pathname}${request.nextUrl.search}`), 301);
  }

  if (host === 'repworth.net') {
    const { pathname } = request.nextUrl;
    const normalised = pathname.endsWith('/') && pathname !== '/' ? pathname.slice(0, -1) : pathname;

    if (normalised === '/' || normalised === '/privacy' || normalised === '/terms' || normalised === '/features' || normalised === '/how-it-works') {
      const requestHeaders = new Headers(request.headers);
      requestHeaders.set('x-coming-soon', '1');
      return NextResponse.next({ request: { headers: requestHeaders } });
    }

    return NextResponse.redirect(new URL('https://repworth.net/'), 307);
  }

  // ── All other hosts: skip Supabase for public paths ───────────────
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
  async function readSelf(): Promise<{ role: string; business_id: string | null } | null> {
    const { data } = await supabase
      .from('users')
      .select('role, business_id')
      .eq('auth_id', authUser!.id)
      .limit(1)
      .single();
    return (data as { role: string; business_id: string | null } | null) ?? null;
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
    if (!self || !['admin', 'sales_partner'].includes(self.role)) {
      return redirectToLogin(request);
    }
  }

  // 4. Admin API routes
  if (pathname.startsWith('/api/admin')) {
    if (!authUser) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const self = await readSelf();
    if (!self || !['admin', 'sales_partner'].includes(self.role)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
  }

  // 5. Owner API routes
  if (pathname.startsWith('/api/dashboard') || pathname.startsWith('/api/settings')) {
    const noStoreHeaders = { 'Cache-Control': 'no-store, private' };
    if (!authUser) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: noStoreHeaders });
    }
    const self = await readSelf();
    if (!self || self.role !== 'owner' || !self.business_id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403, headers: noStoreHeaders });
    }
  }

  // 6. Owner pages
  if (pathname.startsWith('/dashboard') || pathname.startsWith('/settings')) {
    if (!authUser) {
      return redirectToLogin(request, 'owner');
    }
    const self = await readSelf();
    if (!self || self.role !== 'owner' || !self.business_id) {
      return redirectToLogin(request, 'owner');
    }
  }

  // 7. Onboarding paths require authenticated owner with a users row.
  // Does NOT require subscription_status='active' — the pages work pre-payment.
  if (pathname === '/onboarding' || pathname.startsWith('/onboarding/')) {
    if (!authUser) {
      return redirectToLogin(request, 'owner');
    }
    const self = await readSelf();
    if (!self || self.role !== 'owner' || !self.business_id) {
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
