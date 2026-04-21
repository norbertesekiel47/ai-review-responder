import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { createClient } from '@supabase/supabase-js';
import { isProtectedRoute } from '@/lib/shared/protected-routes';

// Service-role client for role lookups (HTTP-based, Edge-compatible).
// Middleware can't use Postgres.js (TCP sockets not available on Edge Runtime).
const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!,
);

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

  // 3. Admin pages (except /admin/login)
  if (pathname.startsWith('/admin') && pathname !== '/admin/login') {
    if (!authUser) {
      return redirectToLogin(request);
    }
    const role = await lookupRole(authUser.id);
    if (!role || !['admin', 'sales_partner'].includes(role)) {
      return redirectToLogin(request);
    }
  }

  // 4. Admin API routes
  if (pathname.startsWith('/api/admin')) {
    if (!authUser) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const role = await lookupRole(authUser.id);
    if (!role || !['admin', 'sales_partner'].includes(role)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
  }

  // 5. Owner API routes
  if (pathname.startsWith('/api/dashboard') || pathname.startsWith('/api/settings')) {
    const noStoreHeaders = { 'Cache-Control': 'no-store, private' };
    if (!authUser) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: noStoreHeaders });
    }
    const { data } = await supabaseAdmin
      .from('users')
      .select('role, business_id')
      .eq('auth_id', authUser.id)
      .limit(1)
      .single();
    if (!data || data.role !== 'owner' || !data.business_id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403, headers: noStoreHeaders });
    }
  }

  // 6. Owner pages
  if (pathname.startsWith('/dashboard') || pathname.startsWith('/settings')) {
    if (!authUser) {
      return redirectToLogin(request);
    }
    const { data } = await supabaseAdmin
      .from('users')
      .select('role, business_id')
      .eq('auth_id', authUser.id)
      .limit(1)
      .single();
    if (!data || data.role !== 'owner' || !data.business_id) {
      return redirectToLogin(request);
    }
  }

  return response;
}

async function lookupRole(authId: string): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from('users')
    .select('role')
    .eq('auth_id', authId)
    .limit(1)
    .single();
  return data?.role ?? null;
}

function redirectToLogin(request: NextRequest): NextResponse {
  const loginUrl = new URL('/admin/login', request.url);
  loginUrl.searchParams.set('from', request.nextUrl.pathname);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
